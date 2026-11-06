package io.junjo.sdk.model;

/**
 * Filters and paging for a group list. Null fields are not sent.
 *
 * @param limit the page size, or null for the server default
 * @param cursor the cursor from the previous page, or null
 * @param kind only groups of this kind, or null
 * @param viewer scope visibility to this user, or null
 */
public record ListGroupsOptions(Integer limit, String cursor, String kind, String viewer) {
    /** No filters, first page. */
    public static ListGroupsOptions defaults() {
        return new ListGroupsOptions(null, null, null, null);
    }

    public ListGroupsOptions withCursor(String next) {
        return new ListGroupsOptions(limit, next, kind, viewer);
    }
}
