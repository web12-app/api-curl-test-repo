/**
 * Sliding-window limiter kept in process memory.
 *
 * Limits reset on restart and apply per process. Run one server process (or use a shared store)
 * so the limits mean what they say.
 */
export class RateLimiter {
  private hits = new Map<string, number[]>();

  private prune(key: string, windowSec: number, now: number): number[] {
    const q = (this.hits.get(key) ?? []).filter((t) => now - t <= windowSec * 1000);
    this.hits.set(key, q);
    return q;
  }

  /** Record a hit and return true, or return false when the limit is already reached. */
  allow(key: string, limit: number, windowSec: number): boolean {
    const now = Date.now();
    const q = this.prune(key, windowSec, now);
    if (q.length >= limit) return false;
    q.push(now);
    return true;
  }

  recordFailure(key: string, windowSec: number): void {
    const now = Date.now();
    this.prune(key, windowSec, now).push(now);
  }

  count(key: string, windowSec: number): number {
    return this.prune(key, windowSec, Date.now()).length;
  }

  clear(key: string): void {
    this.hits.delete(key);
  }
}

export const limiter = new RateLimiter();
