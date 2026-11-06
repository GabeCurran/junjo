package io.junjo.sdk;

import io.junjo.sdk.internal.ApiSupport;
import io.junjo.sdk.internal.Json;
import io.junjo.sdk.internal.Paths;
import io.junjo.sdk.internal.Routes;
import io.junjo.sdk.internal.Wire;
import io.junjo.sdk.model.AddSanctionInput;
import io.junjo.sdk.model.ListSanctionsOptions;
import io.junjo.sdk.model.Page;
import io.junjo.sdk.model.Sanction;
import io.junjo.sdk.model.SanctionHistoryEntry;
import java.util.List;
import java.util.concurrent.CompletableFuture;

/**
 * Sanctions: game-wide restrictions on a person, with types your game defines. A person holds at
 * most one active sanction per type; it stays active until lifted or until it expires, and expiry
 * emits no event. Sanctions share the person's moderation version with game bans; every write
 * accepts {@code If-Match} against it.
 */
public final class SanctionsApi {
    private final ApiSupport api;

    SanctionsApi(ApiSupport api) {
        this.api = api;
    }

    /** Same as {@link #add(AddSanctionInput, WriteOptions)} with default options. */
    public CompletableFuture<Sanction> add(AddSanctionInput input) {
        return add(input, WriteOptions.none());
    }

    /**
     * Creates the person's sanction of the input's type, or replaces the active one. An identical
     * repeat writes nothing and bumps no version. The returned {@code version} is the new
     * moderation version.
     */
    public CompletableFuture<Sanction> add(AddSanctionInput input, WriteOptions opts) {
        return api.write(Routes.addSanction(input), opts, Wire::sanction);
    }

    /** Same as {@link #remove(String, String, String, WriteOptions)} with no actor and default options. */
    public CompletableFuture<Void> remove(String userId, String type) {
        return remove(userId, type, null, WriteOptions.none());
    }

    /**
     * Lifts the person's active sanction of a type. With nothing to lift it fails with
     * {@code not_found} for which {@link JunjoException#isNotActive()} is true; that answer wins
     * over a stale {@code If-Match}.
     *
     * @param actorUserId the person lifting it, or null
     */
    public CompletableFuture<Void> remove(String userId, String type, String actorUserId, WriteOptions opts) {
        return api.writeVoid(Routes.removeSanction(userId, type, actorUserId), opts);
    }

    /** Lists the game's active sanctions, newest start first. {@code opts} may be null. */
    public CompletableFuture<JunjoResponse<Page<Sanction>>> list(ListSanctionsOptions opts) {
        return api.getPage(query(opts, "/v1/sanctions"), Wire::sanction);
    }

    /**
     * The person's active sanctions, newest first. The ETag is the moderation version; an id the
     * game has never seen reads as an empty list with ETag {@code "0"}.
     */
    public CompletableFuture<JunjoResponse<List<Sanction>>> forUser(String userId) {
        return api.getResponse(Routes.user(userId) + "/sanctions",
                r -> Wire.list(Json.arr(Json.parseObject(r.bodyString()), "items"), "items", Wire::sanction));
    }

    /** Every set and lift for the person, newest first. {@code opts} may be null. */
    public CompletableFuture<JunjoResponse<Page<SanctionHistoryEntry>>> history(
            String userId, ListSanctionsOptions opts) {
        return api.getPage(query(opts, Routes.user(userId) + "/sanctions/history"), Wire::sanctionHistory);
    }

    private static String query(ListSanctionsOptions opts, String path) {
        ListSanctionsOptions o = opts == null ? ListSanctionsOptions.defaults() : opts;
        return new Paths.Query()
                .add("type", o.type())
                .add("limit", o.limit())
                .add("cursor", o.cursor())
                .appendTo(path);
    }
}
