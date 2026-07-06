import { injectable } from "inversify";
import { sql } from "kysely";
import { getDb } from "../db/index.js";
import { UniqueIdHelper } from "@churchapps/apihelper";
import { LicenseCard } from "../models/index.js";

// Persistence for licenseCards (PRT-03 audit + PRT-02/PRT-04 lifecycle). Reads
// filter churchId FIRST (mandatory tenancy) and removed=false. NO campus-scope
// logic here (the controller applies CampusScopeHelper / assertWritableCampus
// before calling save/updateStatus).
//
// save() INSERTs (assigns a char(11) id when absent) and now also persists the
// Phase-7 lifecycle columns (batchId/status/printedAt/void*). updateStatus() is
// the SOLE mutation — a churchId + id guarded UPDATE — relaxing the original
// pure append-only posture; the immutable trail now lives in AuditLogHelper rows
// written by the 07-03 controller. templateVersion/counts are int and `removed`
// is bit(1) in MySQL; rowToModel coerces them (number / boolean).
@injectable()
export class LicenseCardRepo {

  // ── Write: INSERT (assigns id when absent) ──
  public async save(model: LicenseCard): Promise<LicenseCard> {
    if (UniqueIdHelper.isMissing(model.id)) model.id = UniqueIdHelper.shortId();
    await getDb().insertInto("licenseCards").values({
      id: model.id,
      churchId: model.churchId,
      personId: model.personId,
      personOrdinationId: model.personOrdinationId,
      campusId: model.campusId,
      templateId: model.templateId,
      templateVersion: model.templateVersion,
      pdfRef: model.pdfRef,
      createdAt: model.createdAt ?? (sql`NOW()` as any),
      createdBy: model.createdBy,
      removed: false,
      batchId: model.batchId,
      status: model.status ?? "printed",
      printedAt: model.printedAt,
      voidReason: model.voidReason,
      voidedAt: model.voidedAt,
      voidedBy: model.voidedBy
    }).execute();
    return model;
  }

  // ── The ONLY mutation: churchId + id guarded status UPDATE ──
  //
  // Drives the draft/queued/printed/reissued/void lifecycle. Only the provided
  // extras are set: pdfRef, printedAt, or the void triple (voidReason + voidedAt
  // NOW() + voidedBy). Mirrors PersonPhotoCropRepo's guarded UPDATE.
  public async updateStatus(
    churchId: string,
    id: string,
    status: string,
    extra?: { pdfRef?: string; printedAt?: Date; voidReason?: string; voidedBy?: string }
  ): Promise<void> {
    await getDb().updateTable("licenseCards")
      .set({
        status,
        ...(extra?.pdfRef !== undefined ? { pdfRef: extra.pdfRef } : {}),
        ...(extra?.printedAt !== undefined ? { printedAt: extra.printedAt } : {}),
        ...(extra?.voidReason !== undefined
          ? { voidReason: extra.voidReason, voidedAt: sql`NOW()` as any, voidedBy: extra.voidedBy }
          : {})
      })
      .where("churchId", "=", churchId)
      .where("id", "=", id)
      .execute();
  }

  // ── Reads: churchId filter FIRST, removed=false ──

  // Get-by-id (church-scoped). Missing/out-of-tenant id → null (404-hide upstream).
  public async load(churchId: string, id: string): Promise<LicenseCard> {
    const row = await getDb().selectFrom("licenseCards").selectAll()
      .where("churchId", "=", churchId)
      .where("id", "=", id)
      .where("removed", "=", false)
      .executeTakeFirst();
    return this.rowToModel(row);
  }

  // Per-person print history, newest-first — church-scoped.
  public async loadByPerson(churchId: string, personId: string): Promise<LicenseCard[]> {
    const rows = await getDb().selectFrom("licenseCards").selectAll()
      .where("churchId", "=", churchId)
      .where("personId", "=", personId)
      .where("removed", "=", false)
      .orderBy("createdAt", "desc")
      .execute();
    return rows.map((r) => this.rowToModel(r));
  }

  // Cards in a batch, oldest-first — church-scoped (print-station per-card list).
  public async loadByBatch(churchId: string, batchId: string): Promise<LicenseCard[]> {
    const rows = await getDb().selectFrom("licenseCards").selectAll()
      .where("churchId", "=", churchId)
      .where("batchId", "=", batchId)
      .where("removed", "=", false)
      .orderBy("createdAt", "asc")
      .execute();
    return rows.map((r) => this.rowToModel(r));
  }

  // Per-credential card history, newest-first — church-scoped.
  public async loadByOrdination(churchId: string, personOrdinationId: string): Promise<LicenseCard[]> {
    const rows = await getDb().selectFrom("licenseCards").selectAll()
      .where("churchId", "=", churchId)
      .where("personOrdinationId", "=", personOrdinationId)
      .where("removed", "=", false)
      .orderBy("createdAt", "desc")
      .execute();
    return rows.map((r) => this.rowToModel(r));
  }

  // Map modeled columns; coerce int `templateVersion` to a number and bit(1)
  // `removed` to a boolean.
  private rowToModel(row: any): LicenseCard {
    if (!row) return null;
    return {
      id: row.id,
      churchId: row.churchId,
      personId: row.personId,
      personOrdinationId: row.personOrdinationId,
      campusId: row.campusId,
      templateId: row.templateId,
      templateVersion: Number(row.templateVersion),
      pdfRef: row.pdfRef,
      createdAt: row.createdAt,
      createdBy: row.createdBy,
      removed: !!row.removed,
      batchId: row.batchId,
      status: row.status,
      printedAt: row.printedAt,
      voidReason: row.voidReason,
      voidedAt: row.voidedAt,
      voidedBy: row.voidedBy
    };
  }

  public convertToModel(_churchId: string, data: any) { return this.rowToModel(data); }
  public convertAllToModel(_churchId: string, data: any[]) { return (data || []).map((d) => this.rowToModel(d)); }
}
