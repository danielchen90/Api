import { injectable } from "inversify";
import { sql } from "kysely";
import { getDb } from "../db/index.js";
import { UniqueIdHelper } from "@churchapps/apihelper";
import { PrintBatch } from "../models/index.js";

// Pure persistence for printBatches (PRT-02): the reproducible, poll-able
// batch-render entity. NO campus-scope logic here — the controller applies
// CampusScope on write; every read filters churchId FIRST (mandatory tenancy)
// and removed=false.
//
// save() INSERTs (assigns a char(11) id when absent, stamps createdAt NOW() if
// unset, defaults status "building"). Progress mutations (updateProgress/finish/
// fail) are churchId + id guarded UPDATEs — DB-backed progress so a concurrent
// poller reads live state (RESEARCH Pitfall 2). cardCount/renderedCount are int
// and `removed` is bit(1) in MySQL; rowToModel coerces them (number / boolean).
@injectable()
export class PrintBatchRepo {

  // ── Write: INSERT (assign id + createdAt + default status) ──
  public async save(model: PrintBatch): Promise<PrintBatch> {
    if (UniqueIdHelper.isMissing(model.id)) model.id = UniqueIdHelper.shortId();
    await getDb().insertInto("printBatches").values({
      id: model.id,
      churchId: model.churchId,
      name: model.name,
      filterJson: model.filterJson,
      status: model.status ?? "building",
      cardCount: model.cardCount ?? 0,
      renderedCount: model.renderedCount ?? 0,
      skippedJson: model.skippedJson,
      pdfRef: model.pdfRef,
      createdAt: model.createdAt ?? (sql`NOW()` as any),
      createdBy: model.createdBy,
      removed: false
    }).execute();
    return model;
  }

  // ── Reads: churchId filter FIRST, removed=false ──

  // Get-by-id (church-scoped). Missing/out-of-tenant id → null (404-hide upstream).
  public async load(churchId: string, id: string): Promise<PrintBatch> {
    const row = await getDb().selectFrom("printBatches").selectAll()
      .where("churchId", "=", churchId)
      .where("id", "=", id)
      .where("removed", "=", false)
      .executeTakeFirst();
    return this.rowToModel(row);
  }

  // Recent batches, newest-first — church-scoped (kiosk recent-batches picker).
  public async loadRecent(churchId: string, limit = 20): Promise<PrintBatch[]> {
    const rows = await getDb().selectFrom("printBatches").selectAll()
      .where("churchId", "=", churchId)
      .where("removed", "=", false)
      .orderBy("createdAt", "desc")
      .limit(limit)
      .execute();
    return rows.map((r) => this.rowToModel(r));
  }

  // ── Guarded mutations (churchId + id) ──

  // Per-card progress bump during render (DB-backed progress numerator).
  public async updateProgress(churchId: string, id: string, renderedCount: number): Promise<void> {
    await getDb().updateTable("printBatches")
      .set({ renderedCount })
      .where("churchId", "=", churchId)
      .where("id", "=", id)
      .execute();
  }

  // Terminal state: status ready|failed + assembled pdfRef + skips.
  public async finish(
    churchId: string,
    id: string,
    extra: { status: string; pdfRef?: string; skippedJson?: string }
  ): Promise<void> {
    await getDb().updateTable("printBatches")
      .set({
        status: extra.status,
        ...(extra.pdfRef !== undefined ? { pdfRef: extra.pdfRef } : {}),
        ...(extra.skippedJson !== undefined ? { skippedJson: extra.skippedJson } : {})
      })
      .where("churchId", "=", churchId)
      .where("id", "=", id)
      .execute();
  }

  // Fire-and-forget .catch: mark failed, record the message into skippedJson.
  public async fail(churchId: string, id: string, err?: unknown): Promise<void> {
    const message = err instanceof Error ? err.message : err ? String(err) : undefined;
    await getDb().updateTable("printBatches")
      .set({
        status: "failed",
        ...(message !== undefined ? { skippedJson: JSON.stringify([{ reason: message }]) } : {})
      })
      .where("churchId", "=", churchId)
      .where("id", "=", id)
      .execute();
  }

  // Map modeled columns; coerce int cardCount/renderedCount to numbers and bit(1)
  // `removed` to a boolean.
  private rowToModel(row: any): PrintBatch {
    if (!row) return null;
    return {
      id: row.id,
      churchId: row.churchId,
      name: row.name,
      filterJson: row.filterJson,
      status: row.status,
      cardCount: Number(row.cardCount),
      renderedCount: Number(row.renderedCount),
      skippedJson: row.skippedJson,
      pdfRef: row.pdfRef,
      createdAt: row.createdAt,
      createdBy: row.createdBy,
      removed: !!row.removed
    };
  }

  public convertToModel(_churchId: string, data: any) { return this.rowToModel(data); }
  public convertAllToModel(_churchId: string, data: any[]) { return (data || []).map((d) => this.rowToModel(d)); }
}
