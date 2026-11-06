// @license All Rights Reserved (see apps/dashboard/LICENSE)
"use client";

import { Plus, X } from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "../../../../../components/ui/button";
import {
  ADMIN_GROUP_KIND_MAX_LENGTH,
  ADMIN_USER_ID_FORMATS,
  ADMIN_USER_ID_NAMESPACE_PATTERN,
  type AdminGroupKindLimits,
  type AdminUserIdFormat,
} from "../../../../../lib/admin-shared";
import { SaveStatus, SettingRow, SettingsGroup, inputClass, useConfigSave } from "./primitives";

let nextRowId = 1;
const rowId = () => nextRowId++;

// Shared footer for editors that save a whole map at once.
function SaveBar({
  label,
  dirty,
  problem,
  pending,
  error,
  savedAt,
  onSave,
}: {
  label: string;
  dirty: boolean;
  problem: string | null;
  pending: boolean;
  error: string | null;
  savedAt: Date | null;
  onSave: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 pt-1">
      <Button size="sm" disabled={pending || !dirty || problem !== null} onClick={onSave}>
        {label}
      </Button>
      {problem ? (
        <p className="text-sm text-destructive">{problem}</p>
      ) : dirty && !pending && !error ? (
        <p className="text-sm text-muted-foreground">Unsaved changes</p>
      ) : (
        <SaveStatus pending={pending} error={error} savedAt={savedAt} />
      )}
    </div>
  );
}

interface FormatRow {
  id: number;
  namespace: string;
  format: AdminUserIdFormat;
}

