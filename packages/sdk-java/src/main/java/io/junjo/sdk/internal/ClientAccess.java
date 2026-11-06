package io.junjo.sdk.internal;

import io.junjo.sdk.JunjoClient;
import java.util.Objects;
import java.util.function.Function;

/**
 * Hands a client's transport to the SDK's own packages (the mirror and the write queue) without a
 * public accessor on {@link JunjoClient}. The client installs the accessor from its static
 * initializer, which has always run by the time a client instance exists, and only one install is
 * accepted.
 *
 * <p>Internal: not part of the supported API.
 */
public final class ClientAccess {
    private static volatile Function<JunjoClient, Transport> accessor;

    private ClientAccess() {}

    /** Called once, by {@link JunjoClient}. */
    public static synchronized void install(Function<JunjoClient, Transport> transportOf) {
        if (accessor != null) throw new IllegalStateException("client access is already installed");
        accessor = Objects.requireNonNull(transportOf, "transportOf");
    }

    public static Transport transport(JunjoClient client) {
        Objects.requireNonNull(client, "client");
        Function<JunjoClient, Transport> a = accessor;
        if (a == null) throw new IllegalStateException("client access is not installed");
        return a.apply(client);
    }
}
