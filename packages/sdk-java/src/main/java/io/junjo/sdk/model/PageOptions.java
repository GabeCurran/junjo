package io.junjo.sdk.model;

/**
 * Paging for a list without filters. Null fields are not sent.
 *
 * @param limit the page size, or null for the server default
 * @param cursor the cursor from the previous page, or null
 */
public record PageOptions(Integer limit, String cursor) {
    /** First page, server default size. */
    public static PageOptions defaults() {
        return new PageOptions(null, null);
    }

    public PageOptions withCursor(String next) {
        return new PageOptions(limit, next);
    }
}
