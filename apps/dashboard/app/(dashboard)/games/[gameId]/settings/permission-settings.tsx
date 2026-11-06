// @license All Rights Reserved (see apps/dashboard/LICENSE)
"use client";

import { Plus, X } from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "../../../../../components/ui/button";
import {
  ADMIN_CONTEXT_KEY_PATTERN,
  type AdminContextInheritance,
  type AdminPermissionMode,
} from "../../../../../lib/admin-shared";
import {
  SaveStatus,
  Segmented,
  SettingRow,
  SettingsGroup,
  inputClass,
  useConfigSave,
} from "./primitives";

const MODE_OPTIONS = [
  { value: "exact", label: "Exact" },
  { value: "nodes", label: "Nodes" },
] as const satisfies readonly { value: AdminPermissionMode; label: string }[];

function ModeSetting({ gameId, initial }: { gameId: string; initial: AdminPermissionMode }) {
  const [mode, setMode] = useState(initial);
  const [choice, setChoice] = useState(initial);
  const { save, pending, error, savedAt } = useConfigSave(gameId);
  const changing = choice !== mode;
  return (
    <SettingRow
      label="Key mode"
      hint="Exact matches keys as written. Nodes reads dots as a tree, folds case and allows wildcards."
    >
      <div className="flex flex-col gap-3">
        <Segmented
          label="Key mode"
          value={choice}
          options={MODE_OPTIONS}
          disabled={pending}
          onChange={setChoice}
        />
        {changing ? (
          <div className="flex max-w-xl flex-col gap-2 rounded-md border border-warn/50 bg-warn/10 p-3 text-sm">
            <p>
              Switching to {choice} checks every stored key first and refuses if one would change
              meaning.
              {choice === "nodes" ? " Keys that pass are lowercased." : ""}
            </p>
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={pending}
                onClick={() =>
                  save({ config: { permissions: { mode: choice } } }, () => setMode(choice))
                }
              >
                Switch to {choice}
              </Button>
              <Button size="sm" variant="ghost" disabled={pending} onClick={() => setChoice(mode)}>
                Keep {mode}
              </Button>
            </div>
          </div>
        ) : null}
        <SaveStatus pending={pending} error={error} savedAt={savedAt} />
      </div>
    </SettingRow>
  );
}

interface DraftValue {
  id: number;
  value: string;
  parents: string;
}

interface DraftKey {
  id: number;
  key: string;
  values: DraftValue[];
}

let nextDraftId = 1;
const draftId = () => nextDraftId++;

function toDraft(contexts: AdminContextInheritance): DraftKey[] {
  return Object.entries(contexts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, { inherit }]) => ({
      id: draftId(),
      key,
      values: Object.entries(inherit)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([value, parents]) => ({ id: draftId(), value, parents: parents.join(", ") })),
    }));
}

function splitParents(text: string): string[] {
  return text
    .split(",")
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p.length > 0);
}

// Values with no parents inherit nothing, so they are left out.
function fromDraft(draft: DraftKey[]): AdminContextInheritance {
  const out: AdminContextInheritance = {};
  for (const k of draft) {
    const inherit: Record<string, string[]> = {};
    for (const v of k.values) {
      const parents = splitParents(v.parents);
      if (v.value.trim().length > 0 && parents.length > 0) {
        inherit[v.value.trim().toLowerCase()] = parents;
      }
    }
    if (Object.keys(inherit).length > 0) out[k.key] = { inherit };
  }
  return out;
}

function draftProblem(draft: DraftKey[]): string | null {
  const keys = new Set<string>();
  for (const k of draft) {
    if (!ADMIN_CONTEXT_KEY_PATTERN.test(k.key)) {
      return `"${k.key}" is not a valid context key: start with a letter, then lowercase letters, digits or underscores, up to 32 characters.`;
    }
    if (keys.has(k.key)) return `The context key "${k.key}" is listed twice.`;
    keys.add(k.key);
    const values = new Set<string>();
    for (const v of k.values) {
      const value = v.value.trim().toLowerCase();
      if (value.length === 0) {
        if (splitParents(v.parents).length > 0) return `A ${k.key} row has parents but no value.`;
        continue;
      }
      if (values.has(value)) return `${k.key} lists "${value}" twice.`;
      values.add(value);
    }
  }
  return null;
}

// What a check in `value` also sees, nearest first: the same walk the
// server ranks contextual entries by.
function chainOf(inherit: Record<string, string[]>, value: string): string[] {
  const seen = new Set([value]);
  const order: string[] = [];
  let frontier = [value];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const v of frontier) {
      for (const parent of inherit[v] ?? []) {
        if (seen.has(parent)) continue;
        seen.add(parent);
        order.push(parent);
        next.push(parent);
      }
    }
    frontier = next;
  }
  return order;
}

