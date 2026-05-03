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
  // Admin token gating the cross-game user query (`GET /v1/users/:junjoUserId/games`).
  // Optional: when unset the route is effectively disabled (every request 401s),
  // so self-hosters with one game per server can ignore it. Cloud + dashboard
  // deployments set it to a long random string.
  JUNJO_ADMIN_TOKEN: z.string().min(1, "JUNJO_ADMIN_TOKEN must not be empty when set").optional(),
  // Per-API-key rate limit on `/v1/*` routes that go through the apiKey
  // middleware. Token-bucket: `RATE_LIMIT_PER_MINUTE` is the sustained
  // refill rate, `RATE_LIMIT_BURST` is the bucket capacity. Both default
  // to 600 / 100 (Phase 14.1 spec). Setting either to 0 disables rate
  // limiting entirely; "" or unset falls back to the default.
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
  // Minimum log level for the structured logger (Phase 14.2). One of
  // `error`, `warn`, `info`, `debug`, `silent`. Defaults to `info`;
  // `silent` suppresses every line. Empty string falls back to the
  // default; unrecognized values are rejected at startup.
  LOG_LEVEL: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? "info" : v))
    .pipe(z.enum(["error", "warn", "info", "debug", "silent"])),
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
