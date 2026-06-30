import { injectable } from "inversify";
import { sql } from "kysely";
import { getDb } from "../db/index.js";
import { UniqueIdHelper } from "@churchapps/apihelper";
import { OrdinationType } from "../models/index.js";

// Pure persistence for ordinationTypes (ORD-01/02): the church-wide controlled
// vocabulary of credentials. Every query is church-scoped (tenancy convention);
// this repo is intentionally NOT campus-scoped — types are defined once per
// church and referenced by the campus-scoped personOrdinations rows (no campusId
// column exists on this table).
//
// `active` is the product toggle (deactivate = update with active=false; the row
// stays valid vocabulary for historical assignments). `removed` is the
// engineering soft-delete tombstone. `code` is the per-church seed idempotency
// key consumed by loadByCode (02-03 seed).
@injectable()
export class OrdinationTypeRepo {
  public async save(model: OrdinationType) {
    return model.id ? this.update(model) : this.create(model);
  }

  private async create(model: OrdinationType): Promise<OrdinationType> {
    model.id = UniqueIdHelper.shortId();
    await getDb().insertInto("ordinationTypes").values({
      id: model.id,
      churchId: model.churchId,
      name: model.name,
      code: model.code,
      sortOrder: model.sortOrder,
      description: model.description,
      active: model.active ?? true,
      removed: false,
      createdAt: sql`NOW()` as any
    }).execute();
    return model;
  }

  // Edit AND deactivate flow through here — deactivate is just an update setting
  // active=false (the type is retained as valid historical vocabulary).
  private async update(model: OrdinationType): Promise<OrdinationType> {
    await getDb().updateTable("ordinationTypes").set({
      name: model.name,
      code: model.code,
      sortOrder: model.sortOrder,
      description: model.description,
      active: model.active
    }).where("id", "=", model.id).where("churchId", "=", model.churchId).execute();
    return model;
  }

  // Seed idempotency probe (02-03): the existing type for a (churchId, code) pair,
  // or null. Church-scoped, non-removed.
  public async loadByCode(churchId: string, code: string): Promise<OrdinationType> {
    const row = await getDb().selectFrom("ordinationTypes").selectAll()
      .where("churchId", "=", churchId)
      .where("code", "=", code)
      .where("removed", "=", false)
      .executeTakeFirst();
    return this.rowToModel(row);
  }

  // The picker / GET-list query: only types currently offered for new grants,
  // ordered by seniority (sortOrder) then name.
  public async loadActive(churchId: string): Promise<OrdinationType[]> {
    const rows = await getDb().selectFrom("ordinationTypes").selectAll()
      .where("churchId", "=", churchId)
      .where("active", "=", true)
      .where("removed", "=", false)
      .orderBy("sortOrder", "asc")
      .orderBy("name", "asc")
      .execute();
    return rows.map((r) => this.rowToModel(r));
  }

  public async load(churchId: string, id: string): Promise<OrdinationType> {
    const row = await getDb().selectFrom("ordinationTypes").selectAll()
      .where("id", "=", id)
      .where("churchId", "=", churchId)
      .where("removed", "=", false)
      .executeTakeFirst();
    return this.rowToModel(row);
  }

  public async loadAll(churchId: string): Promise<OrdinationType[]> {
    const rows = await getDb().selectFrom("ordinationTypes").selectAll()
      .where("churchId", "=", churchId)
      .where("removed", "=", false)
      .orderBy("sortOrder", "asc")
      .orderBy("name", "asc")
      .execute();
    return rows.map((r) => this.rowToModel(r));
  }

  // bit(1) columns round-trip as Buffer/number — coerce to real booleans
  // (Pitfall 5) so callers never branch on a truthy Buffer.
  private rowToModel(row: any): OrdinationType {
    if (!row) return null;
    return {
      id: row.id,
      churchId: row.churchId,
      name: row.name,
      code: row.code,
      sortOrder: row.sortOrder,
      description: row.description,
      active: !!row.active,
      removed: !!row.removed,
      createdAt: row.createdAt
    };
  }

  public convertToModel(_churchId: string, data: any) { return this.rowToModel(data); }
  public convertAllToModel(_churchId: string, data: any[]) { return (data || []).map((d) => this.rowToModel(d)); }
}
