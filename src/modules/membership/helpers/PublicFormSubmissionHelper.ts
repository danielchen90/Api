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
}
