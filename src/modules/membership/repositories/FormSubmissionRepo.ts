import { injectable } from "inversify";
import { sql } from "kysely";
import { getDb } from "../db/index.js";
import { UniqueIdHelper } from "@churchapps/apihelper";
import { FormSubmission } from "../models/index.js";
import { DateHelper } from "../helpers/index.js";
import { applyCampusScope, type CampusScope } from "../helpers/applyCampusScope.js";

@injectable()
export class FormSubmissionRepo {
  public async save(model: FormSubmission) {
    return model.id ? this.update(model) : this.create(model);
  }

  private async create(formSubmission: FormSubmission): Promise<FormSubmission> {
    formSubmission.id = UniqueIdHelper.shortId();
    const submissionDate = DateHelper.toMysqlDate(formSubmission.submissionDate);
    const revisionDate = DateHelper.toMysqlDate(formSubmission.revisionDate);
    await getDb().insertInto("formSubmissions").values({
      id: formSubmission.id,
      churchId: formSubmission.churchId,
      formId: formSubmission.formId,
      contentType: formSubmission.contentType,
      contentId: formSubmission.contentId,
      submissionDate: submissionDate as any,
      submittedBy: formSubmission.submittedBy,
      revisionDate: revisionDate as any,
      revisedBy: formSubmission.revisedBy
    }).execute();
    return formSubmission;
  }

  private async update(formSubmission: FormSubmission): Promise<FormSubmission> {
    await getDb().updateTable("formSubmissions").set({
      contentId: formSubmission.contentId,
      revisedBy: formSubmission.revisedBy,
      revisionDate: sql`NOW()` as any
    }).where("id", "=", formSubmission.id).where("churchId", "=", formSubmission.churchId).execute();
    return formSubmission;
  }

  // Insert a MINIMAL login-free public submission (prayer/contact). Stores only the
  // campus tag + submissionType + visitor-provided fields; no formId/questions/answers.
  // churchId + campusId are the trusted-ROUTE values the controller passes — they are
  // DATA TAGS, never authorization inputs (RESEARCH Pitfall 4).
  public async createPublic(sub: FormSubmission): Promise<FormSubmission> {
    sub.id = UniqueIdHelper.shortId();
    const submissionDate = DateHelper.toMysqlDate(sub.submissionDate ?? new Date());
    await getDb().insertInto("formSubmissions").values({
      id: sub.id,
      churchId: sub.churchId,
      campusId: sub.campusId ?? null,
      submissionType: sub.submissionType,
      unread: 1 as any,
      submitterName: sub.submitterName ?? null,
      submitterEmail: sub.submitterEmail ?? null,
      submitterPhone: sub.submitterPhone ?? null,
      message: sub.message ?? null,
      submissionDate: submissionDate as any
    } as any).execute();
    sub.unread = true;
    return sub;
  }

  // Campus-scoped inbox LIST. Tenancy (churchId) FIRST, then layer the resolved campus
  // scope on top (applyCampusScope: "all" → no filter, "scoped" → campusId IN (set),
  // "deny" → 1=0). Returns list-shaped rows for the B1Admin inbox. The scope is derived
  // server-side from the requesting admin (CampusScopeHelper), NEVER from the request.
  public async loadInboxScoped(churchId: string, scope: CampusScope) {
    let q = getDb().selectFrom("formSubmissions")
      .select(["id", "campusId", "submissionType", "submitterName", "submissionDate", "unread"])
      .where("churchId", "=", churchId)
      .where("submissionType", "is not", null as any)
      .orderBy("submissionDate", "desc");
    q = applyCampusScope(q, scope);
    return q.execute();
  }

  // Campus-scoped inbox DETAIL. Same churchId-first-then-scope shape; an out-of-scope id
  // returns null so the controller can 404-hide it (never leak another campus's row).
  public async loadDetailScoped(churchId: string, id: string, scope: CampusScope) {
    let q = getDb().selectFrom("formSubmissions").selectAll()
      .where("churchId", "=", churchId)
      .where("id", "=", id);
    q = applyCampusScope(q, scope);
    return (await q.executeTakeFirst()) ?? null;
  }

  // Scope-guarded mark-read. The campus scope is layered on top of tenancy so a scoped
  // admin can never flip an out-of-scope submission's unread flag.
  public async markRead(churchId: string, id: string, scope: CampusScope): Promise<bigint> {
    let q = getDb().updateTable("formSubmissions")
      .set({ unread: 0 as any })
      .where("churchId", "=", churchId)
      .where("id", "=", id);
    q = applyCampusScope(q, scope);
    const result = await q.executeTakeFirst();
    return (result?.numUpdatedRows ?? 0n) as bigint;
  }

  public async delete(churchId: string, id: string) {
    await getDb().deleteFrom("formSubmissions").where("id", "=", id).where("churchId", "=", churchId).execute();
  }

  public async load(churchId: string, id: string) {
    return (await getDb().selectFrom("formSubmissions").selectAll().where("id", "=", id).where("churchId", "=", churchId).executeTakeFirst()) ?? null;
  }

  public async loadAll(churchId: string) {
    return getDb().selectFrom("formSubmissions").selectAll().where("churchId", "=", churchId).execute();
  }

  public async loadForContent(churchId: string, contentType: string, contentId: string) {
    return getDb().selectFrom("formSubmissions").selectAll()
      .where("churchId", "=", churchId)
      .where("contentType", "=", contentType)
      .where("contentId", "=", contentId)
      .execute();
  }

  public async loadByFormId(churchId: string, formId: string) {
    return getDb().selectFrom("formSubmissions").selectAll()
      .where("churchId", "=", churchId)
      .where("formId", "=", formId)
      .execute();
  }

  public saveAll(models: FormSubmission[]) {
    const promises: Promise<FormSubmission>[] = [];
    models.forEach((model) => { promises.push(this.save(model)); });
    return Promise.all(promises);
  }

  public insert(model: FormSubmission): Promise<FormSubmission> {
    return this.create(model);
  }

  protected rowToModel(row: any): FormSubmission {
    return {
      id: row.id,
      churchId: row.churchId,
      formId: row.formId,
      contentType: row.contentType,
      contentId: row.contentId,
      submissionDate: row.submissionDate,
      submittedBy: row.submittedBy,
      revisionDate: row.revisionDate,
      revisedBy: row.revisedBy,
      campusId: row.campusId,
      submissionType: row.submissionType,
      unread: row.unread === undefined ? undefined : !!row.unread,
      submitterName: row.submitterName,
      submitterEmail: row.submitterEmail,
      submitterPhone: row.submitterPhone,
      message: row.message
    };
  }

  public convertToModel(_churchId: string, data: any) {
    if (!data) return null;
    return this.rowToModel(data);
  }

  public convertAllToModel(_churchId: string, data: any[]) {
    if (!Array.isArray(data)) return [];
    return data.map((d) => this.rowToModel(d));
  }
}
