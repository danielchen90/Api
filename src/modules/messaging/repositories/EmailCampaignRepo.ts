import { injectable } from "inversify";
import { sql } from "kysely";
import { getDb } from "../db/index.js";
import { UniqueIdHelper } from "@churchapps/apihelper";
import { EmailCampaign } from "../models/index.js";

// Pure persistence for emailCampaigns — the campaign entity. NO campus-scope
// logic here (campaigns are church-scoped; recipients carry the frozen campusId).
// Every READ filters churchId FIRST (mandatory tenancy) and removed=false
// (soft-deletable).
//
// `updateWithVersion` is the OCC guard (mirrors PersonOrdinationRepo): it ALWAYS
// bumps version = version + 1 guarded by WHERE version = expectedVersion and
// returns numUpdatedRows (bigint). 0n means a stale expectedVersion or vanished
// row → the controller maps it to 409 (the double-send + edit-after-schedule
// guard). Callers compare against BigInt 0n, never 0.
//
// `updateCounters` is a churchId+id-guarded rollup progress bump (NOT
// version-guarded — send progress is not an edit conflict, so it must never 409).
@injectable()
export class EmailCampaignRepo {

  // ── Write: INSERT (assign id + version 1 + createdAt + defaults) ──
  public async save(model: EmailCampaign): Promise<EmailCampaign> {
    if (UniqueIdHelper.isMissing(model.id)) {
      model.id = UniqueIdHelper.shortId();
      model.version = 1;
    }
    await getDb().insertInto("emailCampaigns").values({
      id: model.id,
      churchId: model.churchId,
      status: model.status ?? "draft",
      version: 1,
      name: model.name,
      scheduledAt: model.scheduledAt,
      audienceFilterJson: model.audienceFilterJson,
      templateId: model.templateId,
      blockJson: model.blockJson,
      subject: model.subject,
      renderedHtml: model.renderedHtml,
      renderedText: model.renderedText,
      recipientCount: model.recipientCount ?? 0,
      sentCount: model.sentCount ?? 0,
      failedCount: model.failedCount ?? 0,
      createdAt: model.createdAt ?? (sql`NOW()` as any),
      createdBy: model.createdBy,
      removed: false
    }).execute();
    return model;
  }

  // ── Reads: churchId filter FIRST, removed=false ──

  // Get-by-id (church-scoped). Missing/out-of-tenant id → null (404-hide upstream).
  public async load(churchId: string, id: string): Promise<EmailCampaign> {
    const row = await getDb().selectFrom("emailCampaigns").selectAll()
      .where("churchId", "=", churchId)
      .where("id", "=", id)
      .where("removed", "=", false)
      .executeTakeFirst();
    return this.rowToModel(row);
  }

  // Campaigns in a given status for ONE church (scoped callers). removed=false.
  public async loadByStatus(churchId: string, status: string): Promise<EmailCampaign[]> {
    const rows = await getDb().selectFrom("emailCampaigns").selectAll()
      .where("churchId", "=", churchId)
      .where("status", "=", status)
      .where("removed", "=", false)
      .execute();
    return rows.map((r) => this.rowToModel(r));
  }

  // Cross-tenant drain read (NO churchId filter) — the send worker calls this with
  // 'sending' to find EVERY in-flight campaign across all churches. removed=false.
  // The per-recipient claim + church-scoped repo reads keep tenancy intact once the
  // worker is inside a campaign (each has its own churchId).
  public async loadAllByStatus(status: string): Promise<EmailCampaign[]> {
    const rows = await getDb().selectFrom("emailCampaigns").selectAll()
      .where("status", "=", status)
      .where("removed", "=", false)
      .execute();
    return rows.map((r) => this.rowToModel(r));
  }

  // Due scheduled campaigns for the RailwayCron scheduled poller (cross-tenant,
  // like loadAllByStatus — NO churchId filter; the poller runs across all
  // churches). Filters status = "scheduled" + scheduledAt <= now (a null
  // scheduledAt never matches, so drafts are excluded automatically) + removed
  // = false. Rides the pre-provisioned composite index
  // idx_emailCampaigns_church_status_scheduled on (churchId, status,
  // scheduledAt). scheduledAt is a UTC instant; NOW() is UTC on Railway. The
  // worker OCC-claims each row scheduled→sending with its OWN churchId in the
  // guard, so this cross-tenant read never leaks tenancy on the write.
  public async loadDueScheduled(now: Date): Promise<EmailCampaign[]> {
    const rows = await getDb().selectFrom("emailCampaigns").selectAll()
      .where("status", "=", "scheduled")
      .where("scheduledAt", "<=", now)
      .where("removed", "=", false)
      .execute();
    return rows.map((r) => this.rowToModel(r));
  }

