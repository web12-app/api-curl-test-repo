/**
 * Password hashing compatible with the Werkzeug format used by the earlier Flask version:
 *   scrypt:<N>:<r>:<p>$<salt>$<hex>   (new hashes use N=32768, r=8, p=1)
 *   pbkdf2:sha256:<iterations>$<salt>$<hex>
 * Existing accounts keep logging in, and new hashes stay readable by the old format.
 */
import { pbkdf2Sync, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_BYTES = 64;
const SALT_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function randomSalt(length = 16): string {
  let out = "";
  for (const b of randomBytes(length)) out += SALT_CHARS[b % SALT_CHARS.length];
  return out;
}

function scryptMaxmem(n: number, r: number): number {
  return 128 * n * r * 2;
}

export function hashPassword(password: string): string {
  const salt = randomSalt();
  const key = scryptSync(password, salt, KEY_BYTES, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: scryptMaxmem(SCRYPT_N, SCRYPT_R),
  });
  return `scrypt:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}$${salt}$${key.toString("hex")}`;
}

export function verifyPassword(stored: string, password: string): boolean {
  const parts = String(stored).split("$");
  if (parts.length !== 3) return false;
  const [method, salt, hashHex] = parts;
  const expected = Buffer.from(hashHex, "hex");
  if (expected.length === 0) return false;

  let actual: Buffer;
  try {
    const m = method.split(":");
    if (m[0] === "scrypt" && m.length === 4) {
      const n = Number(m[1]);
      const r = Number(m[2]);
      const p = Number(m[3]);
      actual = scryptSync(password, salt, expected.length, { N: n, r, p, maxmem: scryptMaxmem(n, r) });
    } else if (m[0] === "pbkdf2" && m.length === 3 && m[1] === "sha256") {
      actual = pbkdf2Sync(password, salt, Number(m[2]), expected.length, "sha256");
    } else {
      return false;
    }
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
