package io.junjo.sdk.model;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;

/** Body of a role create. Entries and parents are set with their own calls. */
public final class CreateRoleInput extends RequestBody {
    private CreateRoleInput(Map<String, Object> fields) {
        super(fields);
    }

    public static Builder builder(String name, long priority) {
        return new Builder(name, priority);
    }

    /** Builds a {@link CreateRoleInput}. */
    public static final class Builder {
        private final Map<String, Object> f = new LinkedHashMap<>();

        private Builder(String name, long priority) {
            f.put("name", Objects.requireNonNull(name, "name"));
            f.put("priority", priority);
        }

        public Builder color(String color) {
            f.put("color", color);
            return this;
        }

        /** Whether new members receive the role. */
        public Builder isDefault(boolean isDefault) {
            f.put("isDefault", isDefault);
            return this;
        }

        public Builder metadata(Map<String, ?> metadata) {
            f.put("metadata", metadata);
            return this;
        }

        public CreateRoleInput build() {
            return new CreateRoleInput(f);
        }
    }
}