function ContextsEditor({ gameId, initial }: { gameId: string; initial: AdminContextInheritance }) {
  const [saved, setSaved] = useState(() => JSON.stringify(fromDraft(toDraft(initial))));
  const [draft, setDraft] = useState(() => toDraft(initial));
  const [newKey, setNewKey] = useState("");
  const { save, pending, error, savedAt } = useConfigSave(gameId);

  const problem = draftProblem(draft);
  const next = useMemo(() => fromDraft(draft), [draft]);
  const dirty = JSON.stringify(next) !== saved;

  const updateKey = (id: number, fn: (k: DraftKey) => DraftKey) =>
    setDraft((d) => d.map((k) => (k.id === id ? fn(k) : k)));
  const updateValue = (keyId: number, valueId: number, patch: Partial<DraftValue>) =>
    updateKey(keyId, (k) => ({
      ...k,
      values: k.values.map((v) => (v.id === valueId ? { ...v, ...patch } : v)),
    }));

  const addKey = () => {
    const key = newKey.trim();
    if (key.length === 0) return;
    setDraft((d) => [
      ...d,
      { id: draftId(), key, values: [{ id: draftId(), value: "", parents: "" }] },
    ]);
    setNewKey("");
  };

  return (
    <SettingRow
      label="Context inheritance"
      hint="A value lists the values whose entries it also sees, nearest first. Unlisted values see only their own entries."
    >
      <div className="flex flex-col gap-5">
        {draft.length === 0 ? (
          <p className="text-sm text-muted-foreground">No context inherits from another.</p>
        ) : null}
        {draft.map((k) => {
          const inherit = next[k.key]?.inherit ?? {};
          return (
            <div key={k.id} className="rounded-md border border-border">
              <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
                <code className="font-mono text-sm font-medium">{k.key}</code>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={pending}
                  onClick={() => setDraft((d) => d.filter((x) => x.id !== k.id))}
                >
                  Remove {k.key}
                </Button>
              </div>
              <div className="flex flex-col gap-2 p-3">
                <div className="hidden grid-cols-[minmax(0,12rem)_minmax(0,1fr)_2.25rem] gap-2 text-xs text-muted-foreground sm:grid">
                  <span>Value</span>
                  <span>Inherits from</span>
                </div>
                {k.values.map((v) => {
                  const value = v.value.trim().toLowerCase();
                  const chain = value ? chainOf(inherit, value) : [];
                  return (
                    <div key={v.id} className="flex flex-col gap-1">
                      <div className="grid grid-cols-[minmax(0,1fr)_2.25rem] gap-2 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)_2.25rem]">
                        <input
                          aria-label={`${k.key} value`}
                          value={v.value}
                          placeholder="value"
                          disabled={pending}
                          onChange={(e) => updateValue(k.id, v.id, { value: e.target.value })}
                          className={inputClass("col-span-1 font-mono")}
                        />
                        <input
                          aria-label={`Values ${v.value || "this value"} inherits from`}
                          value={v.parents}
                          placeholder="parent, grandparent"
                          disabled={pending}
                          onChange={(e) => updateValue(k.id, v.id, { parents: e.target.value })}
                          className={inputClass(
                            "order-3 col-span-2 font-mono sm:order-none sm:col-span-1",
                          )}
                        />
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Remove ${v.value || "row"}`}
                          disabled={pending}
                          onClick={() =>
                            updateKey(k.id, (x) => ({
                              ...x,
                              values: x.values.filter((y) => y.id !== v.id),
                            }))
                          }
                        >
                          <X className="h-4 w-4" aria-hidden />
                        </Button>
                      </div>
                      {chain.length > 0 ? (
                        <p className="text-xs text-muted-foreground">
                          Checks in <span className="font-mono text-foreground">{value}</span> also
                          see{" "}
                          {chain.map((c, i) => (
                            <span key={c}>
                              {i > 0 ? ", then " : ""}
                              <span className="font-mono text-foreground">{c}</span>
                            </span>
                          ))}
                        </p>
                      ) : null}
                    </div>
                  );
                })}
                <div>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={pending}
                    onClick={() =>
                      updateKey(k.id, (x) => ({
                        ...x,
                        values: [...x.values, { id: draftId(), value: "", parents: "" }],
                      }))
                    }
                  >
                    <Plus className="h-4 w-4" aria-hidden />
                    Add value
                  </Button>
                </div>
              </div>
            </div>
          );
        })}
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            addKey();
          }}
        >
          <input
            aria-label="New context key"
            value={newKey}
            placeholder="context key"
            disabled={pending}
            onChange={(e) => setNewKey(e.target.value)}
            className={inputClass("w-48 font-mono")}
          />
          <Button type="submit" variant="outline" size="sm" disabled={pending || !newKey.trim()}>
            Add context key
          </Button>
        </form>
        <div className="flex flex-wrap items-center gap-3 border-t border-border pt-3">
          <Button
            size="sm"
            disabled={pending || !dirty || problem !== null}
            onClick={() =>
              save({ config: { permissions: { contexts: next } } }, () =>
                setSaved(JSON.stringify(next)),
              )
            }
          >
            Save inheritance
          </Button>
          {problem ? (
            <p className="text-sm text-destructive">{problem}</p>
          ) : dirty && !pending && !error ? (
            <p className="text-sm text-muted-foreground">Unsaved changes</p>
          ) : (
            <SaveStatus pending={pending} error={error} savedAt={savedAt} />
          )}
        </div>
      </div>
    </SettingRow>
  );
}

export function PermissionSettings({
  gameId,
  mode,
  contexts,
}: {
  gameId: string;
  mode: AdminPermissionMode;
  contexts: AdminContextInheritance;
}) {
  return (
    <SettingsGroup id="permissions" title="Permissions">
      <ModeSetting gameId={gameId} initial={mode} />
      <ContextsEditor gameId={gameId} initial={contexts} />
    </SettingsGroup>
  );
}
