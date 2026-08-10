import type { Page } from "@junjo.io/shared";

/**
 * Wraps a cursor-paginated `list(...)` call into an async iterator so
 * callers can `for await (const item of api.listAll(...))` instead of
 * hand-rolling the cursor loop. The fetcher receives `undefined` on
 * the first call and the prior page's `nextCursor` thereafter; iteration
 * stops when `nextCursor` is `null`.
 *
 * `limit` is the page-size hint passed through to the underlying list
 * call (the server still caps it at JUNJO_MAX_PAGE_SIZE).
 *
 * `opts.signal` is forwarded to every page fetch, so aborting it cancels
 * whichever request is in flight and stops the iteration.
 *
 * Cancellation mid-iteration surfaces as a throw from the in-flight
 * page fetch (JunjoError code "cancelled"), and the iteration position
 * is not resumable: the generator is done, and a fresh call starts
 * again from the first page.
 */
export async function* paginate<T>(
  fetchPage: (cursor: string | undefined, opts?: { signal?: AbortSignal }) => Promise<Page<T>>,
  opts?: { signal?: AbortSignal },
): AsyncGenerator<T, void, unknown> {
  let cursor: string | undefined;
  while (true) {
    const page = await fetchPage(cursor, { signal: opts?.signal });
    for (const item of page.items) yield item;
    if (!page.nextCursor) return;
    cursor = page.nextCursor;
  }
}
