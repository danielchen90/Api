import { controller, httpPost, httpGet, requestParam, httpDelete } from "inversify-express-utils";
import express from "express";
import { MembershipBaseController } from "./MembershipBaseController.js";
import { FormSubmission, Answer, Form, Church } from "../models/index.js";
import { Permissions, EmailHelper, Environment } from "../helpers/index.js";
import { CampusScopeHelper } from "../helpers/CampusScopeHelper.js";
import { MemberPermission, Person } from "../models/index.js";
import { WebhookDispatcher } from "../../../shared/webhooks/index.js";
import axios from "axios";

@controller("/membership/formsubmissions")
export class FormSubmissionController extends MembershipBaseController {
  // ── Campus-scoped login-free inbox READ (FRM-03) ──
  //
  // The prayer/contact submissions written by PublicFormSubmissionController are read here
  // by admins. Visibility is scope-enforced ON THE READ via CampusScopeHelper (the exact
  // primitive used by CampusContentController): an org/leadership admin (mode "all") sees
  // every campus's submissions; a campus admin (mode "scoped") sees ONLY their assigned
  // campus(es); a caller with no scope (mode "deny") sees NONE. The scope is ALWAYS derived
  // SERVER-SIDE from `au` — NEVER from a request campusId param (a client cannot widen it).
  //
  // The permission gate is the SAME UNPREFIXED Permissions.forms constant the rest of this
  // controller uses (campus-auth-perms-unprefixed memory: an apiName-prefixed constant would
  // 401 a legitimate campus admin whose per-api JWT carries the bare Forms/Edit permission).
  //
  // ROUTE ORDER (messaging-route-collision memory): these `/inbox*` routes are declared
  // BEFORE the `@httpGet("/:id")` catch-all below so `/inbox` is never swallowed by `/:id`.
  //
  // The actual scope enforcement runs inside the repo: CampusScopeHelper.resolve(au) here
  // derives the CampusScope, and FormSubmissionRepo.loadInboxScoped/loadDetailScoped/markRead
  // apply it via applyCampusScope(query, scope) — churchId tenancy FIRST, then the campus
  // scope layered on top (mode "all" → no filter, "scoped" → campusId IN(set), "deny" → 1=0).

