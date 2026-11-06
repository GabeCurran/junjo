package io.junjo.sdk;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/** A scripted HTTP server on the loopback interface for tests. Handlers run on a cached pool. */
public final class FakeServer implements AutoCloseable {
    /** One recorded request. */
    public record Req(String method, String path, String query, Map<String, List<String>> headers, String body) {
        public String header(String name) {
            for (Map.Entry<String, List<String>> e : headers.entrySet()) {
                if (e.getKey() != null && e.getKey().equalsIgnoreCase(name) && !e.getValue().isEmpty()) {
                    return e.getValue().get(0);
                }
            }
            return null;
        }

        public String pathAndQuery() {
            return query == null ? path : path + "?" + query;
        }
    }

    /** A route handler. */
    @FunctionalInterface
    public interface Handler {
        void handle(Req req, HttpExchange ex) throws Exception;
    }

    private record Route(String method, String path, boolean prefix, Handler handler) {}

    private final HttpServer server;
    private final ExecutorService pool = Executors.newCachedThreadPool(r -> {
        Thread t = new Thread(r, "fake-server");
        t.setDaemon(true);
        return t;
    });
    private final List<Route> routes = new CopyOnWriteArrayList<>();
    public final List<Req> requests = new CopyOnWriteArrayList<>();

    public FakeServer() throws IOException {
        server = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0);
        server.setExecutor(pool);
        server.createContext("/", this::dispatch);
        server.start();
    }

    public String baseUrl() {
        return "http://127.0.0.1:" + server.getAddress().getPort();
    }

    public FakeServer on(String method, String path, Handler handler) {
        routes.add(0, new Route(method, path, false, handler));
        return this;
    }

    public FakeServer onPrefix(String method, String prefix, Handler handler) {
        routes.add(0, new Route(method, prefix, true, handler));
        return this;
    }

    public List<Req> requests(String method, String path) {
        List<Req> out = new ArrayList<>();
        for (Req r : requests) if (r.method().equals(method) && r.path().equals(path)) out.add(r);
        return out;
    }

    private void dispatch(HttpExchange ex) throws IOException {
        String body = new String(ex.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
        Req req = new Req(
                ex.getRequestMethod(),
                ex.getRequestURI().getRawPath(),
                ex.getRequestURI().getRawQuery(),
                Map.copyOf(ex.getRequestHeaders()),
                body);
        requests.add(req);
        try {
            for (Route r : routes) {
                boolean match = r.prefix() ? req.path().startsWith(r.path()) : req.path().equals(r.path());
                if (match && r.method().equals(req.method())) {
                    r.handler().handle(req, ex);
                    return;
                }
            }
            json(ex, 404, "{\"code\":\"not_found\",\"status\":404,\"message\":\"no route\"}");
        } catch (Exception e) {
            try {
                json(ex, 599, "{\"code\":\"internal\",\"status\":599,\"message\":\"handler threw\"}");
            } catch (IOException | RuntimeException ignored) {
                // The exchange may already be committed.
            }
        } finally {
            ex.close();
        }
    }

    public static void json(HttpExchange ex, int status, String body) throws IOException {
        json(ex, status, body, Map.of());
    }

    public static void json(HttpExchange ex, int status, String body, Map<String, String> headers) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().set("Content-Type", "application/json");
        headers.forEach((k, v) -> ex.getResponseHeaders().set(k, v));
        if (status == 204) {
            ex.sendResponseHeaders(204, -1);
            return;
        }
        ex.sendResponseHeaders(status, bytes.length == 0 ? -1 : bytes.length);
        if (bytes.length > 0) {
            try (OutputStream out = ex.getResponseBody()) {
                out.write(bytes);
            }
        }
    }

    public static String error(String code, int status, String message) {
        return "{\"code\":\"" + code + "\",\"status\":" + status + ",\"message\":\"" + message + "\"}";
    }

    /** Opens an SSE response; the caller writes frames and returns to end it. */
    public static OutputStream openSse(HttpExchange ex, String position) throws IOException {
        ex.getResponseHeaders().set("Content-Type", "text/event-stream");
        if (position != null) ex.getResponseHeaders().set("Junjo-Stream-Position", position);
        ex.sendResponseHeaders(200, 0);
        OutputStream out = ex.getResponseBody();
        out.flush();
        return out;
    }

    public static void write(OutputStream out, String text) throws IOException {
        out.write(text.getBytes(StandardCharsets.UTF_8));
        out.flush();
    }

    @Override
    public void close() {
        server.stop(0);
        pool.shutdownNow();
        try {
            pool.awaitTermination(5, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
