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
