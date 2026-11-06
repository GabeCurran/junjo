package io.junjo.sdk.model;

import java.util.LinkedHashMap;
import java.util.Map;

/** Body of a role update. Only the fields set on the builder are sent. */
public final class UpdateRoleInput extends RequestBody {
    private UpdateRoleInput(Map<String, Object> fields) {
        super(fields);
    }

    public static Builder builder() {
        return new Builder();
    }

    /** Builds an {@link UpdateRoleInput}. */
    public static final class Builder {
        private final Map<String, Object> f = new LinkedHashMap<>();

        private Builder() {}

        public Builder name(String name) {
            f.put("name", name);
            return this;
        }

        public Builder priority(long priority) {
            f.put("priority", priority);
            return this;
        }

        /** Null clears the color. */
        public Builder color(String color) {
            f.put("color", color);
            return this;
        }

        public Builder isDefault(boolean isDefault) {
            f.put("isDefault", isDefault);
            return this;
        }

        /** Replaces the whole metadata object. */
        public Builder metadata(Map<String, ?> metadata) {
            f.put("metadata", metadata);
            return this;
        }

        public UpdateRoleInput build() {
            if (f.isEmpty()) throw new IllegalStateException("an update must set at least one field");
            return new UpdateRoleInput(f);
        }
    }
}
