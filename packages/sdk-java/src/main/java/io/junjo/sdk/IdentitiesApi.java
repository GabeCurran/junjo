package io.junjo.sdk;

import io.junjo.sdk.internal.ApiSupport;
import io.junjo.sdk.internal.Json;
import io.junjo.sdk.internal.Paths;
import io.junjo.sdk.internal.Routes;
import io.junjo.sdk.internal.Wire;
import io.junjo.sdk.model.DisplayNameMatch;
import io.junjo.sdk.model.IdentityLinkResult;
import io.junjo.sdk.model.IdentityUnlinkResult;
import io.junjo.sdk.model.LinkCode;
import io.junjo.sdk.model.LinkedIdentity;
import java.util.List;
import java.util.concurrent.CompletableFuture;

/** Linked identities and display names: one person may hold several ids in a game. */
public final class IdentitiesApi {
    private final ApiSupport api;

    IdentitiesApi(ApiSupport api) {
        this.api = api;
    }

    /**
     * Every id held by the person {@code userId} belongs to, earliest first. An id the game has
     * never seen yields an empty list.
     */
    public CompletableFuture<JunjoResponse<List<LinkedIdentity>>> list(String userId) {
        return api.getResponse(Routes.user(userId) + "/identities",
                r -> Wire.list(Json.arr(Json.parseObject(r.bodyString()), "items"), "items", Wire::linkedIdentity));
    }

    /** Same as {@link #setDisplayName(String, String, WriteOptions)} with default options. */
    public CompletableFuture<LinkedIdentity> setDisplayName(String userId, String displayName) {
        return setDisplayName(userId, displayName, WriteOptions.none());
    }

    /**
     * Sets or clears the display name of exactly this id, never of the person's other ids. An
     * unchanged name writes nothing and emits no event.
     *
     * @param displayName 1 to 64 characters, or null to clear
     */
    public CompletableFuture<LinkedIdentity> setDisplayName(String userId, String displayName, WriteOptions opts) {
        return api.write(Routes.setDisplayName(userId, displayName), opts, Wire::linkedIdentity);
    }

    /**
     * Finds ids by display name: exact match ignoring case, most recently named first, at most 20.
     * Each match is the matching id itself, never another id of its person.
     *
     * @param name 1 to 64 characters
     * @param namespace only ids in this namespace, or null for every namespace
     */
    public CompletableFuture<List<DisplayNameMatch>> findByName(String name, String namespace) {
        String path = new Paths.Query()
                .add("name", name)
                .add("namespace", namespace)
                .appendTo("/v1/identities/by-name");
        return api.get(path, o -> Wire.list(Json.arr(o, "items"), "items", Wire::displayNameMatch));
    }

    /** Same as {@link #requestLinkCode(String, WriteOptions)} with default options. */
    public CompletableFuture<LinkCode> requestLinkCode(String userId) {
        return requestLinkCode(userId, WriteOptions.none());
    }

    /** Issues a single-use link code for {@code userId}; a new code cancels the id's earlier ones. */
    public CompletableFuture<LinkCode> requestLinkCode(String userId, WriteOptions opts) {
        return api.write(Routes.requestLinkCode(userId), opts, Wire::linkCode);
    }

    /** Same as {@link #redeemLinkCode(String, String, WriteOptions)} with default options. */
    public CompletableFuture<IdentityLinkResult> redeemLinkCode(String code, String userId) {
        return redeemLinkCode(code, userId, WriteOptions.none());
    }

    /**
     * Redeems a code for {@code userId}, joining it to the requester's person. The code is matched
     * ignoring case, hyphens and spaces.
     */
    public CompletableFuture<IdentityLinkResult> redeemLinkCode(String code, String userId, WriteOptions opts) {
        return api.write(Routes.redeemLinkCode(code, userId), opts, Wire::linkResult);
    }

    /** Same as {@link #unlink(String, WriteOptions)} with default options. */
    public CompletableFuture<IdentityUnlinkResult> unlink(String userId) {
        return unlink(userId, WriteOptions.none());
    }

    /** Splits {@code userId} out of its person into a new, empty person; returns the remaining person. */
    public CompletableFuture<IdentityUnlinkResult> unlink(String userId, WriteOptions opts) {
        return api.write(Routes.unlink(userId), opts, Wire::unlinkResult);
    }
}
