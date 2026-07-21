import { injectable } from "inversify";
import { sql } from "kysely";
import { getDb } from "../db/index.js";
import { UniqueIdHelper } from "@churchapps/apihelper";
import { CampusContent } from "../models/index.js";

// Pure persistence for per-campus public-website content (CMS-01). Mirrors
// LicenseTemplateRepo's OCC conventions: churchId-first reads, version-guarded
// updates via updateWithVersion (ALWAYS bumps `version` so numUpdatedRows is
// unambiguous — the matched-vs-changed ambiguity fix), JSON stored as a string.
//
// NEW-vs-EXISTING ROUTING is decided by the EXPLICIT `isNew` arg of save() (or by
// calling create()/update() directly) — NEVER by id presence. The controller
// (Plan 05) pre-assigns model.id BEFORE any storage so the id is stable, and an id
// is therefore present even for a brand-new row; routing on id alone would
// mis-route a new row into update() and falsely 409. create() RESPECTS a
// caller-supplied id and never overwrites it.
//
// SCOPE MODEL: a NULL campusId row is the ORG DEFAULT for a contentType; a non-null
// campusId row is that campus's SPARSE override. loadOrgDefault filters
// campusId IS NULL; loadForCampus filters a specific campusId. The resolver
// (CampusContentResolver) merges the two field-by-field.
//
// The DB-generated `campusKey` column (COALESCE(campusId,'~ORG~'), backing the
// NULL-safe org-default unique index) is never written and never surfaced.
@injectable()
export class CampusContentRepo {
  public async save(model: CampusContent, isNew: boolean) {
    return isNew ? this.create(model) : this.update(model);
  }

  private async create(model: CampusContent): Promise<CampusContent> {
    // RESPECT a caller-pre-assigned id; only mint one when absent. Never overwrite.
    model.id = model.id ?? UniqueIdHelper.shortId();
    model.version = 1;
    await getDb().insertInto("campusContent").values({
      id: model.id,
      churchId: model.churchId,
      // NULL campusId = org default. Keep an explicit null (not undefined) so the
      // generated campusKey collapses to the '~ORG~' sentinel.
      campusId: model.campusId ?? null,
      contentType: model.contentType,
      content: model.content,
      version: 1,
      createdAt: sql`NOW()` as any
    }).execute();
    return model;
  }

  // OCC path. The caller passes the model carrying the PRIOR version; guard the
  // write with the `version` OCC column. On a stale guard (numUpdatedRows === 0n)
  // the controller maps to 409. Returns numUpdatedRows.
  private async update(model: CampusContent): Promise<bigint> {
    return this.updateWithVersion(model, model.version ?? 1);
  }

  // ── OCC guard ── ALWAYS bumps version = version + 1 so the row's bytes change
  // whenever the WHERE matches (defeats MySQL's matched-vs-changed ambiguity). 0n
  // reliably means stale expectedVersion / row gone → caller returns 409. Guarded
  // churchId FIRST + id + version.
  public async updateWithVersion(model: CampusContent, expectedVersion: number): Promise<bigint> {
    const res = await getDb().updateTable("campusContent").set({
      content: model.content,
      updatedAt: sql`NOW()` as any,
      version: sql`version + 1` as any
    })
      .where("churchId", "=", model.churchId)
      .where("id", "=", model.id)
      .where("version", "=", expectedVersion)
      .executeTakeFirst();
    return res.numUpdatedRows;
  }

  // ── Reads: churchId filter FIRST ──

  // The org default for a contentType (campusId IS NULL). There is at most one per
  // (church, contentType) — the NULL-safe unique index guarantees it.
  public async loadOrgDefault(churchId: string, contentType: string): Promise<CampusContent> {
    const row = await getDb().selectFrom("campusContent").selectAll()
      .where("churchId", "=", churchId)
      .where("campusId", "is", null)
      .where("contentType", "=", contentType)
      .executeTakeFirst();
    return this.rowToModel(row);
  }

  // A specific campus's sparse override for a contentType.
  public async loadForCampus(churchId: string, campusId: string, contentType: string): Promise<CampusContent> {
    const row = await getDb().selectFrom("campusContent").selectAll()
      .where("churchId", "=", churchId)
      .where("campusId", "=", campusId)
      .where("contentType", "=", contentType)
      .executeTakeFirst();
    return this.rowToModel(row);
  }

  // All rows for a church (org defaults + every campus override) — batch use for a
  // resolver that resolves many campuses/contentTypes at once.
  public async loadAllForChurch(churchId: string): Promise<CampusContent[]> {
    const rows = await getDb().selectFrom("campusContent").selectAll()
      .where("churchId", "=", churchId)
      .orderBy("contentType", "asc")
      .execute();
    return rows.map((r) => this.rowToModel(r));
  }

  // NEVER surface the DB-generated campusKey column.
  private rowToModel(row: any): CampusContent {
    if (!row) return null;
    return {
      id: row.id,
      churchId: row.churchId,
      campusId: row.campusId ?? null,
      contentType: row.contentType,
      content: row.content,
      version: row.version,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    };
  }

  public convertToModel(_churchId: string, data: any) { return this.rowToModel(data); }
  public convertAllToModel(_churchId: string, data: any[]) { return (data || []).map((d) => this.rowToModel(d)); }
}
