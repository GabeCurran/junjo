package io.junjo.sdk.internal;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.util.HexFormat;
import java.util.zip.CRC32;

/**
 * The durability primitives the write queue journal and the mirror snapshot share: checksummed
 * JSON lines, forced writes, and atomic file replacement.
 *
 * <p>Line format: eight lowercase hex digits of the CRC32 of the JSON text's UTF-8 bytes, one
 * space, the JSON text, LF. A line that starts with an opening brace has no checksum: journals written
 * before checksums existed contain only such lines, and they are still read (with JSON validation
 * only) so an upgrade replays them. Compaction rewrites them with checksums, so they do not
 * outlive the first open.
 *
 * <p>Replacement: the content goes to a sibling temporary file, which is forced, then moved over
 * the target with {@code ATOMIC_MOVE}, then the directory is forced so the rename itself is
 * durable. There is no fallback to a plain move: a non-atomic replace can leave neither file
 * complete after a crash, so the caller keeps the old file instead.
 *
 * <p>Internal: not part of the supported API.
 */
public final class DurableFiles {
    private static final int CRC_HEX_DIGITS = 8;

    private DurableFiles() {}

    /** Forces a channel to the device. A seam so tests can make a force fail. */
    @FunctionalInterface
    public interface Disk {
        Disk SYSTEM = channel -> channel.force(true);

        void force(FileChannel channel) throws IOException;
    }

    /** A line that carries a checksum which does not match its text. */
    public static final class ChecksumException extends RuntimeException {
        private static final long serialVersionUID = 1L;

        ChecksumException(String message) {
            super(message);
        }
    }

    /** The checksummed line for one JSON text, LF included. */
    public static String line(String json) {
        return crc(json) + " " + json + "\n";
    }

    /**
     * Validates and parses one line without its LF.
     *
     * @throws ChecksumException when the checksum is missing or does not match
     * @throws RuntimeException when the text is not a JSON object
     */
    public static JsonObject parseLine(String line) {
        String json;
        if (line.startsWith("{")) {
            json = line;
        } else {
            if (line.length() < CRC_HEX_DIGITS + 1 || line.charAt(CRC_HEX_DIGITS) != ' ') {
                throw new ChecksumException("line has no checksum");
            }
            json = line.substring(CRC_HEX_DIGITS + 1);
            if (!crc(json).equals(line.substring(0, CRC_HEX_DIGITS))) {
                throw new ChecksumException("line checksum does not match");
            }
        }
        JsonElement el = JsonParser.parseString(json);
        if (!el.isJsonObject()) throw new IllegalStateException("line is not a JSON object");
        return el.getAsJsonObject();
    }

    public static void writeFully(FileChannel channel, String text) throws IOException {
        ByteBuffer buf = ByteBuffer.wrap(text.getBytes(StandardCharsets.UTF_8));
        while (buf.hasRemaining()) channel.write(buf);
    }

    /**
     * Replaces {@code target} with {@code content} atomically and durably.
     *
     * @throws IOException when any step fails, including a file system that cannot move
     *     atomically; {@code target} is then unchanged and the temporary file is removed
     */
    public static void replaceAtomically(Path target, byte[] content, Disk disk) throws IOException {
        Path tmp = target.resolveSibling(target.getFileName() + ".tmp");
        try {
            try (FileChannel out = FileChannel.open(tmp, StandardOpenOption.CREATE, StandardOpenOption.WRITE,
                    StandardOpenOption.TRUNCATE_EXISTING)) {
                ByteBuffer buf = ByteBuffer.wrap(content);
                while (buf.hasRemaining()) out.write(buf);
                disk.force(out);
            }
            Files.move(tmp, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        } catch (AtomicMoveNotSupportedException e) {
            Files.deleteIfExists(tmp);
            throw new IOException("the file system cannot replace " + target + " atomically", e);
        } catch (IOException e) {
            try {
                Files.deleteIfExists(tmp);
            } catch (IOException cleanup) {
                e.addSuppressed(cleanup);
            }
            throw e;
        }
        forceDirectory(target.toAbsolutePath().getParent());
    }

    /**
     * Forces a directory so a rename inside it survives a crash. Some platforms, Windows among
     * them, cannot open a directory as a channel and offer no other way to force one from Java,
     * so that failure is ignored.
     */
    public static void forceDirectory(Path dir) {
        if (dir == null) return;
        try (FileChannel d = FileChannel.open(dir, StandardOpenOption.READ)) {
            d.force(true);
        } catch (IOException ignored) {
            // See the method comment.
        }
    }

    private static String crc(String json) {
        CRC32 c = new CRC32();
        c.update(json.getBytes(StandardCharsets.UTF_8));
        return HexFormat.of().toHexDigits((int) c.getValue());
    }
}
