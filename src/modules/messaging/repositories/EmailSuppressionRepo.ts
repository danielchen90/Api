import { injectable } from "inversify";
import { sql } from "kysely";
import { getDb } from "../db/index.js";
import { UniqueIdHelper } from "@churchapps/apihelper";
import { EmailSuppression } from "../models/index.js";

// Pure persistence for emailSuppression — the CHURCH-WIDE suppression list (NOT
// campus-scoped: a suppressed email is suppressed for the whole church). Every
// READ filters churchId FIRST (mandatory tenancy).
//
// add() is IDEMPOTENT against the UNIQUE (churchId, email) index (Plan 01): a
// second suppression of the same address collides (MySQL ER_DUP_ENTRY) and is
// swallowed as already-suppressed. isSuppressed() is the send-time gate
// (Phase 11/14 consumer).
@injectable()
export class EmailSuppressionRepo {

  // ── Write: idempotent church-wide suppression ──
  //
  // Returns true on a fresh row, false when the email was already suppressed.
  public async add(model: EmailSuppression): Promise<boolean> {
    if (UniqueIdHelper.isMissing(model.id)) model.id = UniqueIdHelper.shortId();
    try {
      await getDb().insertInto("emailSuppression").values({
        id: model.id,
        churchId: model.churchId,
        email: model.email,
        reason: model.reason,
        sourceCampaignId: model.sourceCampaignId,
        createdAt: model.createdAt ?? (sql`NOW()` as any)
      }).execute();
      return true;
    } catch (err: any) {
      // Duplicate (churchId,email) → already suppressed, no-op.
      if (err?.code === "ER_DUP_ENTRY" || String(err?.message ?? "").includes("Duplicate entry")) return false;
      throw err;
    }
  }

  // ── Delete: resubscribe (member opt-back-in) ──
  //
  // Removes suppression rows for (churchId, email) whose reason is in `reasons`.
  // DECISION (RESEARCH Open Q3 + Pitfall 6): default reasons=["unsubscribe"] so a
  // resubscribe undoes ONLY the member's own opt-out. It MUST NOT clear
  // reason="bounce" or "complaint" — those are DELIVERABILITY FACTS (a hard-bounced
  // or complaining address is dead; re-enabling it damages sender reputation). The
  // `reasons` param is filtered into the WHERE, so the default can never
  // accidentally un-suppress a bounce/complaint. Returns the delete count.
  public async remove(churchId: string, email: string, reasons: string[] = ["unsubscribe"]): Promise<number> {
    const res = await getDb().deleteFrom("emailSuppression")
      .where("churchId", "=", churchId)
      .where("email", "=", email)
      .where("reason", "in", reasons)
      .executeTakeFirst();
    return Number(res.numDeletedRows ?? 0n);
  }

  // ── Reads: churchId filter FIRST ──

  // Send-time gate — true if this email is suppressed for the church.
  public async isSuppressed(churchId: string, email: string): Promise<boolean> {
    const row = await getDb().selectFrom("emailSuppression").select(["id"])
      .where("churchId", "=", churchId)
      .where("email", "=", email)
      .executeTakeFirst();
    return !!row;
  }

  public async loadByEmail(churchId: string, email: string): Promise<EmailSuppression> {
    const row = await getDb().selectFrom("emailSuppression").selectAll()
      .where("churchId", "=", churchId)
      .where("email", "=", email)
      .executeTakeFirst();
    return this.rowToModel(row);
  }

  public async loadByChurchId(churchId: string): Promise<EmailSuppression[]> {
    const rows = await getDb().selectFrom("emailSuppression").selectAll()
      .where("churchId", "=", churchId)
      .orderBy("createdAt", "desc")
      .execute();
    return rows.map((r) => this.rowToModel(r));
  }

  private rowToModel(row: any): EmailSuppression {
    if (!row) return null;
    return {
      id: row.id,
      churchId: row.churchId,
      email: row.email,
      reason: row.reason,
      sourceCampaignId: row.sourceCampaignId,
      createdAt: row.createdAt
    };
  }

  public convertToModel(_churchId: string, data: any) { return this.rowToModel(data); }
  public convertAllToModel(_churchId: string, data: any[]) { return (data || []).map((d) => this.rowToModel(d)); }
}
