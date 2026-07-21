import { injectable } from "inversify";
import { UniqueIdHelper } from "@churchapps/apihelper";
import { getDb } from "../db/index.js";
import { Campus } from "../models/index.js";

@injectable()
export class CampusRepo {
  public async save(model: Campus) {
    return model.id ? this.update(model) : this.create(model);
  }

  private async create(model: Campus): Promise<Campus> {
    model.id = UniqueIdHelper.shortId();
    await getDb().insertInto("campuses").values({
      id: model.id,
      churchId: model.churchId,
      name: model.name,
      address1: model.address1,
      address2: model.address2,
      city: model.city,
      state: model.state,
      zip: model.zip,
      country: model.country,
      latitude: model.latitude,
      longitude: model.longitude,
      timezone: model.timezone,
      website: model.website,
      slug: model.slug,
      importKey: model.importKey,
      removed: false
    }).execute();
    return model;
  }

  private async update(model: Campus): Promise<Campus> {
    await getDb().updateTable("campuses").set({
      name: model.name,
      address1: model.address1,
      address2: model.address2,
      city: model.city,
      state: model.state,
      zip: model.zip,
      country: model.country,
      latitude: model.latitude,
      longitude: model.longitude,
      timezone: model.timezone,
      website: model.website,
      slug: model.slug
    }).where("id", "=", model.id)
      .where("churchId", "=", model.churchId)
      .execute();
    return model;
  }

  public async delete(churchId: string, id: string) {
    await getDb().updateTable("campuses").set({ removed: true }).where("id", "=", id).where("churchId", "=", churchId).execute();
  }

  public async load(churchId: string, id: string) {
    return (await getDb().selectFrom("campuses").selectAll().where("id", "=", id).where("churchId", "=", churchId).where("removed", "=", false).executeTakeFirst()) ?? null;
  }

  public async loadAll(churchId: string) {
    return getDb().selectFrom("campuses").selectAll().where("churchId", "=", churchId).where("removed", "=", false).orderBy("name").execute();
  }

  /**
   * ANONYMOUS PUBLIC campus list (SITE-02/03, MAP-01..04). Returns every non-removed
   * campus for the church with ONLY the public physical-location columns (id, slug,
   * name, address, lat/lng) ordered by name. The controller still projects each row
   * through `toPublicCampus` before it leaves the server — this select just narrows
   * the columns; the whitelist builder is the authoritative safety gate.
   */
  public async loadPublicList(churchId: string) {
    return getDb().selectFrom("campuses")
      .select(["id", "slug", "name", "address1", "address2", "city", "state", "zip", "country", "latitude", "longitude"])
      .where("churchId", "=", churchId)
      .where("removed", "=", false)
      .orderBy("name")
      .execute();
  }

  /**
   * Resolve a public campus route slug -> campus. First tries the live
   * `campuses.slug`; on a miss, falls back to the `campusSlugAlias` table (an OLD
   * slug retained after a rename) and returns `{ campus, aliasOf }` so the UI layer
   * can emit a 301 to the campus's CURRENT slug (SITE-03, SC#2). Returns null when
   * neither resolves.
   */
  public async loadBySlug(churchId: string, slug: string): Promise<{ campus: any; aliasOf: string | null } | null> {
    const direct = await getDb().selectFrom("campuses").selectAll()
      .where("churchId", "=", churchId)
      .where("slug", "=", slug)
      .where("removed", "=", false)
      .executeTakeFirst();
    if (direct) return { campus: direct, aliasOf: null };

    const alias = await getDb().selectFrom("campusSlugAlias").selectAll()
      .where("churchId", "=", churchId)
      .where("slug", "=", slug)
      .executeTakeFirst();
    if (!alias?.campusId) return null;

    const aliased = await getDb().selectFrom("campuses").selectAll()
      .where("churchId", "=", churchId)
      .where("id", "=", alias.campusId)
      .where("removed", "=", false)
      .executeTakeFirst();
    if (!aliased) return null;
    return { campus: aliased, aliasOf: slug };
  }

  public convertToModel(_churchId: string, data: any) {
    return data ? this.rowToModel(data) : data;
  }

  public convertAllToModel(_churchId: string, data: any[]) {
    return (data || []).map(row => this.rowToModel(row));
  }

  protected rowToModel(data: any): Campus {
    const result: Campus = {
      id: data.id,
      churchId: data.churchId,
      name: data.name,
      address1: data.address1,
      address2: data.address2,
      city: data.city,
      state: data.state,
      zip: data.zip,
      country: data.country,
      latitude: data.latitude,
      longitude: data.longitude,
      timezone: data.timezone,
      website: data.website,
      slug: data.slug,
      importKey: data.importKey
    };
    return result;
  }
}
