import { injectable } from "inversify";
import { sql } from "kysely";
import { getDb } from "../db/index.js";
import { UniqueIdHelper } from "@churchapps/apihelper";
import { PersonOrdination } from "../models/index.js";
import { applyCampusScope, type CampusScope } from "../helpers/applyCampusScope.js";

// Pure persistence for personOrdinations (ORD-02/03/07): the campus-scoped store
// of credential assignments. NO auth/gating logic lives here (that is 02-03/04).
//
// Every READ filters churchId FIRST (mandatory tenancy), then layers the Phase-1
// `applyCampusScope` primitive ON TOP (Pitfall 3 — scope is ADDITIVE, never a
// replacement for churchId): out-of-scope rows are 404-hidden (load) / silently
// filtered (loadAll/loadForPerson). WRITES do not scope here — the controller
// (02-04) validates the target campus via assertWritableCampus before calling.
//
// `updateWithVersion` is the ORD-07 optimistic-concurrency guard: it ALWAYS bumps
// version = version + 1 guarded by WHERE version = expectedVersion, and returns
// numUpdatedRows (bigint). 0n means a stale expectedVersion or vanished row →
// the controller maps it to 409. The DB-generated `activeFlag` column is never
// written and never surfaced on the model.
@injectable()
export class PersonOrdinationRepo {
  public async save(model: PersonOrdination) {
    return model.id ? this.update(model) : this.create(model);
  }

  private async create(model: PersonOrdination): Promise<PersonOrdination> {
    model.id = UniqueIdHelper.shortId();
    model.version = 1;
    await getDb().insertInto("personOrdinations").values({
      id: model.id,
      churchId: model.churchId,
      campusId: model.campusId,
      personId: model.personId,
      ordinationTypeId: model.ordinationTypeId,
      status: model.status,
      credentialNumber: model.credentialNumber,
      grantedDate: model.grantedDate,
      expirationDate: model.expirationDate,
      version: 1,
      notes: model.notes,
      createdAt: sql`NOW()` as any,
      createdBy: model.createdBy,
      removed: false
    }).execute();
    return model;
  }

  // Non-version-guarded update is intentionally NOT exposed for status/field
  // changes — every mutation MUST go through updateWithVersion (ORD-07). save()
  // routes id-bearing models here only as a guard; callers use updateWithVersion.
  private async update(model: PersonOrdination): Promise<PersonOrdination> {
    await this.updateWithVersion(model, model.version);
    return model;
  }

  // ── Reads: churchId filter FIRST, then applyCampusScope layered on top ──

  public async loadAll(churchId: string, scope: CampusScope): Promise<PersonOrdination[]> {
    let q = getDb().selectFrom("personOrdinations").selectAll()
      .where("churchId", "=", churchId)
      .where("removed", "=", false);
    q = applyCampusScope(q, scope);
    const rows = await q.orderBy("createdAt", "desc").execute();
    return rows.map((r) => this.rowToModel(r));
  }

  // Get-by-id: out-of-scope id is indistinguishable from "not found" (404-hide).
  public async load(churchId: string, id: string, scope: CampusScope): Promise<PersonOrdination> {
    let q = getDb().selectFrom("personOrdinations").selectAll()
      .where("churchId", "=", churchId)
      .where("id", "=", id)
      .where("removed", "=", false);
    q = applyCampusScope(q, scope);
    const row = await q.executeTakeFirst();
    return this.rowToModel(row);
  }

  // ORD-03: one person may hold several ordinations across campuses/types — scope
  // still filters to the caller's writable/visible campuses.
  public async loadForPerson(churchId: string, personId: string, scope: CampusScope): Promise<PersonOrdination[]> {
    let q = getDb().selectFrom("personOrdinations").selectAll()
      .where("churchId", "=", churchId)
      .where("personId", "=", personId)
      .where("removed", "=", false);
    q = applyCampusScope(q, scope);
    const rows = await q.orderBy("createdAt", "desc").execute();
    return rows.map((r) => this.rowToModel(r));
  }

  // ── ORD-07 optimistic-concurrency guard ──
  //
  // ALWAYS bumps version = version + 1 so the row's bytes change whenever the
  // WHERE matches — this defeats MySQL's matched-vs-changed numUpdatedRows
  // ambiguity (Pitfall 2). 0n then reliably means stale version / row gone.
  // Callers compare against BigInt 0n, never 0.
  public async updateWithVersion(model: PersonOrdination, expectedVersion: number): Promise<bigint> {
    const res = await getDb().updateTable("personOrdinations").set({
      status: model.status,
      credentialNumber: model.credentialNumber,
      grantedDate: model.grantedDate,
      expirationDate: model.expirationDate,
      notes: model.notes,
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

  // Status transitions (e.g. revoke) are just version-guarded updates with the
  // new status — every mutation bumps version. Returns numUpdatedRows (0n on
  // stale version → 409 upstream).
  public async revoke(model: PersonOrdination, expectedVersion: number): Promise<bigint> {
    model.status = "revoked";
    return this.updateWithVersion(model, expectedVersion);
  }

  // Version-guarded soft-delete tombstone for when a hard removal (not just a
  // status change) is required. removed=true also bumps version.
  public async softDelete(churchId: string, id: string, expectedVersion: number, updatedBy: string): Promise<bigint> {
    const res = await getDb().updateTable("personOrdinations").set({
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

  // Map all modeled columns; coerce bit(1) `removed` to a boolean; keep `version`
  // a number. NEVER surface the DB-generated `activeFlag`.
  private rowToModel(row: any): PersonOrdination {
    if (!row) return null;
    return {
      id: row.id,
      churchId: row.churchId,
      campusId: row.campusId,
      personId: row.personId,
      ordinationTypeId: row.ordinationTypeId,
      status: row.status,
      credentialNumber: row.credentialNumber,
      grantedDate: row.grantedDate,
      expirationDate: row.expirationDate,
      version: row.version,
      notes: row.notes,
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
