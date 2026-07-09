import {
  SESClient,
  GetIdentityVerificationAttributesCommand,
  GetAccountSendingEnabledCommand,
  GetSendQuotaCommand
} from "@aws-sdk/client-ses";

// DLV-02 — the LIVE verified-domain gate (Phase 11, Plan 01). The send decision
// is derived from real AWS state EVERY 5-minute window — CONTEXT locks: NEVER
// trust a stored `verified` flag (a domain can fall out of verification, or the
// account can be paused, without any DB write). A short TTL cache keeps this off
// the per-recipient hot path (the Plan 02 worker checks once per batch, not per
// email).
//
// Pitfall 1: an identity being VERIFIED is NOT the same as being out of the SES
// sandbox. GetAccountSendingEnabled + the send quota surface sandbox / paused
// caps — a domain can be "Success"-verified while the account is still sandboxed
// or sending-disabled. isSendable() combines BOTH signals; status()/quota()
// expose the caps for the B1Admin banner.
export class VerifiedDomainGate {
  private static readonly TTL_MS = 5 * 60 * 1000;
  private static cache: Record<string, { ok: boolean; at: number }> = {};

  private static client() {
    // Region is env-driven (AWS_REGION), defaulting to us-east-1 — where huro.church
    // is verified with production sending access (confirmed live 2026-07-09). The
    // earlier us-east-2 assumption was wrong: no identity is verified there, so the
    // gate reported the domain unverified. Keep in sync with SesEmailDeliveryProvider.
    return new SESClient({ region: process.env.AWS_REGION || "us-east-1" });
  }

  // Live: identity VERIFIED (VerificationStatus === "Success") AND account
  // sending ENABLED. Cached per domain for 5 minutes.
  public static async isSendable(domain: string): Promise<boolean> {
    const cached = this.cache[domain];
    if (cached && Date.now() - cached.at < this.TTL_MS) return cached.ok;

    const ses = this.client();
    const [attrs, acct] = await Promise.all([
      ses.send(new GetIdentityVerificationAttributesCommand({ Identities: [domain] })),
      ses.send(new GetAccountSendingEnabledCommand({}))
    ]);

    const verified = attrs.VerificationAttributes?.[domain]?.VerificationStatus === "Success";
    // acct.Enabled may be undefined on some accounts — treat only an explicit
    // false as "disabled".
    const ok = !!verified && acct.Enabled !== false;

    this.cache[domain] = { ok, at: Date.now() };
    return ok;
  }

  // SES account send quota — the Plan 02 worker uses this to pace sends against
  // MaxSendRate (per-second) and Max24HourSend (rolling daily cap). Kept here so
  // ALL SES-account reads live in one helper. Missing numbers default to 0.
  public static async quota(): Promise<{ maxSendRate: number; max24Hour: number; sentLast24: number }> {
    const q = await this.client().send(new GetSendQuotaCommand({}));
    return {
      maxSendRate: q.MaxSendRate ?? 0,
      max24Hour: q.Max24HourSend ?? 0,
      sentLast24: q.SentLast24Hours ?? 0
    };
  }

  // Data source for the B1Admin sending-status banner (Plan 02 wires the route).
  // Combines the live sendable decision with the current quota so the UI can show
  // "verified + N of M sent today, cap X/sec" or a sandbox/paused warning.
  public static async status(domain: string): Promise<{
    sendable: boolean;
    maxSendRate: number;
    max24Hour: number;
    sentLast24: number;
  }> {
    const [sendable, q] = await Promise.all([this.isSendable(domain), this.quota()]);
    return { sendable, ...q };
  }
}
