// @license All Rights Reserved (see apps/dashboard/LICENSE)
"use client";

import {
  type ColumnDef,
  type Row,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ArrowUpDown, Search } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

import {
  ADMIN_GROUPS_PAGE_SIZE_OPTIONS,
  type AdminGroup,
  type AdminGroupList,
  type AdminGroupOrder,
  type AdminGroupSort,
  type AdminGroupVisibility,
} from "../../lib/admin-shared";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Notice } from "../ui/section";
import { visibilityLabel } from "./group-detail-header";

const numberFormatter = new Intl.NumberFormat("en-US");
const dateFormatter = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
});

const SEARCH_DEBOUNCE_MS = 350;

const SELECT_CLASS =
  "h-9 rounded-md border border-input bg-background px-3 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

export interface GroupsQueryState {
  q: string;
  kind: string;
  visibility: AdminGroupVisibility | "";
  sort: AdminGroupSort;
  order: AdminGroupOrder;
  offset: number;
  limit: number;
}

interface GroupsTableProps {
  gameId: string;
  data: AdminGroupList;
  query: GroupsQueryState;
  // The set of `kind` values the dashboard surfaces in the filter dropdown.
  // Driven server-side from the matching set so the operator only sees kinds
  // that actually exist in their game (an empty array hides the filter
  // entirely).
  kindOptions: readonly string[];
}

interface VisibilityOption {
  value: AdminGroupVisibility | "";
  label: string;
}

const VISIBILITY_OPTIONS: readonly VisibilityOption[] = [
  { value: "", label: "All visibilities" },
  { value: "public", label: "Public" },
  { value: "invite-only", label: "Invite-only" },
  { value: "secret", label: "Secret" },
];

// Drop empty values from the URL so a stale query string does not pile up
// `?q=&kind=&visibility=`. Defaults are also dropped so the URL stays terse
// when the operator has not changed anything.
function buildSearchParamsFromQuery(query: GroupsQueryState): URLSearchParams {
  const next = new URLSearchParams();
  if (query.q.length > 0) next.set("q", query.q);
  if (query.kind.length > 0) next.set("kind", query.kind);
  if (query.visibility.length > 0) next.set("visibility", query.visibility);
  if (query.sort !== "createdAt") next.set("sort", query.sort);
  if (query.order !== "desc") next.set("order", query.order);
  if (query.offset > 0) next.set("offset", String(query.offset));
  if (query.limit !== 50) next.set("limit", String(query.limit));
  return next;
}

interface SortHeaderProps {
  label: string;
  field: AdminGroupSort;
  query: GroupsQueryState;
  onChange: (sort: AdminGroupSort, order: AdminGroupOrder) => void;
}

