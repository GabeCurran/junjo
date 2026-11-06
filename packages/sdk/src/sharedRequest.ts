import { JunjoError } from "./errors.js";

/** How long one caller is willing to wait on a shared request. */
export interface WaitOptions {
  /** Ends this caller's wait with JunjoError "cancelled". */
  signal?: AbortSignal;
  /** Ends this caller's wait with JunjoError "timeout". 0 waits indefinitely. */
  timeoutMs: number;
}

interface Entry<T> {
  promise: Promise<T>;
  controller: AbortController;
  waiters: number;
  settled: boolean;
}

/**
 * Collapses concurrent identical requests into one. The first caller
 * for a key starts the request; later callers for the same key join it
 * until it settles, and the entry is dropped on success and failure
 * alike, so the next caller after that starts fresh.
 *
 * The request itself runs under its own abort signal, not any caller's.
 * Each caller's signal and timeout end only that caller's wait; the
 * request keeps running for everyone still waiting, and is aborted
 * only once every caller has stopped waiting.
 */
export class SharedRequests<T> {
  private readonly entries = new Map<string, Entry<T>>();

  /**
   * Waits on the request for `key`, starting it with `start` when none
   * is in flight. `onResult` runs once per request, on success, and
   * only while the entry is still registered (see {@link forget}).
   */
  run(
    key: string,
    start: (signal: AbortSignal) => Promise<T>,
    wait: WaitOptions,
    onResult?: (result: T) => void,
  ): Promise<T> {
    let entry = this.entries.get(key);
    if (entry === undefined) {
      const controller = new AbortController();
      // The settle handlers always run after `created` is assigned:
      // promise reactions are asynchronous. The executor turns a
      // synchronous throw from `start` into a rejection.
      const promise = new Promise<T>((resolve) => resolve(start(controller.signal))).then(
        (result) => {
          created.settled = true;
          if (this.entries.get(key) === created) {
            this.entries.delete(key);
            onResult?.(result);
          }
          return result;
        },
        (err: unknown) => {
          created.settled = true;
          if (this.entries.get(key) === created) this.entries.delete(key);
          throw err;
        },
      );
      // Every caller may stop waiting before the request settles; the
      // rejection then has no listener and must not surface as unhandled.
      promise.catch(() => undefined);
      const created: Entry<T> = { promise, controller, waiters: 0, settled: false };
      this.entries.set(key, created);
      entry = created;
    }
    entry.waiters += 1;
    return this.waitFor(key, entry, wait);
  }

  /**
   * Detaches every in-flight request: callers already waiting still
   * receive their answer, but the next caller starts a new request and
   * a detached request no longer reaches `onResult`.
   */
  forget(): void {
    this.entries.clear();
  }

  /** Number of requests in flight. */
  size(): number {
    return this.entries.size;
  }

  private waitFor(key: string, entry: Entry<T>, wait: WaitOptions): Promise<T> {
    const { signal, timeoutMs } = wait;
    if (signal === undefined && timeoutMs <= 0) return entry.promise;

    return new Promise<T>((resolve, reject) => {
      let done = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const finish = () => {
        done = true;
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const leave = (err: JunjoError) => {
        if (done) return;
        finish();
        entry.waiters -= 1;
        if (entry.waiters === 0 && !entry.settled) {
          if (this.entries.get(key) === entry) this.entries.delete(key);
          entry.controller.abort();
        }
        reject(err);
      };
      const onAbort = () => leave(new JunjoError("request cancelled", "cancelled"));

      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      if (timeoutMs > 0) {
        timer = setTimeout(() => leave(new JunjoError("request timed out", "timeout")), timeoutMs);
        // Never hold a game server's event loop open for a pending timeout.
        if (typeof (timer as { unref?: () => void }).unref === "function") {
          (timer as unknown as { unref: () => void }).unref();
        }
      }

      entry.promise.then(
        (result) => {
          if (done) return;
          finish();
          resolve(result);
        },
        (err: unknown) => {
          if (done) return;
          finish();
          reject(err);
        },
      );
    });
  }
}
