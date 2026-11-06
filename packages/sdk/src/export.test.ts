import { describe, expect, it, vi } from "vitest";
import { JunjoError } from "./errors.js";
import { EXPORT_MAX_LINE_CHARS, type ExportRecord } from "./export.js";
import { Junjo } from "./index.js";

const encoder = new TextEncoder();

const header = {
  kind: "header",
  format: "junjo-export",
  version: 1,
  gameId: "game_1",
  exportedAt: "2026-11-09T12:00:00.000Z",
  position: "4211",
};
const game = {
  kind: "game",
  id: "game_1",
  name: "Survival",
  config: {},
  networkId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};
const person = {
  kind: "person",
  id: "p_1",
  identities: [
    {
      userId: "mc:1",
      namespace: "mc",
      linkedAt: "2026-01-01T00:00:00.000Z",
      displayName: "Steve",
      displayNameUpdatedAt: "2026-01-02T00:00:00.000Z",
    },
  ],
};
const group = { kind: "group", id: "g_1", groupKind: "party", name: "Party" };

function counts(over: Record<string, number> = {}): Record<string, number> {
  const base: Record<string, number> = {
    game: 0,
    person: 0,
    group: 0,
    role: 0,
    member: 0,
    invitation: 0,
    relationship: 0,
    ban: 0,
    banHistory: 0,
    sanction: 0,
    sanctionHistory: 0,
    friendship: 0,
    friendRequest: 0,
    block: 0,
    friendTag: 0,
    audit: 0,
  };
  return { ...base, ...over };
}

const lines = (...records: unknown[]) => records.map((r) => `${JSON.stringify(r)}\n`).join("");

const fullBody = lines(header, game, person, group, {
  kind: "end",
  counts: counts({ game: 1, person: 1, group: 1 }),
});

// Splits `text` into chunks of `size` bytes so lines straddle chunk
// boundaries.
function chunkedStream(text: string, size: number, onCancel?: () => void) {
  const bytes = encoder.encode(text);
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + size));
      offset += size;
    },
    cancel() {
      onCancel?.();
    },
  });
}

function client(respond: (req: Request) => Response | Promise<Response>) {
  const requests: Request[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input.toString(), init);
    requests.push(req);
    return respond(req);
  });
  const junjo = new Junjo({
    apiKey: "jk_test.secret",
    baseUrl: "https://example.test",
    fetch: fetchMock as unknown as typeof fetch,
  });
  return { junjo, requests };
}

const ndjson = (body: ReadableStream<Uint8Array> | string) =>
  new Response(body, { status: 200, headers: { "content-type": "application/x-ndjson" } });

async function collect(it: AsyncIterable<ExportRecord>): Promise<ExportRecord[]> {
  const out: ExportRecord[] = [];
  for await (const r of it) out.push(r);
  return out;
}

async function failure(it: AsyncIterable<ExportRecord>) {
  const seen: ExportRecord[] = [];
  try {
    for await (const r of it) seen.push(r);
  } catch (err) {
    expect(err).toBeInstanceOf(JunjoError);
    return { err: err as JunjoError, seen };
  }
  throw new Error("expected the export to throw");
}

