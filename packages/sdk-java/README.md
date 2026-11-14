# Junjo Java SDK

`io.junjo:junjo-sdk` is the Java client for [Junjo](https://junjo.io): groups, members, roles, permissions, game bans, sanctions and linked identities over REST, plus the game stream over Server-Sent Events. It is written for game servers and backends that keep running when the Junjo backend is slow or away:

- every call is asynchronous (`CompletableFuture`) and has a timeout;
- a local permission resolver gives the same answers as the server (it passes the shared conformance vectors);
- `GameMirror` keeps role graphs, game bans, sanctions and tracked members in memory, current via the game stream, readable without locks or I/O from any thread, and can persist itself to a file;
- `WriteQueue` persists writes to a checksummed journal on disk and replays them safely after a crash or an outage.

Runtime dependencies: the JDK (`java.net.http`) and Gson 2.11.0. Java 21 or newer. The jar is a named module, `io.junjo.sdk`.

The per-game API key is a full-control credential. Keep it on your servers; never ship it in a client players can read.

The full guide, including a mapping from the TypeScript SDK's names, is the docs site's Java page (`apps/docs/pages/java.mdx`).

## Install

The artifact is prepared for Maven Central but **not published yet**. Until it is, build it from this directory:

```sh
./gradlew build            # jar, sources jar, javadoc jar, tests
./gradlew publishToMavenLocal
```

Then depend on it:

```kotlin
// build.gradle.kts
dependencies {
    implementation("io.junjo:junjo-sdk:0.1.0")
}
```

```xml
<!-- pom.xml -->
<dependency>
  <groupId>io.junjo</groupId>
  <artifactId>junjo-sdk</artifactId>
  <version>0.1.0</version>
</dependency>
```

## Quick start

```java
import io.junjo.sdk.*;
import io.junjo.sdk.model.*;

JunjoClient junjo = JunjoClient.builder()
        .baseUrl("https://api.junjo.io")
        .apiKey(System.getenv("JUNJO_API_KEY"))
        .requestTimeout(Duration.ofSeconds(10))
        .build();

String player = Ids.namespaced("mc", playerUuid); // "mc:2f0c1a3b-..."

junjo.members().add("grp_main", player)
        .thenCompose(m -> junjo.members().assignRole("grp_main", player, "role_vip"))
        .thenAccept(m -> System.out.println("roles now " + m.roles()))
        .exceptionally(err -> {
            JunjoException e = (JunjoException) err.getCause();
            System.err.println(e.code() + " " + e.status() + " " + e.getMessage());
            return null;
        });

// On shutdown, after closing mirrors, streams and queues built on it:
junjo.close();
```

Namespaces: `groups()`, `members()`, `roles()`, `permissions()`, `bans()`, `sanctions()`, `identities()`, `invitations()`, `events()`, `export()`. Method names match the TypeScript SDK: `bans().add`, `members().removeRole`, `members().overridePermission`, `members().clearPermissionOverride`, `members().getAccess`, `members().getAccessMany`, `members().setMetadata`, `members().setNotes`, `groups().update`, `groups().delete`, `groups().restore`, `groups().inviteByUserId`, `groups().inviteByCode`, `groups().acceptInvitation`, `groups().declineInvitation`, `groups().join`, `groups().leave`, `groups().kick`, `groups().banHistory`, `groups().setRelationship`, `groups().clearRelationship`, `groups().getRelationship`, `groups().listRelationships`, `groups().setParent`, `groups().listChildren`, `groups().batch`, `invitations().list`, `invitations().get`, `invitations().revoke`, `roles().setEntries`, `roles().grantPermission`, `roles().revokePermission`, `roles().getGraph`.

Return types: every paged list (`groups().list`, `groups().banHistory`, `members().list`, `invitations().list`, `bans().list`, `sanctions().list`, `sanctions().history`) returns `JunjoResponse<Page<T>>`, as do the other reads that carry a stream position or an ETag; `streamPosition()` and `etag()` are null when the server sent none. Single-resource reads (`groups().get`, `groups().getRelationship`, `members().get`, `roles().get`, `bans().get`, `invitations().get`) return an empty `Optional` instead of failing with `not_found`.

A group read, create, update, soft delete or restore carries the group's `version()` (a decimal string, also sent as the ETag); lists and event payloads leave it null. `groups().update`, `groups().delete` and `groups().batch` take it as `If-Match`. A batch applies up to 50 `GroupBatchOp`s in one transaction, all or none; its `GroupBatchResponse` holds the new version and one typed `GroupBatchResult` per op (`asMember()`, `asGroup()`, `asRole()`, `asRelationship()`), and a failing op's error names it with `opIndex()`. `QueuedWrite.groupBatch` queues one.

### Errors

Every failure is a `JunjoException` (inside a `CompletionException` when you `join()`):

| Accessor | Meaning |
|---|---|
| `code()` | The server's error code (`not_found`, `banned`, `precondition_failed`, ...) or an SDK code: `network_error`, `timeout`, `cancelled`, `invalid_wire_data`, `stream_overflow`, `unknown`. |
| `status()` | HTTP status, `0` when no response arrived. |
| `requestId()` | Correlation id for bug reports. |
| `retryAfterSeconds()` | The server's `Retry-After`. |
| `details()` | The envelope's `details` object; `importRowErrors()` reads a bulk import's failing rows from it. |
| `isNotActive()` | A lift with nothing to lift: `404 not_found` with `details.reason = "not_active"`. |

New server codes pass through unchanged, so keep a default branch when you switch on `code()`.

### Retries and timeouts

`connectTimeout` (default 10 s) and `requestTimeout` (default 30 s, body included) apply to every call. GETs, the read-only POSTs and writes that carry an `Idempotency-Key` retry on network errors, timeouts, 5xx, 408, 429 and 409 `idempotency_key_in_progress`, with exponential backoff and full jitter, honouring `Retry-After` up to `RetryPolicy.maxRetryAfter`. Other writes are sent once.

```java
junjo.bans().add(
        CreateBanInput.builder(player).reason("cheating").build(),
        WriteOptions.idempotent());                 // random key: safe to retry

junjo.members().assignRole("grp_main", player, "role_mod", null,
        WriteOptions.idempotent().withIfMatch(member.version())); // refused with 412 if the member changed

junjo.members().add("grp_main", player, "role_member", null,
        WriteOptions.idempotent().withIfNoneMatchAny()); // refused with 412 if any membership row exists

junjo.groups().update("grp_main", UpdateGroupInput.builder().name("Main").actorUserId(mod).build(),
        WriteOptions.none().withIfMatch(group.version())); // refused with 412 if the group changed
```

### Write tags and event origin

`JunjoClient.builder().writeTag("shard-1")` sends `Junjo-Write-Tag` on every request; `WriteOptions.withWriteTag(...)` overrides it for one write. Tags are 1 to 128 printable ASCII characters without spaces. Every event carries `origin()`: the `apiKeyId` of the key that made the write (null for admin writes and server jobs) and that write's `tag`, so a writer sharing a key with others can skip the events it caused. Events from older servers read as `EventOrigin.NONE`. `group.updated`, `group.deleted` and `group.relationship.changed` carry the write's `actorUserId`, and `member.left` the kick's `kickedBy`.

### Threads

The client owns a cached pool of daemon threads unless you pass `executor(...)`. Future completions run on that executor, so do not block in a callback; hop to your own thread for game-state changes. Nothing in the SDK blocks the calling thread.

## Local permission checks

`PermissionResolver` is the server's algorithm in Java: member overrides, then directly held roles, then parents and grandparents; within a layer the best [context](#contexts) match wins, then the most specific key; ties go to deny. Both permission modes are supported (`exact`, and `nodes` with `a.b.*` and `*` wildcards and case folding).

```java
RoleGraph graph = junjo.roles().getGraph("grp_main").join().value();
MemberAccess access = junjo.members().getAccess("grp_main", player).join().value();
PermissionCheckResult r = PermissionResolver.compile(graph).check(access, "chat.color");
```

## Contexts

An entry or override can carry a `Context` (for example the world a player is in) so it applies only to checks made in that context; see [contexts in the API reference](https://docs.junjo.io/api-reference/permissions#contexts) for where a contextual entry ranks. `Context` is immutable, folds values with the server's ASCII-only fold, and `Context.GLOBAL` is the empty context. Every call that takes a context has an overload without one, which means global.

```java
Context creative = Context.of("world", "creative");
junjo.roles().grantPermission(roleId, "essentials.*", true, creative);
junjo.roles().revokePermission(roleId, "essentials.*", creative);
junjo.members().overridePermission("grp_main", player, "chat.color", false, Context.of("world", "hub"));
PermissionCheckResult r = junjo.permissions().check(player, "grp_main", "essentials.fly", creative).join();
r.context();   // the deciding entry's context, or Context.GLOBAL
```

`setEntries`, `clearPermissionOverride`, import rows, `checkBatch` and `QueuedWrite.overridePermission` / `clearPermissionOverride` take contexts too.

The game's context inheritance (`permissions.contexts` in its config) is set with the admin API and readable with the game's key: `permissions().config()` returns a `PermissionConfig(mode, contexts)`, and every `RoleGraph` carries the same `contexts()`. The mirror takes it from the server on its own: from the newest role graph it loaded, then live from `permissions.config.updated` events (which also reload the held graphs when the permission mode changes), and keeps it in the snapshot file. `contextInheritance()` is what checks resolve with, `serverContextInheritance()` what the server last sent.

Only with a server whose role graphs do not carry the inheritance yet, give the mirror the same table as the game's config. It is an explicit override that wins over the server's value; `setContextInheritance(null)` removes it:

```java
ContextInheritance worlds = ContextInheritance.builder()
        .inherit("world", "pvpworld", "world")
        .inherit("world", "cave_world_nether", "world_nether")
        .inherit("world", "world_nether", "world")
        .build();
GameMirror mirror = GameMirror.builder(junjo).group("grp_server").contextInheritance(worlds).build();
```

A Paper server keeps one context-bound checker per player and replaces it on a world change:

```java
private final Map<UUID, MemberChecker> checkers = new ConcurrentHashMap<>();

@EventHandler
public void onWorldChange(PlayerChangedWorldEvent event) {
    Player p = event.getPlayer();
    checkers.put(p.getUniqueId(), mirror.checker(Ids.namespaced("mc", p.getUniqueId()), "grp_server",
            Context.of("world", p.getWorld().getName())));   // bind the same way on join
}

boolean has(Player p, String permission) {
    MemberChecker c = checkers.get(p.getUniqueId());
    return c != null && c.can(permission) == Answer.YES;   // lock-free, no I/O
}
```

## The snapshot and stream pattern

The game stream (`GET /v1/events`) carries every event of the game with a gapless position. To keep local state exactly in step:

1. read the position (`events().position()`, or the `streamPosition()` of a snapshot read);
2. load the snapshot;
3. subscribe from that position.

```java
String position = junjo.events().position().join();
RoleGraph graph = junjo.roles().getGraph("grp_main").join().value();

GameSubscription sub = junjo.events().subscribe(
        (event, pos) -> {
            switch (event) {
                case JunjoEvent.GameUserBanned b -> kickIfOnline(b.userId());
                case JunjoEvent.RoleUpdated u -> reloadGraph(u.groupId());
                default -> { }
            }
        },
        SubscribeOptions.builder()
                .from(position)
                .types(EventType.GAME_USER_BANNED, EventType.ROLE_UPDATED)
                .onResync(newPosition -> reloadEverything())    // 410: the old position expired
                .onError(err -> log.error("stream stopped", err)) // fatal: bad key, too many streams
                .build()).join();
```

The stream reconnects on its own after the server ends it (deploys, idle proxies), resuming with `Last-Event-ID`; heartbeats also advance the position. A connection silent for longer than `idleTimeout` (75 s; the server sends a heartbeat every 30 s) is dropped and resumed. Events arrive in order on the stream's own thread. Events of a type this SDK does not know are skipped, but their position still counts.

### GameMirror

`GameMirror` does all of the above for you:

```java
GameMirror mirror = GameMirror.builder(junjo)
        .group("grp_main")
        .snapshotFile(dataDir.resolve("junjo-mirror.snapshot")) // optional: answers at once on the next start
        .onError(err -> log.warn("mirror", err))
        .onChange(change -> invalidate(change))                 // on the applier thread; must not block
        .build();
mirror.start();   // retries through an outage; isReady() turns true once loaded

// When a player connects (asynchronous; answers are UNKNOWN until loaded):
mirror.track(player, "grp_main");

// On the game thread, no locks, no I/O:
if (mirror.isBanned(player) == Answer.YES) disconnect(player);
if (mirror.isSanctioned(player, "mute") == Answer.YES) blockChat(player);
Answer canFly = mirror.can(player, "grp_main", "move.fly");      // YES, NO or UNKNOWN
Optional<PermissionCheckResult> detail = mirror.check(player, "grp_main", "move.fly");

// When the player leaves:
mirror.untrack(player, "grp_main");
```

Every `GameMirror` method takes the user before the group, as `permissions().check` does. The mirror loads the role graphs of the given groups, the whole game ban list and the active sanctions at the position it read first, then follows the stream from there on one applier thread. Member, ban and sanction events whose `memberVersion` / `moderationVersion` is not newer than the loaded state are skipped. A failed reload keeps the old state and retries with backoff.

A person may hold several linked ids. The mirror records each person's ids, so its reads answer for the person whatever id you pass; an id it has not resolved yet answers `UNKNOWN` for bans and sanctions until it is resolved in the background, or call `resolve(id)` first. Tracks issued together are loaded with one `getAccessMany` call per group. With a snapshot file, data loaded at start may be stale until the stream, resumed from the saved position, catches up.

`retainUntracked(Duration.ofHours(24))` keeps an untracked member's last loaded access, in memory and in the snapshot file, for that window after they were last tracked (`lastConnectedAt`). A player who returns within it, even after a restart while Junjo is unreachable, is answered from the retained access as soon as `track` is applied, and the access is reloaded as usual. Retained members are not tracked: they answer `UNKNOWN`, are not in `trackedMembers`, and stream events never reload them. One is dropped when it outlives the window, when a member event carries a newer version, when an identity event names the person, and on a full reload. Off by default.

`checker.excludingRoles(Set.of("role_mod", "role_admin"))` returns a checker that answers as if the member did not hold those roles; overrides and the checker's context apply as before. Exclusion removes held roles only: an excluded role that is a parent of a role still held keeps applying through it, so exclude the child roles too. `checker.excludingOverrides()` answers as if the member had no personal overrides, with role entries, context, inheritance and the status gate unchanged; the two compose in either order.

See the docs page for change kinds, the default-role option for non-members, `checker(userId, groupId)` and the stream health reads.

## Sanctions, display names and export

```java
// Sanctions: game-defined types, one active per person and type, If-Match on the moderation version.
Sanction mute = junjo.sanctions().add(
        AddSanctionInput.builder(player, "mute").reason("spam").build(), WriteOptions.idempotent()).join();
junjo.sanctions().remove(player, "mute", null, WriteOptions.none().withIfMatch(mute.version()));

// Display names, set on exactly one id; findByName ignores case.
junjo.identities().setDisplayName(player, "Steve");
List<DisplayNameMatch> hits = junjo.identities().findByName("steve", "mc").join();

// The NDJSON export, read line by line (needs a key with canExport).
ExportSummary summary = junjo.export().read(record -> backup.write(record.json())).join();

// Only some record kinds, for groups of some kinds; the header names both filters.
junjo.export().read(ExportOptions.all().withRecords(List.of("group", "member")).withGroupKinds(List.of("party")),
        record -> backup.write(record.json())).join();
```

The export fails with `invalid_wire_data` when its end record is missing or its counts disagree with the records read, and with `stream_overflow` when a line passes 16 Mi characters.

## The write queue

`WriteQueue` is for writes that must land eventually, even across an outage or a crash:

```java
WriteQueue queue = WriteQueue.builder(junjo, dataDir.resolve("junjo-writes.jsonl"))
        .onConflict(o -> log.warn("stale write dropped: " + o.entry().write().label()))
        .onRejected(o -> log.warn("write refused: " + o.error().code()))
        .open();

queue.enqueue(QueuedWrite.assignRole("grp_main", player, "role_vip", moderatorId)
        .ifMatch(member.version()));
queue.enqueue(QueuedWrite.removeBan(player, moderatorId));

// On shutdown: drains for up to the close timeout, keeps the rest for next time.
queue.close();
```

- `enqueue` returns after the entry is appended to the journal and forced to disk; when the force fails it throws and the entry is not queued. Each journal line carries a CRC32. The journal is compacted through a temporary file, an atomic move and a directory force; without atomic moves the old journal is kept and an ERROR is logged.
- The `QueuedWrite` factories are named after the API calls and build exactly the same requests. `addMemberIfAbsent` is `addMember` with `If-None-Match: *`: it creates the membership only when none exists in any status, and an existing one is a `412` reported through `onConflict`.
- Each entry gets a random `Idempotency-Key` that it keeps across retries and restarts, so a write whose answer was lost is not applied twice. Add `ifMatch(version)` for writes that must not apply to state that changed after you decided them; the server's key retention is 24 hours, and `If-Match` protects beyond it.
- Entries are sent strictly in order. Network errors, timeouts, 5xx, 408, 429 and 409 `idempotency_key_in_progress` retry the head entry with backoff; later entries wait. A 401 also retries (a rotated key should not wipe the queue).
- `412 precondition_failed` drops the entry and calls `onConflict`. Any other 4xx drops it and calls `onRejected`. Either way the entry, the status and the raw response body are first appended to the dead-letter file next to the journal (`deadLetterFile()`), so nothing is lost when a callback is unset or throws. Journal lines that fail their checksum are moved there too.
- **Lifts that find nothing to lift succeed.** A queued lift (`removeBan`, `groupUnban`, `removeSanction`) answered with `isNotActive()` counts as success, because the state it asked for already holds. A plain `not_found` (an unknown group, for example) is still a rejection.
- `flush(Duration)` waits for the queue to empty. `close()` stops accepting entries and drains for up to `closeTimeout` (10 s); anything still pending is resent on the next `open()`.

## Example: a Minecraft server plugin

Players are `mc:` ids built from their UUIDs, the main thread reads only from the mirror, and moderation writes go through the write queue:

```java
// onEnable
mirror = GameMirror.builder(junjo).group("grp_server")
        .snapshotFile(getDataFolder().toPath().resolve("junjo-mirror.snapshot")).build();
mirror.start();
queue = WriteQueue.builder(junjo, getDataFolder().toPath().resolve("junjo-writes.jsonl")).open();

// AsyncPlayerPreLoginEvent (an async thread: waiting is fine, and it resolves linked ids)
String id = Ids.namespaced("mc", event.getUniqueId());
mirror.track(id, "grp_server").orTimeout(3, TimeUnit.SECONDS).exceptionally(err -> null).join();
if (mirror.isBanned(id) == Answer.YES) event.disallow(AsyncPlayerPreLoginEvent.Result.KICK_BANNED, banMessage);

// BlockPlaceEvent (the main thread: a lock-free read, never a network call)
if (!mirror.can(id, "grp_server", "build.place").orElse(false)) event.setCancelled(true);

// A /mute command
queue.enqueue(QueuedWrite.addSanction(AddSanctionInput.builder(id, "mute")
        .expiresAt(Instant.now().plus(Duration.ofHours(1))).actorUserId(moderatorId).build()));

// onDisable
queue.close();
mirror.close();   // saves the snapshot file
junjo.close();
```

## Shading

The SDK is safe to relocate with the Gradle Shadow plugin or the Maven Shade plugin: it loads no classes by name, uses no `ServiceLoader`, and reads no resources by path. Relocate Gson together with the SDK if your platform ships a different Gson, and exclude the SDK's `module-info.class`, which names the original packages:

```kotlin
tasks.shadowJar {
    relocate("io.junjo.sdk", "com.yourgame.libs.junjo")
    relocate("com.google.gson", "com.yourgame.libs.gson")
    exclude("module-info.class")
}
```

The module exports only the API packages; `io.junjo.sdk.internal` is not supported API.

## Ids

```java
Ids.namespaced("mc", uuid);           // "mc:2f0c1a3b-4d5e-6f70-8192-a3b4c5d6e7f8"
Ids.canonicalize("mc:2F0C1A3B4D5E6F708192A3B4C5D6E7F8");
Ids.uuidOf(id, "mc");                 // Optional<UUID>
```

A game can declare that every id in a namespace is a canonical UUID; the server then rejects other spellings, so build ids with `Ids.namespaced`.

## Building and testing

```sh
./gradlew build
```

Gradle 9.8.2 comes from the wrapper; it needs a JDK 17 or newer to run and compiles with `--release 21`. Tests use JUnit 5 and the JDK's built-in HTTP server, and read the permission conformance vectors from `../shared/conformance/permission-vectors.json`.

The live end-to-end tests run when `JUNJO_IT_BASE_URL` and `JUNJO_IT_API_KEY` are set (a disposable game's key: they create groups, roles, members, bans, sanctions and links):

```sh
JUNJO_IT_BASE_URL=http://localhost:8787 JUNJO_IT_API_KEY=jk_... ./gradlew test
```

The kind-limit and export tests also need `JUNJO_IT_ADMIN_TOKEN`: they change the game's `groups.kinds` config (and restore it) and mint, then revoke, a key with `canExport`.

Publishing (maintainers only) signs when `JUNJO_SIGNING_KEY` / `JUNJO_SIGNING_PASSWORD` are set and adds the Central staging repository when `JUNJO_CENTRAL_USERNAME` / `JUNJO_CENTRAL_PASSWORD` are set. `./gradlew publishMavenPublicationToStagingRepository` writes the exact release artifacts to `build/staging-repo` for inspection.
