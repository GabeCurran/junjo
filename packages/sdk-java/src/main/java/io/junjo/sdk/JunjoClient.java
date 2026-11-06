package io.junjo.sdk;

import io.junjo.sdk.internal.ApiSupport;
import io.junjo.sdk.internal.ClientAccess;
import io.junjo.sdk.internal.Transport;
import java.time.Duration;
import java.util.Objects;
import java.util.concurrent.Executor;

/**
 * The Junjo client: one per game and API key, shared by every thread. All calls are asynchronous
 * and return {@link java.util.concurrent.CompletableFuture}s that fail with
 * {@link JunjoException} (wrapped in {@link java.util.concurrent.CompletionException} when joined).
 *
 * <p>No call blocks the caller. Every request has a timeout. {@link #close()} cancels pending
 * calls (they fail with {@code cancelled}), stops SDK threads and releases connections; streams,
 * mirrors and queues built on the client must be closed first or they stop with it.
 */
public final class JunjoClient implements AutoCloseable {
    /** This SDK's version, sent in the User-Agent header. */
    public static final String VERSION = "0.1.0";

    static {
        ClientAccess.install(client -> client.transport);
    }

    private final Transport transport;
    private final GroupsApi groups;
    private final MembersApi members;
    private final RolesApi roles;
    private final PermissionsApi permissions;
    private final BansApi bans;
    private final SanctionsApi sanctions;
    private final ExportApi export;
    private final IdentitiesApi identities;
    private final EventsApi events;

    private JunjoClient(Builder b) {
        this.transport = new Transport(
                b.baseUrl,
                b.apiKey,
                b.connectTimeout,
                b.requestTimeout,
                b.retry,
                b.logger,
                b.executor,
                "junjo-java/" + VERSION);
        ApiSupport api = new ApiSupport(transport);
        this.groups = new GroupsApi(api);
        this.members = new MembersApi(api);
        this.roles = new RolesApi(api);
        this.permissions = new PermissionsApi(api);
        this.bans = new BansApi(api);
        this.sanctions = new SanctionsApi(api);
        this.export = new ExportApi(transport);
        this.identities = new IdentitiesApi(api);
        this.events = new EventsApi(api);
    }

    public static Builder builder() {
        return new Builder();
    }

    /** Groups, group bans and kicks. */
    public GroupsApi groups() {
        return groups;
    }

    public MembersApi members() {
        return members;
    }

    /** Roles and role graphs. */
    public RolesApi roles() {
        return roles;
    }

    /** Server-side permission checks. */
    public PermissionsApi permissions() {
        return permissions;
    }

    /** Game bans and moderation state. */
    public BansApi bans() {
        return bans;
    }

    public SanctionsApi sanctions() {
        return sanctions;
    }

    public ExportApi export() {
        return export;
    }

    /** Linked identities and display names. */
    public IdentitiesApi identities() {
        return identities;
    }

    /** The game event stream. */
    public EventsApi events() {
        return events;
    }

    /** Whether {@link #close()} has run. */
    public boolean isClosed() {
        return transport.isClosed();
    }

    /** Cancels pending calls and releases every resource. Idempotent. */
    @Override
    public void close() {
        transport.close();
    }

    /** Builds a {@link JunjoClient}. {@link #baseUrl} and {@link #apiKey} are required. */
    public static final class Builder {
        private String baseUrl;
        private String apiKey;
        private Duration connectTimeout = Duration.ofSeconds(10);
        private Duration requestTimeout = Duration.ofSeconds(30);
        private RetryPolicy retry = RetryPolicy.defaults();
        private JunjoLogger logger = JunjoLogger.NONE;
        private Executor executor;

        private Builder() {}

        /** The server root: scheme, host, optional port and path prefix, without {@code /v1}. */
        public Builder baseUrl(String url) {
            this.baseUrl = Objects.requireNonNull(url, "baseUrl");
            return this;
        }

        /** The per-game API key, sent as {@code Authorization: Bearer}. */
        public Builder apiKey(String key) {
            this.apiKey = Objects.requireNonNull(key, "apiKey");
            return this;
        }

        /** The TCP and TLS connect timeout. Default 10 s. */
        public Builder connectTimeout(Duration timeout) {
            this.connectTimeout = positive(timeout, "connectTimeout");
            return this;
        }

        /** The whole-request timeout per attempt, body included. Default 30 s. */
        public Builder requestTimeout(Duration timeout) {
            this.requestTimeout = positive(timeout, "requestTimeout");
            return this;
        }

        /** Default {@link RetryPolicy#defaults()}. */
        public Builder retryPolicy(RetryPolicy policy) {
            this.retry = Objects.requireNonNull(policy, "policy");
            return this;
        }

        /** Total attempts for retryable calls, including the first. */
        public Builder maxAttempts(int attempts) {
            this.retry = retry.withMaxAttempts(attempts);
            return this;
        }

        /** Default: discard everything. */
        public Builder logger(JunjoLogger log) {
            this.logger = Objects.requireNonNull(log, "logger");
            return this;
        }

        /**
         * The executor for HTTP work and future completions. When none is given the client owns a
         * cached pool of daemon threads and shuts it down on close; a supplied executor is never
         * shut down by the SDK.
         */
        public Builder executor(Executor exec) {
            this.executor = Objects.requireNonNull(exec, "executor");
            return this;
        }

        /**
         * @throws IllegalStateException when the base URL or the API key is missing
         * @throws IllegalArgumentException when the base URL is not an http or https URL
         */
        public JunjoClient build() {
            if (baseUrl == null) throw new IllegalStateException("baseUrl is required");
            if (apiKey == null || apiKey.isBlank()) throw new IllegalStateException("apiKey is required");
            return new JunjoClient(this);
        }

        private static Duration positive(Duration d, String name) {
            Objects.requireNonNull(d, name);
            if (d.isZero() || d.isNegative()) throw new IllegalArgumentException(name + " must be positive");
            return d;
        }
    }
}