describe("junjo.export", () => {
  it("GETs /v1/export with the key and an NDJSON accept header", async () => {
    const { junjo, requests } = client(() => ndjson(fullBody));
    await collect(junjo.export());
    expect(requests[0]?.method).toBe("GET");
    expect(new URL(requests[0]?.url ?? "").pathname).toBe("/v1/export");
    expect(requests[0]?.headers.get("accept")).toBe("application/x-ndjson");
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer jk_test.secret");
  });

  it("yields every record in order, header first and end last, across split chunks", async () => {
    const { junjo } = client(() => ndjson(chunkedStream(fullBody, 7)));
    const records = await collect(junjo.export());
    expect(records.map((r) => r.kind)).toEqual(["header", "game", "person", "group", "end"]);
    const first = records[0];
    if (first?.kind !== "header") throw new Error("expected header");
    expect(first.position).toBe("4211");
    const p = records[2];
    if (p?.kind !== "person") throw new Error("expected person");
    expect(p.identities[0]?.displayName).toBe("Steve");
    // Timestamps stay as the wire strings.
    expect(p.identities[0]?.linkedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("decodes multi-byte characters split across chunks", async () => {
    const named = { ...group, name: "Gruppe üß \u{1F600}" };
    const body = lines(header, named, { kind: "end", counts: counts({ group: 1 }) });
    const { junjo } = client(() => ndjson(chunkedStream(body, 3)));
    const records = await collect(junjo.export());
    const g = records[1];
    if (g?.kind !== "group") throw new Error("expected group");
    expect(g.name).toBe("Gruppe üß \u{1F600}");
  });

  it("yields records before the body has ended", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    const { junjo } = client(() => ndjson(stream));
    const it = junjo.export()[Symbol.asyncIterator]();
    controller.enqueue(encoder.encode(lines(header)));
    const first = await it.next();
    expect(first.value?.kind).toBe("header");
    controller.enqueue(encoder.encode(lines({ kind: "end", counts: counts() })));
    controller.close();
    expect((await it.next()).value?.kind).toBe("end");
    expect((await it.next()).done).toBe(true);
  });

  it("accepts a final line without a trailing newline and blank lines", async () => {
    const body = `${lines(header)}\n${JSON.stringify({ kind: "end", counts: counts() })}`;
    const { junjo } = client(() => ndjson(body));
    const records = await collect(junjo.export());
    expect(records.map((r) => r.kind)).toEqual(["header", "end"]);
  });

  it("throws invalid_wire_data after the last record when the end record is missing", async () => {
    const body = lines(header, game, person);
    const { junjo } = client(() => ndjson(chunkedStream(body, 50)));
    const { err, seen } = await failure(junjo.export());
    expect(err.code).toBe("invalid_wire_data");
    expect(err.message).toContain("end record");
    expect(seen.map((r) => r.kind)).toEqual(["header", "game", "person"]);
  });

  it("throws on a truncated last line", async () => {
    const body = `${lines(header, game)}{"kind":"end","cou`;
    const { junjo } = client(() => ndjson(body));
    const { err } = await failure(junjo.export());
    expect(err.code).toBe("invalid_wire_data");
  });

  it("throws when the end counts disagree with the records read", async () => {
    const body = lines(header, game, { kind: "end", counts: counts({ game: 1, person: 2 }) });
    const { junjo } = client(() => ndjson(body));
    const { err } = await failure(junjo.export());
    expect(err.code).toBe("invalid_wire_data");
    expect(err.message).toContain("person");
  });

  it("throws when the stream does not start with a header", async () => {
    const { junjo } = client(() => ndjson(lines(game, { kind: "end", counts: counts() })));
    const { err, seen } = await failure(junjo.export());
    expect(err.code).toBe("invalid_wire_data");
    expect(seen).toEqual([]);
  });

  it("throws on data after the end record", async () => {
    const body = lines(header, { kind: "end", counts: counts() }, game);
    const { junjo } = client(() => ndjson(body));
    const { err } = await failure(junjo.export());
    expect(err.code).toBe("invalid_wire_data");
  });

  it.each([
    ["not JSON", "nope\n"],
    ["an array", "[1]\n"],
    ["no kind", '{"id":"x"}\n'],
  ])("throws invalid_wire_data on a line that is %s", async (_label, bad) => {
    const { junjo } = client(() => ndjson(lines(header) + bad));
    const { err } = await failure(junjo.export());
    expect(err.code).toBe("invalid_wire_data");
  });

  it("passes an unknown kind through and counts it against the end record", async () => {
    const future = { kind: "guildBank", id: "b_1", gold: 5 };
    const body = lines(header, future, { kind: "end", counts: counts({ guildBank: 1 }) });
    const { junjo } = client(() => ndjson(body));
    const records = await collect(junjo.export());
    expect(records[1]).toEqual({ kind: "unknown", rawKind: "guildBank", record: future });
  });

  it("surfaces permission_denied for a key without canExport", async () => {
    const { junjo } = client(() =>
      Response.json(
        { code: "permission_denied", status: 403, message: "key cannot export" },
        { status: 403 },
      ),
    );
    const { err } = await failure(junjo.export());
    expect(err.code).toBe("permission_denied");
    expect(err.status).toBe(403);
  });

  it("cancels the body when the consumer stops early", async () => {
    const onCancel = vi.fn();
    const { junjo } = client(() => ndjson(chunkedStream(fullBody, 20, onCancel)));
    for await (const r of junjo.export()) {
      if (r.kind === "header") break;
    }
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("surfaces a mid-stream transport failure as network_error", async () => {
    let sent = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(encoder.encode(lines(header)));
          return;
        }
        controller.error(new Error("socket hang up"));
      },
    });
    const { junjo } = client(() => ndjson(stream));
    const { err, seen } = await failure(junjo.export());
    expect(err.code).toBe("network_error");
    expect(err.message).toContain("socket hang up");
    expect(seen.map((r) => r.kind)).toEqual(["header"]);
  });

  it("surfaces an aborted signal mid-stream as cancelled", async () => {
    const ac = new AbortController();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(lines(header)));
      },
      pull(controller) {
        ac.abort();
        controller.error(new DOMException("aborted", "AbortError"));
      },
    });
    const { junjo } = client(() => ndjson(stream));
    const { err } = await failure(junjo.export({ signal: ac.signal }));
    expect(err.code).toBe("cancelled");
  });

  it("throws stream_overflow on a line past the cap", async () => {
    const big = "x".repeat(EXPORT_MAX_LINE_CHARS + 1);
    const { junjo } = client(() => ndjson(lines(header) + big));
    const { err } = await failure(junjo.export());
    expect(err.code).toBe("stream_overflow");
  });
});
