import { act } from "@testing-library/react";
import { vi } from "vitest";
import { STREAM_TEARDOWN_DELAY_MS } from "./subscriptionHub.js";

// Test helpers for the hub's deferred stream teardown. The fake clock
// still advances with real time, so waitFor keeps polling; the
// teardown delay is skipped on demand instead of waited out.

/** Fakes setTimeout for the rest of the test; restore with vi.useRealTimers(). */
export function useTeardownTimers(): void {
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout"] });
}

/** Runs any stream teardown the hub has deferred. */
export function passTeardownDelay(): void {
  act(() => {
    vi.advanceTimersByTime(STREAM_TEARDOWN_DELAY_MS);
  });
}
