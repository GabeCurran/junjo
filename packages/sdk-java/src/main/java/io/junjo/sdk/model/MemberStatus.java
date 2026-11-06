package io.junjo.sdk.model;

/** A member's state in a group. {@link #UNKNOWN} stands for a value newer than this SDK. */
public enum MemberStatus {
    /** A current member; the only status that exercises permissions. */
    ACTIVE("active"),
    /** Invited but not yet joined. */
    INVITED("invited"),
    /** Left on their own. */
    LEFT("left"),
    /** Removed by a moderator. */
    KICKED("kicked"),
    /** Banned from the group. */
    BANNED("banned"),
    /** A status this SDK version does not know. */
    UNKNOWN("unknown");

    private final String wire;

    MemberStatus(String wire) {
        this.wire = wire;
    }

    /** The wire spelling. */
    public String wire() {
        return wire;
    }

    public static MemberStatus fromWire(String value) {
        for (MemberStatus s : values()) {
            if (s.wire.equals(value)) return s;
        }
        return UNKNOWN;
    }
}
