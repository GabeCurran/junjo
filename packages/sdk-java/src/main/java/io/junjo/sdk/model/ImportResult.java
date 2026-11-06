package io.junjo.sdk.model;

import java.util.List;

/**
 * The outcome of a bulk membership import.
 *
 * @param items one entry per row, in request order
 */
public record ImportResult(long created, long reactivated, long updated, long unchanged, List<Item> items) {
    /** Copies the list. */
    public ImportResult {
        items = List.copyOf(items);
    }

    /**
     * One row's outcome.
     *
     * @param status {@code created}, {@code reactivated}, {@code updated} or {@code unchanged}
     * @param version the member version after the import
     */
    public record Item(String userId, String status, long version) {}
}
