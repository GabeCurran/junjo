export type EmbedMap = Readonly<Record<string, readonly string[]>>;

export const EMBED_MAP: EmbedMap = {
  "system-architecture": ["apps/docs/pages/index.mdx"],
  "permission-resolution": ["apps/docs/pages/api-reference/permissions.mdx"],
  "webhook-delivery": [
    "apps/docs/pages/api-reference/webhooks.mdx",
    "apps/docs/pages/self-host.mdx",
  ],
  "auth-flow": ["apps/docs/pages/auth/index.mdx"],
};
