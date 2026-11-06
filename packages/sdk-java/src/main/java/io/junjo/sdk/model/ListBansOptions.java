package io.junjo.sdk.model;

/**
 * Paging for the game ban list. Null fields are not sent.
 *
 * @param limit the page size, or null for the server default
 * @param cursor the cursor from the previous page, or null
 */
public record ListBansOptions(Integer limit, String cursor, boolean includeExpired) {
    /** Active bans, first page. */
    public static ListBansOptions defaults() {
        return new ListBansOptions(null, null, false);
    }

    public ListBansOptions withCursor(String next) {
        return new ListBansOptions(limit, next, includeExpired);
    }
}
