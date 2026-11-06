import type { Context } from "hono";

// A frame that cannot be handed to the client within this long means the
// client stopped reading, and the stream is closed.
export const STREAM_WRITE_TIMEOUT_MS = 30_000;

// Open event streams in this process, counted per API key and per game.
export class StreamSlots {
  private readonly perKey = new Map<string, number>();
  private readonly perGame = new Map<string, number>();

  constructor(
    private readonly maxPerKey: number,
    private readonly maxPerGame: number,
  ) {}

  tryAcquire(key: string, gameId: string): boolean {
    if ((this.perKey.get(key) ?? 0) >= this.maxPerKey) return false;
    if ((this.perGame.get(gameId) ?? 0) >= this.maxPerGame) return false;
    this.perKey.set(key, (this.perKey.get(key) ?? 0) + 1);
    this.perGame.set(gameId, (this.perGame.get(gameId) ?? 0) + 1);
    return true;
  }

  release(key: string, gameId: string): void {
    decrement(this.perKey, key);
    decrement(this.perGame, gameId);
  }
}

function decrement(map: Map<string, number>, key: string): void {
  const next = (map.get(key) ?? 0) - 1;
  if (next > 0) map.set(key, next);
  else map.delete(key);
}

// Destroys the underlying socket when the Node adapter exposes it; a
// stalled client would otherwise hold the half-written response open.
export function abandonResponse(c: Context): void {
  const outgoing = (c.env as { outgoing?: { destroy?: () => void } } | undefined)?.outgoing;
  outgoing?.destroy?.();
}

// Waits for `pending` (one frame write) for at most `timeoutMs`. Returns
// "ok" when the frame was handed off, "error" when the write failed and
// "timeout" when the client stopped reading.
export async function writeWithin(
  pending: Promise<unknown>,
  timeoutMs: number,
): Promise<"ok" | "error" | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  try {
    return await Promise.race([
      pending.then(
        () => "ok" as const,
        () => "error" as const,
      ),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }
}
