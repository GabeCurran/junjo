package io.junjo.sdk;

import com.google.gson.JsonObject;
import io.junjo.sdk.internal.ApiSupport;
import io.junjo.sdk.internal.Json;
import io.junjo.sdk.internal.Paths;
import io.junjo.sdk.internal.Routes;
import io.junjo.sdk.internal.Wire;
import io.junjo.sdk.model.Context;
import io.junjo.sdk.model.PermissionCheckRequest;
import io.junjo.sdk.model.PermissionCheckResult;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;

/**
 * Server-side permission checks. For checks on a hot path, resolve locally from a mirror instead
 * (see {@code io.junjo.sdk.mirror.GameMirror}).
 */
public final class PermissionsApi {
    /** The most entries the server accepts in one batch request. */
    public static final int BATCH_MAX = 100;

    private final ApiSupport api;

    PermissionsApi(ApiSupport api) {
        this.api = api;
    }

    /** Same as {@link #check(String, String, String, boolean)} without inheritance. */
    public CompletableFuture<PermissionCheckResult> check(String userId, String groupId, String permission) {
        return check(userId, groupId, permission, false);
    }

    /**
     * Checks one permission in one group with no context: only global entries apply.
     *
     * @param inherit also walk the group's ancestors, nearest first, until one decides
     */
    public CompletableFuture<PermissionCheckResult> check(
            String userId, String groupId, String permission, boolean inherit) {
        return check(userId, groupId, permission, inherit, Context.GLOBAL);
    }

    /** Same as {@link #check(String, String, String, boolean, Context)} without inheritance. */
    public CompletableFuture<PermissionCheckResult> check(
            String userId, String groupId, String permission, Context context) {
        return check(userId, groupId, permission, false, context);
    }

    /**
     * Checks one permission in one group, in a context. Entries limited to a context apply when
     * the check's context matches them; {@link Context#GLOBAL} sees only global entries. The
     * result's {@link PermissionCheckResult#context()} is the deciding entry's context.
     *
     * @param inherit also walk the group's ancestors, nearest first, until one decides
     */
    public CompletableFuture<PermissionCheckResult> check(
            String userId, String groupId, String permission, boolean inherit, Context context) {
        Paths.Query query = new Paths.Query()
                .add("userId", userId)
                .add("groupId", groupId)
                .add("permission", permission)
                .add("inherit", inherit ? "true" : null);
        String path = Routes.contextQuery(query, context).appendTo("/v1/permissions/check");
        return api.get(path, Wire::checkResult);
    }

    /**
     * Checks many entries, each in its own {@link PermissionCheckRequest#context()}. Results are
     * positional. Inputs longer than {@link #BATCH_MAX} are split
     * into sequential requests. An unknown group fails the whole call with {@code not_found}.
     *
     * @param inherit walk group ancestors for every entry
     */
    public CompletableFuture<List<PermissionCheckResult>> checkBatch(
            List<PermissionCheckRequest> checks, boolean inherit) {
        List<PermissionCheckRequest> all = List.copyOf(checks);
        CompletableFuture<List<PermissionCheckResult>> chain = CompletableFuture.completedFuture(new ArrayList<>());
        for (int offset = 0; offset < all.size(); offset += BATCH_MAX) {
            List<PermissionCheckRequest> slice = all.subList(offset, Math.min(all.size(), offset + BATCH_MAX));
            chain = chain.thenCompose(acc -> sendBatch(slice, inherit).thenApply(results -> {
                acc.addAll(results);
                return acc;
            }));
        }
        return chain.thenApply(List::copyOf);
    }

    /** Same as {@link #checkBatch(List, boolean)} without inheritance. */
    public CompletableFuture<List<PermissionCheckResult>> checkBatch(List<PermissionCheckRequest> checks) {
        return checkBatch(checks, false);
    }

    private CompletableFuture<List<PermissionCheckResult>> sendBatch(
            List<PermissionCheckRequest> slice, boolean inherit) {
        List<Map<String, Object>> entries = new ArrayList<>();
        for (PermissionCheckRequest c : slice) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("userId", c.userId());
            m.put("groupId", c.groupId());
            m.put("permission", c.permission());
            if (!c.context().isGlobal()) m.put("context", c.context().values());
            entries.add(m);
        }
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("checks", entries);
        if (inherit) body.put("inherit", true);
        return api.readPost("/v1/permissions/check-batch", body).thenApply(r -> {
            JsonObject o = Json.parseObject(r.bodyString());
            List<PermissionCheckResult> results = Wire.list(Json.arr(o, "results"), "results", Wire::checkResult);
            if (results.size() != slice.size()) {
                throw Json.wire("check-batch returned " + results.size() + " results for " + slice.size() + " checks");
            }
            return results;
        });
    }
}
