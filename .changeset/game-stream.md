---
"@junjo.io/shared": minor
"@junjo.io/sdk": minor
"@junjo.io/react": minor
---

Game stream: every event of a game on one connection, in commit order, resumable.

- **`GET /v1/events`.** One Server-Sent Events stream per game carrying every event, including game bans, identity links and friend events, which no group stream carries. Optional `types` filter.
- **Positions and resume.** Each event gets a gapless position in commit order, sent on the `id:` line. Reconnecting with `Last-Event-ID` delivers the missed events from a durable event log (24 hours by default); an older position answers `410 stream_position_expired`, meaning "load a fresh snapshot". Streams on every server instance see every event.
- **Snapshot positions.** `GET /v1/events/position`, and a `Junjo-Stream-Position` header on the role graph, role and member lists, member access, ban list and linked-id reads, so a cache can join a snapshot to the stream without missing events.
- **`junjo.events` on the client.** `position()` and `subscribe(handler, { types, from, onResync, ... })`, which reconnects with backoff and resumes from its position. React gets `useGameEvents`, sharing one stream per provider.
- **New event `member.updated`** (`changed`: `metadata`, `notes`, `overrides`) when a member's metadata, notes or overrides change. It also reaches group streams and webhook endpoints subscribed to every type.
- New error codes: `too_many_streams` (10 open game streams per key, 200 per game, per server instance) and `stream_position_expired`.
- Group streams are otherwise unchanged.
