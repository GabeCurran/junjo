package io.junjo.sdk.export;

import java.util.List;

/**
 * What an export carries. The header, {@code game} and {@code end} records are always sent.
 *
 * @param records the record kinds to export, without {@code game}, or null for every kind; the
 *     server refuses an unknown kind with {@code bad_request}
 * @param groupKinds keeps the group-scoped records (groups, roles, members, invitations,
 *     relationships by their A side, and the group rows of ban history and audit) of groups of
 *     these kinds only, or null for every group; game-scoped records are not affected, leave them
 *     out with {@code records}
 */
public record ExportOptions(List<String> records, List<String> groupKinds) {
    /**
     * Copies the lists.
     *
     * @throws IllegalArgumentException when a list is empty, or an entry is empty or contains a
     *     comma
     */
    public ExportOptions {
        records = checked(records, "records");
        groupKinds = checked(groupKinds, "groupKinds");
    }

    /** Every record kind of every group. */
    public static ExportOptions all() {
        return new ExportOptions(null, null);
    }

    public ExportOptions withRecords(List<String> kinds) {
        return new ExportOptions(kinds, groupKinds);
    }

    public ExportOptions withGroupKinds(List<String> kinds) {
        return new ExportOptions(records, kinds);
    }

    // The query sends each list comma-joined, so an entry with a comma would split into two.
    private static List<String> checked(List<String> values, String name) {
        if (values == null) return null;
        List<String> copy = List.copyOf(values);
        if (copy.isEmpty()) throw new IllegalArgumentException(name + " must name at least one entry, or be null");
        for (String v : copy) {
            if (v.isEmpty() || v.indexOf(',') >= 0) {
                throw new IllegalArgumentException(name + " entries must be non-empty and contain no comma");
            }
        }
        return copy;
    }
}
