import type { ZodError, ZodTypeAny, z } from "zod";
import { Errors } from "./errors.js";

// Renders every issue as `path: message`, joined by "; ". An issue on
// the value itself names its path `<root>`.
export function formatIssues(error: ZodError): string {
  return error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ");
}

// Parses `input` or throws a 400 listing every issue. `fallback` is the
// message for an error that carries no issues.
export function parseBody<S extends ZodTypeAny>(
  schema: S,
  input: unknown,
  fallback = "invalid request body",
): z.infer<S> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw Errors.badRequest(formatIssues(parsed.error) || fallback);
  return parsed.data;
}
