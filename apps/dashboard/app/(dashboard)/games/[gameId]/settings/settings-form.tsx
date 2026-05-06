// @license All Rights Reserved (see apps/dashboard/LICENSE)
"use client";

import { useState, useTransition } from "react";
import type { AdminGameConfig, AdminGameConfigPatch } from "../../../../../lib/admin";
import { updateGameConfigAction } from "./actions";

const VISIBILITY_OPTIONS: ("private" | "friends-only" | "public")[] = [
  "private",
  "friends-only",
  "public",
];

interface SettingsFormProps {
  initial: AdminGameConfig;
  gameId: string;
}

export function SettingsForm({ initial, gameId }: SettingsFormProps) {
  const [config, setConfig] = useState(initial.config);
  const [networkId, setNetworkId] = useState<string | null>(initial.networkId);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<Date | null>(null);

  const submit = (patch: AdminGameConfigPatch) => {
    setError(null);
    startTransition(async () => {
      const result = await updateGameConfigAction(gameId, patch);
      if (!result.ok) {
        setError(result.error ?? "save failed");
      } else {
        setSavedAt(new Date());
      }
    });
  };

  const updateFriends = (patch: AdminGameConfigPatch["config"]) => {
    const friendsPatch = patch?.friends;
    if (!friendsPatch) return;
    setConfig((prev) => ({
      ...prev,
      friends: {
        ...prev.friends,
        ...friendsPatch,
        tags: { ...prev.friends.tags, ...(friendsPatch.tags ?? {}) },
        discovery: { ...prev.friends.discovery, ...(friendsPatch.discovery ?? {}) },
        visibility: { ...prev.friends.visibility, ...(friendsPatch.visibility ?? {}) },
      },
    }));
    submit({ config: patch });
  };

  const updateBlocks = (patch: AdminGameConfigPatch["config"]) => {
    if (!patch?.blocks) return;
    setConfig((prev) => ({ ...prev, blocks: { ...prev.blocks, ...patch.blocks } }));
    submit({ config: patch });
  };

  const updateNetworkId = (value: string | null) => {
    setNetworkId(value);
    submit({ networkId: value });
  };

  const f = config.friends;
  const b = config.blocks;

  return (
    <div className="flex flex-col gap-6">
      {error ? (
        <div className="rounded-md border border-destructive bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}
      {savedAt && !error ? (
        <div className="text-xs text-muted-foreground">
          Saved {savedAt.toLocaleTimeString()}
          {pending ? " (saving...)" : ""}
        </div>
      ) : null}

      {/* Friends */}
      <Section title="Friends">
        <Toggle
          label="Enable friends"
          description="Master switch. When off, every friends route returns 404."
          checked={f.enabled}
          disabled={pending}
          onChange={(v) => updateFriends({ friends: { enabled: v } })}
        />
        <Radio
          label="Friend scope"
          description="Just this game isolates friendships per game. Shared across my game network lets sibling games with the same Network ID see each others friendships."
          value={f.scope}
          options={[
            { value: "per-game", label: "Just this game" },
            { value: "network", label: "Shared across my game network" },
          ]}
          disabled={pending}
          onChange={(v) => updateFriends({ friends: { scope: v as "per-game" | "network" } })}
        />
        {f.scope === "network" ? (
          <TextInput
            label="Network ID"
            description="Sibling games with the same value AND scope=network share visibility."
            value={networkId ?? ""}
            disabled={pending}
            onCommit={(v) => updateNetworkId(v.length > 0 ? v : null)}
          />
        ) : null}
        <Toggle
          label="Require friend request acceptance"
          description="When off, sending a request creates the friendship immediately (no pending state)."
          checked={f.requestsRequired}
          disabled={pending}
          onChange={(v) => updateFriends({ friends: { requestsRequired: v } })}
        />
        <NumberInput
          label="Max friends per user"
          value={f.maxFriends}
          disabled={pending}
          onCommit={(v) => updateFriends({ friends: { maxFriends: v } })}
        />
        <NumberInput
          label="Max pending outbound requests"
          value={f.maxPendingRequests}
          disabled={pending}
          onCommit={(v) => updateFriends({ friends: { maxPendingRequests: v } })}
        />
      </Section>

      {/* Tags & discovery */}
      <Section title="Tags &amp; discovery">
        <Toggle
          label="Enable friend tags"
          description="When off, tag routes return 404 and the dashboard hides tag UI."
          checked={f.tags.enabled}
          disabled={pending}
          onChange={(v) => updateFriends({ friends: { tags: { enabled: v } } })}
        />
        <NumberInput
          label="Max tags per user"
          value={f.tags.maxPerUser}
          disabled={pending}
          onCommit={(v) => updateFriends({ friends: { tags: { maxPerUser: v } } })}
        />
        <Toggle
          label="Enable mutual-friend suggestions"
          checked={f.discovery.enabled}
          disabled={pending}
          onChange={(v) => updateFriends({ friends: { discovery: { enabled: v } } })}
        />
        <NumberInput
          label="Minimum mutual friends for suggestions"
          value={f.discovery.minMutuals}
          disabled={pending}
          onCommit={(v) => updateFriends({ friends: { discovery: { minMutuals: v } } })}
        />
      </Section>

      {/* Visibility */}
      <Section title="Visibility">
        <CheckboxGroup
          label="Allowed visibility levels"
          description="The set users can choose from. Restricting this never deletes existing data."
          values={f.visibility.allowed}
          options={VISIBILITY_OPTIONS}
          disabled={pending}
          onChange={(values) =>
            updateFriends({
              friends: {
                visibility: {
                  allowed: values as ("private" | "friends-only" | "public")[],
                },
              },
            })
          }
        />
        <Radio
          label="Default visibility for new users"
          value={f.visibility.default}
          options={f.visibility.allowed.map((v) => ({ value: v, label: v }))}
          disabled={pending}
          onChange={(v) =>
            updateFriends({
              friends: {
                visibility: {
                  default: v as "private" | "friends-only" | "public",
                },
              },
            })
          }
        />
      </Section>

      {/* Blocks */}
      <Section title="Blocks">
        <Toggle
          label="Enable blocks"
          description="When off, block routes return 404."
          checked={b.enabled}
          disabled={pending}
          onChange={(v) => updateBlocks({ blocks: { enabled: v } })}
        />
      </Section>
    </div>
  );
}

// =====================================================================
// Tiny form primitives (kept inline to avoid pulling in another file
// for a one-page surface)
// =====================================================================

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset className="rounded-lg border border-border bg-card p-4">
      <legend className="px-2 text-sm font-semibold">{title}</legend>
      <div className="flex flex-col gap-4">{children}</div>
    </fieldset>
  );
}

