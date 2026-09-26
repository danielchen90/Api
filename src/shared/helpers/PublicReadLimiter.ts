import express from "express";

/**
 * PublicReadLimiter: a per-IP, per-surface fixed-window limiter for ANONYMOUS public reads
 * (campus content, public events feed). Same shape as PublicFormSubmissionHelper.rateLimit (the
 * login-free submit limiter), but with a much larger budget because reads are cheap and the public
 * site's server renderer may call from a single IP.
 *
 * PER-INSTANCE in-memory (not shared across Api replicas): a minimum abuse brake, not a global cap.
 * Pair it with the Cache-Control headers the endpoints set so a CDN / ISR layer absorbs most reads.
 */
export class PublicReadLimiter {
  public static MAX_HITS = 5000; // per window, per IP, per surface (the public site renders server-side from one IP)
  public static WINDOW_MS = 60 * 1000;
  private static buckets: Map<string, { count: number; resetAt: number }> = new Map();

  public static clientIp(req: express.Request): string {
    const fwd = (req.headers?.["x-forwarded-for"] as string) || "";
    const first = fwd.split(",")[0]?.trim();
    return first || (req as any).ip || (req as any).socket?.remoteAddress || "unknown";
  }

  /** TRUE when the request is within budget; FALSE when the caller should answer 429. */
  public static allow(ip: string, surface: string, now = Date.now()): boolean {
    const key = `${ip || "unknown"}:${surface}`;
    const bucket = PublicReadLimiter.buckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      PublicReadLimiter.buckets.set(key, { count: 1, resetAt: now + PublicReadLimiter.WINDOW_MS });
      if (PublicReadLimiter.buckets.size > 50000) PublicReadLimiter.prune(now);
      return true;
    }
    if (bucket.count >= PublicReadLimiter.MAX_HITS) return false;
    bucket.count += 1;
    return true;
  }

  /** Short shared cache for anonymous reads: browsers 60s, shared caches 5 min. */
  public static setCacheHeaders(res: express.Response, maxAge = 60, sMaxAge = 300) {
    try {
      res.set("Cache-Control", `public, max-age=${maxAge}, s-maxage=${sMaxAge}, stale-while-revalidate=600`);
    } catch {
      // headers already sent / fake response in tests
    }
  }

  public static reset() {
    PublicReadLimiter.buckets.clear();
  }

  private static prune(now: number) {
    for (const [k, v] of PublicReadLimiter.buckets) if (now >= v.resetAt) PublicReadLimiter.buckets.delete(k);
  }
}
