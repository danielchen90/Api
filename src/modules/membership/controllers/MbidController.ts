import { controller, httpPost } from "inversify-express-utils";
import express from "express";
import crypto from "crypto";
import { MembershipBaseController } from "./MembershipBaseController.js";
import { MbidAccountErasure } from "../helpers/mbid/MbidAccountErasure.js";

const MAX_SKEW_S = 300;

/**
 * Service calls from Mary Banks ID (/membership/mbid).
 *
 * POST /membership/mbid/account-deleted { sub }
 *   Called by the Partners relay after a Mary Banks ID account is deleted (the Keycloak user is
 *   already gone). Signed with the shared secret MBID_DELETION_SECRET:
 *     x-mbid-timestamp: unix seconds (must be within 300 s of now)
 *     x-mbid-signature: hex HMAC-SHA256(secret, `${timestamp}.${sub}`)
 *   503 when the secret is not set, 401 on a bad or stale signature, 500 on failure (the relay
 *   retries), else 200 { ok: true, found, erased? }. Idempotent: an unknown or already erased sub
 *   answers found: false. What is deleted vs anonymized: MbidAccountErasure.
 */
@controller("/membership/mbid")
export class MbidController extends MembershipBaseController {
  static verify(secret: string, timestamp: string, sub: string, signature: string, nowS = Math.floor(Date.now() / 1000)): boolean {
    const ts = Number(timestamp);
    if (!/^\d{1,12}$/.test(timestamp) || !Number.isFinite(ts) || Math.abs(nowS - ts) > MAX_SKEW_S) return false;
    const expected = crypto.createHmac("sha256", secret).update(`${timestamp}.${sub}`).digest("hex");
    const given = String(signature || "").trim().toLowerCase();
    if (given.length !== expected.length || !/^[0-9a-f]+$/.test(given)) return false;
    return crypto.timingSafeEqual(Buffer.from(given, "utf8"), Buffer.from(expected, "utf8"));
  }

  @httpPost("/account-deleted")
  public async accountDeleted(req: express.Request, res: express.Response): Promise<any> {
    return this.actionWrapperAnon(req, res, async () => {
      const secret = process.env.MBID_DELETION_SECRET || "";
      if (!secret) return this.json({ ok: false, error: "not_configured" }, 503);
      const sub = String((req.body as any)?.sub || "").trim();
      const timestamp = String(req.headers["x-mbid-timestamp"] || "").trim();
      const signature = String(req.headers["x-mbid-signature"] || "");
      if (!sub || sub.length > 64 || !MbidController.verify(secret, timestamp, sub, signature)) return this.json({ ok: false, error: "unauthorized" }, 401);
      try {
        const result = await MbidAccountErasure.erase(sub);
        console.log("[mbid-erase] sub=" + sub + " found=" + result.found + " erased=" + JSON.stringify(result.erased));
        return this.json(result.found ? { ok: true, found: true, erased: result.erased } : { ok: true, found: false }, 200);
      } catch (e: any) {
        console.error("[mbid-erase] sub=" + sub + " failed: " + String(e?.message || e).slice(0, 300));
        return this.json({ ok: false, error: "erase_failed" }, 500);
      }
    });
  }
}
