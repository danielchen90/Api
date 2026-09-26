/**
 * PublicFormSubmissionHelper — spam defense for the login-free prayer/contact submit
 * (FRM-04). Two layered, login-free defenses:
 *
 *   1. HONEYPOT (`isBot`) — a hidden form field (`website`) that a human never sees and
 *      thus never fills, but naive bots auto-complete. A non-empty honeypot ⇒ bot ⇒ the
 *      controller SILENTLY drops the submission (success-shaped response, nothing stored).
 *
 *   2. PER-IP / PER-FORM RATE LIMIT (`rateLimit`) — an in-memory token bucket keyed on
 *      `${ip}:${formKey}` that rejects burst submissions (429).
 *
 * TERTIARY / FUTURE HARDENING (RESEARCH Pitfall 5): the rate limiter is PER-INSTANCE
 * in-memory. Railway may run MULTIPLE Api instances, so a determined attacker spread
 * across instances gets N× the budget — this is a MINIMUM defense layered on top of the
 * honeypot, NOT a hard global cap. A shared store (Redis / DB token bucket) is the future
 * hardening; the honeypot (instance-independent) is the primary bot filter.
 */
export class PublicFormSubmissionHelper {
  // Hidden honeypot field name. Kept private so both the check and any doc reference it
  // from one place. The public form must render a field named `website` off-screen.
  private static HONEYPOT_FIELD = "website";

  // Token-bucket limits: at most MAX_HITS submits per WINDOW_MS per (ip, form).
  private static MAX_HITS = 5;
  private static WINDOW_MS = 10 * 60 * 1000; // 10 minutes

  // Per-instance in-memory buckets. key → { count, resetAt }. Not shared across Railway
  // instances (see class doc) — a minimum defense, not a global cap.
  private static buckets: Map<string, { count: number; resetAt: number }> = new Map();

  /**
   * Honeypot check. A non-empty hidden field means a bot filled it in → drop.
   * A human leaves it blank (it is visually hidden), so blank ⇒ NOT a bot.
   */
  public static isBot(body: any): boolean {
    const val = body?.[PublicFormSubmissionHelper.HONEYPOT_FIELD];
    return typeof val === "string" ? val.trim().length > 0 : val !== undefined && val !== null && val !== "";
  }

  /**
   * Per-IP / per-form token bucket. Returns TRUE when the request is within budget
   * (allowed) and FALSE when the bucket is exhausted (the controller returns 429).
   *
   * @param ip       requester IP (server-derived from x-forwarded-for / socket).
   * @param formKey  the form discriminator — formId when present, else submissionType.
   */
  public static rateLimit(ip: string, formKey: string): boolean {
    const key = `${ip || "unknown"}:${formKey || "unknown"}`;
    const now = Date.now();
    const bucket = PublicFormSubmissionHelper.buckets.get(key);

    if (!bucket || now >= bucket.resetAt) {
      // Fresh window.
      PublicFormSubmissionHelper.buckets.set(key, { count: 1, resetAt: now + PublicFormSubmissionHelper.WINDOW_MS });
      return true;
    }

    if (bucket.count >= PublicFormSubmissionHelper.MAX_HITS) return false; // exhausted → 429
    bucket.count += 1;
    return true;
  }

  // ── Next Steps form types (website redesign 2026-09) ──
  public static VALID_TYPES = ["prayer", "contact", "visit", "salvation", "baptism", "serve", "discipleship"];
  // Types whose free-text message is required (the original prayer/contact forms). The Next Steps
  // types are a "tap to respond" action where name + email are enough.
  public static MESSAGE_REQUIRED_TYPES = ["prayer", "contact"];
  public static MAX_NOTES = 1000;

  /**
   * Validate the optional "visit" extras. Returns `{ extra }` (only the provided, cleaned fields; null
   * when none) or `{ error }`.
   *   visitDate  ISO date (YYYY-MM-DD or a full ISO timestamp), today .. today+365 days
   *   partySize  integer 1..20
   *   notes      string, max 1000
   * `now` is injectable for tests. "Today" is evaluated in UTC with one day of slack on the lower
   * bound so a visitor west of UTC picking their local today is not rejected.
   */
  public static validateVisitExtra(body: any, now: Date = new Date()): { extra?: Record<string, any> | null; error?: string } {
    const extra: Record<string, any> = {};

    if (body?.visitDate !== undefined && body.visitDate !== null && body.visitDate !== "") {
      const raw = body.visitDate.toString().trim();
      if (!/^\d{4}-\d{2}-\d{2}(T.*)?$/.test(raw)) return { error: "Visit date must be a date (YYYY-MM-DD)." };
      const day = raw.slice(0, 10);
      const d = new Date(day + "T00:00:00Z");
      if (isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== day) return { error: "Visit date must be a date (YYYY-MM-DD)." };
      const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
      const dayMs = 24 * 60 * 60 * 1000;
      if (d.getTime() < todayUtc - dayMs) return { error: "Visit date cannot be in the past." };
      if (d.getTime() > todayUtc + 365 * dayMs) return { error: "Visit date must be within the next year." };
      extra.visitDate = day;
    }

    if (body?.partySize !== undefined && body.partySize !== null && body.partySize !== "") {
      const n = Number(body.partySize);
      if (!Number.isInteger(n) || n < 1 || n > 20) return { error: "Party size must be a whole number from 1 to 20." };
      extra.partySize = n;
    }

    if (body?.notes !== undefined && body.notes !== null && body.notes !== "") {
      if (typeof body.notes !== "string") return { error: "Notes must be text." };
      const t = body.notes.trim();
      if (t.length > PublicFormSubmissionHelper.MAX_NOTES) return { error: "Notes can be at most 1000 characters." };
      if (t) extra.notes = t;
    }

    return { extra: Object.keys(extra).length > 0 ? extra : null };
  }
}
