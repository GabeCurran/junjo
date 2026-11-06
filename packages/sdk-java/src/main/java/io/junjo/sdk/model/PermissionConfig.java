package io.junjo.sdk.model;

import io.junjo.sdk.permissions.ContextInheritance;
import java.util.Objects;

/**
 * A game's permission config: how keys are matched and how context values inherit.
 *
 * @param mode how the game's permission keys are matched
 * @param contexts the inheritance between context values, the config's {@code permissions.contexts}
 */
public record PermissionConfig(PermissionMode mode, ContextInheritance contexts) {
    /** A null inheritance reads as {@link ContextInheritance#NONE}. */
    public PermissionConfig {
        Objects.requireNonNull(mode, "mode");
        if (contexts == null) contexts = ContextInheritance.NONE;
    }
}
