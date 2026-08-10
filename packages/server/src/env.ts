import { z } from "zod";

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  PORT: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? 8787 : Number(v)))
    .pipe(z.number().int().positive()),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  JUNJO_BASE_URL: z.string().url().optional(),
  // When unset the admin endpoints are effectively disabled (every
  // request 401s); cloud + dashboard deployments set a long random string.
  JUNJO_ADMIN_TOKEN: z.string().min(1, "JUNJO_ADMIN_TOKEN must not be empty when set").optional(),
  // Setting either rate-limit field to 0 disables rate limiting entirely;
  // "" or unset falls back to the default.
  RATE_LIMIT_PER_MINUTE: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? 600 : Number(v)))
    .pipe(
      z
        .number()
        .int("RATE_LIMIT_PER_MINUTE must be a non-negative integer")
        .nonnegative("RATE_LIMIT_PER_MINUTE must be a non-negative integer"),
    ),
  RATE_LIMIT_BURST: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? 100 : Number(v)))
    .pipe(
      z
        .number()
        .int("RATE_LIMIT_BURST must be a non-negative integer")
        .nonnegative("RATE_LIMIT_BURST must be a non-negative integer"),
    ),
  LOG_LEVEL: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? "info" : v))
    .pipe(z.enum(["error", "warn", "info", "debug", "silent"])),
  // Upper bound on the `limit` query parameter for every list endpoint.
  // Default 100 matches cloud's abuse-protection ceiling; self-hosters
  // running junjo against their own infrastructure can raise it. The
  // SDK and webhook delivery worker honor whatever value the server
  // accepts, so no client-side change is needed beyond passing a higher
  // limit. Set at boot via setMaxPageSize() in index.ts; tests can
  // override via the same setter.
  JUNJO_MAX_PAGE_SIZE: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? 100 : Number(v)))
    .pipe(
      z
        .number()
        .int("JUNJO_MAX_PAGE_SIZE must be a positive integer")
        .positive("JUNJO_MAX_PAGE_SIZE must be a positive integer"),
    ),
  // Whether a trusted proxy fronts the server and APPENDS the client
  // address to x-forwarded-for (Railway, nginx, any standard LB). When
  // true, rate limiting keys keyless traffic on the rightmost
  // x-forwarded-for hop (the one hop the client cannot forge). When
  // false (default, correct for direct exposure), the header is ignored
  // entirely and the socket address is used. Cloud deployments behind
  // Railway MUST set this to "true" or all keyless traffic shares the
  // proxy's socket address bucket.
  TRUST_PROXY: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),
  // Operator escape hatch for webhook URL SSRF guard. Default false rejects
  // POST /v1/webhooks { url: ... } pointed at loopback / link-local /
  // RFC1918 / IPv6 ULA hosts. Self-host devs running a receiver on the same
  // machine set "true" or "1" to permit them.
  WEBHOOK_ALLOW_PRIVATE_HOSTS: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid server environment:\n${issues}`);
  }
  return parsed.data;
}
