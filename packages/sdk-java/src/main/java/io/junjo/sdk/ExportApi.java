package io.junjo.sdk;

import io.junjo.sdk.export.ExportReader;
import io.junjo.sdk.export.ExportRecord;
import io.junjo.sdk.export.ExportSummary;
import io.junjo.sdk.internal.Threads;
import io.junjo.sdk.internal.Transport;
import java.io.UncheckedIOException;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.CompletableFuture;
import java.util.function.Consumer;

/**
 * The streaming game export ({@code GET /v1/export}), readable only with a key that has
 * {@code canExport}; other keys fail with {@code permission_denied}. The body is processed line by
 * line as it arrives and is never held in memory whole. The request timeout covers the response
 * headers only; a long export streams for as long as it needs.
 */
public final class ExportApi {
    private final Transport transport;

    ExportApi(Transport transport) {
        this.transport = transport;
    }

    /**
     * Opens the export. Completes once the server answered; iterating the reader then blocks on
     * the network, so iterate off any latency-sensitive thread and close the reader when done.
     */
    public CompletableFuture<ExportReader> open() {
        return transport.openStream("/v1/export", Map.of(), "application/x-ndjson")
                .thenApply(resp -> new ExportReader(resp.body()));
    }

    /**
     * Reads the whole export on a dedicated daemon thread, handing each record (header and end
     * included) to {@code consumer} in order. Completes with the summary once the end record was
     * read and its counts verified. Fails with {@code invalid_wire_data} when the export is cut
     * short or malformed, {@code stream_overflow} when a line passes
     * {@link ExportReader#MAX_LINE_CHARS}, {@code network_error} when the connection fails, or
     * with whatever the consumer throws. Records already handed to the consumer stay handed over,
     * so a consumer that persists them must discard its output on failure.
     */
    public CompletableFuture<ExportSummary> read(Consumer<ExportRecord> consumer) {
        Objects.requireNonNull(consumer, "consumer");
        CompletableFuture<ExportSummary> done = new CompletableFuture<>();
        open().whenComplete((reader, err) -> {
            if (err != null) {
                done.completeExceptionally(Transport.unwrap(err));
                return;
            }
            Threads.start("junjo-export", () -> {
                try (ExportReader r = reader) {
                    while (r.hasNext()) consumer.accept(r.next());
                    done.complete(r.summary());
                } catch (UncheckedIOException e) {
                    done.completeExceptionally(new JunjoException(
                            JunjoException.NETWORK_ERROR, "export stream failed: " + e.getCause().getMessage(), e));
                } catch (Throwable t) {
                    done.completeExceptionally(t);
                }
            });
        });
        return done;
    }
}
