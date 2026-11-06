package io.junjo.sdk.internal;

import io.junjo.sdk.JunjoException;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

/**
 * An incremental Server-Sent Events reader over a blocking stream.
 *
 * <p>Lines end in LF, CRLF or a lone CR. A blank line ends a frame. Comment lines (starting with
 * {@code :}) are ignored, so a heartbeat with an {@code id:} line yields a frame carrying only an
 * id, while a heartbeat that is only a comment yields nothing. Multiple {@code data:} lines join
 * with LF. One optional space after the field colon is stripped, as the SSE specification says.
 *
 * <p>A frame larger than the configured cap fails with {@link JunjoException} code
 * {@code invalid_wire_data}, so a broken or hostile stream cannot grow memory without bound.
 *
 * <p>Internal: not part of the supported API.
 */
public final class SseReader {
    private final InputStream in;
    private final int maxFrameBytes;
    private final byte[] buf = new byte[8192];
    private int pos;
    private int len;
    private boolean pendingCr;
    private int frameBytes;

    /**
     * One parsed frame. Any field is null when its line was absent.
     *
     * @param data the {@code data:} lines joined with LF
     */
    public record Frame(String event, String data, String id) {}

    /** The reader never closes {@code in}. */
    public SseReader(InputStream in, int maxFrameBytes) {
        this.in = in;
        this.maxFrameBytes = maxFrameBytes;
    }

    /**
     * Blocks until the next non-empty frame. Returns null at end of stream; a partial trailing
     * frame is discarded.
     */
    public Frame next() throws IOException {
        String event = null;
        StringBuilder data = null;
        String id = null;
        boolean any = false;
        frameBytes = 0;
        while (true) {
            String line = readLine();
            if (line == null) return null;
            if (line.isEmpty()) {
                if (any) return new Frame(event, data == null ? null : data.toString(), id);
                frameBytes = 0;
                continue;
            }
            if (line.startsWith(":")) continue;
            int colon = line.indexOf(':');
            String field = colon < 0 ? line : line.substring(0, colon);
            String value = colon < 0 ? "" : line.substring(colon + 1);
            if (value.startsWith(" ")) value = value.substring(1);
            switch (field) {
                case "event" -> {
                    event = value;
                    any = true;
                }
                case "data" -> {
                    if (data == null) data = new StringBuilder(value);
                    else data.append('\n').append(value);
                    any = true;
                }
                case "id" -> {
                    // An id containing NUL is ignored, as the SSE specification requires.
                    if (value.indexOf('\0') < 0) {
                        id = value;
                        any = true;
                    }
                }
                default -> {
                    // retry and unknown fields carry nothing this client uses.
                }
            }
        }
    }

    private String readLine() throws IOException {
        ByteArrayOutputStream line = new ByteArrayOutputStream(128);
        while (true) {
            if (pos >= len) {
                len = in.read(buf);
                pos = 0;
                if (len < 0) {
                    len = 0;
                    return null;
                }
                continue;
            }
            byte b = buf[pos++];
            if (pendingCr) {
                pendingCr = false;
                if (b == '\n') continue;
            }
            if (b == '\n') return line.toString(StandardCharsets.UTF_8);
            if (b == '\r') {
                pendingCr = true;
                return line.toString(StandardCharsets.UTF_8);
            }
            line.write(b);
            if (++frameBytes > maxFrameBytes) {
                throw new JunjoException(
                        JunjoException.INVALID_WIRE_DATA,
                        "SSE frame exceeded " + maxFrameBytes + " bytes without a delimiter",
                        null);
            }
        }
    }
}
