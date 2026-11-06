package io.junjo.sdk.model;

import java.util.List;
import java.util.Optional;

/**
 * A group's roles with everything a local resolver needs.
 *
 * @param defaultRoleId the default role, or null
 * @param roles every role, highest priority first
 */
public record RoleGraph(String groupId, PermissionMode mode, String defaultRoleId, List<Role> roles) {
    /** Copies the list. */
    public RoleGraph {
        roles = List.copyOf(roles);
    }

    public Optional<Role> role(String roleId) {
        for (Role r : roles) {
            if (r.id().equals(roleId)) return Optional.of(r);
        }
        return Optional.empty();
    }
}
