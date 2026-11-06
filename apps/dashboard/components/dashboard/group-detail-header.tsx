// @license All Rights Reserved (see apps/dashboard/LICENSE)
import type { AdminGroup } from "../../lib/admin-shared";

const numberFormatter = new Intl.NumberFormat("en-US");

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
});

const dateTimeFormatter = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

// Labels for the stored visibility values; unknown values show as stored.
const VISIBILITY_LABELS: Record<string, string> = {
  public: "Public",
  "invite-only": "Invite-only",
  secret: "Secret",
};

export function visibilityLabel(visibility: string): string {
  return VISIBILITY_LABELS[visibility] ?? visibility;
}

// The page header's meta line: id, kind, visibility.
export function GroupMeta({ group }: { group: AdminGroup }) {
  return (
    <>
      <span className="font-mono">{group.id}</span>
      <span className="mx-2 text-border">/</span>
      {group.kind}
      <span className="mx-2 text-border">/</span>
      {visibilityLabel(group.visibility)}
    </>
  );
}

function Figure({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex flex-col-reverse">
      <dt className="mt-1 text-sm text-muted-foreground">{label}</dt>
      <dd className="font-condensed text-3xl font-semibold tabular-nums leading-none">{value}</dd>
    </div>
  );
}

function DateFigure({ iso, label }: { iso: string; label: string }) {
  return (
    <div className="flex flex-col-reverse">
      <dt className="mt-1 text-sm text-muted-foreground">{label}</dt>
      <dd className="text-base font-medium tabular-nums leading-none">
        <time dateTime={iso} title={dateTimeFormatter.format(new Date(iso))}>
          {dateFormatter.format(new Date(iso))}
        </time>
      </dd>
    </div>
  );
}

// The group's size and age, as a row of figures under the page header.
export function GroupFigures({ group }: { group: AdminGroup }) {
  return (
    <dl className="flex flex-wrap items-end gap-x-12 gap-y-4">
      <Figure value={numberFormatter.format(group.memberCount)} label="active members" />
      <DateFigure iso={group.createdAt} label="created" />
      <DateFigure iso={group.updatedAt} label="updated" />
    </dl>
  );
}
