import { injectable } from "inversify";
import { sql } from "kysely";
import { getDb } from "../db/index.js";
import { UniqueIdHelper } from "@churchapps/apihelper";
import { SavedAudience } from "../models/index.js";

// Pure persistence for savedAudiences — AUD-09 reusable NAMED audiences (Phase
// 10, Plan 04). Church-scoped (a saved audience belongs to the whole church, NOT
// a campus). Every READ filters churchId FIRST (mandatory tenancy). Stores ONLY
// the descriptor (label + audienceType + targetId + filterJson) — never a
// resolved person list — so it re-scopes per caller at run time. delete() is a
// SOFT delete (removed=1) for auditability.
@injectable()
export class SavedAudienceRepo {

  // ── Write: insert (id + createdAt + removed defaulted) ──
  public async save(model: SavedAudience): Promise<SavedAudience> {
    if (UniqueIdHelper.isMissing(model.id)) model.id = UniqueIdHelper.shortId();
    if (!model.createdAt) model.createdAt = new Date();
    if (model.removed === undefined) model.removed = false;
    await getDb().insertInto("savedAudiences").values({
      id: model.id,
      churchId: model.churchId,
      label: model.label,
      audienceType: model.audienceType,
      targetId: model.targetId,
      filterJson: model.filterJson,
      createdAt: model.createdAt ?? (sql`NOW()` as any),
      createdBy: model.createdBy,
      removed: (model.removed ? 1 : 0) as any
    }).execute();
    return model;
  }

  // ── Reads: churchId filter FIRST, active (removed=false) only ──

  public async loadAll(churchId: string): Promise<SavedAudience[]> {
    const rows = await getDb().selectFrom("savedAudiences").selectAll()
      .where("churchId", "=", churchId)
      .where("removed", "=", 0 as any)
      .orderBy("createdAt", "desc")
      .execute();
    return rows.map((r) => this.rowToModel(r));
  }

  public async load(churchId: string, id: string): Promise<SavedAudience> {
    const row = await getDb().selectFrom("savedAudiences").selectAll()
      .where("churchId", "=", churchId)
      .where("id", "=", id)
      .where("removed", "=", 0 as any)
      .executeTakeFirst();
    return this.rowToModel(row);
  }

  // Soft delete — removed=true (auditability), churchId+id guarded.
  public async delete(churchId: string, id: string): Promise<void> {
    await getDb().updateTable("savedAudiences")
      .set({ removed: 1 as any })
      .where("churchId", "=", churchId)
      .where("id", "=", id)
      .execute();
  }

  private rowToModel(row: any): SavedAudience {
    if (!row) return null;
    return {
      id: row.id,
      churchId: row.churchId,
      label: row.label,
      audienceType: row.audienceType,
      targetId: row.targetId,
      filterJson: row.filterJson,
      createdAt: row.createdAt,
      createdBy: row.createdBy,
      // bit(1) → boolean (MySQL may return a Buffer/number).
      removed: row.removed === true || row.removed === 1 || (row.removed?.[0] === 1)
    };
  }

  public convertToModel(_churchId: string, data: any) { return this.rowToModel(data); }
  public convertAllToModel(_churchId: string, data: any[]) { return (data || []).map((d) => this.rowToModel(d)); }
}
