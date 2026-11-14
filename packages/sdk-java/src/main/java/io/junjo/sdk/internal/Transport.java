package io.junjo.sdk.internal;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import io.junjo.sdk.JunjoException;
import io.junjo.sdk.JunjoLogger;
import io.junjo.sdk.RetryPolicy;
import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpConnectTimeoutException;
import java.net.http.HttpHeaders;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpTimeoutException;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.CancellationException;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Executor;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/**
 * The HTTP layer every API namespace, the event stream, the mirror and the write queue share. It
 * owns the {@link HttpClient}, the timer thread used for timeouts and retry waits, and (when the
 * caller supplied none) the executor.
 *
 * <p>Every call is asynchronous. A request timeout is enforced by the SDK's own timer in addition
 * to {@link HttpRequest.Builder#timeout}, because the JDK timeout stops at the response headers
 * and a server that stalls the body must still surface as {@code timeout}.
 *
 * <p>Internal: not part of the supported API.
 */
public final class Transport implements AutoCloseable {
    /** The header that carries a stream position on snapshot reads and on the game stream. */
    public static final String POSITION_HEADER = "Junjo-Stream-Position";

    /** The header that carries a write tag, recorded on the events the write causes. */
    public static final String WRITE_TAG_HEADER = "Junjo-Write-Tag";

    private static final DateTimeFormatter HTTP_DATE = DateTimeFormatter.RFC_1123_DATE_TIME;
    private static final int MAX_ERROR_BODY_BYTES = 64 * 1024;

    private final String baseUrl;
    private final String apiKey;
    private final Duration requestTimeout;
    private final RetryPolicy retry;
    private final JunjoLogger logger;
    private final String userAgent;
    private final String writeTag;
    private final HttpClient http;
    private final ExecutorService ownedExecutor;
    private final Executor executor;
    private final ScheduledThreadPoolExecutor timer;
    private final Set<CompletableFuture<?>> pending = ConcurrentHashMap.newKeySet();
    private final AtomicBoolean closed = new AtomicBoolean();

    /**
     * Creates the transport.
     *
     * @param baseUrl the server root, without a trailing {@code /v1}
     * @param apiKey the per-game API key, or null for no Authorization header
     * @param requestTimeout the default whole-request timeout
     * @param executor the executor for HTTP work and callbacks, or null for an owned pool
     * @param writeTag the {@code Junjo-Write-Tag} sent on every request whose own headers carry
     *     none, or null for none; the caller has validated it
     */
    public Transport(
            String baseUrl,
            String apiKey,
            Duration connectTimeout,
            Duration requestTimeout,
            RetryPolicy retry,
            JunjoLogger logger,
            Executor executor,
            String userAgent,
            String writeTag) {
        String trimmed = Objects.requireNonNull(baseUrl, "baseUrl").trim();
        while (trimmed.endsWith("/")) trimmed = trimmed.substring(0, trimmed.length() - 1);
        URI parsed = URI.create(trimmed);
        if (parsed.getScheme() == null
                || !(parsed.getScheme().equals("http") || parsed.getScheme().equals("https"))) {
            throw new IllegalArgumentException("baseUrl must be an http or https URL");
        }
        this.baseUrl = trimmed;
        this.apiKey = apiKey;
        this.requestTimeout = Objects.requireNonNull(requestTimeout, "requestTimeout");
        this.retry = Objects.requireNonNull(retry, "retry");
        this.logger = logger == null ? JunjoLogger.NONE : logger;
        this.userAgent = userAgent;
        this.writeTag = writeTag;
        if (executor == null) {
            this.ownedExecutor = Executors.newCachedThreadPool(Threads.daemonFactory("junjo-http"));
            this.executor = ownedExecutor;
        } else {
            this.ownedExecutor = null;
            this.executor = executor;
        }
        this.timer = new ScheduledThreadPoolExecutor(1, Threads.daemonFactory("junjo-timer"));
        this.timer.setRemoveOnCancelPolicy(true);
        this.http = HttpClient.newBuilder()
                .connectTimeout(Objects.requireNonNull(connectTimeout, "connectTimeout"))
                .executor(this.executor)
                .followRedirects(HttpClient.Redirect.NEVER)
                .build();
    }

    /** The executor callbacks run on. */
    public Executor executor() {
        return executor;
    }

    /** The logger. */
    public JunjoLogger logger() {
        return logger;
    }

    /** Whether {@link #close()} has run. */
    public boolean isClosed() {
        return closed.get();
    }

