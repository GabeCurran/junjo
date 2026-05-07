// Runtime config that route schemas need to read on every request,
// distinct from the boot-time env (which loads once into a typed Env).
// Schemas live as top-level constants in `routes/*.schema.ts` and are
// constructed at module-load time, so anything they consult must be
// resolvable lazily; hence the getter/setter shape.

const DEFAULT_MAX_PAGE_SIZE = 100;

let maxPageSize = DEFAULT_MAX_PAGE_SIZE;

export function getMaxPageSize(): number {
  return maxPageSize;
}

export function setMaxPageSize(value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`maxPageSize must be a positive integer (got ${value})`);
  }
  maxPageSize = value;
}

// Test-only escape hatch. The default is the same as cloud, so most
// suites need no setup; suites that exercise the cap restore it via
// this helper after a setMaxPageSize call.
export function resetMaxPageSize(): void {
  maxPageSize = DEFAULT_MAX_PAGE_SIZE;
}
