import { injectable } from "inversify";
import { sql } from "kysely";
import { getDb } from "../db/index.js";
import { UniqueIdHelper } from "@churchapps/apihelper";
import { CampaignRecipient } from "../models/index.js";

// Pure persistence for campaignRecipients — one frozen row per resolved
// recipient. NO campus-scope logic: campusId is FROZEN onto the row by the
// Phase-10 resolver and NEVER re-scoped here. Every READ filters churchId FIRST
// (mandatory tenancy).
//
// The audience freeze (Phase 10) materializes many rows at once, so a bulk
// saveAll() is provided. Engagement stamps (open/click/bounce/unsub +
// providerMessageId) are written via the churchId+id-guarded updateStatus.
@injectable()
export class CampaignRecipientRepo {

  // ── Writes ──

  // Single insert (assign id + createdAt + default status).
  public async save(model: CampaignRecipient): Promise<CampaignRecipient> {
    if (UniqueIdHelper.isMissing(model.id)) model.id = UniqueIdHelper.shortId();
    await getDb().insertInto("campaignRecipients").values(this.toRow(model)).execute();
    return model;
  }

  // Bulk insert — the freeze materializes many rows in one round-trip (Phase 10).
  public async saveAll(models: CampaignRecipient[]): Promise<CampaignRecipient[]> {
    if (!models || models.length === 0) return models;
    for (const m of models) if (UniqueIdHelper.isMissing(m.id)) m.id = UniqueIdHelper.shortId();
    await getDb().insertInto("campaignRecipients").values(models.map((m) => this.toRow(m))).execute();
    return models;
  }

  // ── Reads: churchId filter FIRST ──

  // All recipients of a campaign (church-scoped).
  public async loadByCampaign(churchId: string, campaignId: string): Promise<CampaignRecipient[]> {
    const rows = await getDb().selectFrom("campaignRecipients").selectAll()
      .where("churchId", "=", churchId)
      .where("campaignId", "=", campaignId)
      .execute();
    return rows.map((r) => this.rowToModel(r));
  }

  // Send drain — uses the (churchId, campaignId, status) index (Plan 01).
  public async loadByCampaignAndStatus(churchId: string, campaignId: string, status: string): Promise<CampaignRecipient[]> {
    const rows = await getDb().selectFrom("campaignRecipients").selectAll()
      .where("churchId", "=", churchId)
      .where("campaignId", "=", campaignId)
      .where("status", "=", status)
      .execute();
    return rows.map((r) => this.rowToModel(r));
  }

  // Send-drain READ — the next batch of unsent rows for a campaign (DLV-03: the
  // worker processes ≤ `limit` rows per pass, never the whole list at once). Uses
  // the (churchId, campaignId, status) send-drain index (2026-07-08 migration).
  public async loadPendingBatch(churchId: string, campaignId: string, limit = 100): Promise<CampaignRecipient[]> {
    const rows = await getDb().selectFrom("campaignRecipients").selectAll()
      .where("churchId", "=", churchId)
      .where("campaignId", "=", campaignId)
      .where("status", "=", "pending")
      .limit(limit)
      .execute();
    return rows.map((r) => this.rowToModel(r));
  }

  // ── Exactly-once per-recipient claim (DLV-04) ──
  //
  // The matched-rows-guarded claim: flip a SINGLE `pending` row to `sending`. The
  // WHERE status='pending' means only an UNCLAIMED row can win — and because the
  // claim literally CHANGES status pending→sending, matched ALWAYS equals changed
  // (no MySQL matched-vs-changed ambiguity here, unlike a same-value UPDATE), so
  // `numUpdatedRows === 1n` reliably means THIS worker won the row. Concurrent
  // drains cannot both win. The DB row-claim — NOT a transport idempotency token
  // (Pitfall 5: SES v1 has none) — IS the exactly-once guard. Compare against the
  // BigInt `1n`, never `1` (Pitfall 2).
  public async claimForSending(churchId: string, id: string): Promise<boolean> {
    const res = await getDb().updateTable("campaignRecipients")
      .set({ status: "sending" })
      .where("churchId", "=", churchId)
      .where("id", "=", id)
      .where("status", "=", "pending")
      .executeTakeFirst();
    return res.numUpdatedRows === 1n;
  }

