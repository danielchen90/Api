// DLV-02 — per-church email identity (Phase 11, Plan 01). ONE row per church
// (upserted by churchId): the from-name, from-email and reply-to a campaign sends
// under. This is stored intent — the LIVE sendable decision still comes from
// VerifiedDomainGate (never a stored `verified` flag). Mirrors the membership
// Setting model shape; `createdAt`/`updatedAt` are Dates set server-side.
export class ChurchEmailSettings {
  public id?: string;
  public churchId?: string;
  public fromName?: string;
  public fromEmail?: string;
  public replyTo?: string;
  public createdAt?: Date;
  public updatedAt?: Date;
}
