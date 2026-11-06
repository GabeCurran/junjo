package io.junjo.sdk.model;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/**
 * Body of a bulk membership import: 1 to 500 rows with unique user ids, applied in one
 * all-or-nothing transaction.
 */
public final class MemberImport extends RequestBody {
    /** The most rows one import accepts. */
    public static final int MAX_ROWS = 500;

    private MemberImport(Map<String, Object> fields) {
        super(fields);
    }

    public static Builder builder() {
        return new Builder();
    }

    /** Builds a {@link MemberImport}. */
    public static final class Builder {
        private final List<Map<String, Object>> rows = new ArrayList<>();
        private Boolean allowBanned;
        private String actorUserId;

        private Builder() {}

        public Builder add(ImportMember row) {
            rows.add(Objects.requireNonNull(row, "row").fields());
            return this;
        }

        public Builder addAll(List<ImportMember> rows) {
            for (ImportMember r : rows) add(r);
            return this;
        }

        /** Imports banned people's state without lifting their bans. */
        public Builder allowBanned(boolean allow) {
            this.allowBanned = allow;
            return this;
        }

        public Builder actorUserId(String actorUserId) {
            this.actorUserId = actorUserId;
            return this;
        }

        public MemberImport build() {
            if (rows.isEmpty() || rows.size() > MAX_ROWS) {
                throw new IllegalStateException("an import carries 1 to " + MAX_ROWS + " rows");
            }
            Map<String, Object> f = new LinkedHashMap<>();
            f.put("members", List.copyOf(rows));
            if (allowBanned != null) f.put("allowBanned", allowBanned);
            if (actorUserId != null) f.put("actorUserId", actorUserId);
            return new MemberImport(f);
        }
    }
}
