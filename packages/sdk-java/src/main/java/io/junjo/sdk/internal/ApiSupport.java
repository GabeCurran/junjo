package io.junjo.sdk.internal;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import io.junjo.sdk.JunjoException;
import io.junjo.sdk.JunjoResponse;
import io.junjo.sdk.WriteOptions;
import io.junjo.sdk.model.Page;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.function.Function;

/**
 * Request plumbing shared by the API namespaces: send, then decode, with every decoding failure
 * surfacing as {@link JunjoException}.
 *
 * <p>Internal: not part of the supported API.
 */
public final class ApiSupport {
    private final Transport transport;

    public ApiSupport(Transport transport) {
        this.transport = transport;
    }

    public Transport transport() {
        return transport;
    }

    /** GET returning a decoded object. */
    public <T> CompletableFuture<T> get(String path, Function<JsonObject, T> decode) {
        return transport.send(Call.get(path)).thenApply(r -> decode.apply(Json.parseObject(r.bodyString())));
    }

    /** GET returning a decoded value with its stream position and ETag. */
    public <T> CompletableFuture<JunjoResponse<T>> getResponse(String path, Function<HttpResult, T> decode) {
        return transport.send(Call.get(path))
                .thenApply(r -> new JunjoResponse<>(decode.apply(r), r.streamPosition(), r.etag()));
    }

    /** GET of a page, with its stream position and ETag. */
    public <T> CompletableFuture<JunjoResponse<Page<T>>> getPage(
            String path, Function<JsonObject, T> item) {
        return getResponse(path, r -> Wire.page(Json.parseObject(r.bodyString()), item));
    }

    /** GET where {@code 404 not_found} means "absent". */
    public <T> CompletableFuture<Optional<T>> getOptional(String path, Function<JsonObject, T> decode) {
        return transport.send(Call.get(path))
                .handle((r, err) -> {
                    if (err != null) {
                        Throwable t = Transport.unwrap(err);
                        if (t instanceof JunjoException je && "not_found".equals(je.code())) return Optional.<T>empty();
                        throw t instanceof RuntimeException re ? re : new CompletionException(t);
                    }
                    return Optional.of(decode.apply(Json.parseObject(r.bodyString())));
                });
    }

    /** A write returning a decoded object. */
    public <T> CompletableFuture<T> write(Route route, WriteOptions opts, Function<JsonObject, T> decode) {
        return transport.send(call(route, opts)).thenApply(r -> decode.apply(Json.parseObject(r.bodyString())));
    }

    /** A write whose response body is ignored. */
    public CompletableFuture<Void> writeVoid(Route route, WriteOptions opts) {
        return transport.send(call(route, opts)).thenApply(r -> null);
    }

    /** A read-only POST returning the raw result. */
    public CompletableFuture<HttpResult> readPost(String path, Object body) {
        return transport.send(Call.readPost(path, encode(body)));
    }

    private static Call call(Route route, WriteOptions opts) {
        return Call.write(route.method(), route.path(), encode(route.body()), opts);
    }

    /** Encodes a body: null stays absent, everything else becomes JSON. */
    public static String encode(Object body) {
        if (body == null) return null;
        JsonElement el = Json.toJson(body);
        return Json.GSON.toJson(el);
    }
}
