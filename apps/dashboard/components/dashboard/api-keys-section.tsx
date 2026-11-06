// @license All Rights Reserved (see apps/dashboard/LICENSE)
import { type AdminApiKey, AdminDisabledError, fetchAdminApiKeys } from "../../lib/admin";
import { Badge } from "../ui/badge";
import { Notice, Section } from "../ui/section";
import { CreateApiKeyDialog } from "./create-api-key-dialog";
import { EditApiKeyDialog } from "./edit-api-key-dialog";
import { RevokeApiKeyDialog } from "./revoke-api-key-dialog";

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
});

interface SectionShellProps {
  gameId: string;
  children: React.ReactNode;
}

function SectionShell({ gameId, children }: SectionShellProps) {
  return (
    <Section
      title="API keys"
      meta="The full secret is shown once, when the key is created."
      actions={<CreateApiKeyDialog gameId={gameId} />}
    >
      {children}
    </Section>
  );
}

interface EmptyStateProps {
  gameId: string;
  title: string;
  body: string;
}

function EmptyState({ gameId, title, body }: EmptyStateProps) {
  return (
    <SectionShell gameId={gameId}>
      <Notice title={title} body={body} />
    </SectionShell>
  );
}

interface ApiKeyRowProps {
  gameId: string;
  apiKey: AdminApiKey;
}

function ApiKeyRow({ gameId, apiKey }: ApiKeyRowProps) {
  const revoked = apiKey.revokedAt !== null;
  return (
    <tr className="border-b border-border/60 last:border-0">
      <td className="py-3 pr-3 sm:pr-4">
        {apiKey.name ? <div className="text-sm font-medium">{apiKey.name}</div> : null}
        <span className="font-mono text-xs sm:text-sm">{apiKey.prefix}</span>
        {apiKey.preferredNamespaces.length > 0 ? (
          <div className="mt-0.5 text-xs text-muted-foreground">
            Prefers {apiKey.preferredNamespaces.join(", ")}
          </div>
        ) : null}
        {apiKey.canExport ? (
          <div className="mt-0.5 text-xs text-muted-foreground">Can export</div>
        ) : null}
      </td>
      <td className="hidden py-3 pr-4 text-xs text-muted-foreground sm:table-cell">
        {dateFormatter.format(new Date(apiKey.createdAt))}
      </td>
      <td className="hidden py-3 pr-4 text-xs text-muted-foreground md:table-cell">
        {apiKey.revokedAt ? dateFormatter.format(new Date(apiKey.revokedAt)) : "-"}
      </td>
      <td className="py-3 pr-2 sm:pr-4">
        {revoked ? (
          <Badge variant="muted">Revoked</Badge>
        ) : (
          <Badge variant="secondary">Active</Badge>
        )}
      </td>
      <td className="py-3 text-right">
        <div className="flex justify-end gap-1">
          <EditApiKeyDialog gameId={gameId} apiKey={apiKey} />
          {revoked ? null : (
            <RevokeApiKeyDialog gameId={gameId} keyId={apiKey.id} prefix={apiKey.prefix} />
          )}
        </div>
      </td>
    </tr>
  );
}

interface ApiKeysSectionProps {
  gameId: string;
}

export async function ApiKeysSection({ gameId }: ApiKeysSectionProps) {
  let apiKeys: AdminApiKey[];
  try {
    const page = await fetchAdminApiKeys(gameId);
    apiKeys = page.items;
  } catch (err) {
    if (err instanceof AdminDisabledError) {
      return (
        <EmptyState
          gameId={gameId}
          title="Cross-game access is off"
          body="Set JUNJO_ADMIN_TOKEN on the dashboard and the server to list keys."
        />
      );
    }
    return (
      <EmptyState
        gameId={gameId}
        title="Could not load API keys"
        body={err instanceof Error ? err.message : "The API keys request failed."}
      />
    );
  }

  if (apiKeys.length === 0) {
    return (
      <EmptyState
        gameId={gameId}
        title="No API keys yet"
        body="Issue one for your game server; the SDK sends it on every call."
      />
    );
  }

  return (
    <SectionShell gameId={gameId}>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-xs text-muted-foreground">
              <th className="py-2 pr-3 text-left font-medium sm:pr-4">Key</th>
              <th className="hidden py-2 pr-4 text-left font-medium sm:table-cell">Created</th>
              <th className="hidden py-2 pr-4 text-left font-medium md:table-cell">Revoked</th>
              <th className="py-2 pr-2 text-left font-medium sm:pr-4">Status</th>
              <th className="py-2 font-medium" aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {apiKeys.map((apiKey) => (
              <ApiKeyRow key={apiKey.id} gameId={gameId} apiKey={apiKey} />
            ))}
          </tbody>
        </table>
      </div>
    </SectionShell>
  );
}
