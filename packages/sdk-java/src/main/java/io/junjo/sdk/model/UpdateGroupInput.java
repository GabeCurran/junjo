package io.junjo.sdk.model;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Body of a group update. Only the fields set on the builder are sent. The actor attributes the
 * change and is not a change itself, so an update must set at least one other field.
 */
public final class UpdateGroupInput extends RequestBody {
    private UpdateGroupInput(Map<String, Object> fields) {
        super(fields);
    }

    public static Builder builder() {
        return new Builder();
    }

    /** Builds an {@link UpdateGroupInput}. */
    public static final class Builder {
        private final Map<String, Object> f = new LinkedHashMap<>();

        private Builder() {}

        /** The new name, unique per game. */
        public Builder name(String name) {
            f.put("name", name);
            return this;
        }

        /** {@code public}, {@code invite-only} or {@code secret}. */
        public Builder visibility(String visibility) {
            f.put("visibility", visibility);
            return this;
        }

        /** Replaces the whole metadata object. */
        public Builder metadata(Map<String, ?> metadata) {
            f.put("metadata", metadata);
            return this;
        }

        /** Null clears the default role. */
        public Builder defaultRoleId(String roleId) {
            f.put("defaultRoleId", roleId);
            return this;
        }

        /** Sets or replaces the passcode; null clears it. */
        public Builder passcode(String passcode) {
            f.put("passcode", passcode);
            return this;
        }

        /** The acting user, recorded in audit and on the {@code group.updated} event. */
        public Builder actorUserId(String userId) {
            f.put("actorUserId", userId);
            return this;
        }

        /** @throws IllegalStateException when no field other than the actor is set */
        public UpdateGroupInput build() {
            if (f.isEmpty() || (f.size() == 1 && f.containsKey("actorUserId"))) {
                throw new IllegalStateException("an update must set at least one field besides the actor");
            }
            return new UpdateGroupInput(f);
        }
    }
}
