import { controller, httpPost } from "inversify-express-utils";
import express from "express";
import { MembershipBaseController } from "./MembershipBaseController.js";
import { CampusScopeHelper, normalizeAudience, resolveDescriptorPersonIds } from "../helpers/index.js";

/**
 * Scoped audience-resolution seam (Phase 10, AUD-01/02/03) — the ONE safe way to resolve an
 * audience to a people set. Mirrors LeadershipReportController EXACTLY for gating + scope
 * (People-View, UNPREFIXED; CampusScopeHelper.resolve server-side; scoped repo load), but returns
 * JSON — the { personId, email, campusId, mergeData }[] contract the messaging RecipientResolver
 * (Plan 02) consumes over the existing HTTP seam.
 *
 * WHY THIS EXISTS: no existing membership people-list endpoint (people, groupmembers, or
 * list-people routes) applies campus scope — routing audience resolution through them LEAKS every
 * campus to a Campus Admin, and a cross-campus recipient leak in a real send is unrecallable.
 * Messaging NEVER re-implements applyCampusScope; it calls THIS endpoint with the caller JWT so
 * membership re-derives the SAME scope server-side.
 *
 * The audience is type+target+filter — person IDs are OUTPUTS of the scoped resolve, NEVER a
 * client input. A campus/auxiliary target is a NARROWING applied WITHIN scope (an out-of-scope
 * target yields zero rows via applyCampusScope, never a leak — Pitfall 7).
 *
 * NOTE: the class name MUST be globally unique across ALL modules — inversify-express-utils
 * registers controllers by class name and crash-loops on a collision (LeadershipReportController
 * documents a real 502 from a duplicate). This is AudienceController (membership); the messaging
 * campaign controller in Plan 02 is the distinct CampaignAudienceController.
 */
@controller("/membership/audiences")
export class AudienceController extends MembershipBaseController {

  @httpPost("/resolve")
  public async resolve(req: express.Request, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      // 1. READ gate — Campaigns-View, UNPREFIXED (omit apiName). This is the campaign-audience
      //    seam: the messaging RecipientResolver forwards the caller's MessagingApi JWT here, and
      //    that JWT carries MessagingApi "Campaigns" perms, NOT MembershipApi "People" (per-api
      //    JWTs are permission-scoped). Campus scoping below still constrains WHICH people resolve.
      if (!au.checkAccess({ contentType: "Campaigns", action: "View" })) return this.json({}, 401);

      // 2. SCOPE server-side from the caller JWT — NEVER from req.body (Pitfall 3).
      const scope = await CampusScopeHelper.resolve(au, this.repos);

      // 3. Descriptor from body (type+target+filter ONLY; personIds is never an input).
      const descriptor = normalizeAudience(req.body);
      const campusTargetId = descriptor.type === "campus" ? descriptor.targetId : undefined;

      // 4. Resolve the id narrowing (group/aux expansion + filterJson intersect); null = whole scoped church.
      const personIds = await resolveDescriptorPersonIds(au.churchId, descriptor, this.repos);

      // 5. Load people SCOPED — out-of-scope is structurally impossible (applyCampusScope in loadForAudience).
      const people = (await this.repos.person.loadForAudience(au.churchId, scope, { campusTargetId, personIds })) as any[];

      // 6. Enrich mergeData with the ACTIVE ordination credential (BLD-03 third merge-field category),
      //    frozen into the snapshot at RESOLVE time (not render time) so a later revoke/re-grant never
      //    drifts a sent card. BATCH the credential lookup for the resolved id set (no N+1) — same
      //    campus scope, so an out-of-scope credential is structurally impossible. First active row per
      //    person wins (createdAt desc = most recent grant). ordinationType.name IS the title.
      const resolvedIds = people.map((p) => p.id).filter((id): id is string => !!id);
      const activeOrdinations = await this.repos.personOrdination.loadActiveForPeople(au.churchId, resolvedIds, scope);
      const ordinationTypes = (await this.repos.ordinationType.loadAll(au.churchId)) as any[];
      const typeNameById = new Map<string, string>(ordinationTypes.map((t) => [t.id, t.name]));
      // personId → first (most-recent) active credential's merge fields.
      const credByPerson = new Map<string, { ordinationTitle: string; credentialNumber: string; ordinationStatus: string }>();
      for (const ord of activeOrdinations) {
        if (credByPerson.has(ord.personId)) continue; // rows are createdAt-desc → keep the first (most recent)
        credByPerson.set(ord.personId, {
          ordinationTitle: (ord.ordinationTypeId && typeNameById.get(ord.ordinationTypeId)) || "",
          credentialNumber: ord.credentialNumber || "",
          ordinationStatus: ord.status || ""
        });
      }

      // 6b. Enrich with the church name + per-person campus name/address. The compliant
      //     CAN-SPAM footer (CampaignRenderHelper.buildFooter → renderContext) needs churchName +
      //     the campus physical address, but the membership DB (not the messaging module) is the
      //     ONLY source, so it must ride the snapshot from HERE — otherwise renderContext reads
      //     these keys off mergeData, finds them absent, and every sent/previewed email ships an
      //     EMPTY footer (no church identity, no legal address). BATCH: one church load + one
      //     campuses loadAll, mapped by campusId (no N+1). Frozen at resolve so a later
      //     church/campus edit never drifts a sent card (same doctrine as the credential above).
      const church = await this.repos.church.loadById(au.churchId);
      const churchName: string = (church as any)?.name || "";
      const campuses = (await this.repos.campus.loadAll(au.churchId)) as any[];
      const campusById = new Map<string, any>(campuses.map((c) => [c.id, c]));
      const campusAddressLine = (c: any): string =>
        [c?.address1, c?.address2, c?.city, c?.state, c?.zip, c?.country]
          .filter((part) => part && String(part).trim().length > 0)
          .join(" ");

      // 7. Map to the resolver contract. mergeData keys MUST match MergeFieldHelper (12-01) + client
      //    mergeTags (12-05): person basics + ordination credential + church/campus footer fields. A
      //    person with no active credential (or a blank address field) surfaces empty values
      //    (render-time fallback handles blanks). The discrete address fields (address1/city/state/
      //    zip/country) are carried too so CampaignRenderHelper.buildFooter (via renderContext) can
      //    assemble the CAN-SPAM address line identically for preview, test-send, and real send.
      return people.map((p) => {
        const cred = credByPerson.get(p.id) ?? { ordinationTitle: "", credentialNumber: "", ordinationStatus: "" };
        const campus = p.campusId ? campusById.get(p.campusId) : undefined;
        return {
          personId: p.id,
          email: p.email,
          campusId: p.campusId,
          mergeData: {
            firstName: p.firstName,
            lastName: p.lastName,
            displayName: p.displayName,
            email: p.email,
            ordinationTitle: cred.ordinationTitle,
            credentialNumber: cred.credentialNumber,
            ordinationStatus: cred.ordinationStatus,
            churchName,
            campusName: campus?.name || "",
            campusAddress: campusAddressLine(campus),
            address1: campus?.address1 || "",
            address2: campus?.address2 || "",
            city: campus?.city || "",
            state: campus?.state || "",
            zip: campus?.zip || "",
            country: campus?.country || ""
          }
        };
      });
    });
  }
}
