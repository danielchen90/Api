import crypto from "crypto";

/**
 * Six-digit email codes. Only an HMAC is stored: HMAC-SHA256 keyed with ENCRYPTION_KEY (falling
 * back to JWT_SECRET) over a random per-row salt, the user id, the address and the code. Without
 * the server key a leaked row cannot be brute-forced offline, and the salt keeps two rows for the
 * same code distinct.
 */
export class EmailCodeHelper {
  public static TTL_MS = 30 * 60 * 1000;
  public static MAX_ATTEMPTS = 5;
  public static MAX_SENDS_PER_HOUR = 5;

  public static generate(): string {
    return crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
  }

  public static newSalt(): string {
    return crypto.randomBytes(16).toString("hex");
  }

  private static key(): string {
    const k = process.env.ENCRYPTION_KEY || process.env.JWT_SECRET || "";
    if (!k) throw new Error("ENCRYPTION_KEY is not set");
    return k;
  }

  public static hash(code: string, salt: string, userId: string, email: string): string {
    return crypto.createHmac("sha256", EmailCodeHelper.key()).update(salt + ":" + userId + ":" + email + ":" + code).digest("hex");
  }

  public static matches(code: string, salt: string, userId: string, email: string, expectedHash: string): boolean {
    if (!/^\d{6}$/.test(code || "")) return false;
    const actual = Buffer.from(EmailCodeHelper.hash(code, salt, userId, email), "utf8");
    const expected = Buffer.from(expectedHash || "", "utf8");
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  }

  public static subject = "Your Bible Teachers International code";

  public static bodyText(code: string): string {
    return "Your code is " + code + ". Enter it to add this email to your Mary Banks ID. If you didn't ask for this, ignore this email.";
  }

  public static bodyHtml(code: string): string {
    return "<p>Your code is</p>" +
      `<p style="font-size: 28px; font-weight: bold; letter-spacing: 6px; text-align: center; font-family: monospace; padding: 16px; background: #f3f4f6; border-radius: 6px;">${code}</p>` +
      "<p>Enter it to add this email to your Mary Banks ID. If you didn't ask for this, ignore this email.</p>";
  }
}
