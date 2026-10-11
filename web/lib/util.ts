export function nowIso(): string {
  return new Date().toISOString();
}

/** Seconds since the epoch, as a float (same unit the Flask version stored in sessions). */
export function nowSec(): number {
  return Date.now() / 1000;
}

export function isPlainObject(v: unknown): v is Record<string, any> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Parse an integer from a query string or JSON value. Returns null when it is not a whole number. */
export function parseIntStrict(v: unknown): number | null {
  if (typeof v === "number") return Number.isInteger(v) ? v : null;
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!/^[+-]?\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}