function IdFormatsEditor({
  gameId,
  initial,
}: {
  gameId: string;
  initial: Record<string, AdminUserIdFormat>;
}) {
  const toRows = (m: Record<string, AdminUserIdFormat>): FormatRow[] =>
    Object.entries(m)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([namespace, format]) => ({ id: rowId(), namespace, format }));
  const [rows, setRows] = useState(() => toRows(initial));
  const [saved, setSaved] = useState(() => JSON.stringify(initial, Object.keys(initial).sort()));
  const { save, pending, error, savedAt } = useConfigSave(gameId);

  const next = useMemo(() => {
    const out: Record<string, AdminUserIdFormat> = {};
    for (const r of rows) if (r.namespace.trim()) out[r.namespace.trim()] = r.format;
    return out;
  }, [rows]);
  const serialized = JSON.stringify(next, Object.keys(next).sort());
  const dirty = serialized !== saved;
  const problem = (() => {
    const seen = new Set<string>();
    for (const r of rows) {
      const ns = r.namespace.trim();
      if (!ns) continue;
      if (!ADMIN_USER_ID_NAMESPACE_PATTERN.test(ns)) {
        return `"${ns}" is not a valid namespace: 1 to 32 lowercase letters, digits, underscores or hyphens.`;
      }
      if (seen.has(ns)) return `"${ns}" is listed twice.`;
      seen.add(ns);
    }
    return null;
  })();

  return (
    <SettingRow
      label="Id formats"
      hint="Ids in a listed namespace (the text before the first colon) must match its format. Declaring one is refused while a stored id does not match."
    >
      <div className="flex flex-col gap-2">
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No namespace declares a format.</p>
        ) : null}
        {rows.map((r) => (
          <div key={r.id} className="flex items-center gap-2">
            <input
              aria-label="Namespace"
              value={r.namespace}
              placeholder="namespace"
              disabled={pending}
              onChange={(e) =>
                setRows((rs) =>
                  rs.map((x) => (x.id === r.id ? { ...x, namespace: e.target.value } : x)),
                )
              }
              className={inputClass("w-48 font-mono")}
            />
            <select
              aria-label={`Format for ${r.namespace || "namespace"}`}
              value={r.format}
              disabled={pending}
              onChange={(e) =>
                setRows((rs) =>
                  rs.map((x) =>
                    x.id === r.id ? { ...x, format: e.target.value as AdminUserIdFormat } : x,
                  ),
                )
              }
              className={inputClass("w-36")}
            >
              {ADMIN_USER_ID_FORMATS.map((f) => (
                <option key={f} value={f}>
                  {f === "uuid" ? "UUID" : f}
                </option>
              ))}
            </select>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Remove ${r.namespace || "row"}`}
              disabled={pending}
              onClick={() => setRows((rs) => rs.filter((x) => x.id !== r.id))}
            >
              <X className="h-4 w-4" aria-hidden />
            </Button>
          </div>
        ))}
        <div>
          <Button
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={() => setRows((rs) => [...rs, { id: rowId(), namespace: "", format: "uuid" }])}
          >
            <Plus className="h-4 w-4" aria-hidden />
            Add namespace
          </Button>
        </div>
        <SaveBar
          label="Save formats"
          dirty={dirty}
          problem={problem}
          pending={pending}
          error={error}
          savedAt={savedAt}
          onSave={() =>
            save({ config: { identity: { formats: next } } }, () => setSaved(serialized))
          }
        />
      </div>
    </SettingRow>
  );
}

interface KindRow {
  id: number;
  kind: string;
  maxMembers: string;
  maxPerUser: string;
  idleDeleteHours: string;
  deleteWhenEmpty: boolean;
}

const LIMIT_FIELDS = [
  { field: "maxMembers", label: "Max members", min: 1, max: 100_000 },
  { field: "maxPerUser", label: "Per person", min: 1, max: 1000 },
  { field: "idleDeleteHours", label: "Idle delete (h)", min: 1, max: 8760 },
] as const;

function kindToRow(kind: string, l: AdminGroupKindLimits): KindRow {
  return {
    id: rowId(),
    kind,
    maxMembers: l.maxMembers === undefined ? "" : String(l.maxMembers),
    maxPerUser: l.maxPerUser === undefined ? "" : String(l.maxPerUser),
    idleDeleteHours: l.idleDeleteHours === undefined ? "" : String(l.idleDeleteHours),
    deleteWhenEmpty: l.deleteWhenEmpty === true,
  };
}

function rowToLimits(r: KindRow): AdminGroupKindLimits {
  const out: AdminGroupKindLimits = {};
  for (const { field } of LIMIT_FIELDS) {
    if (r[field].trim() !== "") out[field] = Number(r[field]);
  }
  if (r.deleteWhenEmpty) out.deleteWhenEmpty = true;
  return out;
}

function GroupKindsEditor({
  gameId,
  initial,
}: {
  gameId: string;
  initial: Record<string, AdminGroupKindLimits>;
}) {
  const [rows, setRows] = useState(() =>
    Object.entries(initial)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, l]) => kindToRow(k, l)),
  );
  const canonical = (m: Record<string, AdminGroupKindLimits>) =>
    JSON.stringify(
      Object.keys(m)
        .sort()
        .map((k) => [k, rowToLimits(kindToRow(k, m[k] ?? {}))]),
    );
  const [saved, setSaved] = useState(() => canonical(initial));
  const { save, pending, error, savedAt } = useConfigSave(gameId);

  const next = useMemo(() => {
    const out: Record<string, AdminGroupKindLimits> = {};
    for (const r of rows) if (r.kind.trim()) out[r.kind.trim()] = rowToLimits(r);
    return out;
  }, [rows]);
  const serialized = canonical(next);
  const dirty = serialized !== saved;
  const problem = (() => {
    const seen = new Set<string>();
    for (const r of rows) {
      const kind = r.kind.trim();
      if (!kind) continue;
      if (kind.length > ADMIN_GROUP_KIND_MAX_LENGTH) {
        return `"${kind.slice(0, 16)}..." is longer than ${ADMIN_GROUP_KIND_MAX_LENGTH} characters.`;
      }
      if (seen.has(kind)) return `The kind "${kind}" is listed twice.`;
      seen.add(kind);
      for (const { field, label, min, max } of LIMIT_FIELDS) {
        const raw = r[field].trim();
        if (raw === "") continue;
        const n = Number(raw);
        if (!Number.isInteger(n) || n < min || n > max) {
          return `${label} for ${kind} must be a whole number from ${min} to ${max.toLocaleString("en-US")}.`;
        }
      }
    }
    return null;
  })();

  const update = (id: number, patch: Partial<KindRow>) =>
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  return (
    <SettingRow
      label="Group kinds"
      hint="Limits for every group of a kind. A blank field imposes nothing; a kind left out has no limits."
    >
      <div className="flex flex-col gap-2">
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No group kind has limits.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="py-1.5 pr-2 font-medium">Kind</th>
                  {LIMIT_FIELDS.map((f) => (
                    <th key={f.field} className="py-1.5 pr-2 font-medium">
                      {f.label}
                    </th>
                  ))}
                  <th className="py-1.5 pr-2 font-medium">Delete empty</th>
                  <th className="py-1.5" aria-label="Remove" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-border/60 last:border-0">
                    <td className="py-1.5 pr-2">
                      <input
                        aria-label="Group kind"
                        value={r.kind}
                        placeholder="kind"
                        disabled={pending}
                        onChange={(e) => update(r.id, { kind: e.target.value })}
                        className={inputClass("w-28 font-mono")}
                      />
                    </td>
                    {LIMIT_FIELDS.map((f) => (
                      <td key={f.field} className="py-1.5 pr-2">
                        <input
                          aria-label={`${f.label} for ${r.kind || "kind"}`}
                          type="number"
                          inputMode="numeric"
                          min={f.min}
                          max={f.max}
                          value={r[f.field]}
                          placeholder="none"
                          disabled={pending}
                          onChange={(e) => update(r.id, { [f.field]: e.target.value })}
                          className={inputClass("w-20")}
                        />
                      </td>
                    ))}
                    <td className="py-1.5 pr-2">
                      <input
                        type="checkbox"
                        aria-label={`Delete ${r.kind || "kind"} groups when empty`}
                        checked={r.deleteWhenEmpty}
                        disabled={pending}
                        onChange={(e) => update(r.id, { deleteWhenEmpty: e.target.checked })}
                        className="h-4 w-4"
                      />
                    </td>
                    <td className="py-1.5 text-right">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Remove ${r.kind || "row"}`}
                        disabled={pending}
                        onClick={() => setRows((rs) => rs.filter((x) => x.id !== r.id))}
                      >
                        <X className="h-4 w-4" aria-hidden />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div>
          <Button
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={() => setRows((rs) => [...rs, kindToRow("", {})])}
          >
            <Plus className="h-4 w-4" aria-hidden />
            Add kind
          </Button>
        </div>
        <SaveBar
          label="Save limits"
          dirty={dirty}
          problem={problem}
          pending={pending}
          error={error}
          savedAt={savedAt}
          onSave={() => save({ config: { groups: { kinds: next } } }, () => setSaved(serialized))}
        />
      </div>
    </SettingRow>
  );
}

export function StructureSettings({
  gameId,
  formats,
  kinds,
}: {
  gameId: string;
  formats: Record<string, AdminUserIdFormat>;
  kinds: Record<string, AdminGroupKindLimits>;
}) {
  return (
    <>
      <SettingsGroup id="identity" title="Identity">
        <IdFormatsEditor gameId={gameId} initial={formats} />
      </SettingsGroup>
      <SettingsGroup id="groups" title="Groups">
        <GroupKindsEditor gameId={gameId} initial={kinds} />
      </SettingsGroup>
    </>
  );
}
