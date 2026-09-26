/**
 * A small per-key fixed-window rate limiter (per Api instance, in memory). Same shape as
 * PublicReadLimiter but instance-based so each surface picks its own budget.
 */
export class FixedWindowLimiter {
  private buckets: Map<string, { count: number; resetAt: number }> = new Map();

  constructor(public maxHits: number, public windowMs: number) {}

  /** TRUE when the call is within budget, FALSE when the caller should answer 429. */
  public allow(key: string, now = Date.now()): boolean {
    const k = key || "unknown";
    const bucket = this.buckets.get(k);
    if (!bucket || now >= bucket.resetAt) {
      this.buckets.set(k, { count: 1, resetAt: now + this.windowMs });
      if (this.buckets.size > 50000) this.prune(now);
      return true;
    }
    if (bucket.count >= this.maxHits) return false;
    bucket.count += 1;
    return true;
  }

  public reset() {
    this.buckets.clear();
  }

  private prune(now: number) {
    for (const [k, v] of this.buckets) if (now >= v.resetAt) this.buckets.delete(k);
  }
}
