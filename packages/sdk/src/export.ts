import type { ExportEnd, ExportHeader, ExportRecordKind } from "@junjo.io/shared";
import { JunjoError } from "./errors.js";
import type { HttpClient } from "./http.js";

// Records are the parsed JSON lines as the server wrote them: timestamps
// stay ISO strings and ids stay plain strings, so a file read through
// this iterator can be written back out unchanged. References between
// records use internal ids (`id`, `personId`, `*PersonId`); `userId`,
// `actorUserId` and `targetUserId` hold external ids and are null when
// the person has none left.

type Json = Record<string, unknown>;

export type { ExportEnd, ExportHeader, ExportRecordKind } from "@junjo.io/shared";

export interface ExportGameRecord {
  kind: "game";
  id: string;
  name: string;
  /** The game config as stored, unresolved. */
  config: Json;
  networkId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ExportPersonRecord {
  kind: "person";
  id: string;
  /** Earliest-linked first. */
  identities: {
    userId: string;
    namespace: string | null;
    linkedAt: string;
    displayName: string | null;
    displayNameUpdatedAt: string | null;
  }[];
}

export interface ExportGroupRecord {
  kind: "group";
  id: string;
  groupKind: string;
  name: string;
  visibility: string;
  metadata: Json;
  defaultRoleId: string | null;
  parentGroupId: string | null;
  hasPasscode: boolean;
  createdAt: string;
  updatedAt: string;
  softDeletedAt: string | null;
  memberActivityAt: string;
}

export interface ExportRoleRecord {
  kind: "role";
  id: string;
  groupId: string;
  name: string;
  priority: number;
  color: string | null;
  isDefault: boolean;
  metadata: Json;
  entries: { permission: string; value: boolean }[];
  /** Parent role ids. */
  parents: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ExportMemberRecord {
  kind: "member";
  id: string;
  groupId: string;
  personId: string;
  userId: string | null;
  status: string;
  /** Role ids. */
  roles: string[];
  overrides: { permission: string; value: boolean; setAt: string; setByPersonId: string | null }[];
  metadata: Json;
  notesPublic: string | null;
  notesPrivate: string | null;
  version: number;
  joinedAt: string;
  leftAt: string | null;
  bannedUntil: string | null;
}

export interface ExportInvitationRecord {
  kind: "invitation";
  id: string;
  groupId: string;
  code: string;
  roleId: string | null;
  targetUserId: string | null;
  createdByPersonId: string | null;
  createdAt: string;
  expiresAt: string | null;
  usedAt: string | null;
  usedByPersonId: string | null;
}

/** A directed group relationship as stored. */
export interface ExportRelationshipRecord {
  kind: "relationship";
  groupAId: string;
  groupBId: string;
  type: string;
  since: string;
  setByPersonId: string | null;
}

/** A game ban; group bans are members with status `banned`. */
export interface ExportBanRecord {
  kind: "ban";
  id: string;
  personId: string;
  userId: string | null;
  bannedAt: string;
  expiresAt: string | null;
  reason: string | null;
  bannedByPersonId: string | null;
  issuer: string | null;
}

export interface ExportBanHistoryRecord {
  kind: "banHistory";
  id: string;
  personId: string;
  userId: string | null;
  scope: "game" | "group";
  groupId: string | null;
  historyKind: "set" | "lifted";
  reason: string | null;
  expiresAt: string | null;
  eventAt: string;
  actorPersonId: string | null;
  issuer: string | null;
}

/** The current or last sanction of each type, expired ones included. */
export interface ExportSanctionRecord {
  kind: "sanction";
  id: string;
  personId: string;
  userId: string | null;
  type: string;
  reason: string | null;
  issuer: string | null;
  issuedByPersonId: string | null;
  startedAt: string;
  expiresAt: string | null;
}

export interface ExportSanctionHistoryRecord {
  kind: "sanctionHistory";
  id: string;
  personId: string;
  userId: string | null;
  type: string;
  historyKind: "set" | "lifted";
  reason: string | null;
  expiresAt: string | null;
  eventAt: string;
  actorPersonId: string | null;
  issuer: string | null;
}

/**
 * A directed friend, friend request or block row as stored; a
 * friendship is two records.
 */
export interface ExportUserRelationshipRecord {
  kind: "friendship" | "friendRequest" | "block";
  id: string;
  actorPersonId: string;
  actorUserId: string | null;
  targetPersonId: string;
  targetUserId: string | null;
  createdAt: string;
  respondedAt: string | null;
  metadata: Json;
}

export interface ExportFriendTagRecord {
  kind: "friendTag";
  id: string;
  personId: string;
  name: string;
  color: string | null;
  createdAt: string;
  /** The `friendship` record ids the tag is applied to. */
  relationshipIds: string[];
}

export interface ExportAuditRecord {
  kind: "audit";
  id: string;
  groupId: string | null;
  actorPersonId: string | null;
  action: string;
  targetId: string | null;
  payload: unknown;
  apiKeyId: string | null;
  createdAt: string;
}

/**
 * A line whose `kind` this SDK version does not know, passed through so
 * a newer server cannot break an older reader. `kind: "unknown"` is the
 * discriminant; `rawKind` is the kind the line carried.
 */
export interface ExportUnknownRecord {
  kind: "unknown";
  rawKind: string;
  record: Json;
}

/** One line of a game export, discriminated on `kind`. */
export type ExportRecord =
  | ExportHeader
  | ExportGameRecord
  | ExportPersonRecord
  | ExportGroupRecord
  | ExportRoleRecord
  | ExportMemberRecord
  | ExportInvitationRecord
  | ExportRelationshipRecord
  | ExportBanRecord
  | ExportBanHistoryRecord
  | ExportSanctionRecord
  | ExportSanctionHistoryRecord
  | ExportUserRelationshipRecord
  | ExportFriendTagRecord
  | ExportAuditRecord
  | ExportEnd
  | ExportUnknownRecord;

// Typed as a full record so a kind added to the shared list fails to
// compile until it is listed here.
const KNOWN_KINDS: Record<ExportRecordKind | "header" | "end", true> = {
  header: true,
  game: true,
  person: true,
  group: true,
  role: true,
  member: true,
  invitation: true,
  relationship: true,
  ban: true,
  banHistory: true,
  sanction: true,
  sanctionHistory: true,
  friendship: true,
  friendRequest: true,
  block: true,
  friendTag: true,
  audit: true,
  end: true,
};

/**
 * Cap on one unterminated line, in UTF-16 code units (about 16 MiB of
 * ASCII). A real record is far smaller; past this the stream is broken
 * and buffering further would grow memory without bound.
 */
export const EXPORT_MAX_LINE_CHARS = 16 * 1024 * 1024;

/** Options for {@link Junjo.export}. */
export interface ExportOptions {
  /**
   * Cancels the request and the read; surfaces as JunjoError code
   * "cancelled". No client timeout applies to an export, since a large
   * game streams for as long as it takes, so this is the only way to
   * bound one.
   */
  signal?: AbortSignal;
}

function wireError(message: string): JunjoError {
  return new JunjoError(message, "invalid_wire_data");
}

function parseLine(line: string): ExportRecord {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (err) {
    throw new JunjoError("export line was not valid JSON", "invalid_wire_data", undefined, {
      cause: err,
    });
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw wireError("export line was not a JSON object");
  }
  const kind = (value as { kind?: unknown }).kind;
  if (typeof kind !== "string") throw wireError("export line has no string kind");
  if (Object.prototype.hasOwnProperty.call(KNOWN_KINDS, kind)) return value as ExportRecord;
  return { kind: "unknown", rawKind: kind, record: value as Json };
}

/**
 * Streams the whole game (GET /v1/export) as parsed records, header
 * first and the end record last. The body is read incrementally and
 * never held whole; at most one line is buffered.
 *
 * The API key must have `canExport`, otherwise the request fails with
 * `permission_denied`. The iterator throws `invalid_wire_data` when the
 * first record is not the header, when a line is not a JSON object with
 * a string `kind`, when anything follows the end record, when the end
 * record's counts disagree with the records read, and when the stream
 * ends without the end record. That last throw arrives after every
 * record that did arrive has been yielded, so a consumer that persists
 * records as they come must discard its output on any throw. Transport
 * failures mid-stream surface as `network_error`, an aborted `signal` as
 * `cancelled`, and a line longer than {@link EXPORT_MAX_LINE_CHARS} as
 * `stream_overflow`. Ending the iteration early closes the connection.
 */
export async function* exportGame(
  http: HttpClient,
  opts?: ExportOptions,
): AsyncGenerator<ExportRecord, void, undefined> {
  const res = await http.openStream("/v1/export", {
    signal: opts?.signal,
    accept: "application/x-ndjson",
  });
  if (!res.body)
    throw new JunjoError("export response has no body", "invalid_wire_data", res.status);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const seen = new Map<string, number>();
  let buffer = "";
  let first = true;
  let end: ExportEnd | null = null;
  let finished = false;

  // Validates one line's record against the stream so far.
  const accept = (line: string): ExportRecord | null => {
    if (line.trim() === "") return null;
    if (end !== null) throw wireError("export has data after its end record");
    const record = parseLine(line);
    if (first && record.kind !== "header") throw wireError("export does not start with a header");
    first = false;
    if (record.kind === "end") {
      end = record;
      return record;
    }
    const counted = record.kind === "unknown" ? record.rawKind : record.kind;
    seen.set(counted, (seen.get(counted) ?? 0) + 1);
    return record;
  };

  try {
    while (true) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (err) {
        if (opts?.signal?.aborted) {
          throw new JunjoError("request cancelled", "cancelled", undefined, { cause: err });
        }
        throw new JunjoError(
          err instanceof Error && err.message ? `network error: ${err.message}` : "network error",
          "network_error",
          undefined,
          { cause: err },
        );
      }
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let nl = buffer.indexOf("\n");
      while (nl !== -1) {
        const record = accept(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
        if (record !== null) yield record;
        nl = buffer.indexOf("\n");
      }
      if (buffer.length > EXPORT_MAX_LINE_CHARS) {
        throw new JunjoError(
          `export line exceeded ${EXPORT_MAX_LINE_CHARS} characters`,
          "stream_overflow",
        );
      }
    }
    finished = true;
    // A final line without a trailing newline still counts.
    const last = accept(buffer + decoder.decode());
    if (last !== null) yield last;

    const endRecord = end as ExportEnd | null;
    if (endRecord === null) {
      throw wireError("export ended without its end record; the stream was cut short");
    }
    for (const [kind, count] of Object.entries(endRecord.counts)) {
      if ((seen.get(kind) ?? 0) !== count) {
        throw wireError(
          `export end record counts ${count} ${kind} records but ${seen.get(kind) ?? 0} arrived`,
        );
      }
    }
  } finally {
    // An early exit (a consumer break, or a throw above) leaves the body
    // open; cancelling releases the connection.
    if (!finished) await reader.cancel().catch(() => {});
  }
}