function Toggle({
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-3">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1 h-4 w-4"
      />
      <div className="flex flex-col gap-0.5">
        <span className="text-sm">{label}</span>
        {description ? <span className="text-xs text-muted-foreground">{description}</span> : null}
      </div>
    </label>
  );
}

function Radio({
  label,
  description,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  description?: string;
  value: string;
  options: { value: string; label: string }[];
  disabled?: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-sm font-medium">{label}</span>
      {description ? <span className="text-xs text-muted-foreground">{description}</span> : null}
      <div className="mt-1 flex flex-col gap-1">
        {options.map((opt) => (
          <label key={opt.value} className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name={label}
              value={opt.value}
              checked={value === opt.value}
              disabled={disabled}
              onChange={() => onChange(opt.value)}
            />
            {opt.label}
          </label>
        ))}
      </div>
    </div>
  );
}

function CheckboxGroup({
  label,
  description,
  values,
  options,
  disabled,
  onChange,
}: {
  label: string;
  description?: string;
  values: string[];
  options: string[];
  disabled?: boolean;
  onChange: (next: string[]) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-sm font-medium">{label}</span>
      {description ? <span className="text-xs text-muted-foreground">{description}</span> : null}
      <div className="mt-1 flex flex-col gap-1">
        {options.map((opt) => (
          <label key={opt} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={values.includes(opt)}
              disabled={disabled || (values.length === 1 && values[0] === opt)}
              onChange={(e) => {
                const next = e.target.checked
                  ? Array.from(new Set([...values, opt]))
                  : values.filter((v) => v !== opt);
                if (next.length === 0) return; // never allow empty
                onChange(next);
              }}
            />
            {opt}
          </label>
        ))}
      </div>
    </div>
  );
}

function TextInput({
  label,
  description,
  value,
  disabled,
  onCommit,
}: {
  label: string;
  description?: string;
  value: string;
  disabled?: boolean;
  onCommit: (v: string) => void;
}) {
  const [local, setLocal] = useState(value);
  return (
    <label className="flex flex-col gap-1">
      <span className="text-sm font-medium">{label}</span>
      {description ? <span className="text-xs text-muted-foreground">{description}</span> : null}
      <input
        type="text"
        value={local}
        disabled={disabled}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={() => {
          if (local !== value) onCommit(local);
        }}
        className="rounded-md border border-border bg-background px-2 py-1 text-sm"
      />
    </label>
  );
}

function NumberInput({
  label,
  description,
  value,
  disabled,
  onCommit,
}: {
  label: string;
  description?: string;
  value: number;
  disabled?: boolean;
  onCommit: (v: number) => void;
}) {
  const [local, setLocal] = useState(String(value));
  return (
    <label className="flex flex-col gap-1">
      <span className="text-sm font-medium">{label}</span>
      {description ? <span className="text-xs text-muted-foreground">{description}</span> : null}
      <input
        type="number"
        value={local}
        disabled={disabled}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={() => {
          const n = Number(local);
          if (Number.isFinite(n) && n !== value) onCommit(n);
        }}
        className="w-32 rounded-md border border-border bg-background px-2 py-1 text-sm"
      />
    </label>
  );
}
