package io.junjo.sdk.model;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;

/**
 * Body of a game ban create or replace.
 */
public final class CreateBanInput extends RequestBody {
    private CreateBanInput(Map<String, Object> fields) {
        super(fields);
    }

    public static Builder builder(String userId) {
        return new Builder(userId);
    }

    /** The banned id. */
    public String userId() {
        return (String) fields().get("userId");
    }

    /** Builds a {@link CreateBanInput}. */
    public static final class Builder {
        private final Map<String, Object> f = new LinkedHashMap<>();

        private Builder(String userId) {
            f.put("userId", Objects.requireNonNull(userId, "userId"));
        }

        /** Null for none. */
        public Builder reason(String reason) {
            f.put("reason", reason);
            return this;
        }

        /** Null for permanent. */
        public Builder expiresAt(Instant expiresAt) {
            f.put("expiresAt", expiresAt == null ? null : expiresAt.toString());
            return this;
        }

        /** When the ban started, for a ban carried over from another system; at most 60 s in the future. */
        public Builder bannedAt(Instant bannedAt) {
            f.put("bannedAt", Objects.requireNonNull(bannedAt, "bannedAt").toString());
            return this;
        }

        /** Free text, 1 to 128 characters, recorded verbatim and never resolved to a user. */
        public Builder issuer(String issuer) {
            f.put("issuer", Objects.requireNonNull(issuer, "issuer"));
            return this;
        }

        /** The acting moderator; surfaces as {@code Ban.bannedBy}. */
        public Builder actorUserId(String actorUserId) {
            f.put("actorUserId", Objects.requireNonNull(actorUserId, "actorUserId"));
            return this;
        }

        public CreateBanInput build() {
            return new CreateBanInput(f);
        }
    }
}
