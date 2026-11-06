package io.junjo.sdk.export;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParseException;
import com.google.gson.JsonParser;
import io.junjo.sdk.JunjoException;
import io.junjo.sdk.internal.Json;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.Reader;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.NoSuchElementException;

/**
 * A blocking, forward-only reader over an export body, one record per line. The body is read as it
 * arrives; nothing beyond the current line is buffered.
 *
 * <p>Validation: the first record must be a {@code header} of format {@code junjo-export} version
 * 1; the last must be an {@code end} record whose {@code counts} equal the number of records read
 * per kind. A body that ends without the end record (a cut-short export) fails with
 * {@link JunjoException} code {@code invalid_wire_data}, as do malformed lines, mismatched counts
 * and records after the end. The header and end records are yielded like the others. A line
 * longer than {@link #MAX_LINE_CHARS} fails with {@code stream_overflow}: a real record is far
 * smaller, so the stream is broken and buffering further would grow memory without bound.
 *
 * <p>Not thread-safe. {@link #close()} releases the connection and may be called from another
 * thread to abort a read.
 */
public final class ExportReader implements Iterator<ExportRecord>, AutoCloseable {
    /** The only export format version this reader understands. */
    public static final int FORMAT_VERSION = 1;

    /** The cap on one line, in UTF-16 code units (16 Mi, about 16 MiB of ASCII). */
    public static final int MAX_LINE_CHARS = 16 * 1024 * 1024;

    private static final int READ_CHUNK_CHARS = 8192;

    private final Reader reader;
    private final InputStream body;
    private final Map<String, Long> tally = new LinkedHashMap<>();
    private final char[] chunk = new char[READ_CHUNK_CHARS];
    private int chunkPos;
    private int chunkLen;
    private ExportRecord next;
    private boolean sawEnd;
    private boolean finished;
    private ExportRecord header;
    private ExportSummary summary;

    /** Reads an export body, from the server or a saved file; {@link #close()} closes it. */
    public ExportReader(InputStream body) {
        this.body = body;
        this.reader = new InputStreamReader(body, StandardCharsets.UTF_8);
    }

    /**
     * Blocks until the next record is available or the body ends.
     *
     * @throws JunjoException with {@code invalid_wire_data} when the export is malformed or cut
     *     short, or {@code stream_overflow} when a line passes {@link #MAX_LINE_CHARS}
     * @throws UncheckedIOException when the connection fails
     */
    @Override
    public boolean hasNext() {
        if (next != null) return true;
        if (finished) return false;
        String line;
        try {
            do {
                line = readLine();
            } while (line != null && line.isBlank());
        } catch (IOException e) {
            finished = true;
            throw new UncheckedIOException("export stream failed", e);
        }
        if (line == null) {
            finished = true;
            if (!sawEnd) throw wire("export ended without its end record; discard it and export again");
            return false;
        }
        if (sawEnd) throw wire("export has records after its end record");
        next = parse(line);
        return true;
    }

    /** @throws NoSuchElementException after the last record */
    @Override
    public ExportRecord next() {
        if (!hasNext()) throw new NoSuchElementException();
        ExportRecord r = next;
        next = null;
        return r;
    }

    /** The header record once it has been read, else null. */
    public ExportRecord header() {
        return header;
    }

    /** The summary once the end record has been read and validated, else null. */
    public ExportSummary summary() {
        return summary;
    }

    private ExportRecord parse(String line) {
        JsonObject o;
        try {
            JsonElement el = JsonParser.parseString(line);
            if (!el.isJsonObject()) throw wire("export line is not a JSON object");
            o = el.getAsJsonObject();
        } catch (JsonParseException e) {
            throw wire("export line is not valid JSON");
        }
        String kind = Json.str(o, "kind");
        ExportRecord record = new ExportRecord(kind, Json.toJavaMap(o), line);
        if (header == null) {
            if (!kind.equals("header")) throw wire("export does not start with a header record");
            if (!"junjo-export".equals(Json.optStr(o, "format"))) throw wire("export header has an unknown format");
            long version = Json.optLong(o, "version", -1);
            if (version != FORMAT_VERSION) throw wire("export format version " + version + " is not supported");
            header = record;
            return record;
        }
        if (kind.equals("end")) {
            sawEnd = true;
            JsonObject counts = Json.obj(o, "counts");
            Map<String, Long> expected = new LinkedHashMap<>();
            for (String k : counts.keySet()) expected.put(k, Json.lng(counts, k));
            for (Map.Entry<String, Long> e : tally.entrySet()) {
                if (!e.getValue().equals(expected.getOrDefault(e.getKey(), 0L))) {
                    throw wire("export counted " + expected.getOrDefault(e.getKey(), 0L) + " " + e.getKey()
                            + " records but carried " + e.getValue());
                }
            }
            for (Map.Entry<String, Long> e : expected.entrySet()) {
                if (e.getValue() != 0 && !tally.containsKey(e.getKey())) {
                    throw wire("export counted " + e.getValue() + " " + e.getKey() + " records but carried none");
                }
            }
            JsonObject h = Json.parseObject(header.json());
            summary = new ExportSummary(
                    Json.optStr(h, "gameId"),
                    Json.optStr(h, "position"),
                    exportedAt(h),
                    Map.copyOf(expected));
            return record;
        }
        if (kind.equals("header")) throw wire("export has a second header record");
        tally.merge(kind, 1L, Long::sum);
        return record;
    }

    // One line without its terminator (LF or CRLF), or null at the end of the body. A final line
    // without a terminator still counts.
    private String readLine() throws IOException {
        StringBuilder line = new StringBuilder();
        boolean any = false;
        while (true) {
            if (chunkPos >= chunkLen) {
                chunkLen = reader.read(chunk);
                chunkPos = 0;
                if (chunkLen < 0) {
                    chunkLen = 0;
                    return any ? stripCr(line) : null;
                }
                continue;
            }
            any = true;
            char c = chunk[chunkPos++];
            if (c == '\n') return stripCr(line);
            line.append(c);
            if (line.length() > MAX_LINE_CHARS) {
                throw new JunjoException(JunjoException.STREAM_OVERFLOW,
                        "export line exceeded " + MAX_LINE_CHARS + " characters", null);
            }
        }
    }

    private static String stripCr(StringBuilder line) {
        int n = line.length();
        return n > 0 && line.charAt(n - 1) == '\r' ? line.substring(0, n - 1) : line.toString();
    }

    private static Instant exportedAt(JsonObject h) {
        return Json.optInstant(h, "exportedAt");
    }

    private static JunjoException wire(String message) {
        return new JunjoException(JunjoException.INVALID_WIRE_DATA, message, null);
    }

    /** Closes the body and the connection. Idempotent. */
    @Override
    public void close() {
        finished = true;
        try {
            body.close();
        } catch (IOException ignored) {
            // Nothing to recover.
        }
    }
}
