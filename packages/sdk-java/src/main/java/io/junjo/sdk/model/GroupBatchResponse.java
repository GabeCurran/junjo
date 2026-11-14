package io.junjo.sdk.model;

import java.util.List;

/**
 * A group batch's answer.
 *
 * @param version the group's version after the batch, as a decimal string; also the ETag
 * @param results one result per op, in op order
 */
public record GroupBatchResponse(String version, List<GroupBatchResult> results) {
    /** Copies the results. */
    public GroupBatchResponse {
        results = List.copyOf(results);
    }

    /**
     * The result of op {@code index}.
     *
     * @throws IndexOutOfBoundsException when no op has that index
     */
    public GroupBatchResult result(int index) {
        return results.get(index);
    }
}
