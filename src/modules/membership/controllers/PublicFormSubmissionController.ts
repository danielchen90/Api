import { controller, httpPost, requestParam } from "inversify-express-utils";
import express from "express";
import { MembershipBaseController } from "./MembershipBaseController.js";
import { PublicFormSubmissionHelper } from "../helpers/PublicFormSubmissionHelper.js";
import { AuditLogHelper } from "../helpers/AuditLogHelper.js";
import { FormSubmission } from "../models/index.js";

/**
 * PublicFormSubmissionController — the login-free prayer/contact submit (FRM-01/02/04).
 *
 * ANONYMOUS: `POST /membership/public/:churchId/:campusId/submit` wrapped in
 * `actionWrapperAnon` (no `au`). A visitor submits a prayer request or contact message
 * with NO login. churchId + campusId come from the TRUSTED ROUTE, never from a spoofable
 * auth field — and they are DATA TAGS only, not authorization inputs (RESEARCH Pitfall 4:
 * a submission is public-by-design, so tagging it with a church/campus is safe; only the
 * READ side is scope-enforced, in FormSubmissionController).
 *
 * SPAM DEFENSE (FRM-04), login-free, two layers (PublicFormSubmissionHelper):
 *   1. HONEYPOT — a filled hidden `website` field ⇒ bot ⇒ SILENT DROP: return a
 *      success-shaped `{ ok: true }` and store NOTHING (a bot must not learn it failed).
 *   2. PER-IP / PER-FORM RATE LIMIT — burst submits from one IP for one form → 429.
 *
 * This controller NEVER touches the existing authenticated FormSubmissionController.save
 * (workflow/questions) path — it only writes the minimal login-free columns via
 * FormSubmissionRepo.createPublic.
 *
 * ROUTE SAFETY (messaging-route-collision memory): mounted under the multi-segment
 * `/membership/public` prefix as `/:churchId/:campusId/submit` — a multi-segment path
 * that cannot be swallowed by any single-segment `/:id` catch-all. (It shares the
 * `/membership/public` mount with PublicLeadershipController, whose routes are also
 * multi-segment and distinct.)
 */
@controller("/membership/public")
export class PublicFormSubmissionController extends MembershipBaseController {
  private static VALID_TYPES = ["prayer", "contact"];

  @httpPost("/:churchId/:campusId/submit")
  public async submit(
    @requestParam("churchId") churchId: string,
    @requestParam("campusId") campusId: string,
    req: express.Request,
    res: express.Response
  ): Promise<any> {
    return this.actionWrapperAnon(req, res, async () => {
      const body: any = req.body ?? {};

      // 1. Honeypot — a filled hidden field is a bot. SILENT DROP: success shape, no insert.
      if (PublicFormSubmissionHelper.isBot(body)) return { ok: true };

      // 2. Per-IP / per-form rate limit. Keyed on the derived IP + the form discriminator
      //    (formId when present, else submissionType). Exhausted → 429.
      const ip = AuditLogHelper.getClientIp(req);
      const formKey = (body.formId as string) || (body.submissionType as string) || "";
      if (!PublicFormSubmissionHelper.rateLimit(ip, formKey)) {
        return this.json({ error: "Too many submissions. Please try again later." }, 429);
      }

      // 3. Validate. churchId + campusId come from the trusted ROUTE (never the body).
      const submissionType: string = body.submissionType;
      const name: string = (body.name ?? "").toString().trim();
      const email: string = (body.email ?? "").toString().trim();
      const phone: string | undefined = body.phone ? body.phone.toString().trim() : undefined;
      const message: string = (body.message ?? "").toString().trim();

      if (!churchId || !campusId) return this.json({ error: "Invalid submission target." }, 400);
      if (!PublicFormSubmissionController.VALID_TYPES.includes(submissionType)) {
        return this.json({ error: "Invalid submission type." }, 400);
      }
      if (!name || !email || !message) return this.json({ error: "Name, email and message are required." }, 400);

      // 4. Store the MINIMAL login-free submission. churchId/campusId are trusted-route
      //    DATA TAGS; createPublic writes only the minimal columns (no formId/answers).
      const sub = new FormSubmission();
      sub.churchId = churchId;
      sub.campusId = campusId;
      sub.submissionType = submissionType;
      sub.submitterName = name;
      sub.submitterEmail = email;
      sub.submitterPhone = phone;
      sub.message = message;
      await this.repos.formSubmission.createPublic(sub);

      return { ok: true };
    });
  }
}
