package io.junjo.sdk.model;

import io.junjo.sdk.permissions.ContextInheritance;
import java.util.List;
import java.util.Optional;

/**
 * A group's roles with everything a local resolver needs.
 *
 * @param defaultRoleId the default role, or null
 * @param roles every role, highest priority first
 * @param contexts the game's context inheritance at the time of the read; the same for every
 *     group of the game. {@link ContextInheritance#NONE} when the server sent none.
 */
public record RoleGraph(
        String groupId, PermissionMode mode, String defaultRoleId, List<Role> roles, ContextInheritance contexts) {
    /** Copies the list; a null inheritance reads as {@link ContextInheritance#NONE}. */
    public RoleGraph {
        roles = List.copyOf(roles);
        if (contexts == null) contexts = ContextInheritance.NONE;
    }

    /** A graph without context inheritance. */
    public RoleGraph(String groupId, PermissionMode mode, String defaultRoleId, List<Role> roles) {
        this(groupId, mode, defaultRoleId, roles, ContextInheritance.NONE);
    }

    public Optional<Role> role(String roleId) {
        for (Role r : roles) {
            if (r.id().equals(roleId)) return Optional.of(r);
        }
        return Optional.empty();
    }
}