  // Recent campaigns, newest-first — church-scoped (list picker). selectAll is
  // fine for this foundation; a body-omitting list read can be added later.
  public async loadRecent(churchId: string, limit = 20): Promise<EmailCampaign[]> {
    const rows = await getDb().selectFrom("emailCampaigns").selectAll()
      .where("churchId", "=", churchId)
      .where("removed", "=", false)
      .orderBy("createdAt", "desc")
      .limit(limit)
      .execute();
    return rows.map((r) => this.rowToModel(r));
  }

  // ── OCC guard (church + id + version) ──
  //
  // ALWAYS bumps version = version + 1 so the row's bytes change whenever the
  // WHERE matches — defeats MySQL's matched-vs-changed numUpdatedRows ambiguity
  // (Pitfall 2). 0n then reliably means stale version / row gone → 409 upstream.
  public async updateWithVersion(model: EmailCampaign, expectedVersion: number): Promise<bigint> {
    const res = await getDb().updateTable("emailCampaigns").set({
      status: model.status,
      name: model.name,
      scheduledAt: model.scheduledAt,
      audienceFilterJson: model.audienceFilterJson,
      templateId: model.templateId,
      blockJson: model.blockJson,
      subject: model.subject,
      renderedHtml: model.renderedHtml,
      renderedText: model.renderedText,
      // Persist the frozen-audience size on the OCC edit path (freeze sets this).
      // Without it, updateWithVersion never wrote recipientCount so the confirm
      // dialog read "0 people" and progress read "X of 0".
      ...(model.recipientCount !== undefined ? { recipientCount: model.recipientCount } : {}),
      updatedAt: sql`NOW()` as any,
      version: sql`version + 1` as any
    })
      .where("id", "=", model.id)
      .where("churchId", "=", model.churchId)
      .where("version", "=", expectedVersion)
      .executeTakeFirst();
    return res.numUpdatedRows;
  }

  // ── Rollup progress (church + id guarded, NOT version-guarded) ──
  //
  // Send-progress counters. NOT an edit conflict, so this must never 409 — it is
  // a plain guarded UPDATE (like PrintBatchRepo.updateProgress). Only the counters
  // passed in are set.
  public async updateCounters(
    churchId: string,
    id: string,
    counters: { recipientCount?: number; sentCount?: number; failedCount?: number }
  ): Promise<void> {
    await getDb().updateTable("emailCampaigns")
      .set({
        ...(counters.recipientCount !== undefined ? { recipientCount: counters.recipientCount } : {}),
        ...(counters.sentCount !== undefined ? { sentCount: counters.sentCount } : {}),
        ...(counters.failedCount !== undefined ? { failedCount: counters.failedCount } : {})
      })
      .where("churchId", "=", churchId)
      .where("id", "=", id)
      .execute();
  }

  // Map modeled columns; coerce int version/counters to numbers and bit(1)
  // `removed` to a boolean.
  private rowToModel(row: any): EmailCampaign {
    if (!row) return null;
    return {
      id: row.id,
      churchId: row.churchId,
      status: row.status,
      version: Number(row.version),
      name: row.name,
      scheduledAt: row.scheduledAt,
      audienceFilterJson: row.audienceFilterJson,
      templateId: row.templateId,
      blockJson: row.blockJson,
      subject: row.subject,
      renderedHtml: row.renderedHtml,
      renderedText: row.renderedText,
      recipientCount: Number(row.recipientCount),
      sentCount: Number(row.sentCount),
      failedCount: Number(row.failedCount),
      createdAt: row.createdAt,
      createdBy: row.createdBy,
      updatedAt: row.updatedAt,
      removed: !!row.removed
    };
  }

  public convertToModel(_churchId: string, data: any) { return this.rowToModel(data); }
  public convertAllToModel(_churchId: string, data: any[]) { return (data || []).map((d) => this.rowToModel(d)); }
}