    /**
     * Runs a task on the timer thread after a delay. The task must be quick; hand real work to
     * {@link #executor()}.
     */
    public ScheduledFuture<?> schedule(Runnable task, long delayMillis) {
        return timer.schedule(task, Math.max(0, delayMillis), TimeUnit.MILLISECONDS);
    }

    /**
     * Sends a request with the client's retry policy.
     *
     * @return the 2xx response; any other outcome completes exceptionally with JunjoException
     */
    public CompletableFuture<HttpResult> send(Call call) {
        return send(call, retry);
    }

    /**
     * Sends a request with an explicit retry policy. A call that is not {@link Call#retryable()}
     * gets one attempt regardless of the policy.
     *
     * @return the 2xx response; any other outcome completes exceptionally with JunjoException
     */
    public CompletableFuture<HttpResult> send(Call call, RetryPolicy policy) {
        return run(call, policy, false);
    }

    /**
     * Sends a request once and completes with the response whatever its status. Only a failure
     * without a response (network error, timeout, cancellation) completes exceptionally. For a
     * caller that needs the raw body of a refusal.
     */
    public CompletableFuture<HttpResult> exchange(Call call) {
        return run(call, RetryPolicy.none(), true);
    }

    private CompletableFuture<HttpResult> run(Call call, RetryPolicy policy, boolean anyStatus) {
        CompletableFuture<HttpResult> result = new CompletableFuture<>();
        if (closed.get()) {
            result.completeExceptionally(closedError());
            return result;
        }
        pending.add(result);
        AtomicReference<CompletableFuture<?>> current = new AtomicReference<>();
        AtomicReference<ScheduledFuture<?>> wait = new AtomicReference<>();
        result.whenComplete((r, e) -> {
            pending.remove(result);
            if (result.isCancelled()) {
                CompletableFuture<?> c = current.get();
                if (c != null) c.cancel(true);
                ScheduledFuture<?> w = wait.get();
                if (w != null) w.cancel(false);
            }
        });
        int attempts = call.retryable() ? policy.maxAttempts() : 1;
        attempt(call, policy, anyStatus, 1, attempts, result, current, wait);
        return result;
    }

    private void attempt(
            Call call,
            RetryPolicy policy,
            boolean anyStatus,
            int n,
            int maxAttempts,
            CompletableFuture<HttpResult> result,
            AtomicReference<CompletableFuture<?>> current,
            AtomicReference<ScheduledFuture<?>> wait) {
        if (result.isDone()) return;
        if (closed.get()) {
            result.completeExceptionally(closedError());
            return;
        }
        Duration timeout = call.timeout() != null ? call.timeout() : requestTimeout;
        HttpRequest request;
        try {
            request = buildRequest(call, timeout, "application/json");
        } catch (IllegalArgumentException e) {
            result.completeExceptionally(new JunjoException("bad_request", 0, "invalid request: " + e.getMessage(),
                    null, null, null, e));
            return;
        }
        AtomicBoolean timedOut = new AtomicBoolean();
        CompletableFuture<HttpResponse<byte[]>> sent;
        try {
            sent = http.sendAsync(request, HttpResponse.BodyHandlers.ofByteArray());
        } catch (RuntimeException e) {
            result.completeExceptionally(classify(e, false));
            return;
        }
        current.set(sent);
        ScheduledFuture<?> deadline = timer.schedule(() -> {
            timedOut.set(true);
            sent.cancel(true);
        }, Math.max(1, timeout.toMillis()), TimeUnit.MILLISECONDS);
        sent.whenComplete((resp, err) -> {
            deadline.cancel(false);
            if (result.isDone()) return;
            JunjoException failure;
            Long retryAfter = null;
            if (err != null) {
                failure = classify(err, timedOut.get());
                if (!failure.isTransportFailure()) {
                    result.completeExceptionally(failure);
                    return;
                }
            } else {
                HttpResult res = new HttpResult(resp.statusCode(), resp.body(), resp.headers());
                if (anyStatus || (res.status() >= 200 && res.status() < 300)) {
                    result.complete(res);
                    return;
                }
                failure = errorFrom(res.status(), res.bodyString(), res.headers(), null);
                if (!isRetryableStatus(failure)) {
                    result.completeExceptionally(failure);
                    return;
                }
                retryAfter = failure.retryAfterSeconds().isPresent()
                        ? failure.retryAfterSeconds().getAsLong()
                        : null;
            }
            if (n >= maxAttempts || closed.get()) {
                result.completeExceptionally(failure);
                return;
            }
            long delay;
            if (retryAfter != null) {
                if (retryAfter * 1000 > policy.maxRetryAfter().toMillis()) {
                    result.completeExceptionally(failure);
                    return;
                }
                delay = retryAfter * 1000;
            } else {
                delay = Backoff.fullJitterMillis(n - 1, policy.baseDelay(), policy.maxDelay());
            }
            Safe.debug(logger, () -> call.method() + " " + call.path() + " failed with " + failure.code()
                    + "; retry " + n + " in " + delay + " ms");
            try {
                wait.set(timer.schedule(
                        () -> executor.execute(
                                () -> attempt(call, policy, anyStatus, n + 1, maxAttempts, result, current, wait)),
                        delay,
                        TimeUnit.MILLISECONDS));
            } catch (RuntimeException rejected) {
                result.completeExceptionally(closed.get() ? closedError() : failure);
            }
        });
    }

