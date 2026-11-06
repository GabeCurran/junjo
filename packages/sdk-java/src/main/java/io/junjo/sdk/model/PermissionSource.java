package io.junjo.sdk.model;

/** What decided a permission check. {@link #UNKNOWN} stands for a value newer than this SDK. */
public enum PermissionSource {
    /** A role entry decided. */
    ROLE("role"),
    /** The member's own override decided. */
    OVERRIDE("override"),
    /** An active member with nothing matching: denied. */
    DEFAULT("default"),
    /** Not an active member of the group: denied. */
    NONE("none"),
    /** A source this SDK version does not know. */
    UNKNOWN("unknown");

    private final String wire;

    PermissionSource(String wire) {
        this.wire = wire;
    }

    /** The wire spelling. */
    public String wire() {
        return wire;
    }

    public static PermissionSource fromWire(String value) {
        for (PermissionSource s : values()) {
            if (s.wire.equals(value)) return s;
        }
        return UNKNOWN;
    }
}