  @httpGet("/inbox")
  public async inbox(req: express.Request<{}, {}, null>, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      if (!au.checkAccess(Permissions.forms.admin) && !au.checkAccess(Permissions.forms.edit)) return this.json([], 401);
      // Scope derived server-side from the requesting admin — never from the request.
      const scope = await CampusScopeHelper.resolve(au, this.repos);
      return this.repos.formSubmission.loadInboxScoped(au.churchId, scope);
    });
  }

  @httpGet("/inbox/:id")
  public async inboxDetail(@requestParam("id") id: string, req: express.Request<{}, {}, null>, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      if (!au.checkAccess(Permissions.forms.admin) && !au.checkAccess(Permissions.forms.edit)) return this.json({}, 401);
      const scope = await CampusScopeHelper.resolve(au, this.repos);
      const row = await this.repos.formSubmission.loadDetailScoped(au.churchId, id, scope);
      // Out-of-scope (or absent) → 404, never leak another campus's submission.
      if (!row) return this.json({}, 404);
      return this.repos.formSubmission.convertToModel(au.churchId, row);
    });
  }

  @httpPost("/inbox/:id/read")
  public async inboxMarkRead(@requestParam("id") id: string, req: express.Request<{}, {}, null>, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      if (!au.checkAccess(Permissions.forms.admin) && !au.checkAccess(Permissions.forms.edit)) return this.json({}, 401);
      const scope = await CampusScopeHelper.resolve(au, this.repos);
      const numUpdated = await this.repos.formSubmission.markRead(au.churchId, id, scope);
      // Scope-guarded: a row outside the caller's scope updates nothing → 404.
      if (numUpdated === 0n) return this.json({}, 404);
      return this.json({ ok: true });
    });
  }

  @httpGet("/:id")
  public async get(@requestParam("id") id: string, req: express.Request<{}, {}, null>, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      if (!au.checkAccess(Permissions.forms.admin) && !au.checkAccess(Permissions.forms.edit)) return this.json({}, 401);
      const result: FormSubmission = this.repos.formSubmission.convertToModel(au.churchId, await this.repos.formSubmission.load(au.churchId, id));
      if (this.include(req, "form")) await this.appendForm(au.churchId, result);
      if (this.include(req, "questions")) await this.appendQuestions(au.churchId, result);
      if (this.include(req, "answers")) await this.appendAnswers(au.churchId, result);
      return result;
    });
  }

  @httpGet("/")
  public async getAll(req: express.Request<{}, {}, null>, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      if (!au.checkAccess(Permissions.forms.admin) && !au.checkAccess(Permissions.forms.edit)) return this.json({}, 401);
      else {
        let result = null;
        if (req.query.personId !== undefined) result = await this.repos.formSubmission.loadForContent(au.churchId, "person", req.query.personId.toString());
        else if (req.query.formId !== undefined) result = await this.repos.formSubmission.loadByFormId(au.churchId, req.query.formId.toString());
        else result = await this.repos.formSubmission.loadAll(au.churchId);
        return this.repos.formSubmission.convertAllToModel(au.churchId, result);
      }
    });
  }

  @httpGet("/formId/:formId")
  public async getByFormId(@requestParam("formId") formId: string, req: express.Request<{}, {}, null>, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      if (!this.formAccess(au, formId)) return this.json([], 401);
      else {
        const formSubmissions = await this.repos.formSubmission.convertAllToModel(au.churchId, (await this.repos.formSubmission.loadByFormId(au.churchId, formId)) as any[]);
        console.log("Form Submissions", formSubmissions.length);
        const promises: Promise<FormSubmission>[] = [];
        formSubmissions.forEach((formSubmission: FormSubmission) => {
          promises.push(this.appendForm(au.churchId, formSubmission));
          promises.push(this.appendQuestions(au.churchId, formSubmission));
          promises.push(this.appendAnswers(au.churchId, formSubmission));
        });
        await Promise.all(promises);
        return formSubmissions;
      }
    });
  }

  @httpPost("/")
  public async save(req: express.Request<{}, {}, FormSubmission[]>, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      if (req.body?.length > 0) {
        const results: any[] = [];
        for (const formSubmission of req.body) {
          const { formId } = formSubmission;
          let { churchId } = formSubmission;

          const formAccess = await this.repos.form.access(formId);
          const form = formAccess && this.repos.form.convertToModel(formAccess.churchId, formAccess);

          if (!form) {
            results.push({ error: `Form with id ${formId} not found` });
          } else {
            if (!churchId) churchId = form.churchId;
            if (!churchId && au) churchId = au.churchId;
            if (form.restricted && !this.formAccess(au, formId)) {
              results.push({ error: `You're not allowed to submit ${form.name}` });
            } else {
              formSubmission.churchId = churchId;
              const savedSubmissions = await this.repos.formSubmission.save(formSubmission);

              const answerPromises: Promise<Answer>[] = [];
              formSubmission?.answers?.forEach((answer) => {
                if (!answer.churchId) answer.churchId = churchId;
                answer.formSubmissionId = savedSubmissions.id;
                answerPromises.push(this.repos.answer.save(answer));
              });
              if (answerPromises.length > 0) {
                await Promise.all(answerPromises);
              }

              results.push(savedSubmissions);
              // Submitters land in workflows via the unified trigger engine, which
              // subscribes to this event (form.submission.created) on the internal bus.
              await WebhookDispatcher.emit(churchId, "form.submission.created", savedSubmissions);

              await this.sendEmails(formSubmission, form, churchId);
            }
          }
        }

        return results;
      }

      return { error: "Please check body. formsubmissions is required" };
    });
  }

  private async sendEmails(formSubmission: FormSubmission, form: Form, churchId: string) {
    // send email to form members that have emailNotification set to true
    const memberPermissions = (await this.repos.memberPermission.loadByEmailNotification(churchId, "form", form.id, true)) as any;
    const church: Church = await this.repos.church.loadById(churchId);
    if ((memberPermissions as any[])?.length > 0) {
      const ids = (memberPermissions as any[]).map((mp: MemberPermission) => mp.memberId);
      if (ids?.length > 0) {
        const people = (await this.repos.person.loadByIds(formSubmission.churchId, ids)) as any[];
        if ((people as any[])?.length > 0) {
          const contentRows: any[] = [];
          formSubmission.questions.forEach((q) => {
            formSubmission.answers.forEach((a) => {
              if (q.id === a.questionId) {
                contentRows.push("<tr><th style=\"font-size: 16px\" width=\"30%\">" + q.title + "</th><td style=\"font-size: 15px\">" + a.value + "</td></tr>");
              }
            });
          });

          const contents = "<table role=\"presentation\" style=\"text-align: left;\" cellspacing=\"8\" width=\"80%\"><tablebody>" + contentRows.join(" ") + "</tablebody></table>";
          const promises: Promise<any>[] = [];
          (people as any[]).forEach((p: Person) => {
            if (p.email) promises.push(EmailHelper.sendTemplatedEmail(Environment.supportEmail, p.email, church.name, Environment.b1AdminRoot, "New Submissions for " + form.name, contents));
          });
          promises.push(this.sendNotifications(churchId, form, ids));
          await Promise.all(promises);
        }
      }
    }
  }

  private async sendNotifications(churchId: string, form: Form, peopleIds: string[]) {
    const data = {
      churchId,
      peopleIds,
      contentType: "form",
      contentId: form.id,
      message: "New Form Submission: " + form.name
    };
    // todo add some kind of auth token and check for it. Can't be jwt since submissions can be anonymous.  Need to encrypt something
    // const config:AxiosRequestConfig = { headers: { "Authorization": "Bearer " + au.jwt } };
    return axios.post(Environment.messagingApi + "/notifications/ping", data);
  }

  @httpDelete("/:id")
  public async delete(@requestParam("id") id: string, req: express.Request<{}, {}, null>, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      if (!au.checkAccess(Permissions.forms.admin) && !au.checkAccess(Permissions.forms.edit)) return this.json({}, 401);
      else {
        await this.repos.answer.deleteForSubmission(au.churchId, id);
        await new Promise((resolve) => setTimeout(resolve, 500)); // I think it takes a split second for the FK restraints to see the answers were deleted sometimes and the delete below fails.
        await this.repos.formSubmission.delete(au.churchId, id);
        return this.json({});
      }
    });
  }

  private async appendForm(churchId: string, formSubmission: FormSubmission) {
    const data = await this.repos.form.load(churchId, formSubmission.formId);
    formSubmission.form = this.repos.form.convertToModel(churchId, data);
    return formSubmission;
  }

  private async appendQuestions(churchId: string, formSubmission: FormSubmission) {
    const data = (await this.repos.question.loadForForm(churchId, formSubmission.formId)) as any[];
    formSubmission.questions = this.repos.question.convertAllToModel(churchId, data);
    return formSubmission;
  }

  private async appendAnswers(churchId: string, formSubmission: FormSubmission) {
    const data = (await this.repos.answer.loadForFormSubmission(churchId, formSubmission.id)) as any[];
    formSubmission.answers = this.repos.answer.convertAllToModel(churchId, data);
    return formSubmission;
  }
}
