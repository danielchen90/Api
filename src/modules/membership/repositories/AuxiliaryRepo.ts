import { injectable } from "inversify";
import { UniqueIdHelper } from "@churchapps/apihelper";
import { getDb } from "../db/index.js";
import { Auxiliary } from "../models/index.js";

@injectable()
export class AuxiliaryRepo {
  public async save(model: Auxiliary) {
    return model.id ? this.update(model) : this.create(model);
  }

  private async create(model: Auxiliary): Promise<Auxiliary> {
    model.id = UniqueIdHelper.shortId();
    await getDb().insertInto("auxiliaries").values({
      id: model.id,
      churchId: model.churchId,
      name: model.name,
      description: model.description,
      importKey: model.importKey,
      removed: false
    }).execute();
    return model;
  }

  private async update(model: Auxiliary): Promise<Auxiliary> {
    await getDb().updateTable("auxiliaries").set({
      name: model.name,
      description: model.description
    }).where("id", "=", model.id).where("churchId", "=", model.churchId).execute();
    return model;
  }

  public async delete(churchId: string, id: string) {
    await getDb().updateTable("auxiliaries").set({ removed: true }).where("id", "=", id).where("churchId", "=", churchId).execute();
  }

  public async load(churchId: string, id: string) {
    return (await getDb().selectFrom("auxiliaries").selectAll().where("id", "=", id).where("churchId", "=", churchId).where("removed", "=", false).executeTakeFirst()) ?? null;
  }

  public async loadAll(churchId: string) {
    return getDb().selectFrom("auxiliaries").selectAll().where("churchId", "=", churchId).where("removed", "=", false).orderBy("name").execute();
  }

  public convertToModel(_churchId: string, data: any) {
    return data ? this.rowToModel(data) : data;
  }

  public convertAllToModel(_churchId: string, data: any[]) {
    return (data || []).map((row) => this.rowToModel(row));
  }

  protected rowToModel(data: any): Auxiliary {
    return {
      id: data.id,
      churchId: data.churchId,
      name: data.name,
      description: data.description,
      importKey: data.importKey
    };
  }
}
