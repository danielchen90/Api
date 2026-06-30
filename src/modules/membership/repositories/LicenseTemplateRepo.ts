import { injectable } from "inversify";
import { sql } from "kysely";
import { getDb } from "../db/index.js";
import { UniqueIdHelper } from "@churchapps/apihelper";
import { LicenseTemplate, LicenseTemplateVersion } from "../models/index.js";

// Pure persistence for license card templates (TPL-03, TPL-04). Mirrors
// PersonOrdinationRepo's conventions: churchId-first reads, version-guarded
// updates via updateWithVersion (ALWAYS bumps version so numUpdatedRows is
// unambiguous — Pitfall 2), version-guarded softDelete, bit(1)→boolean coercion.
// Templates are church-wide vocabulary (NOT campus-scoped — RESEARCH Open Q2), so
// there is NO applyCampusScope here.
//
// TWO version concepts (RESEARCH Pitfall 4 — never conflate):
//   - `version` is the OCC guard checked/bumped by updateWithVersion.
//   - `currentVersion` is the audit content version, bumped on every save and
//     mirrored into licenseTemplateVersions.versionNumber via writeSnapshot.
//
// NEW-vs-EXISTING ROUTING is decided by the EXPLICIT `isNew` arg of save() (or by
// calling create()/update() directly) — NEVER by id presence. The controller
// (05-02) pre-assigns model.id BEFORE image storage so the FileStorage key path
// is stable and the v1 row + its immutable snapshot share one id; an id is
// therefore present even for brand-new templates, and routing on id alone would
// mis-route a new template into update() and falsely 409. create() consequently
// RESPECTS a caller-supplied id and never overwrites it.
//
// The DB-generated defaultFlag/activeFlag columns are never written and never
// surfaced on the model.
@injectable()
export class LicenseTemplateRepo {
  public async save(model: LicenseTemplate, isNew: boolean) {
    return isNew ? this.create(model) : this.update(model);
  }

  private async create(model: LicenseTemplate): Promise<LicenseTemplate> {
    // RESPECT a caller-pre-assigned id (controller sets it for image storage);
    // only mint one when absent. Never overwrite.
    model.id = model.id ?? UniqueIdHelper.shortId();
    model.version = 1;
    model.currentVersion = 1;
    await getDb().insertInto("licenseTemplates").values({
      id: model.id,
      churchId: model.churchId,
      name: model.name,
      ordinationTypeId: model.ordinationTypeId,
      isDefault: model.isDefault,
      active: model.active,
      layoutJson: model.layoutJson,
      currentVersion: 1,
      version: 1,
      removed: false,
      createdAt: sql`NOW()` as any,
      createdBy: model.createdBy
    }).execute();
    await this.writeSnapshot(model);
    return model;
  }

  // OCC path. The caller passes the model carrying the PRIOR currentVersion; bump
  // the audit content version here, then guard the write with the separate
  // `version` OCC column. On a stale guard (numUpdatedRows === 0n) RETURN 0n
  // WITHOUT writing a snapshot (controller maps to 409); otherwise freeze the
  // snapshot. Returns numUpdatedRows.
  private async update(model: LicenseTemplate): Promise<bigint> {
    model.currentVersion = (model.currentVersion ?? 1) + 1;
    const numUpdatedRows = await this.updateWithVersion(model, model.version);
    if (numUpdatedRows === 0n) return numUpdatedRows;
    await this.writeSnapshot(model);
    return numUpdatedRows;
  }

  // ── OCC guard ── ALWAYS bumps version = version + 1 so the row's bytes change
  // whenever the WHERE matches (defeats MySQL's matched-vs-changed ambiguity —
  // Pitfall 2). 0n reliably means stale expectedVersion / row gone. Also writes
  // the bumped currentVersion (audit) carried on the model.
  public async updateWithVersion(model: LicenseTemplate, expectedVersion: number): Promise<bigint> {
    const res = await getDb().updateTable("licenseTemplates").set({
      name: model.name,
      ordinationTypeId: model.ordinationTypeId,
      isDefault: model.isDefault,
      active: model.active,
      layoutJson: model.layoutJson,
      currentVersion: model.currentVersion,
      updatedAt: sql`NOW()` as any,
      updatedBy: model.updatedBy,
      version: sql`version + 1` as any
    })
      .where("id", "=", model.id)
      .where("churchId", "=", model.churchId)
      .where("version", "=", expectedVersion)
      .executeTakeFirst();
    return res.numUpdatedRows;
  }

