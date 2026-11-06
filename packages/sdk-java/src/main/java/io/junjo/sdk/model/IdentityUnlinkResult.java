package io.junjo.sdk.model;

import java.util.List;

/**
 * The person after an unlink.
 *
 * @param unlinkedUserId the id that left; it now names a new, empty person
 * @param identities the ids the person still holds, earliest first
 */
public record IdentityUnlinkResult(String userId, String unlinkedUserId, List<LinkedIdentity> identities) {
    /** Copies the list. */
    public IdentityUnlinkResult {
        identities = List.copyOf(identities);
    }
}
