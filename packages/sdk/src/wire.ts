import { JunjoError } from "./errors.js";

// `new Date("garbage")` yields an Invalid Date that only blows up later
// (e.g. at toISOString), far from the cause. Wire timestamps fail loudly
// at the deserialization boundary instead, naming the offending field.
export function parseWireDate(value: string, field: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new JunjoError(
      `invalid timestamp in ${field}: ${JSON.stringify(value)}`,
      "invalid_wire_data",
    );
  }
  return date;
}
