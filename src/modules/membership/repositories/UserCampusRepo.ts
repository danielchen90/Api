import { injectable } from "inversify";
import { sql } from "kysely";
import { getDb } from "../db/index.js";
import { UniqueIdHelper } from "@churchapps/apihelper";
import { UserCampus } from "../models/index.js";

// Pure persistence for userCampuses (PERM-01). Every query is church-scoped
// (tenancy convention). This repo holds NO campusId-from-request logic — the
// scope resolver (Plan 02) consumes loadCampusIdsForUser; assignments are
// created/revoked by the assignment API (Plan 04).
@injectable()
export class UserCampusRepo {
  public async save(model: UserCampus) {
    return model.id ? this.update(model) : this.create(model);
  }

  private async create(model: UserCampus): Promise<UserCampus> {
    model.id = UniqueIdHelper.shortId();
    await getDb().insertInto("userCampuses").values({
      id: model.id,
      churchId: model.churchId,
      userId: model.userId,
      campusId: model.campusId,
      addedBy: model.addedBy,
      createdAt: sql`NOW()` as any,
      removed: false
    }).execute();
    return model;
  }

  private async update(model: UserCampus): Promise<UserCampus> {
    await getDb().updateTable("userCampuses").set({
      campusId: model.campusId,
      addedBy: model.addedBy
    }).where("id", "=", model.id).where("churchId", "=", model.churchId).execute();
    return model;
  }

  // Per-request scope resolver query (PERM-02 dependency): the campusIds a user
  // is currently assigned to. Scoped to churchId + userId, non-removed only.
  public async loadCampusIdsForUser(churchId: string, userId: string): Promise<string[]> {
    const rows = await getDb().selectFrom("userCampuses")
      .select("campusId")
      .where("churchId", "=", churchId)
      .where("userId", "=", userId)
      .where("removed", "=", false)
      .execute();
    return rows.map((r) => r.campusId);
  }

  // Full assignment rows for one user — the assignment-list endpoint (Plan 04).
  public async loadForUser(churchId: string, userId: string): Promise<UserCampus[]> {
    const rows = await getDb().selectFrom("userCampuses").selectAll()
      .where("churchId", "=", churchId)
      .where("userId", "=", userId)
      .where("removed", "=", false)
      .orderBy("createdAt", "desc")
      .execute();
    return rows.map((r) => this.rowToModel(r));
  }

  public async load(churchId: string, id: string): Promise<UserCampus> {
    const row = await getDb().selectFrom("userCampuses").selectAll()
      .where("id", "=", id)
      .where("churchId", "=", churchId)
      .where("removed", "=", false)
      .executeTakeFirst();
    return this.rowToModel(row);
  }

  public async loadAll(churchId: string): Promise<UserCampus[]> {
    const rows = await getDb().selectFrom("userCampuses").selectAll()
      .where("churchId", "=", churchId)
      .where("removed", "=", false)
      .orderBy("createdAt", "desc")
      .execute();
    return rows.map((r) => this.rowToModel(r));
  }

  // Revocable assignment: soft-delete keeps history (removed = true).
  public async delete(churchId: string, id: string) {
    await getDb().updateTable("userCampuses").set({ removed: true })
      .where("id", "=", id).where("churchId", "=", churchId).execute();
  }

  private rowToModel(row: any): UserCampus {
    if (!row) return null;
    return {
      id: row.id,
      churchId: row.churchId,
      userId: row.userId,
      campusId: row.campusId,
      addedBy: row.addedBy,
      createdAt: row.createdAt,
      removed: !!row.removed
    };
  }

  public convertToModel(_churchId: string, data: any) { return this.rowToModel(data); }
  public convertAllToModel(_churchId: string, data: any[]) { return (data || []).map((d) => this.rowToModel(d)); }
}
