import { injectable } from "inversify";
import { sql } from "kysely";
import { getDb } from "../db/index.js";
import { UniqueIdHelper } from "@churchapps/apihelper";
import { LicenseCard } from "../models/index.js";

// Pure persistence for licenseCards (PRT-03): the campus-scoped print-audit row
// written on a CONFIRMED print (Plan 06-04). This is an APPEND-ONLY audit repo —
// NO OCC/version and NO campus-scope logic here (the controller applies
// CampusScopeHelper / assertWritableCampus before calling save). Every read
// filters churchId FIRST (mandatory tenancy) and removed=false.
//
// save() is INSERT-only (assigns a char(11) id when absent). templateVersion is
// int and `removed` is bit(1) in MySQL; rowToModel coerces them to number /
// boolean so the model always carries plain types.
@injectable()
export class LicenseCardRepo {

  // ── Write: INSERT only (append-only audit) ──
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
      removed: false
    }).execute();
    return model;
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
      removed: !!row.removed
    };
  }

  public convertToModel(_churchId: string, data: any) { return this.rowToModel(data); }
  public convertAllToModel(_churchId: string, data: any[]) { return (data || []).map((d) => this.rowToModel(d)); }
}
