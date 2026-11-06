package io.junjo.sdk.model;

import java.util.List;
import java.util.Optional;

/**
 * A person's moderation state in the game: the game ban and the active sanctions.
 *
 * @param version the moderation version; 0 when the person was never moderated
 * @param ban the current ban, or null
 * @param sanctions the active sanctions, newest first
 */
public record Moderation(String userId, long version, Ban ban, List<Sanction> sanctions) {
    /** Copies the list. */
    public Moderation {
        sanctions = sanctions == null ? List.of() : List.copyOf(sanctions);
    }

    /** The current ban, when there is one. */
    public Optional<Ban> currentBan() {
        return Optional.ofNullable(ban);
    }
}
