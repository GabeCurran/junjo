// @license All Rights Reserved (see apps/dashboard/LICENSE)
"use client";

import { type ColumnDef, flexRender, getCoreRowModel, useReactTable } from "@tanstack/react-table";
import { Search } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

import {
  ADMIN_MEMBERS_PAGE_SIZE_OPTIONS,
  ADMIN_MEMBER_STATUS_FILTERS,
  type AdminGroupMember,
  type AdminGroupMemberList,
  type AdminMemberStatusFilter,
} from "../../lib/admin-shared";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { RoleChip } from "../ui/role-chip";
import { Notice } from "../ui/section";
import { EditMemberNotesDialog } from "./edit-member-notes-dialog";
import { InviteMemberDialog } from "./invite-member-dialog";
import { KickMemberDialog } from "./kick-member-dialog";
import { SetPermissionOverrideDialog } from "./set-permission-override-dialog";
import { ViewPermissionOverridesDialog } from "./view-permission-overrides-dialog";

const numberFormatter = new Intl.NumberFormat("en-US");
const dateFormatter = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
});

const SEARCH_DEBOUNCE_MS = 350;
const SEARCH_VALUE_MAX = 255;

const SELECT_CLASS = cn(
  "h-9 rounded-md border border-input bg-background px-3 text-sm ring-offset-background",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
);

export interface MembersQueryState {
  q: string;
  status: AdminMemberStatusFilter;
  offset: number;
  limit: number;
}

interface MembersTableProps {
  data: AdminGroupMemberList;
  query: MembersQueryState;
  // Both ids are needed to construct row-action links into the admin
  // endpoints. Passed from the page (Server Component) since the Client
  // Component cannot read params.
  gameId: string;
  groupId: string;
}

interface StatusOption {
  value: AdminMemberStatusFilter;
  label: string;
}

const STATUS_OPTIONS: readonly StatusOption[] = [
  { value: "active", label: "Active" },
  { value: "left", label: "Left" },
  { value: "kicked", label: "Kicked" },
  { value: "invited", label: "Invited" },
  { value: "all", label: "All" },
];

// Drop empty / default values from the URL so a stale query string does not
// pile up `?q=&status=active`. Active is the default so it stays implicit.
function buildSearchParamsFromQuery(query: MembersQueryState): URLSearchParams {
  const next = new URLSearchParams();
  if (query.q.length > 0) next.set("q", query.q);
  if (query.status !== "active") next.set("status", query.status);
  if (query.offset > 0) next.set("offset", String(query.offset));
  if (query.limit !== 50) next.set("limit", String(query.limit));
  return next;
}

function statusBadgeVariant(status: string): "secondary" | "muted" | "destructive" | "outline" {
  switch (status) {
    case "active":
      return "secondary";
    case "left":
      return "muted";
    case "kicked":
      return "destructive";
    case "invited":
      return "outline";
    default:
      return "muted";
  }
}

function statusLabel(status: string): string {
  return STATUS_OPTIONS.find((o) => o.value === status)?.label ?? status;
}

