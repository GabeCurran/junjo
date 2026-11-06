package io.junjo.sdk.model;

/**
 * Filters and paging for sanction lists. Null fields are not sent.
 *
 * @param type only this sanction type, or null for every type
 * @param limit the page size, or null for the server default
 * @param cursor the cursor from the previous page, or null
 */
public record ListSanctionsOptions(String type, Integer limit, String cursor) {
    /** Every type, first page. */
    public static ListSanctionsOptions defaults() {
        return new ListSanctionsOptions(null, null, null);
    }

    public ListSanctionsOptions withCursor(String next) {
        return new ListSanctionsOptions(type, limit, next);
    }
}
