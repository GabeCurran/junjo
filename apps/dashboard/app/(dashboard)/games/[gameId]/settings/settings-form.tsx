// @license All Rights Reserved (see apps/dashboard/LICENSE)
"use client";

import { useState } from "react";

import type { AdminGameConfig, AdminGameConfigPatch } from "../../../../../lib/admin";
import { PermissionSettings } from "./permission-settings";
import {
  NumberField,
  SaveStatus,
  Segmented,
  SettingRow,
  SettingsGroup,
  Switch,
  TextField,
  useConfigSave,
} from "./primitives";
import { StructureSettings } from "./structure-settings";

type Visibility = "private" | "friends-only" | "public";

const VISIBILITY_OPTIONS: readonly { value: Visibility; label: string }[] = [
  { value: "private", label: "Private" },
  { value: "friends-only", label: "Friends only" },
  { value: "public", label: "Public" },
];

const SECTIONS = [
  { id: "permissions", label: "Permissions" },
  { id: "identity", label: "Identity" },
  { id: "groups", label: "Groups" },
  { id: "friends", label: "Friends" },
  { id: "blocks", label: "Blocks" },
] as const;

interface SettingsFormProps {
  initial: AdminGameConfig;
  gameId: string;
}

// Friends, tags, visibility and blocks: each control saves on change.
function SocialSettings({ initial, gameId }: SettingsFormProps) {
  const [config, setConfig] = useState(initial.config);
  const [networkId, setNetworkId] = useState<string | null>(initial.networkId);
  const friendsSave = useConfigSave(gameId);
  const blocksSave = useConfigSave(gameId);

  const updateFriends = (patch: NonNullable<AdminGameConfigPatch["config"]>) => {
    const friendsPatch = patch.friends;
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
    friendsSave.save({ config: patch });
  };

  const f = config.friends;
  const pending = friendsSave.pending;

  return (
    <>
      <SettingsGroup id="friends" title="Friends" status={<SaveStatus {...friendsSave} />}>
        <SettingRow label="Friends" hint="Off turns every friends route into a 404.">
          <Switch
            label="Enable friends"
            checked={f.enabled}
            disabled={pending}
            onChange={(v) => updateFriends({ friends: { enabled: v } })}
          />
        </SettingRow>
        <SettingRow
          label="Scope"
          hint="Network shares friendships with games that use the same network id."
        >
          <div className="flex flex-col gap-3">
            <Segmented
              label="Friend scope"
              value={f.scope}
              options={[
                { value: "per-game", label: "This game" },
                { value: "network", label: "Network" },
              ]}
              disabled={pending}
              onChange={(v) => updateFriends({ friends: { scope: v } })}
            />
            {f.scope === "network" ? (
              <TextField
                value={networkId ?? ""}
                placeholder="network id"
                disabled={pending}
                onCommit={(v) => {
                  const next = v.length > 0 ? v : null;
                  setNetworkId(next);
                  friendsSave.save({ networkId: next });
                }}
              />
            ) : null}
          </div>
        </SettingRow>
        <SettingRow label="Requests" hint="Off makes a request an instant friendship.">
          <Switch
            label="Require friend request acceptance"
            checked={f.requestsRequired}
            disabled={pending}
            onChange={(v) => updateFriends({ friends: { requestsRequired: v } })}
          />
        </SettingRow>
        <SettingRow label="Max friends" htmlFor="max-friends">
          <NumberField
            id="max-friends"
            value={f.maxFriends}
            min={1}
            max={100_000}
            disabled={pending}
            onCommit={(v) => updateFriends({ friends: { maxFriends: v } })}
          />
        </SettingRow>
        <SettingRow label="Max pending requests" htmlFor="max-pending">
          <NumberField
            id="max-pending"
            value={f.maxPendingRequests}
            min={1}
            max={10_000}
            disabled={pending}
            onCommit={(v) => updateFriends({ friends: { maxPendingRequests: v } })}
          />
        </SettingRow>
        <SettingRow label="Tags" hint="Labels people put on their friends.">
          <div className="flex items-center gap-4">
            <Switch
              label="Enable friend tags"
              checked={f.tags.enabled}
              disabled={pending}
              onChange={(v) => updateFriends({ friends: { tags: { enabled: v } } })}
            />
            <span className="text-sm text-muted-foreground">up to</span>
            <NumberField
              value={f.tags.maxPerUser}
              min={1}
              max={1000}
              disabled={pending}
              onCommit={(v) => updateFriends({ friends: { tags: { maxPerUser: v } } })}
            />
            <span className="text-sm text-muted-foreground">per person</span>
          </div>
        </SettingRow>
        <SettingRow label="Suggestions" hint="Suggest people who share enough mutual friends.">
          <div className="flex items-center gap-4">
            <Switch
              label="Enable mutual-friend suggestions"
              checked={f.discovery.enabled}
              disabled={pending}
              onChange={(v) => updateFriends({ friends: { discovery: { enabled: v } } })}
            />
            <span className="text-sm text-muted-foreground">at</span>
            <NumberField
              value={f.discovery.minMutuals}
              min={1}
              max={50}
              disabled={pending}
              onCommit={(v) => updateFriends({ friends: { discovery: { minMutuals: v } } })}
            />
            <span className="text-sm text-muted-foreground">mutuals</span>
          </div>
        </SettingRow>
        <SettingRow
          label="List visibility"
          hint="Which levels people can pick, and the one new people start with. Narrowing it keeps existing choices."
        >
          <div className="flex flex-col gap-2">
            {VISIBILITY_OPTIONS.map((opt) => {
              const allowed = f.visibility.allowed.includes(opt.value);
              const isDefault = f.visibility.default === opt.value;
              return (
                <div key={opt.value} className="flex items-center gap-4 text-sm">
                  <label className="flex w-36 items-center gap-2">
                    <input
                      type="checkbox"
                      checked={allowed}
                      disabled={pending || isDefault}
                      onChange={(e) => {
                        const next = e.target.checked
                          ? [...f.visibility.allowed, opt.value]
                          : f.visibility.allowed.filter((v) => v !== opt.value);
                        if (next.length > 0) {
                          updateFriends({ friends: { visibility: { allowed: next } } });
                        }
                      }}
                      className="h-4 w-4"
                    />
                    {opt.label}
                  </label>
                  {isDefault ? (
                    <span className="text-muted-foreground">Default</span>
                  ) : allowed ? (
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() =>
                        updateFriends({ friends: { visibility: { default: opt.value } } })
                      }
                      className="text-primary hover:underline disabled:opacity-50"
                    >
                      Make default
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup id="blocks" title="Blocks" status={<SaveStatus {...blocksSave} />}>
        <SettingRow label="Blocks" hint="Off turns every block route into a 404.">
          <Switch
            label="Enable blocks"
            checked={config.blocks.enabled}
            disabled={blocksSave.pending}
            onChange={(v) => {
              setConfig((prev) => ({ ...prev, blocks: { ...prev.blocks, enabled: v } }));
              blocksSave.save({ config: { blocks: { enabled: v } } });
            }}
          />
        </SettingRow>
      </SettingsGroup>
    </>
  );
}

export function SettingsForm({ initial, gameId }: SettingsFormProps) {
  const c = initial.config;
  return (
    <div className="grid gap-10 lg:grid-cols-[10rem_minmax(0,1fr)]">
      <nav aria-label="Settings sections" className="hidden lg:block">
        <ul className="sticky top-8 flex flex-col gap-0.5 text-sm">
          {SECTIONS.map((s) => (
            <li key={s.id}>
              <a
                href={`#${s.id}`}
                className="block rounded-sm px-2 py-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                {s.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <div className="flex min-w-0 flex-col gap-10">
        <PermissionSettings
          gameId={gameId}
          mode={c.permissions.mode}
          contexts={c.permissions.contexts}
        />
        <StructureSettings gameId={gameId} formats={c.identity.formats} kinds={c.groups.kinds} />
        <SocialSettings initial={initial} gameId={gameId} />
      </div>
    </div>
  );
}