  // ── Progress + completion counts (SND-06) ──
  //
  // Per-status counts for a campaign: powers the /status X-of-N progress AND the
  // worker's completion detection (flip to `sent` only when pending===0 &&
  // sending===0). One GROUP BY, church-scoped. Coerce MySQL's bigint COUNT to a
  // number.
  public async countByStatus(
    churchId: string,
    campaignId: string
  ): Promise<{ sent: number; failed: number; pending: number; sending: number; total: number }> {
    const rows = await getDb().selectFrom("campaignRecipients")
      .select(["status"])
      .select((eb) => eb.fn.countAll<number>().as("cnt"))
      .where("churchId", "=", churchId)
      .where("campaignId", "=", campaignId)
      .groupBy("status")
      .execute();
    const out = { sent: 0, failed: 0, pending: 0, sending: 0, total: 0 };
    for (const r of rows) {
      const n = Number((r as any).cnt);
      out.total += n;
      if ((r as any).status === "sent") out.sent = n;
      else if ((r as any).status === "failed") out.failed = n;
      else if ((r as any).status === "pending") out.pending = n;
      else if ((r as any).status === "sending") out.sending = n;
    }
    return out;
  }

  // Webhook tenancy lookup — resolve a provider message id back to its recipient.
  public async loadByProviderMessageId(churchId: string, providerMessageId: string): Promise<CampaignRecipient> {
    const row = await getDb().selectFrom("campaignRecipients").selectAll()
      .where("churchId", "=", churchId)
      .where("providerMessageId", "=", providerMessageId)
      .executeTakeFirst();
    return this.rowToModel(row);
  }

  // ── Guarded engagement update (church + id) ──
  //
  // Send-result + tracking stamps. Only the fields passed in are set (partial
  // patch), so a bounce stamp never clobbers an earlier open stamp.
  public async updateStatus(
    churchId: string,
    id: string,
    extra: {
      status?: string;
      providerMessageId?: string;
      errorMessage?: string;
      openedAt?: Date;
      clickedAt?: Date;
      bouncedAt?: Date;
      unsubscribedAt?: Date;
    }
  ): Promise<void> {
    await getDb().updateTable("campaignRecipients")
      .set({
        ...(extra.status !== undefined ? { status: extra.status } : {}),
        ...(extra.providerMessageId !== undefined ? { providerMessageId: extra.providerMessageId } : {}),
        ...(extra.errorMessage !== undefined ? { errorMessage: extra.errorMessage } : {}),
        ...(extra.openedAt !== undefined ? { openedAt: extra.openedAt } : {}),
        ...(extra.clickedAt !== undefined ? { clickedAt: extra.clickedAt } : {}),
        ...(extra.bouncedAt !== undefined ? { bouncedAt: extra.bouncedAt } : {}),
        ...(extra.unsubscribedAt !== undefined ? { unsubscribedAt: extra.unsubscribedAt } : {})
      })
      .where("churchId", "=", churchId)
      .where("id", "=", id)
      .execute();
  }

  // Build an insert row (assign createdAt NOW() + default status).
  private toRow(model: CampaignRecipient): any {
    return {
      id: model.id,
      churchId: model.churchId,
      campaignId: model.campaignId,
      personId: model.personId,
      email: model.email,
      campusId: model.campusId,
      mergeSnapshot: model.mergeSnapshot,
      status: model.status ?? "pending",
      openedAt: model.openedAt,
      clickedAt: model.clickedAt,
      bouncedAt: model.bouncedAt,
      unsubscribedAt: model.unsubscribedAt,
      providerMessageId: model.providerMessageId,
      errorMessage: model.errorMessage,
      createdAt: model.createdAt ?? (sql`NOW()` as any)
    };
  }

  private rowToModel(row: any): CampaignRecipient {
    if (!row) return null;
    return {
      id: row.id,
      churchId: row.churchId,
      campaignId: row.campaignId,
      personId: row.personId,
      email: row.email,
      campusId: row.campusId,
      mergeSnapshot: row.mergeSnapshot,
      status: row.status,
      openedAt: row.openedAt,
      clickedAt: row.clickedAt,
      bouncedAt: row.bouncedAt,
      unsubscribedAt: row.unsubscribedAt,
      providerMessageId: row.providerMessageId,
      errorMessage: row.errorMessage,
      createdAt: row.createdAt
    };
  }

  public convertToModel(_churchId: string, data: any) { return this.rowToModel(data); }
  public convertAllToModel(_churchId: string, data: any[]) { return (data || []).map((d) => this.rowToModel(d)); }
}
