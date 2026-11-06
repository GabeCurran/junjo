---
"@junjo.io/shared": minor
"@junjo.io/sdk": minor
"@junjo.io/react": minor
---

Linked identities: one person, several external ids.

- **Namespaces and canonical formats.** An id's namespace is the text before its first `:`. A game can declare a format per namespace (`identity.formats`, first format `uuid`); ids in a declared namespace that do not match are rejected with `invalid_user_id` on every path that accepts a user id, so two spellings can never become two people. Opt-in; games that declare nothing behave exactly as before.
- **Deterministic ids in responses and events.** Every response, SSE event and webhook payload names a person by one rule: the earliest-linked id in the first namespace the caller prefers, otherwise the earliest-linked id overall. API keys and webhook endpoints carry an optional ordered `preferredNamespaces` list. People with a single id see no change.
- **`identities` on the client.** `list(userId)`, `requestLinkCode(userId)`, `redeemLinkCode({ code, userId })` and `unlink(userId)`. Codes are single use, expire after five minutes and are rate limited. A link is refused when both people already hold roles, relationships or history, or when either is banned. React gets `useIdentities`.
- **Events.** New `identity.linked` and `identity.unlinked`; `game.user.banned` and `game.user.unbanned` gain `userId`.
- **Audit.** Entries carry `apiKey`, the key whose request wrote them; API keys gain an optional display `name`.
- **Webhook endpoints** accept and return `preferredNamespaces`.
- New error codes: `invalid_user_id`, `identity_format_conflict`, `link_code_invalid`, `link_refused`.
