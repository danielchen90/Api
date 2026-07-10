import { sql } from "kysely";
import { injectable } from "inversify";
import { UniqueIdHelper } from "@churchapps/apihelper";
import { getDb } from "../db/index.js";
import { EmailTemplate } from "../models/index.js";

@injectable()
export class EmailTemplateRepo {
  public async save(model: EmailTemplate) {
    return model.id ? this.update(model) : this.create(model);
  }

  private async create(model: EmailTemplate): Promise<EmailTemplate> {
    model.id = UniqueIdHelper.shortId();
    await getDb().insertInto("emailTemplates").values({
      id: model.id,
      churchId: model.churchId,
      name: model.name,
      subject: model.subject,
      htmlContent: model.htmlContent,
      blockJson: model.blockJson,
      category: model.category,
      dateCreated: sql`NOW()`,
      dateModified: sql`NOW()`
    }).execute();
    return model;
  }

  private async update(model: EmailTemplate): Promise<EmailTemplate> {
    await getDb().updateTable("emailTemplates").set({
      name: model.name,
      subject: model.subject,
      htmlContent: model.htmlContent,
      blockJson: model.blockJson,
      category: model.category,
      dateModified: sql`NOW()`
    }).where("id", "=", model.id).where("churchId", "=", model.churchId).execute();
    return model;
  }

  // List read for the template picker (BLD-02). Deliberately does NOT select the
  // full blockJson (a design can be large) — instead it derives a lightweight
  // `hasBlockJson` boolean so the picker can distinguish builder-designs (loadable
  // into the editor) from legacy HTML-only templates (blockJson NULL — still
  // listed, back-compat). The picker calls loadById(id) only when a builder-design
  // template is actually chosen, to fetch the design JSON to reload.
  public async loadByChurchId(churchId: string) {
    const rows = await getDb().selectFrom("emailTemplates")
      .select([
        "id", "churchId", "name", "subject", "category", "dateCreated", "dateModified", "blockJson"
      ])
      .where("churchId", "=", churchId)
      .orderBy("name")
      .execute();
    // Map blockJson → a boolean flag; never leak the full design into the list.
    return rows.map((r: any) => ({
      id: r.id,
      churchId: r.churchId,
      name: r.name,
      subject: r.subject,
      category: r.category,
      dateCreated: r.dateCreated,
      dateModified: r.dateModified,
      hasBlockJson: r.blockJson !== null && r.blockJson !== undefined && String(r.blockJson).length > 0
    }));
  }

  public async loadById(churchId: string, id: string) {
    return (await getDb().selectFrom("emailTemplates").selectAll()
      .where("id", "=", id).where("churchId", "=", churchId).executeTakeFirst()) ?? null;
  }

  public async delete(churchId: string, id: string) {
    await getDb().deleteFrom("emailTemplates").where("id", "=", id).where("churchId", "=", churchId).execute();
  }

  protected rowToModel(data: any): EmailTemplate {
    return {
      id: data.id,
      churchId: data.churchId,
      name: data.name,
      subject: data.subject,
      htmlContent: data.htmlContent,
      blockJson: data.blockJson,
      category: data.category,
      dateCreated: data.dateCreated,
      dateModified: data.dateModified
    };
  }

  public convertToModel(data: any) {
    return this.rowToModel(data);
  }

  public convertAllToModel(data: any[]) {
    return data.map((d: any) => this.rowToModel(d));
  }
}
