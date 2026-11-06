package io.junjo.sdk.model;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;
import java.util.regex.Pattern;

/**
 * Body of a sanction create or replace. The type must match {@link #TYPE_PATTERN}; {@code ban} is
 * reserved for the ban API.
 */
public final class AddSanctionInput extends RequestBody {
    /** The sanction type syntax the server accepts. */
    public static final Pattern TYPE_PATTERN = Pattern.compile("^[a-z0-9][a-z0-9_.-]{0,31}$");

    private AddSanctionInput(Map<String, Object> fields) {
        super(fields);
    }

    /** @throws IllegalArgumentException when the type is malformed or reserved */
    public static Builder builder(String userId, String type) {
        return new Builder(userId, type);
    }

    public String userId() {
        return (String) fields().get("userId");
    }

    public String type() {
        return (String) fields().get("type");
    }

    /** Whether the server accepts {@code type} as a sanction type. */
    public static boolean isValidType(String type) {
        return type != null && TYPE_PATTERN.matcher(type).matches() && !type.equals("ban");
    }

    /** Builds an {@link AddSanctionInput}. */
    public static final class Builder {
        private final Map<String, Object> f = new LinkedHashMap<>();

        private Builder(String userId, String type) {
            if (!isValidType(type)) throw new IllegalArgumentException("invalid or reserved sanction type: " + type);
            f.put("userId", Objects.requireNonNull(userId, "userId"));
            f.put("type", type);
        }

        /** Up to 500 characters, or null. */
        public Builder reason(String reason) {
            f.put("reason", reason);
            return this;
        }

        /** Null for permanent; a past value creates a sanction already expired. */
        public Builder expiresAt(Instant expiresAt) {
            f.put("expiresAt", expiresAt == null ? null : expiresAt.toString());
            return this;
        }

        /** May lie in the past; at most 60 s ahead of the server. Default: the time of the call. */
        public Builder startedAt(Instant startedAt) {
            f.put("startedAt", Objects.requireNonNull(startedAt, "startedAt").toString());
            return this;
        }

        /** Free text, 1 to 128 characters, recorded verbatim and never resolved to a user. */
        public Builder issuer(String issuer) {
            f.put("issuer", Objects.requireNonNull(issuer, "issuer"));
            return this;
        }

        /** The person issuing it; surfaces as {@link Sanction#issuedBy()}. */
        public Builder actorUserId(String actorUserId) {
            f.put("actorUserId", Objects.requireNonNull(actorUserId, "actorUserId"));
            return this;
        }

        public AddSanctionInput build() {
            return new AddSanctionInput(f);
        }
    }
}
