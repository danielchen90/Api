import { injectable } from "inversify";
import { sql } from "kysely";
import { getDb } from "../db/index.js";
import { UniqueIdHelper } from "@churchapps/apihelper";
import { UserAuxiliary } from "../models/index.js";

// Pure persistence for userAuxiliaries (mirrors UserCampusRepo). Church-scoped;
// the scope resolver consumes loadAuxiliaryIdsForUser, the assignment API drives
// create/list/revoke.
@injectable()
export class UserAuxiliaryRepo {
  public async save(model: UserAuxiliary) {
    return model.id ? this.update(model) : this.create(model);
  }

  private async create(model: UserAuxiliary): Promise<UserAuxiliary> {
    model.id = UniqueIdHelper.shortId();
    await getDb().insertInto("userAuxiliaries").values({
      id: model.id,
      churchId: model.churchId,
      userId: model.userId,
      auxiliaryId: model.auxiliaryId,
      addedBy: model.addedBy,
      createdAt: sql`NOW()` as any,
      removed: false
    }).execute();
    return model;
  }

  private async update(model: UserAuxiliary): Promise<UserAuxiliary> {
    await getDb().updateTable("userAuxiliaries").set({ auxiliaryId: model.auxiliaryId, addedBy: model.addedBy })
      .where("id", "=", model.id).where("churchId", "=", model.churchId).execute();
    return model;
  }

  // Per-request scope resolver query: the auxiliaryIds a user presides over.
  public async loadAuxiliaryIdsForUser(churchId: string, userId: string): Promise<string[]> {
    const rows = await getDb().selectFrom("userAuxiliaries").select("auxiliaryId")
      .where("churchId", "=", churchId).where("userId", "=", userId).where("removed", "=", false).execute();
    return rows.map((r) => r.auxiliaryId);
  }

  // All (non-removed) assignments for one auxiliary — the "presidents of X" list.
  public async loadForAuxiliary(churchId: string, auxiliaryId: string): Promise<UserAuxiliary[]> {
    const rows = await getDb().selectFrom("userAuxiliaries").selectAll()
      .where("churchId", "=", churchId).where("auxiliaryId", "=", auxiliaryId).where("removed", "=", false)
      .orderBy("createdAt", "desc").execute();
    return rows.map((r) => this.rowToModel(r));
  }

  // Presidents of an auxiliary WITH display names (joined via userChurches→people)
  // for the admin assignment panel.
  public async loadPresidents(churchId: string, auxiliaryId: string): Promise<any[]> {
    return (getDb() as any).selectFrom("userAuxiliaries as ua")
      .leftJoin("userChurches as uc", (join: any) => join.onRef("uc.userId", "=", "ua.userId").on("uc.churchId", "=", churchId))
      .leftJoin("people as p", "p.id", "uc.personId")
      .leftJoin("users as u", "u.id", "ua.userId")
      .select(["ua.id as id", "ua.userId as userId", "ua.auxiliaryId as auxiliaryId", "uc.personId as personId", "p.displayName as name", "u.email as email"])
      .where("ua.churchId", "=", churchId).where("ua.auxiliaryId", "=", auxiliaryId).where("ua.removed", "=", 0 as any)
      .execute();
  }

  public async load(churchId: string, id: string): Promise<UserAuxiliary> {
    const row = await getDb().selectFrom("userAuxiliaries").selectAll()
      .where("id", "=", id).where("churchId", "=", churchId).where("removed", "=", false).executeTakeFirst();
    return this.rowToModel(row);
  }

  public async delete(churchId: string, id: string) {
    await getDb().updateTable("userAuxiliaries").set({ removed: true }).where("id", "=", id).where("churchId", "=", churchId).execute();
  }

  private rowToModel(row: any): UserAuxiliary {
    if (!row) return null;
    return { id: row.id, churchId: row.churchId, userId: row.userId, auxiliaryId: row.auxiliaryId, addedBy: row.addedBy, createdAt: row.createdAt, removed: !!row.removed };
  }

  public convertToModel(_churchId: string, data: any) { return this.rowToModel(data); }
  public convertAllToModel(_churchId: string, data: any[]) { return (data || []).map((d) => this.rowToModel(d)); }
}
