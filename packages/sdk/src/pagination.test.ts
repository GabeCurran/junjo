import type { Page } from "@junjo.io/shared";
import { describe, expect, it, vi } from "vitest";
import { paginate } from "./pagination.js";

describe("paginate", () => {
  it("yields items across pages, feeding nextCursor back into each fetch", async () => {
    const pages: Record<string, Page<string>> = {
      first: { items: ["a", "b"], nextCursor: "cur_1" },
      cur_1: { items: ["c"], nextCursor: "cur_2" },
      cur_2: { items: ["d", "e"], nextCursor: null },
    };
    const fetchPage = vi.fn(async (cursor: string | undefined): Promise<Page<string>> => {
      const page = pages[cursor ?? "first"];
      if (!page) throw new Error(`unexpected cursor: ${cursor}`);
      return page;
    });

    const seen: string[] = [];
    for await (const item of paginate(fetchPage)) {
      seen.push(item);
    }

    expect(seen).toEqual(["a", "b", "c", "d", "e"]);
    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(fetchPage.mock.calls[0]?.[0]).toBeUndefined();
    expect(fetchPage.mock.calls[1]?.[0]).toBe("cur_1");
    expect(fetchPage.mock.calls[2]?.[0]).toBe("cur_2");
  });

  it("stops after a single page whose nextCursor is null", async () => {
    const fetchPage = vi.fn(
      async (): Promise<Page<number>> => ({ items: [1, 2], nextCursor: null }),
    );

    const seen: number[] = [];
    for await (const item of paginate(fetchPage)) {
      seen.push(item);
    }

    expect(seen).toEqual([1, 2]);
    expect(fetchPage).toHaveBeenCalledOnce();
  });

  it("completes without yielding when the first page is empty", async () => {
    const fetchPage = vi.fn(async (): Promise<Page<number>> => ({ items: [], nextCursor: null }));

    const seen: number[] = [];
    for await (const item of paginate(fetchPage)) {
      seen.push(item);
    }

    expect(seen).toEqual([]);
    expect(fetchPage).toHaveBeenCalledOnce();
  });

  it("forwards the signal to every fetchPage call", async () => {
    const controller = new AbortController();
    const fetchPage = vi.fn(
      async (
        cursor: string | undefined,
        opts?: { signal?: AbortSignal },
      ): Promise<Page<string>> => {
        expect(opts?.signal).toBe(controller.signal);
        return cursor === undefined
          ? { items: ["a"], nextCursor: "cur_1" }
          : { items: ["b"], nextCursor: null };
      },
    );

    const seen: string[] = [];
    for await (const item of paginate(fetchPage, { signal: controller.signal })) {
      seen.push(item);
    }

    expect(seen).toEqual(["a", "b"]);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it("propagates a rejection from a mid-iteration page fetch", async () => {
    const boom = new Error("page 2 failed");
    const fetchPage = vi.fn(async (cursor: string | undefined): Promise<Page<string>> => {
      if (cursor === undefined) return { items: ["a"], nextCursor: "cur_1" };
      throw boom;
    });

    const seen: string[] = [];
    await expect(
      (async () => {
        for await (const item of paginate(fetchPage)) {
          seen.push(item);
        }
      })(),
    ).rejects.toBe(boom);

    // The first page's items were still delivered before the failure.
    expect(seen).toEqual(["a"]);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });
});
