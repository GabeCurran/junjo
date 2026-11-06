package io.junjo.sdk.model;

import java.util.List;
import java.util.Optional;

/**
 * One page of a cursor-paginated list.
 *
 * @param nextCursor the cursor for the next page, or null on the last page
 * @param <T> the item type
 */
public record Page<T>(List<T> items, String nextCursor) {
    /** Copies the items. */
    public Page {
        items = List.copyOf(items);
    }

    /** The next cursor, empty on the last page. */
    public Optional<String> next() {
        return Optional.ofNullable(nextCursor);
    }

    /** Whether another page follows. */
    public boolean hasMore() {
        return nextCursor != null;
    }
}
