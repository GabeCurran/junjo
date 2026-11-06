package io.junjo.sdk.model;

import java.util.List;

/**
 * Filters and paging for a member list. Null fields are not sent.
 *
 * @param limit the page size (1 to 100), or null for the server default
 * @param cursor the cursor from the previous page, or null
 * @param statuses only these statuses, or null or empty for every status
 */
public record ListMembersOptions(Integer limit, String cursor, List<MemberStatus> statuses) {
    /** Copies the status list. */
    public ListMembersOptions {
        statuses = statuses == null ? List.of() : List.copyOf(statuses);
    }

    /** Every status, first page. */
    public static ListMembersOptions defaults() {
        return new ListMembersOptions(null, null, null);
    }

    public ListMembersOptions withCursor(String next) {
        return new ListMembersOptions(limit, next, statuses);
    }
}
