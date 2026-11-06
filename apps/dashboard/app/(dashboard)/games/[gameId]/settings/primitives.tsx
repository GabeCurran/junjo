// @license All Rights Reserved (see apps/dashboard/LICENSE)
"use client";

import { type ReactNode, useCallback, useId, useState, useTransition } from "react";

import type { AdminGameConfigPatch } from "../../../../../lib/admin";
import { cn } from "../../../../../lib/utils";
import { updateGameConfigAction } from "./actions";

// One save channel per editor, so a refusal shows next to what caused it.
export function useConfigSave(gameId: string) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const save = useCallback(
    (patch: AdminGameConfigPatch, onSaved?: () => void) => {
      setError(null);
      startTransition(async () => {
        const result = await updateGameConfigAction(gameId, patch);
        if (!result.ok) {
          setError(result.error ?? "The server refused the change.");
          return;
        }
        setSavedAt(new Date());
        onSaved?.();
      });
    },
    [gameId],
  );
  return { save, pending, error, savedAt };
}

// The strip under an editor: refusal, progress, or when it last saved.
export function SaveStatus({
  pending,
  error,
  savedAt,
}: {
  pending: boolean;
  error: string | null;
  savedAt: Date | null;
}) {
  if (error) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {error.replace(/^admin request failed: /, "")}
      </p>
    );
  }
  if (pending) return <p className="text-sm text-muted-foreground">Saving</p>;
  if (savedAt) {
    return (
      <p className="text-sm text-muted-foreground">
        Saved at {savedAt.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
      </p>
    );
  }
  return null;
}

// A settings group: its name and anchor on the left at wide widths,
// the rows on the right.
export function SettingsGroup({
  id,
  title,
  status,
  children,
}: {
  id: string;
  title: string;
  status?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-6">
      <div className="flex items-baseline justify-between gap-4 border-b border-border pb-2">
        <h2 id={`${id}-title`} className="text-lg font-semibold">
          {title}
        </h2>
        {status}
      </div>
      <div className="divide-y divide-border/60">{children}</div>
    </section>
  );
}

// Label and hint on the left, the control on the right.
export function SettingRow({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-2 py-4 md:grid-cols-[15rem_minmax(0,1fr)] md:gap-6">
      <div>
        {htmlFor ? (
          <label htmlFor={htmlFor} className="text-sm font-medium">
            {label}
          </label>
        ) : (
          <p className="text-sm font-medium">{label}</p>
        )}
        {hint ? <p className="mt-0.5 text-sm text-muted-foreground">{hint}</p> : null}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function Switch({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  // The accessible name; the visible label sits in the row.
  label: string;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors disabled:opacity-50",
        checked ? "border-primary bg-primary" : "border-input bg-muted",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "inline-block h-4 w-4 rounded-full bg-background shadow transition-transform",
          checked ? "translate-x-6" : "translate-x-1",
        )}
      />
    </button>
  );
}

export function NumberField({
  id,
  value,
  min,
  max,
  disabled,
  onCommit,
}: {
  id?: string;
  value: number;
  min?: number;
  max?: number;
  disabled?: boolean;
  onCommit: (next: number) => void;
}) {
  const [local, setLocal] = useState(String(value));
  return (
    <input
      id={id}
      type="number"
      inputMode="numeric"
      min={min}
      max={max}
      value={local}
      disabled={disabled}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={() => {
        const n = Number(local);
        if (local !== "" && Number.isInteger(n) && n !== value) onCommit(n);
        else setLocal(String(value));
      }}
      className={inputClass("w-32")}
    />
  );
}

export function TextField({
  id,
  value,
  placeholder,
  disabled,
  onCommit,
}: {
  id?: string;
  value: string;
  placeholder?: string;
  disabled?: boolean;
  onCommit: (next: string) => void;
}) {
  const [local, setLocal] = useState(value);
  return (
    <input
      id={id}
      type="text"
      value={local}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={() => {
        if (local !== value) onCommit(local.trim());
      }}
      className={inputClass("w-full max-w-sm")}
    />
  );
}

// A row of mutually exclusive choices, set as a segmented control.
export function Segmented<T extends string>({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  disabled?: boolean;
  onChange: (next: T) => void;
}) {
  const name = useId();
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex w-fit flex-wrap rounded-md border border-input p-0.5"
    >
      {options.map((opt) => (
        <label
          key={opt.value}
          className={cn(
            "cursor-pointer rounded-sm px-3 py-1 text-sm transition-colors has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring",
            value === opt.value
              ? "bg-secondary font-medium text-foreground"
              : "text-muted-foreground hover:text-foreground",
            disabled && "cursor-not-allowed opacity-50",
          )}
        >
          <input
            type="radio"
            name={name}
            value={opt.value}
            checked={value === opt.value}
            disabled={disabled}
            onChange={() => onChange(opt.value)}
            className="sr-only"
          />
          {opt.label}
        </label>
      ))}
    </div>
  );
}

export function inputClass(extra?: string): string {
  return cn(
    "h-9 rounded-md border border-input bg-background px-2.5 text-sm placeholder:text-muted-foreground disabled:opacity-50",
    extra,
  );
}