  // Freeze the current layout into an immutable snapshot row whose versionNumber
  // equals the row's (new) currentVersion. Called by BOTH create and a successful
  // update — every successful save produces exactly one audit snapshot.
  private async writeSnapshot(model: LicenseTemplate): Promise<void> {
    await getDb().insertInto("licenseTemplateVersions").values({
      id: UniqueIdHelper.shortId(),
      churchId: model.churchId,
      templateId: model.id,
      versionNumber: model.currentVersion,
      layoutJson: model.layoutJson,
      createdAt: sql`NOW()` as any,
      createdBy: model.updatedBy ?? model.createdBy
    }).execute();
  }

  // ── Reads: churchId filter FIRST; no campus scope (church-wide vocabulary) ──

  public async loadAll(churchId: string): Promise<LicenseTemplate[]> {
    const rows = await getDb().selectFrom("licenseTemplates").selectAll()
      .where("churchId", "=", churchId)
      .where("removed", "=", false)
      .orderBy("createdAt", "desc")
      .execute();
    return rows.map((r) => this.rowToModel(r));
  }

  public async load(churchId: string, id: string): Promise<LicenseTemplate> {
    const row = await getDb().selectFrom("licenseTemplates").selectAll()
      .where("churchId", "=", churchId)
      .where("id", "=", id)
      .where("removed", "=", false)
      .executeTakeFirst();
    return this.rowToModel(row);
  }

  // Full snapshot history for a template, newest version first (TPL-03 audit).
  public async loadVersions(churchId: string, templateId: string): Promise<LicenseTemplateVersion[]> {
    const rows = await getDb().selectFrom("licenseTemplateVersions").selectAll()
      .where("churchId", "=", churchId)
      .where("templateId", "=", templateId)
      .orderBy("versionNumber", "desc")
      .execute();
    return rows.map((r) => this.versionRowToModel(r));
  }

  // A single frozen snapshot (Phase-6 reproduce-an-old-card: render a specific
  // historical version of a template).
  public async loadVersion(churchId: string, templateId: string, versionNumber: number): Promise<LicenseTemplateVersion> {
    const row = await getDb().selectFrom("licenseTemplateVersions").selectAll()
      .where("churchId", "=", churchId)
      .where("templateId", "=", templateId)
      .where("versionNumber", "=", versionNumber)
      .executeTakeFirst();
    return this.versionRowToModel(row);
  }

  // Version-guarded soft-delete tombstone; also bumps version. Returns
  // numUpdatedRows (0n on stale version → 409 upstream).
  public async softDelete(churchId: string, id: string, expectedVersion: number, updatedBy: string): Promise<bigint> {
    const res = await getDb().updateTable("licenseTemplates").set({
      removed: true,
      updatedAt: sql`NOW()` as any,
      updatedBy,
      version: sql`version + 1` as any
    })
      .where("id", "=", id)
      .where("churchId", "=", churchId)
      .where("version", "=", expectedVersion)
      .executeTakeFirst();
    return res.numUpdatedRows;
  }

  // Coerce bit(1) flags to booleans; keep version/currentVersion numbers. NEVER
  // surface the DB-generated defaultFlag/activeFlag.
  private rowToModel(row: any): LicenseTemplate {
    if (!row) return null;
    return {
      id: row.id,
      churchId: row.churchId,
      name: row.name,
      ordinationTypeId: row.ordinationTypeId,
      isDefault: !!row.isDefault,
      active: !!row.active,
      layoutJson: row.layoutJson,
      currentVersion: row.currentVersion,
      version: row.version,
      removed: !!row.removed,
      createdAt: row.createdAt,
      createdBy: row.createdBy,
      updatedAt: row.updatedAt,
      updatedBy: row.updatedBy
    };
  }

  private versionRowToModel(row: any): LicenseTemplateVersion {
    if (!row) return null;
    return {
      id: row.id,
      churchId: row.churchId,
      templateId: row.templateId,
      versionNumber: row.versionNumber,
      layoutJson: row.layoutJson,
      createdAt: row.createdAt,
      createdBy: row.createdBy
    };
  }

  public convertToModel(_churchId: string, data: any) { return this.rowToModel(data); }
  public convertAllToModel(_churchId: string, data: any[]) { return (data || []).map((d) => this.rowToModel(d)); }
}
