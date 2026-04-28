import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

// API keys are presented to the dev as `{prefix}.{secret}`. The prefix
// is stored in plaintext and indexed for O(1) lookup; the secret is
// scrypt-hashed because a database leak should not be enough to act as
// the developer.

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

const SALT_BYTES = 16;
const KEY_BYTES = 32;
const PREFIX_BYTES = 12;
const SECRET_BYTES = 32;

export interface RawApiKey {
  prefix: string;
  secret: string;
  full: string; // `prefix.secret`
  hashedSecret: string;
}

export async function generateApiKey(): Promise<RawApiKey> {
  const prefix = `jk_${randomBytes(PREFIX_BYTES).toString("base64url")}`;
  const secret = randomBytes(SECRET_BYTES).toString("base64url");
  const hashedSecret = await hashSecret(secret);
  return { prefix, secret, full: `${prefix}.${secret}`, hashedSecret };
}

export async function hashSecret(secret: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await scrypt(secret, salt, KEY_BYTES);
  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifySecret(secret: string, stored: string): Promise<boolean> {
  const [scheme, saltB64, keyB64] = stored.split("$");
  if (scheme !== "scrypt" || !saltB64 || !keyB64) return false;
  const salt = Buffer.from(saltB64, "base64");
  const expected = Buffer.from(keyB64, "base64");
  if (expected.length !== KEY_BYTES) return false;
  const got = await scrypt(secret, salt, KEY_BYTES);
  return got.length === expected.length && timingSafeEqual(got, expected);
}

export function parseApiKey(raw: string): { prefix: string; secret: string } | null {
  const dot = raw.indexOf(".");
  if (dot < 1 || dot === raw.length - 1) return null;
  return { prefix: raw.slice(0, dot), secret: raw.slice(dot + 1) };
}
