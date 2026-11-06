// Lazy expiry for bans and sanctions: rows are never flipped when their
// time passes, so every read decides activity here. A null `until` is
// permanent; an `until` at or before `now` has lapsed.
export function isActiveUntil(until: Date | null, now: Date): boolean {
  return until === null || until > now;
}
