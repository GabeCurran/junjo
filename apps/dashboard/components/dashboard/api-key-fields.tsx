// @license All Rights Reserved (see apps/dashboard/LICENSE)
import {
  ADMIN_API_KEY_MAX_PREFERRED_NAMESPACES,
  ADMIN_API_KEY_NAME_MAX_LENGTH,
} from "../../lib/admin-shared";
import { Input } from "../ui/input";
import { Label } from "../ui/label";

interface ApiKeyFieldsProps {
  idPrefix: string;
  defaultName?: string | null;
  defaultNamespaces?: string[];
  defaultCanExport?: boolean;
}

// Name, namespace-preference and export inputs shared by the issue and
// edit dialogs. Field names match what the API key Server Actions read.
export function ApiKeyFields({
  idPrefix,
  defaultName,
  defaultNamespaces,
  defaultCanExport,
}: ApiKeyFieldsProps) {
  const nameId = `${idPrefix}-name`;
  const namespacesId = `${idPrefix}-namespaces`;
  const exportId = `${idPrefix}-can-export`;
  return (
    <>
      <div className="space-y-2">
        <Label htmlFor={nameId}>Name (optional)</Label>
        <Input
          id={nameId}
          name="name"
          type="text"
          defaultValue={defaultName ?? ""}
          maxLength={ADMIN_API_KEY_NAME_MAX_LENGTH}
          placeholder="Lobby server"
          autoComplete="off"
        />
        <p className="text-xs text-muted-foreground">Shown on audit entries this key writes.</p>
      </div>
      <div className="space-y-2">
        <Label htmlFor={namespacesId}>Preferred namespaces (optional)</Label>
        <Input
          id={namespacesId}
          name="preferredNamespaces"
          type="text"
          defaultValue={(defaultNamespaces ?? []).join(", ")}
          placeholder="game, web"
          autoComplete="off"
        />
        <p className="text-xs text-muted-foreground">
          In order, up to {ADMIN_API_KEY_MAX_PREFERRED_NAMESPACES}, separated by commas. Responses
          read with this key name a person by their id in the first namespace listed that they have;
          otherwise by their earliest-linked id.
        </p>
      </div>
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <input
            id={exportId}
            name="canExport"
            type="checkbox"
            defaultChecked={defaultCanExport ?? false}
            className="h-4 w-4 rounded border-input"
          />
          <Label htmlFor={exportId}>Can export</Label>
        </div>
        <p className="text-xs text-muted-foreground">
          Allows this key to download the whole game as a file, including member notes and the audit
          log. Leave off unless the key belongs to a backup or migration tool.
        </p>
      </div>
    </>
  );
}
