import crypto from "crypto";
import { Environment } from "../../../shared/helpers/Environment.js";

// HMAC-signed, self-contained token that authorizes an UNAUTHENTICATED one-click
// unsubscribe from an email footer link (no login, no session). Copied in shape
// from doing/helpers/ReminderTokenHelper (HMAC-SHA256 over base64url(payload),
// `.` separator, crypto.timingSafeEqual verify, epoch `exp` check) — deliberately
// NOT cross-imported so messaging owns its own unsubscribe primitive.
//
// DECISION (RESEARCH Open Q2): the token carries the EMAIL, not a recipientId.
// Suppression is CHURCH-WIDE keyed on email (see EmailSuppressionRepo header), so
// an email-in-token endpoint is fully self-contained — the public controller
// knows exactly what to suppress with NO DB lookup, and campus scope is
// irrelevant to a church-wide suppression.

interface TokenPayload {
  c: string; // churchId
  e: string; // email
  cam?: string; // optional campaignId (attribution/source)
  exp: number; // epoch seconds
}

const b64url = (buf: Buffer | string): string => Buffer.from(buf).toString("base64url");
const secret = (): string => Environment.jwtSecret || "unsubscribe-fallback-secret";

const sign = (data: string): string => crypto.createHmac("sha256", secret()).update(data).digest("base64url");

export class UnsubscribeTokenHelper {
  // Long default TTL (10 years): an unsubscribe link inside an archived email must
  // still work months/years after send.
  public static create(churchId: string, email: string, campaignId?: string, ttlDays = 3650): string {
    const exp = Math.floor(Date.now() / 1000) + ttlDays * 86400;
    const payload: TokenPayload = { c: churchId, e: email, cam: campaignId, exp };
    const body = b64url(JSON.stringify(payload));
    return `${body}.${sign(body)}`;
  }

  public static verify(token?: string): { churchId: string; email: string; campaignId?: string } | null {
    if (!token || typeof token !== "string") return null;
    const [body, sig] = token.split(".");
    if (!body || !sig) return null;

    const expected = sign(body);
    const sigBuf = Buffer.from(sig);
    const expBuf = Buffer.from(expected);
    // Guard equal length FIRST — timingSafeEqual throws on a length mismatch.
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;

    try {
      const p = JSON.parse(Buffer.from(body, "base64url").toString()) as TokenPayload;
      if (!p.c || !p.e || !p.exp || p.exp * 1000 < Date.now()) return null;
      return { churchId: p.c, email: p.e, campaignId: p.cam };
    } catch {
      return null;
    }
  }
}
