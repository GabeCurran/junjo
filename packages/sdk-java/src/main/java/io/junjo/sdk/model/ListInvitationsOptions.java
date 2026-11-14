package io.junjo.sdk.model;

/**
 * Filters and paging for a group's invitation list. Null fields are not sent.
 *
 * @param limit the page size, or null for the server default
 * @param cursor the cursor from the previous page, or null
 * @param includeExpired also list expired invitations
 * @param includeUsed also list used invitations
 */
public record ListInvitationsOptions(Integer limit, String cursor, boolean includeExpired, boolean includeUsed) {
    /** Unused, unexpired invitations, first page. */
    public static ListInvitationsOptions defaults() {
        return new ListInvitationsOptions(null, null, false, false);
    }

    public ListInvitationsOptions withCursor(String next) {
        return new ListInvitationsOptions(limit, next, includeExpired, includeUsed);
    }
}
