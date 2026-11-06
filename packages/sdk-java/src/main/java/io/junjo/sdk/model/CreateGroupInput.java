package io.junjo.sdk.model;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;

/** Body of a group create. */
public final class CreateGroupInput extends RequestBody {
    private CreateGroupInput(Map<String, Object> fields) {
        super(fields);
    }

    /**
     * @param name the name, unique per game
     */
    public static Builder builder(String kind, String name) {
        return new Builder(kind, name);
    }

    /** Builds a {@link CreateGroupInput}. */
    public static final class Builder {
        private final Map<String, Object> f = new LinkedHashMap<>();

        private Builder(String kind, String name) {
            f.put("kind", Objects.requireNonNull(kind, "kind"));
            f.put("name", Objects.requireNonNull(name, "name"));
        }

        /** {@code public}, {@code invite-only} or {@code secret}. */
        public Builder visibility(String visibility) {
            f.put("visibility", visibility);
            return this;
        }

        public Builder metadata(Map<String, ?> metadata) {
            f.put("metadata", metadata);
            return this;
        }

        public Builder defaultRoleId(String roleId) {
            f.put("defaultRoleId", roleId);
            return this;
        }

        /** A creator added as an active member in the same write. */
        public Builder creatorUserId(String userId) {
            f.put("creatorUserId", userId);
            return this;
        }

        public Builder passcode(String passcode) {
            f.put("passcode", passcode);
            return this;
        }

        public CreateGroupInput build() {
            return new CreateGroupInput(f);
        }
    }
}