    /**
     * Opens a streaming GET. The request timeout covers the response headers only; the body stays
     * open until the caller closes the returned stream. A non-2xx answer completes exceptionally
     * with the parsed error.
     */
    public CompletableFuture<HttpResponse<InputStream>> openStream(String path, Map<String, String> headers) {
        return openStream(path, headers, "text/event-stream");
    }

    /**
     * Opens a streaming GET with an explicit {@code Accept} type. Same contract as
     * {@link #openStream(String, Map)}.
     */
    public CompletableFuture<HttpResponse<InputStream>> openStream(
            String path, Map<String, String> headers, String accept) {
        CompletableFuture<HttpResponse<InputStream>> result = new CompletableFuture<>();
        if (closed.get()) {
            result.completeExceptionally(closedError());
            return result;
        }
        Call call = Call.get(path).withHeaders(headers);
        HttpRequest request = buildRequest(call, requestTimeout, accept);
        AtomicBoolean timedOut = new AtomicBoolean();
        CompletableFuture<HttpResponse<InputStream>> sent =
                http.sendAsync(request, HttpResponse.BodyHandlers.ofInputStream());
        ScheduledFuture<?> deadline = timer.schedule(() -> {
            timedOut.set(true);
            sent.cancel(true);
        }, Math.max(1, requestTimeout.toMillis()), TimeUnit.MILLISECONDS);
        pending.add(result);
        result.whenComplete((r, e) -> {
            pending.remove(result);
            if (result.isCancelled()) sent.cancel(true);
        });
        sent.whenComplete((resp, err) -> {
            deadline.cancel(false);
            if (err != null) {
                result.completeExceptionally(classify(err, timedOut.get()));
                return;
            }
            if (resp.statusCode() >= 200 && resp.statusCode() < 300) {
                if (!result.complete(resp)) closeQuietly(resp.body());
                return;
            }
            String body;
            try (InputStream in = resp.body()) {
                body = new String(in.readNBytes(MAX_ERROR_BODY_BYTES), StandardCharsets.UTF_8);
            } catch (IOException e) {
                body = "";
            }
            result.completeExceptionally(errorFrom(resp.statusCode(), body, resp.headers(), null));
        });
        return result;
    }

