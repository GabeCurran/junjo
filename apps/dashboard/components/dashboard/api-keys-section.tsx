// @license All Rights Reserved (see apps/dashboard/LICENSE)
import { KeyRound } from "lucide-react";

import { type AdminApiKey, AdminDisabledError, fetchAdminApiKeys } from "../../lib/admin";
import { Badge } from "../ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { CreateApiKeyDialog } from "./create-api-key-dialog";
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
    <Card>
      <CardHeader className="flex-row items-start justify-between space-y-0">
        <div className="space-y-1.5">
          <CardTitle className="text-base">API keys</CardTitle>
          <CardDescription>
            Server-side keys for SDK calls. The full secret is shown exactly once on issuance.
          </CardDescription>
        </div>
        <CreateApiKeyDialog gameId={gameId} />
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
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
      <div className="flex flex-col items-center rounded-md border border-dashed border-border bg-card/50 p-10 text-center">
        <KeyRound className="h-8 w-8 text-muted-foreground" aria-hidden />
        <p className="mt-3 text-sm font-medium">{title}</p>
        <p className="mt-1 max-w-md text-xs text-muted-foreground">{body}</p>
      </div>
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
    <tr className="border-b border-border last:border-0">
      <td className="py-3 pr-4">
        <span className="font-mono text-sm">{apiKey.prefix}</span>
      </td>
      <td className="py-3 pr-4 text-xs text-muted-foreground">
        {dateFormatter.format(new Date(apiKey.createdAt))}
      </td>
      <td className="py-3 pr-4 text-xs text-muted-foreground">
        {apiKey.revokedAt ? dateFormatter.format(new Date(apiKey.revokedAt)) : "-"}
      </td>
      <td className="py-3 pr-4">
        {revoked ? (
          <Badge variant="muted">Revoked</Badge>
        ) : (
          <Badge variant="secondary">Active</Badge>
        )}
      </td>
      <td className="py-3 text-right">
        {revoked ? null : (
          <RevokeApiKeyDialog gameId={gameId} keyId={apiKey.id} prefix={apiKey.prefix} />
        )}
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
          title="Cross-game access is disabled"
          body="Set JUNJO_ADMIN_TOKEN on this dashboard to load API keys."
        />
      );
    }
    return (
      <EmptyState
        gameId={gameId}
        title="Could not load API keys"
        body={err instanceof Error ? err.message : "unknown error fetching API keys"}
      />
    );
  }

  if (apiKeys.length === 0) {
    return (
      <EmptyState
        gameId={gameId}
        title="No API keys yet"
        body="Click 'Issue key' above to mint the first server-side API key for this game. The secret will be shown once on issuance and stored only as a scrypt hash."
      />
    );
  }

  return (
    <SectionShell gameId={gameId}>
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
              <th className="py-2 pr-4 text-left font-medium">Prefix</th>
              <th className="py-2 pr-4 text-left font-medium">Created</th>
              <th className="py-2 pr-4 text-left font-medium">Revoked</th>
              <th className="py-2 pr-4 text-left font-medium">Status</th>
              <th className="py-2 font-medium" aria-label="Revoke" />
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
