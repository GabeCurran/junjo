package io.junjo.sdk.mirror;

/**
 * One change to the mirror's state, delivered to the {@code onChange} listener after the new
 * state is readable.
 *
 * @param userId the person concerned, as the mirror keys them, or null when the change is not
 *     about one person or covers everyone (a full reload)
 * @param groupId the group concerned, or null when the change is not about one group or covers
 *     every group (a full reload)
 */
public record MirrorChange(Kind kind, String userId, String groupId) {
    /** What changed. */
    public enum Kind {
        /** A tracked member's status, roles or overrides. */
        ACCESS,
        /** A game ban. */
        BAN,
        /** A sanction. */
        SANCTION,
        /** A group's role graph, including the group being deleted. */
        ROLE_GRAPH,
        /** A tracked member's display name. */
        DISPLAY_NAME
    }
}
