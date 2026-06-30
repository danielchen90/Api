import { injectable } from "inversify";
import { sql } from "kysely";
import { getDb } from "../db/index.js";
import { UniqueIdHelper } from "@churchapps/apihelper";
import { PersonPhotoCrop } from "../models/index.js";

// Pure persistence for personPhotoCrops (PHO-04): the normalized license-crop
// transform per person. NO campus-scope/version mechanics — a crop is NOT
// campus-intrinsic (RESEARCH Open Q4); scope flows through People/Edit + the
// person reads in the controller. Every read filters churchId FIRST (mandatory
// tenancy) and removed=false.
//
// save() is an UPSERT keyed by (churchId, personId, purpose) — the UNIQUE index.
// It probes loadByPurpose first and UPDATEs the crop fields in place when a row
// exists, else INSERTs a new row. This honors the unique index deterministically
// without relying on ON DUPLICATE KEY.
//
// DECIMAL note: MySQL returns decimal(7,5) columns as STRINGS through the driver,
// so rowToModel coerces cropX/Y/Width/Height (and rotation) to numbers — the
// model always carries plain numbers.
@injectable()
export class PersonPhotoCropRepo {

  // ── Reads: churchId filter FIRST, removed=false ──

  // All crops for a person (church-scoped). Used by GET ?personId=.
  public async loadForPerson(churchId: string, personId: string): Promise<PersonPhotoCrop[]> {
    const rows = await getDb().selectFrom("personPhotoCrops").selectAll()
      .where("churchId", "=", churchId)
      .where("personId", "=", personId)
      .where("removed", "=", false)
      .orderBy("createdAt", "desc")
      .execute();
    return rows.map((r) => this.rowToModel(r));
  }

  // Get-by-id (church-scoped). Missing/out-of-tenant id → null (404-hide upstream).
  public async load(churchId: string, id: string): Promise<PersonPhotoCrop> {
    const row = await getDb().selectFrom("personPhotoCrops").selectAll()
      .where("churchId", "=", churchId)
      .where("id", "=", id)
      .where("removed", "=", false)
      .executeTakeFirst();
    return this.rowToModel(row);
  }

  // Upsert probe — the existing crop for (churchId, personId, purpose), if any.
  public async loadByPurpose(churchId: string, personId: string, purpose: string): Promise<PersonPhotoCrop> {
    const row = await getDb().selectFrom("personPhotoCrops").selectAll()
      .where("churchId", "=", churchId)
      .where("personId", "=", personId)
      .where("purpose", "=", purpose)
      .where("removed", "=", false)
      .executeTakeFirst();
    return this.rowToModel(row);
  }

  // ── Upsert by (churchId, personId, purpose) ──
  //
  // Probe loadByPurpose; if a row exists UPDATE its crop fields in place (by
  // id+churchId), else INSERT a new row. Honors UNIQUE(churchId,personId,purpose).
  public async save(model: PersonPhotoCrop): Promise<PersonPhotoCrop> {
    const purpose = model.purpose || "license";
    const existing = await this.loadByPurpose(model.churchId, model.personId, purpose);
    if (existing?.id) {
      await getDb().updateTable("personPhotoCrops").set({
        cropX: model.cropX,
        cropY: model.cropY,
        cropWidth: model.cropWidth,
        cropHeight: model.cropHeight,
        rotation: model.rotation ?? 0,
        sourceUpdated: model.sourceUpdated,
        updatedAt: sql`NOW()` as any,
        updatedBy: model.updatedBy
      })
        .where("id", "=", existing.id)
        .where("churchId", "=", model.churchId)
        .execute();
      return { ...existing, ...model, id: existing.id, purpose };
    }
    return this.create({ ...model, purpose });
  }

  private async create(model: PersonPhotoCrop): Promise<PersonPhotoCrop> {
    model.id = UniqueIdHelper.shortId();
    await getDb().insertInto("personPhotoCrops").values({
      id: model.id,
      churchId: model.churchId,
      personId: model.personId,
      purpose: model.purpose || "license",
      cropX: model.cropX,
      cropY: model.cropY,
      cropWidth: model.cropWidth,
      cropHeight: model.cropHeight,
      rotation: model.rotation ?? 0,
      sourceUpdated: model.sourceUpdated,
      createdAt: sql`NOW()` as any,
      createdBy: model.createdBy,
      removed: false
    }).execute();
    return model;
  }

  // Map modeled columns; coerce bit(1) `removed` to a boolean and the DECIMAL
  // crop fields (driver returns strings) to numbers.
  private rowToModel(row: any): PersonPhotoCrop {
    if (!row) return null;
    return {
      id: row.id,
      churchId: row.churchId,
      personId: row.personId,
      purpose: row.purpose,
      cropX: Number(row.cropX),
      cropY: Number(row.cropY),
      cropWidth: Number(row.cropWidth),
      cropHeight: Number(row.cropHeight),
      rotation: Number(row.rotation),
      sourceUpdated: row.sourceUpdated,
      createdAt: row.createdAt,
      createdBy: row.createdBy,
      updatedAt: row.updatedAt,
      updatedBy: row.updatedBy,
      removed: !!row.removed
    };
  }

  public convertToModel(_churchId: string, data: any) { return this.rowToModel(data); }
  public convertAllToModel(_churchId: string, data: any[]) { return (data || []).map((d) => this.rowToModel(d)); }
}
