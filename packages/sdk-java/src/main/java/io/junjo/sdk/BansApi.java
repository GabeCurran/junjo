package io.junjo.sdk;

import io.junjo.sdk.internal.ApiSupport;
import io.junjo.sdk.internal.Json;
import io.junjo.sdk.internal.Paths;
import io.junjo.sdk.internal.Routes;
import io.junjo.sdk.internal.Wire;
import io.junjo.sdk.model.Ban;
import io.junjo.sdk.model.CreateBanInput;
import io.junjo.sdk.model.ListBansOptions;
import io.junjo.sdk.model.Moderation;
import io.junjo.sdk.model.Page;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;

/**
 * Game bans. Writes accept {@code If-Match} against the person's moderation version (shared
 * with sanctions), which keeps a replayed lift from removing a newer ban.
 */
public final class BansApi {
    private final ApiSupport api;

    BansApi(ApiSupport api) {
        this.api = api;
    }

    /** Same as {@link #add(CreateBanInput, WriteOptions)} with default options. */
    public CompletableFuture<Ban> add(CreateBanInput input) {
        return add(input, WriteOptions.none());
    }

    /** Creates or replaces the person's game ban. */
    public CompletableFuture<Ban> add(CreateBanInput input, WriteOptions opts) {
        return api.write(Routes.addBan(input), opts, Wire::ban);
    }

    /** Same as {@link #remove(String, String, WriteOptions)} with no actor and default options. */
    public CompletableFuture<Void> remove(String userId) {
        return remove(userId, null, WriteOptions.none());
    }

    /**
     * Lifts the active game ban. With none active it fails with {@code not_found} for which
     * {@link JunjoException#isNotActive()} is true; that answer wins over a stale {@code If-Match}.
     *
     * @param actorUserId the acting moderator, or null
     */
    public CompletableFuture<Void> remove(String userId, String actorUserId, WriteOptions opts) {
        return api.writeVoid(Routes.removeBan(userId, actorUserId), opts);
    }

    /** Empty when no ban is active. */
    public CompletableFuture<Optional<Ban>> get(String userId) {
        return api.getOptional("/v1/bans/" + Paths.seg(userId), Wire::ban);
    }

    /** Lists the game's bans, newest first. {@code opts} may be null. */
    public CompletableFuture<JunjoResponse<Page<Ban>>> list(ListBansOptions opts) {
        ListBansOptions o = opts == null ? ListBansOptions.defaults() : opts;
        String path = new Paths.Query()
                .add("limit", o.limit())
                .add("cursor", o.cursor())
                .add("includeExpired", o.includeExpired() ? "true" : null)
                .appendTo("/v1/bans");
        return api.getPage(path, Wire::ban);
    }

    /**
     * Reads a person's moderation state: the moderation version (also the ETag), the active ban
     * and the active sanctions. An id the game has never seen reads as version 0 with nothing
     * active, so the result is always usable as the {@code If-Match} of the next ban or sanction
     * write.
     */
    public CompletableFuture<JunjoResponse<Moderation>> moderation(String userId) {
        return api.getResponse(
                Routes.user(userId) + "/moderation", r -> Wire.moderation(Json.parseObject(r.bodyString())));
    }
}