function SortHeader({ label, field, query, onChange }: SortHeaderProps) {
  const active = query.sort === field;
  const Icon = !active ? ArrowUpDown : query.order === "asc" ? ArrowUp : ArrowDown;
  return (
    <button
      type="button"
      onClick={() => {
        const nextOrder: AdminGroupOrder =
          active && query.order === "desc"
            ? "asc"
            : active && query.order === "asc"
              ? "desc"
              : "desc";
        // Clicking a sort header always returns to the first page so the
        // operator does not stay on page 4 when the row order shifts under
        // them.
        onChange(field, nextOrder);
      }}
      className={cn(
        "inline-flex items-center gap-1 text-xs font-medium",
        active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
      <Icon className={cn("h-3 w-3", !active && "opacity-50")} aria-hidden />
    </button>
  );
}

export function GroupsTable({ gameId, data, query, kindOptions }: GroupsTableProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const searchInputId = useId();
  const visibilitySelectId = useId();
  const kindSelectId = useId();
  const pageSizeSelectId = useId();

  // Local search state mirrors the URL `q` so the input feels responsive. We
  // push the URL after a 350ms idle window so a fast typer does not trigger
  // 8 server fetches per word. The skipFirstEffectRef guard suppresses the
  // mount-time effect (we already have the right URL).
  const [searchValue, setSearchValue] = useState(query.q);
  const skipFirstEffectRef = useRef(true);

  const pushQuery = useCallback(
    (updates: Partial<GroupsQueryState>) => {
      const merged: GroupsQueryState = { ...query, ...updates };
      const next = buildSearchParamsFromQuery(merged);
      const target = next.toString();
      const current = searchParams?.toString() ?? "";
      if (target === current) return;
      router.replace(target.length > 0 ? `${pathname}?${target}` : pathname, { scroll: false });
    },
    [pathname, query, router, searchParams],
  );

  // Reset the local search box when the URL `q` changes from outside,
  // through history navigation. Comparing string equality keeps this
  // idempotent.
  useEffect(() => {
    setSearchValue(query.q);
  }, [query.q]);

  // Debounced URL push for the search input. We intentionally do NOT push
  // when the local value already matches the URL (covers the synced-from-URL
  // case above and the no-op keystroke case where the user types and then
  // immediately backspaces).
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

  const columns = useMemo<ColumnDef<AdminGroup>[]>(
    () => [
      {
        accessorKey: "name",
        header: () => (
          <SortHeader
            label="Name"
            field="name"
            query={query}
            onChange={(sort, order) => pushQuery({ sort, order, offset: 0 })}
          />
        ),
        cell: ({ row }) => (
          <div className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-3">
            <Link
              href={`/games/${encodeURIComponent(gameId)}/groups/${encodeURIComponent(row.original.id)}`}
              onClick={(e) => e.stopPropagation()}
              className="font-medium hover:underline"
            >
              {row.original.name}
            </Link>
            <span className="font-mono text-xs text-muted-foreground">{row.original.id}</span>
          </div>
        ),
      },
      {
        accessorKey: "kind",
        header: "Kind",
        cell: ({ row }) => <span className="text-muted-foreground">{row.original.kind}</span>,
      },
      {
        accessorKey: "visibility",
        header: "Visibility",
        cell: ({ row }) => (
          <span className="text-muted-foreground">{visibilityLabel(row.original.visibility)}</span>
        ),
      },
      {
        accessorKey: "memberCount",
        header: () => (
          <SortHeader
            label="Members"
            field="memberCount"
            query={query}
            onChange={(sort, order) => pushQuery({ sort, order, offset: 0 })}
          />
        ),
        cell: ({ row }) => (
          <span className="tabular-nums">{numberFormatter.format(row.original.memberCount)}</span>
        ),
      },
      {
        accessorKey: "createdAt",
        header: () => (
          <SortHeader
            label="Created"
            field="createdAt"
            query={query}
            onChange={(sort, order) => pushQuery({ sort, order, offset: 0 })}
          />
        ),
        cell: ({ row }) => (
          <span className="whitespace-nowrap text-muted-foreground">
            {dateFormatter.format(new Date(row.original.createdAt))}
          </span>
        ),
      },
    ],
    [gameId, pushQuery, query],
  );

  const table = useReactTable<AdminGroup>({
    data: data.items,
    columns,
    // Server-driven: the table stays a presentation layer. Sorting,
    // filtering, and pagination all happen on the server via URL state.
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

  const handleRowNavigate = useCallback(
    (row: Row<AdminGroup>) => {
      router.push(
        `/games/${encodeURIComponent(gameId)}/groups/${encodeURIComponent(row.original.id)}`,
      );
    },
    [gameId, router],
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              id={searchInputId}
              value={searchValue}
              onChange={(e) => setSearchValue(e.target.value)}
              placeholder="Search by name"
              aria-label="Search groups by name"
              className="w-full pl-9 sm:w-64"
              maxLength={120}
              autoComplete="off"
            />
          </div>
          {kindOptions.length > 0 ? (
            <>
              <label htmlFor={kindSelectId} className="sr-only">
                Filter by kind
              </label>
              <select
                id={kindSelectId}
                value={query.kind}
                onChange={(e) => pushQuery({ kind: e.target.value, offset: 0 })}
                className={SELECT_CLASS}
              >
                <option value="">All kinds</option>
                {kindOptions.map((kind) => (
                  <option key={kind} value={kind}>
                    {kind}
                  </option>
                ))}
              </select>
            </>
          ) : null}
          <label htmlFor={visibilitySelectId} className="sr-only">
            Filter by visibility
          </label>
          <select
            id={visibilitySelectId}
            value={query.visibility}
            onChange={(e) =>
              pushQuery({
                visibility: e.target.value as AdminGroupVisibility | "",
                offset: 0,
              })
            }
            className={SELECT_CLASS}
          >
            {VISIBILITY_OPTIONS.map((opt) => (
              <option key={opt.value || "all"} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
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
            {ADMIN_GROUPS_PAGE_SIZE_OPTIONS.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
        </div>
      </div>

      {data.items.length === 0 ? (
        query.q.length > 0 || query.kind.length > 0 || query.visibility.length > 0 ? (
          <Notice
            title="No groups match this filter"
            body="Clear the search, kind and visibility filters to see every group."
          />
        ) : (
          <Notice title="No groups yet" body="Groups your game creates show up here." />
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
                <tr
                  key={row.id}
                  onClick={() => handleRowNavigate(row)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      handleRowNavigate(row);
                    }
                  }}
                  tabIndex={0}
                  className="cursor-pointer border-b border-border/60 outline-none hover:bg-accent/40 focus-visible:bg-accent/40"
                >
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