    private HttpRequest buildRequest(Call call, Duration timeout, String accept) {
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create(baseUrl + call.path()))
                .timeout(timeout);
        // The client-level tag first so a call's own tag replaces it, then caller headers so the
        // SDK-owned values below win.
        if (writeTag != null) b.setHeader(WRITE_TAG_HEADER, writeTag);
        for (Map.Entry<String, String> h : call.headers().entrySet()) {
            b.setHeader(h.getKey(), h.getValue());
        }
        b.setHeader("Accept", accept);
        if (userAgent != null) b.setHeader("User-Agent", userAgent);
        if (apiKey != null) b.setHeader("Authorization", "Bearer " + apiKey);
        if (call.body() != null) {
            b.setHeader("Content-Type", "application/json");
            b.method(call.method(), HttpRequest.BodyPublishers.ofString(call.body(), StandardCharsets.UTF_8));
        } else {
            b.method(call.method(), HttpRequest.BodyPublishers.noBody());
        }
        return b.build();
    }

    private static boolean isRetryableStatus(JunjoException e) {
        int s = e.status();
        if (s >= 500 || s == 408 || s == 429) return true;
        return s == 409 && "idempotency_key_in_progress".equals(e.code());
    }

    /**
     * Turns a failure from the HTTP client into the matching SDK error.
     *
     * @param timedOut whether the SDK's own deadline fired
     */
    public JunjoException classify(Throwable err, boolean timedOut) {
        Throwable t = unwrap(err);
        if (t instanceof JunjoException je) return je;
        if (timedOut) return new JunjoException(JunjoException.TIMEOUT, "request timed out", t);
        if (t instanceof HttpConnectTimeoutException) {
            return new JunjoException(JunjoException.TIMEOUT, "connect timed out", t);
        }
        if (t instanceof HttpTimeoutException) {
            return new JunjoException(JunjoException.TIMEOUT, "request timed out", t);
        }
        if (closed.get()) return closedError();
        if (t instanceof CancellationException) {
            return new JunjoException(JunjoException.CANCELLED, "request cancelled", t);
        }
        String detail = t.getMessage() == null ? t.getClass().getSimpleName() : t.getMessage();
        return new JunjoException(JunjoException.NETWORK_ERROR, "network error: " + detail, t);
    }

    /** Strips the wrappers CompletableFuture puts around a failure. */
    public static Throwable unwrap(Throwable err) {
        Throwable t = err;
        while ((t instanceof CompletionException || t instanceof ExecutionException) && t.getCause() != null) {
            t = t.getCause();
        }
        return t;
    }

    private static JunjoException closedError() {
        return new JunjoException(JunjoException.CANCELLED, "client closed", null);
    }

    /**
     * Builds the error for a non-2xx response. A body that is not the envelope yields code
     * {@code unknown} with the transport status, never a fabricated server code.
     *
     * @param cause the cause, or null
     */
    public static JunjoException errorFrom(int status, String body, HttpHeaders headers, Throwable cause) {
        JsonObject env = null;
        try {
            JsonElement el = com.google.gson.JsonParser.parseString(body == null ? "" : body);
            if (el.isJsonObject()) env = el.getAsJsonObject();
        } catch (RuntimeException ignored) {
            env = null;
        }
        String code = null;
        String message = null;
        String requestId = null;
        int envStatus = status;
        Map<String, Object> details = null;
        if (env != null) {
            code = stringField(env, "code");
            message = stringField(env, "message");
            requestId = stringField(env, "requestId");
            JsonElement s = env.get("status");
            if (s != null && s.isJsonPrimitive() && s.getAsJsonPrimitive().isNumber()) {
                envStatus = s.getAsInt();
            }
            JsonElement d = env.get("details");
            if (d != null && d.isJsonObject()) details = new LinkedHashMap<>(Json.toJavaMap(d.getAsJsonObject()));
        }
        if (requestId == null) requestId = headers.firstValue("x-request-id").orElse(null);
        Long retryAfter = parseRetryAfter(headers.firstValue("retry-after").orElse(null));
        if (message == null || message.isEmpty()) message = "request failed with HTTP " + status;
        return new JunjoException(
                code == null ? JunjoException.UNKNOWN : code,
                code == null ? status : envStatus,
                message,
                requestId,
                retryAfter,
                details,
                cause);
    }

    private static String stringField(JsonObject o, String name) {
        JsonElement el = o.get(name);
        return el != null && el.isJsonPrimitive() && el.getAsJsonPrimitive().isString() ? el.getAsString() : null;
    }

    /**
     * Parses {@code Retry-After}: delta seconds, or an HTTP date converted to seconds from now.
     *
     * @param raw the header value, or null
     * @return whole seconds, or null when absent or unparseable
     */
    public static Long parseRetryAfter(String raw) {
        if (raw == null) return null;
        String v = raw.trim();
        if (v.matches("\\d{1,9}")) return Long.parseLong(v);
        try {
            ZonedDateTime at = ZonedDateTime.parse(v, HTTP_DATE);
            long secs = Duration.between(ZonedDateTime.now(at.getZone()), at).toSeconds();
            return Math.max(0, secs);
        } catch (DateTimeParseException e) {
            return null;
        }
    }

    private static void closeQuietly(InputStream in) {
        try {
            in.close();
        } catch (IOException ignored) {
            // Nothing to recover.
        }
    }

    /**
     * Cancels pending calls (they fail with {@code cancelled}), stops the timer and the HTTP
     * client, and shuts down the owned executor. Idempotent.
     */
    @Override
    public void close() {
        if (!closed.compareAndSet(false, true)) return;
        for (CompletableFuture<?> f : pending.toArray(new CompletableFuture<?>[0])) {
            f.completeExceptionally(closedError());
        }
        pending.clear();
        timer.shutdownNow();
        http.shutdownNow();
        try {
            http.awaitTermination(Duration.ofSeconds(2));
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        if (ownedExecutor != null) ownedExecutor.shutdownNow();
    }
}
