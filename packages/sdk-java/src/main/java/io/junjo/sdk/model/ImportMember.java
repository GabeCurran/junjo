package io.junjo.sdk.model;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/**
 * One row of a bulk membership import. {@code roleIds}, {@code overrides} and {@code metadata}
 * replace the member's current value when set and leave it untouched when not set.
 */
public final class ImportMember extends RequestBody {
    private ImportMember(Map<String, Object> fields) {
        super(fields);
    }

    public static Builder builder(String userId) {
        return new Builder(userId);
    }

    /** Builds an {@link ImportMember}. */
    public static final class Builder {
        private final Map<String, Object> f = new LinkedHashMap<>();

        private Builder(String userId) {
            f.put("userId", Objects.requireNonNull(userId, "userId"));
        }

        /** The full set of directly held roles. */
        public Builder roleIds(List<String> roleIds) {
            f.put("roleIds", List.copyOf(roleIds));
            return this;
        }

        /**
         * The member's full override list, global and contextual. Each {@code (permission,
         * context)} pair may appear once.
         */
        public Builder overrides(List<PermissionEntry> overrides) {
            List<Map<String, Object>> out = new ArrayList<>();
            for (PermissionEntry e : overrides) {
                Map<String, Object> m = new LinkedHashMap<>();
                m.put("permission", e.permission());
                m.put("value", e.value());
                if (!e.context().isGlobal()) m.put("context", e.context().values());
                out.add(m);
            }
            f.put("overrides", out);
            return this;
        }

        public Builder metadata(Map<String, ?> metadata) {
            f.put("metadata", Objects.requireNonNull(metadata, "metadata"));
            return this;
        }

        public ImportMember build() {
            return new ImportMember(f);
        }
    }
}
