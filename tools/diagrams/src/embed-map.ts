export type EmbedMap = Readonly<Record<string, readonly string[]>>;

export const EMBED_MAP: EmbedMap = {
  "system-architecture": ["apps/docs/pages/index.mdx"],
  "permission-resolution": ["apps/docs/pages/api-reference/permissions.mdx"],
  "webhook-delivery": ["apps/docs/pages/api-reference/webhooks.mdx"],
  "auth-flow": ["apps/docs/pages/auth/index.mdx"],
  "trust-boundary": ["apps/docs/pages/security-model.mdx"],
  "friend-flow": ["apps/docs/pages/sdk/friends.mdx"],
  "sse-flow": ["apps/docs/pages/api-reference/events.mdx"],
  "invitation-lifecycle": ["apps/docs/pages/sdk/invitations.mdx"],
  "self-host-deployment": ["apps/docs/pages/self-host.mdx"],
};
