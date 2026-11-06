package io.junjo.sdk;

import com.google.gson.JsonElement;
import io.junjo.sdk.internal.ApiSupport;
import io.junjo.sdk.internal.Json;
import io.junjo.sdk.internal.Routes;
import io.junjo.sdk.internal.Wire;
import io.junjo.sdk.model.Context;
import io.junjo.sdk.model.CreateRoleInput;
import io.junjo.sdk.model.PermissionEntry;
import io.junjo.sdk.model.Role;
import io.junjo.sdk.model.RoleGraph;
import io.junjo.sdk.model.UpdateRoleInput;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;

/** Roles: create, read, update, delete, permission entries, parents and the group's role graph. */
public final class RolesApi {
    private final ApiSupport api;

    RolesApi(ApiSupport api) {
        this.api = api;
    }

    /** Same as {@link #create(String, CreateRoleInput, WriteOptions)} with default options. */
    public CompletableFuture<Role> create(String groupId, CreateRoleInput input) {
        return create(groupId, input, WriteOptions.none());
    }

    public CompletableFuture<Role> create(String groupId, CreateRoleInput input, WriteOptions opts) {
        return api.write(Routes.createRole(groupId, input), opts, Wire::role);
    }

    /** Empty when the role does not exist. */
    public CompletableFuture<Optional<Role>> get(String roleId) {
        return api.getOptional(Routes.role(roleId), Wire::role);
    }

    /** Every role in the group, highest priority first, in one response. */
    public CompletableFuture<JunjoResponse<List<Role>>> list(String groupId) {
        return api.getResponse(Routes.group(groupId) + "/roles", r -> {
            JsonElement el = Json.parse(r.bodyString());
            if (el.isJsonArray()) return Wire.list(el.getAsJsonArray(), "roles", Wire::role);
            if (el.isJsonObject()) return Wire.list(Json.arr(el.getAsJsonObject(), "items"), "items", Wire::role);
            throw Json.wire("role list was neither an array nor a page");
        });
    }

    /** Same as {@link #update(String, UpdateRoleInput, WriteOptions)} with default options. */
    public CompletableFuture<Role> update(String roleId, UpdateRoleInput input) {
        return update(roleId, input, WriteOptions.none());
    }

    public CompletableFuture<Role> update(String roleId, UpdateRoleInput input, WriteOptions opts) {
        return api.write(Routes.updateRole(roleId, input), opts, Wire::role);
    }

    /** Same as {@link #delete(String, WriteOptions)} with default options. */
    public CompletableFuture<Void> delete(String roleId) {
        return delete(roleId, WriteOptions.none());
    }

    /** Fails with {@code role_has_members} while members hold the role. */
    public CompletableFuture<Void> delete(String roleId, WriteOptions opts) {
        return api.writeVoid(Routes.deleteRole(roleId), opts);
    }

    /** Same as {@link #setEntries(String, List, WriteOptions)} with default options. */
    public CompletableFuture<Role> setEntries(String roleId, List<PermissionEntry> entries) {
        return setEntries(roleId, entries, WriteOptions.none());
    }

    /**
     * Replaces the role's whole entry list, grants and denies, global and contextual, in one atomic
     * write. Entries are matched by key and context: those absent from {@code entries} are removed
     * from the role. Each {@code (permission, context)} pair may appear once.
     */
    public CompletableFuture<Role> setEntries(String roleId, List<PermissionEntry> entries, WriteOptions opts) {
        return api.write(Routes.setEntries(roleId, entries), opts, Wire::role);
    }

    /** Same as {@link #grantPermission(String, String, boolean, WriteOptions)} with a grant and default options. */
    public CompletableFuture<Role> grantPermission(String roleId, String permission) {
        return grantPermission(roleId, permission, true, WriteOptions.none());
    }

    /**
     * Adds or updates one entry on the role: {@code value} true grants the key, false stores a
     * deny entry for it.
     */
    public CompletableFuture<Role> grantPermission(String roleId, String permission, boolean value, WriteOptions opts) {
        return grantPermission(roleId, permission, value, Context.GLOBAL, opts);
    }

    /**
     * Same as {@link #grantPermission(String, String, boolean, Context, WriteOptions)} with default
     * options.
     */
    public CompletableFuture<Role> grantPermission(String roleId, String permission, boolean value, Context context) {
        return grantPermission(roleId, permission, value, context, WriteOptions.none());
    }

    /**
     * Adds or updates the role's entry for the key in {@code context}: {@code value} true grants
     * the key there, false stores a deny. The entry for a context is separate from the key's
     * global entry and from its entries in other contexts; {@link Context#GLOBAL} writes the
     * global one.
     */
    public CompletableFuture<Role> grantPermission(
            String roleId, String permission, boolean value, Context context, WriteOptions opts) {
        return api.write(Routes.grantPermission(roleId, permission, value, context), opts, Wire::role);
    }

    /** Same as {@link #revokePermission(String, String, WriteOptions)} with default options. */
    public CompletableFuture<Role> revokePermission(String roleId, String permission) {
        return revokePermission(roleId, permission, WriteOptions.none());
    }

    /** Removes the role's global entry for the key, grant or deny. */
    public CompletableFuture<Role> revokePermission(String roleId, String permission, WriteOptions opts) {
        return revokePermission(roleId, permission, Context.GLOBAL, opts);
    }

    /** Same as {@link #revokePermission(String, String, Context, WriteOptions)} with default options. */
    public CompletableFuture<Role> revokePermission(String roleId, String permission, Context context) {
        return revokePermission(roleId, permission, context, WriteOptions.none());
    }

    /**
     * Removes the role's entry for the key in exactly {@code context}, grant or deny; entries for
     * the key in other contexts stay. {@link Context#GLOBAL} removes the global entry.
     */
    public CompletableFuture<Role> revokePermission(
            String roleId, String permission, Context context, WriteOptions opts) {
        return api.write(Routes.revokePermission(roleId, permission, context), opts, Wire::role);
    }

    /** Same as {@link #setParents(String, List, WriteOptions)} with default options. */
    public CompletableFuture<Role> setParents(String roleId, List<String> parents) {
        return setParents(roleId, parents, WriteOptions.none());
    }

    /**
     * Replaces the role's parents, which must belong to the same group. A list that would close
     * an inheritance cycle fails with {@code parent_cycle}.
     */
    public CompletableFuture<Role> setParents(String roleId, List<String> parents, WriteOptions opts) {
        return api.write(Routes.setParents(roleId, parents), opts, Wire::role);
    }

    /**
     * Reads the group's permission mode, default role and every role in one call: everything a
     * local resolver needs.
     */
    public CompletableFuture<JunjoResponse<RoleGraph>> getGraph(String groupId) {
        return api.getResponse(
                Routes.group(groupId) + "/role-graph", r -> Wire.roleGraph(Json.parseObject(r.bodyString())));
    }
}
