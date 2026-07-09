import { injectable } from "inversify";
import { sql } from "kysely";
import { getDb } from "../db/index.js";
import { UniqueIdHelper } from "@churchapps/apihelper";
import { ChurchEmailSettings } from "../models/index.js";

// DLV-02 — per-church email identity persistence (Phase 11, Plan 01). ONE row
// per church (enforced by the UNIQUE churchId index in the migration). Mirrors
// membership/SettingRepo: id via UniqueIdHelper.shortId(), createdAt/updatedAt via
// SQL NOW(), churchId-guarded writes. The endpoint save path is upsert() —
// loadByChurch then update-or-create — so there is never a second row for a
// church.
@injectable()
export class ChurchEmailSettingsRepo {
  public async save(model: ChurchEmailSettings): Promise<ChurchEmailSettings> {
    return model.id ? this.update(model) : this.create(model);
  }

  private async create(model: ChurchEmailSettings): Promise<ChurchEmailSettings> {
    model.id = UniqueIdHelper.shortId();
    await getDb().insertInto("churchEmailSettings").values({
      id: model.id,
      churchId: model.churchId,
      fromName: model.fromName,
      fromEmail: model.fromEmail,
      replyTo: model.replyTo,
      createdAt: sql`NOW()` as any
    }).execute();
    return model;
  }

  private async update(model: ChurchEmailSettings): Promise<ChurchEmailSettings> {
    await getDb().updateTable("churchEmailSettings").set({
      fromName: model.fromName,
      fromEmail: model.fromEmail,
      replyTo: model.replyTo,
      updatedAt: sql`NOW()` as any
    }).where("id", "=", model.id).where("churchId", "=", model.churchId).execute();
    return model;
  }

  public async loadByChurch(churchId: string): Promise<ChurchEmailSettings | null> {
    const row = await getDb().selectFrom("churchEmailSettings").selectAll()
      .where("churchId", "=", churchId)
      .executeTakeFirst();
    return row ? this.rowToModel(row) : null;
  }

  // The endpoint save path — ONE record per church. Load first; update in place
  // if it exists, else create. churchId is always server-derived by the caller.
  public async upsert(
    churchId: string,
    data: { fromName?: string; fromEmail?: string; replyTo?: string }
  ): Promise<ChurchEmailSettings> {
    const existing = await this.loadByChurch(churchId);
    if (existing) {
      existing.fromName = data.fromName;
      existing.fromEmail = data.fromEmail;
      existing.replyTo = data.replyTo;
      return this.update(existing);
    }
    return this.create({ churchId, fromName: data.fromName, fromEmail: data.fromEmail, replyTo: data.replyTo });
  }

  private rowToModel(row: any): ChurchEmailSettings {
    if (!row) return null;
    return {
      id: row.id,
      churchId: row.churchId,
      fromName: row.fromName,
      fromEmail: row.fromEmail,
      replyTo: row.replyTo,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    };
  }

  public convertToModel(_churchId: string, data: any) { return this.rowToModel(data); }
  public convertAllToModel(_churchId: string, data: any[]) { return (data || []).map((d) => this.rowToModel(d)); }
}
