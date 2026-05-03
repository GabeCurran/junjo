import type { Viewport } from "./types.ts";

export function filterViewports(
  viewports: readonly Viewport[],
  name: string | undefined,
): Viewport[] {
  if (!name) return [...viewports];
  const matches = viewports.filter((v) => v.name === name);
  if (matches.length === 0) {
    const known = viewports.map((v) => v.name).join(", ") || "(none)";
    throw new Error(`no viewport named "${name}". known viewports: ${known}`);
  }
  return matches;
}
