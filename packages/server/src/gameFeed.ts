import type { PrismaClient } from "@prisma/client";
import type { EventHub } from "./eventHub.js";
import { type LoggedEvent, readEventLog, readStreamPosition } from "./eventLog.js";
import { logger } from "./logger.js";

export const GAME_FEED_POLL_INTERVAL_MS = 1_000;
export const GAME_FEED_WINDOW = 1_000;
export const EVENT_LOG_PAGE = 500;

export interface GameFeedOptions {
  // How often a feed reads the log without a local wake-up, which is how
  // events committed by other server processes arrive. 0 disables it.
  pollIntervalMs?: number;
}

// Tails one game's event log for every game stream of that game in this
// process. Reads happen on a local publish for the game and on the poll
// interval; overlapping wake-ups coalesce into one more read. The window
// holds a contiguous run of positions ending at `head`, so a stream
// whose cursor falls inside it is served from memory and any other
// stream reads the log itself.
export class GameFeed {
  private head: bigint;
  private window: LoggedEvent[] = [];
  private readonly listeners = new Set<() => void>();
  private reading = false;
  private again = false;
  private stopped = false;
  private readonly unsubscribe: () => void;
  private readonly timer: ReturnType<typeof setInterval> | null;

  constructor(
    private readonly prisma: PrismaClient,
    hub: EventHub,
    readonly gameId: string,
    start: bigint,
    pollIntervalMs: number,
  ) {
    this.head = start;
    this.unsubscribe = hub.subscribeGame(gameId, () => this.wake());
    if (pollIntervalMs > 0) {
      this.timer = setInterval(() => this.wake(), pollIntervalMs);
      this.timer.unref?.();
    } else {
      this.timer = null;
    }
  }

  // Events after `cursor` held in memory, oldest first, or null when the
  // window does not reach back to `cursor`. Empty when the stream is
  // caught up.
  eventsAfter(cursor: bigint): LoggedEvent[] | null {
    const first = this.window[0]?.seq ?? this.head + 1n;
    if (cursor < first - 1n) return null;
    if (cursor >= this.head) return [];
    return this.window.slice(Number(cursor + 1n - first));
  }

  // Called after each read that found new events.
  onAdvance(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  wake(): void {
    if (this.stopped) return;
    if (this.reading) {
      this.again = true;
      return;
    }
    this.reading = true;
    void (async () => {
      try {
        do {
          this.again = false;
          await this.readNew();
        } while (this.again && !this.stopped);
      } catch (err) {
        // The next wake-up or poll retries from the same head.
        logger.warn({ err, gameId: this.gameId }, "game feed read failed");
      } finally {
        this.reading = false;
      }
    })();
  }

  stop(): void {
    this.stopped = true;
    this.unsubscribe();
    if (this.timer) clearInterval(this.timer);
    this.listeners.clear();
    this.window = [];
  }

  private async readNew(): Promise<void> {
    for (;;) {
      const rows = await readEventLog(this.prisma, this.gameId, this.head, EVENT_LOG_PAGE);
      if (this.stopped) return;
      for (const row of rows) {
        // Positions are gapless, so a jump means rows were swept before
        // this feed read them; restart the window at the new row.
        if (row.seq !== this.head + 1n) this.window = [];
        this.window.push(row);
        this.head = row.seq;
      }
      if (this.window.length > GAME_FEED_WINDOW) {
        this.window = this.window.slice(this.window.length - GAME_FEED_WINDOW);
      }
      if (rows.length > 0) {
        for (const listener of [...this.listeners]) listener();
      }
      if (rows.length < EVENT_LOG_PAGE) return;
    }
  }
}

// One feed per game with open streams, shared by those streams and
// stopped when the last one releases it.
export class GameFeeds {
  private readonly feeds = new Map<string, { feed: Promise<GameFeed>; refs: number }>();
  private readonly pollIntervalMs: number;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly hub: EventHub,
    opts: GameFeedOptions = {},
  ) {
    this.pollIntervalMs = opts.pollIntervalMs ?? GAME_FEED_POLL_INTERVAL_MS;
  }

  async acquire(gameId: string): Promise<GameFeed> {
    let entry = this.feeds.get(gameId);
    if (!entry) {
      const feed = readStreamPosition(this.prisma, gameId).then((start) => {
        const created = new GameFeed(this.prisma, this.hub, gameId, start, this.pollIntervalMs);
        // An event published between the position read and the hub
        // subscription would otherwise wait for the next poll.
        created.wake();
        return created;
      });
      entry = { feed, refs: 0 };
      this.feeds.set(gameId, entry);
      // A failed start drops the entry so the next stream retries.
      feed.catch(() => {
        if (this.feeds.get(gameId) === entry) this.feeds.delete(gameId);
      });
    }
    entry.refs++;
    try {
      return await entry.feed;
    } catch (err) {
      entry.refs--;
      throw err;
    }
  }

  release(feed: GameFeed): void {
    const entry = this.feeds.get(feed.gameId);
    if (!entry) return;
    entry.refs--;
    if (entry.refs > 0) return;
    this.feeds.delete(feed.gameId);
    feed.stop();
  }

  activeFeeds(): number {
    return this.feeds.size;
  }
}
