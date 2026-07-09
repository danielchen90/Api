import { injectable } from "inversify";
import { sql } from "kysely";
import { getDb } from "../db/index.js";
import { UniqueIdHelper } from "@churchapps/apihelper";
import { CampaignEvent } from "../models/index.js";

// Pure persistence for campaignEvents — the append-only provider webhook log.
// Every READ filters churchId FIRST (mandatory tenancy).
//
// insert() is IDEMPOTENT: providerEventId is UNIQUE (Plan 01), so a redelivered
// Resend/Svix event collides on the unique index (MySQL ER_DUP_ENTRY) and is
// swallowed as already-recorded (returns false) rather than thrown. A fresh
// insert returns true. This makes at-least-once webhook delivery safe.
@injectable()
export class CampaignEventRepo {

  // ── Write: idempotent append-only insert ──
  //
  // Returns true on a fresh insert, false when the providerEventId was already
  // recorded (duplicate webhook — a safe no-op).
  public async insert(model: CampaignEvent): Promise<boolean> {
    if (UniqueIdHelper.isMissing(model.id)) model.id = UniqueIdHelper.shortId();
    try {
      await getDb().insertInto("campaignEvents").values({
        id: model.id,
        churchId: model.churchId,
        campaignId: model.campaignId,
        recipientId: model.recipientId,
        eventType: model.eventType,
        payloadJson: model.payloadJson,
        providerEventId: model.providerEventId,
        createdAt: model.createdAt ?? (sql`NOW()` as any)
      }).execute();
      return true;
    } catch (err: any) {
      // Duplicate providerEventId → already recorded, no-op (idempotent webhook).
      if (err?.code === "ER_DUP_ENTRY" || String(err?.message ?? "").includes("Duplicate entry")) return false;
      throw err;
    }
  }

  // ── Reads: churchId filter FIRST ──

  public async loadByCampaign(churchId: string, campaignId: string): Promise<CampaignEvent[]> {
    const rows = await getDb().selectFrom("campaignEvents").selectAll()
      .where("churchId", "=", churchId)
      .where("campaignId", "=", campaignId)
      .orderBy("createdAt", "desc")
      .execute();
    return rows.map((r) => this.rowToModel(r));
  }

  private rowToModel(row: any): CampaignEvent {
    if (!row) return null;
    return {
      id: row.id,
      churchId: row.churchId,
      campaignId: row.campaignId,
      recipientId: row.recipientId,
      eventType: row.eventType,
      payloadJson: row.payloadJson,
      providerEventId: row.providerEventId,
      createdAt: row.createdAt
    };
  }

  public convertToModel(_churchId: string, data: any) { return this.rowToModel(data); }
  public convertAllToModel(_churchId: string, data: any[]) { return (data || []).map((d) => this.rowToModel(d)); }
}
