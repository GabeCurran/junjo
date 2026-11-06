package io.junjo.sdk.model;

/**
 * How a game's permission keys are matched. In {@link #EXACT} mode keys are opaque and
 * case-sensitive. In {@link #NODES} mode keys are dot-separated and folded to lowercase, a final
 * {@code .*} segment matches one or more further segments, and a bare {@code *} matches every key.
 */
public enum PermissionMode {
    /** Opaque, case-sensitive keys. */
    EXACT("exact"),
    /** Dot-separated, case-insensitive keys with trailing wildcards. */
    NODES("nodes");

    private final String wire;

    PermissionMode(String wire) {
        this.wire = wire;
    }

    /** The wire spelling. */
    public String wire() {
        return wire;
    }

    /**
     * @throws IllegalArgumentException for an unknown spelling
     */
    public static PermissionMode fromWire(String value) {
        for (PermissionMode m : values()) {
            if (m.wire.equals(value)) return m;
        }
        throw new IllegalArgumentException("unknown permission mode: " + value);
    }
}
