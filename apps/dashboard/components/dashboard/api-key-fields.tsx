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
}

// Name and namespace-preference inputs shared by the issue and edit
// dialogs. Field names match what the API key Server Actions read.
export function ApiKeyFields({ idPrefix, defaultName, defaultNamespaces }: ApiKeyFieldsProps) {
  const nameId = `${idPrefix}-name`;
  const namespacesId = `${idPrefix}-namespaces`;
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
    </>
  );
}