export function MembersTable({ data, query, gameId, groupId }: MembersTableProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const searchInputId = useId();
  const statusSelectId = useId();
  const pageSizeSelectId = useId();

  // Local search state mirrors the URL `q`. We push the URL after a 350ms
  // idle window so a fast typer does not trigger 8 server fetches per word.
  // skipFirstEffectRef suppresses the mount-time effect (we already have the
  // right URL).
  const [searchValue, setSearchValue] = useState(query.q);
  const skipFirstEffectRef = useRef(true);

  const pushQuery = useCallback(
    (updates: Partial<MembersQueryState>) => {
      const merged: MembersQueryState = { ...query, ...updates };
      const next = buildSearchParamsFromQuery(merged);
      const target = next.toString();
      const current = searchParams?.toString() ?? "";
      if (target === current) return;
      router.replace(target.length > 0 ? `${pathname}?${target}` : pathname, { scroll: false });
    },
    [pathname, query, router, searchParams],
  );

  // Reset the local search box when the URL `q` changes from outside,
  // through history navigation.
  useEffect(() => {
    setSearchValue(query.q);
  }, [query.q]);

  useEffect(() => {
    if (skipFirstEffectRef.current) {
      skipFirstEffectRef.current = false;
      return;
    }
    if (searchValue === query.q) return;
    const handle = setTimeout(() => {
      pushQuery({ q: searchValue, offset: 0 });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(handle);
    };
  }, [searchValue, query.q, pushQuery]);

  const columns = useMemo<ColumnDef<AdminGroupMember>[]>(
    () => [
      {
        accessorKey: "externalUserId",
        header: "User",
        cell: ({ row }) => (
          <div className="flex flex-col">
            <span className="font-mono">{row.original.externalUserId}</span>
            <span className="font-mono text-xs text-muted-foreground" title="Junjo user id">
              {row.original.junjoUserId}
            </span>
          </div>
        ),
      },
      {
        accessorKey: "status",
        header: "Status",
        cell: ({ row }) => (
          <Badge variant={statusBadgeVariant(row.original.status)}>
            {statusLabel(row.original.status)}
          </Badge>
        ),
      },
      {
        accessorKey: "roles",
        header: "Roles",
        cell: ({ row }) => {
          const roles = row.original.roles;
          if (roles.length === 0) {
            return <span className="text-muted-foreground">-</span>;
          }
          return (
            <div className="flex flex-wrap gap-1">
              {roles.map((r) => (
                <RoleChip key={r.id} name={r.name} color={r.color} />
              ))}
            </div>
          );
        },
      },
      {
        accessorKey: "notesPublic",
        header: "Public note",
        cell: ({ row }) => {
          const note = row.original.notesPublic;
          if (!note) return <span className="text-muted-foreground">-</span>;
          // Truncate visually via CSS; the full note is one click away in
          // the Notes row-action dialog.
          return (
            <span
              className="inline-block max-w-[16rem] truncate align-bottom text-muted-foreground"
              title={note}
            >
              {note}
            </span>
          );
        },
      },
      {
        accessorKey: "joinedAt",
        header: "Joined",
        cell: ({ row }) => (
          <span className="whitespace-nowrap text-muted-foreground">
            {dateFormatter.format(new Date(row.original.joinedAt))}
          </span>
        ),
      },
      {
        id: "actions",
        header: () => <span className="sr-only">Actions</span>,
        // Each action is its own dialog. Rendered inline rather than behind
        // a dropdown menu to keep the row's surface area focused; four
        // buttons fit on a desktop row and the dashboard assumes
        // desk-bound operators.
        cell: ({ row }) => {
          const m = row.original;
          return (
            <div className="flex flex-wrap items-center justify-end gap-1">
              <EditMemberNotesDialog
                gameId={gameId}
                groupId={groupId}
                userId={m.externalUserId}
                externalUserId={m.externalUserId}
                notesPublic={m.notesPublic}
                notesPrivate={m.notesPrivate}
              />
              <SetPermissionOverrideDialog
                gameId={gameId}
                groupId={groupId}
                userId={m.externalUserId}
                externalUserId={m.externalUserId}
              />
              <ViewPermissionOverridesDialog
                gameId={gameId}
                groupId={groupId}
                userId={m.externalUserId}
                externalUserId={m.externalUserId}
              />
              <KickMemberDialog
                gameId={gameId}
                groupId={groupId}
                userId={m.externalUserId}
                externalUserId={m.externalUserId}
                status={m.status}
              />
            </div>
          );
        },
      },
    ],
    [gameId, groupId],
  );

  const table = useReactTable<AdminGroupMember>({
    data: data.items,
    columns,
    // Server-driven: the table is a presentation layer. Sorting, filtering,
    // and pagination all happen on the server via URL state.
    manualSorting: true,
    manualFiltering: true,
    manualPagination: true,
    pageCount: Math.max(1, Math.ceil(data.total / query.limit)),
    getCoreRowModel: getCoreRowModel(),
  });

  const currentPage = Math.floor(query.offset / query.limit) + 1;
  const totalPages = Math.max(1, Math.ceil(data.total / query.limit));
  const start = data.total === 0 ? 0 : query.offset + 1;
  const end = query.offset + data.items.length;

  const filtered = query.q.length > 0 || query.status !== "active";

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              id={searchInputId}
              value={searchValue}
              onChange={(e) => setSearchValue(e.target.value)}
              placeholder="Search by user id"
              aria-label="Search members by external user id"
              className="w-full pl-9 sm:w-64"
              maxLength={SEARCH_VALUE_MAX}
              autoComplete="off"
            />
          </div>
          <label htmlFor={statusSelectId} className="sr-only">
            Filter by status
          </label>
          <select
            id={statusSelectId}
            value={query.status}
            onChange={(e) => {
              const next = e.target.value as AdminMemberStatusFilter;
              if ((ADMIN_MEMBER_STATUS_FILTERS as readonly string[]).includes(next)) {
                pushQuery({ status: next, offset: 0 });
              }
            }}
            className={SELECT_CLASS}
          >
            {STATUS_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <label htmlFor={pageSizeSelectId} className="text-sm text-muted-foreground">
              Rows
            </label>
            <select
              id={pageSizeSelectId}
              value={query.limit}
              onChange={(e) => {
                const nextLimit = Number(e.target.value);
                pushQuery({ limit: nextLimit, offset: 0 });
              }}
              className={SELECT_CLASS}
            >
              {ADMIN_MEMBERS_PAGE_SIZE_OPTIONS.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          </div>
          <InviteMemberDialog gameId={gameId} groupId={groupId} />
        </div>
      </div>

      {data.items.length === 0 ? (
        filtered ? (
          <Notice
            title="No members match this filter"
            body="Clear the search, or set status to All to include members who left, were kicked or are invited."
          />
        ) : (
          <Notice
            title="No active members"
            body="Invite one, or set status to All to see past members."
          />
        )
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              {table.getHeaderGroups().map((hg) => (
                <tr key={hg.id} className="border-b border-border text-xs text-muted-foreground">
                  {hg.headers.map((header) => (
                    <th key={header.id} className="py-2 pr-4 text-left font-medium">
                      {header.isPlaceholder
                        ? null
                        : flexRender(header.column.columnDef.header, header.getContext())}
                    </th>
                  ))}
                </tr>
              ))}
            </thead>
            <tbody>
              {table.getRowModel().rows.map((row) => (
                <tr key={row.id} className="border-b border-border/60 hover:bg-accent/40">
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id} className="py-2.5 pr-4">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex flex-col items-start justify-between gap-3 text-sm text-muted-foreground sm:flex-row sm:items-center">
        <span className="tabular-nums">
          {data.total === 0
            ? "No results"
            : `${numberFormatter.format(start)}-${numberFormatter.format(end)} of ${numberFormatter.format(data.total)}`}
        </span>
        <div className="flex items-center gap-2">
          <span className="tabular-nums">
            Page {numberFormatter.format(currentPage)} of {numberFormatter.format(totalPages)}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => pushQuery({ offset: Math.max(0, query.offset - query.limit) })}
            disabled={query.offset === 0}
          >
            Previous
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => pushQuery({ offset: query.offset + query.limit })}
            disabled={!data.hasMore}
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}
