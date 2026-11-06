package io.junjo.sdk.model;

import java.util.List;

/**
 * The person after a link.
 *
 * @param identities every id the person now holds, earliest first
 */
public record IdentityLinkResult(String userId, String linkedUserId, List<LinkedIdentity> identities) {
    /** Copies the list. */
    public IdentityLinkResult {
        identities = List.copyOf(identities);
    }
}
