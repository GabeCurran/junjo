package io.junjo.sdk;

import io.junjo.sdk.internal.ApiSupport;
import io.junjo.sdk.internal.Paths;
import io.junjo.sdk.internal.Routes;
import io.junjo.sdk.internal.Wire;
import io.junjo.sdk.model.Invitation;
import io.junjo.sdk.model.ListInvitationsOptions;
import io.junjo.sdk.model.Page;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;

/**
 * Invitations: list a group's invitations, look one up by code, and revoke one. Creating,
 * accepting and declining live on {@link GroupsApi}.
 */
public final class InvitationsApi {
    private final ApiSupport api;

    InvitationsApi(ApiSupport api) {
        this.api = api;
    }

    /**
     * Lists a group's invitations, newest first. Used and expired invitations are left out unless
     * the options include them. {@code opts} may be null.
     */
    public CompletableFuture<JunjoResponse<Page<Invitation>>> list(String groupId, ListInvitationsOptions opts) {
        ListInvitationsOptions o = opts == null ? ListInvitationsOptions.defaults() : opts;
        String path = new Paths.Query()
                .add("limit", o.limit())
                .add("cursor", o.cursor())
                .add("includeExpired", o.includeExpired() ? "true" : null)
                .add("includeUsed", o.includeUsed() ? "true" : null)
                .appendTo(Routes.group(groupId) + "/invitations");
        return api.getPage(path, Wire::invitation);
    }

    /** Empty when no invitation has this code. */
    public CompletableFuture<Optional<Invitation>> get(String code) {
        return api.getOptional(Routes.invitation(code), Wire::invitation);
    }

    /** Same as {@link #revoke(String, WriteOptions)} with default options. */
    public CompletableFuture<Void> revoke(String code) {
        return revoke(code, WriteOptions.none());
    }

    /** Deletes an invitation so its code can no longer be redeemed. */
    public CompletableFuture<Void> revoke(String code, WriteOptions opts) {
        return api.writeVoid(Routes.revokeInvitation(code), opts);
    }
}
