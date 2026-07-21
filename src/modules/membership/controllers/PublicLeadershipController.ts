import { controller, httpGet, requestParam } from "inversify-express-utils";
import express from "express";
import { MembershipBaseController } from "./MembershipBaseController.js";
import { toPublicLeader, type PublicLeaderDTO } from "../helpers/PublicDto.js";

/**
 * PublicLeadershipController — the FIRST anonymous public read (PUB-01).
 *
 * GET /membership/public/:churchId/leadership returns the church's opted-in leaders as
 * `{ id, displayName, role, photo }` and NOTHING else. It is the first consumer of the
 * `PublicDto` positive-whitelist convention and the template every later `/public/`
 * read (Plan 05 content, all of Phase 20) follows.
 *
 * ANONYMOUS: wrapped in `actionWrapperAnon` (SettingController.appTheme is the precedent)
 * — no `au`, no auth, no permission gate. Safety comes from the projection + the opt-in
 * gate, NOT from a caller identity.
 *
 * OPT-IN, DEFAULT OFF (CONTEXT-locked): a person is listed ONLY when they have positively
 * opted in via the existing `VisibilityPreference` system (any field explicitly set to
 * `everyone`). No preference row / nothing set to `everyone` → NOT listed. So the list is
 * EMPTY until people opt in — the correct, safe default.
 *
 * PHOTOS: minor + unknown-age photos are always suppressed (adult-only), enforced inside
 * `toPublicLeader` → `resolvePublicPhoto`.
 *
 * NEVER exposes email / phone / address / householdId / birthDate under any query param.
 * Campus-level address/phone/service-times are the content model's job (Plan 05), not here.
 *
 * ROUTE SAFETY (messaging-route-collision memory): mounted under a distinct `/membership/public`
 * prefix; `/:churchId/leadership` is multi-segment and cannot be swallowed by any single-segment
 * `/:id` catch-all. No `/membership/public/:something` catch-all exists.
 */
@controller("/membership/public")
export class PublicLeadershipController extends MembershipBaseController {
  @httpGet("/:churchId/leadership")
  public async leadership(@requestParam("churchId") churchId: string, req: express.Request, res: express.Response): Promise<any> {
    return this.actionWrapperAnon(req, res, async () => {
      if (!churchId) return [];

      // 1. Candidate leaders = role members for this church, keyed to a person via userChurches.
      //    roleMember.loadByRoleId already joins userChurches → personId.
      const roles = (await this.repos.role.loadByChurchId(churchId)) as any[];
      if (!roles || roles.length === 0) return [];

      // personId → role/title (first role wins; roles are the church's leadership titles)
      const roleByPerson = new Map<string, string>();
      for (const role of roles) {
        const members = (await this.repos.roleMember.loadByRoleId(role.id, churchId)) as any[];
        for (const m of members) {
          if (m.personId && !roleByPerson.has(m.personId)) roleByPerson.set(m.personId, role.name ?? null);
        }
      }
      if (roleByPerson.size === 0) return [];

      // 2. Load the candidate people rows (church-scoped, non-removed).
      const personIds = Array.from(roleByPerson.keys());
      const people = (await this.repos.person.loadByIds(churchId, personIds)) as any[];
      if (!people || people.length === 0) return [];

      // 3. OPT-IN gate, DEFAULT OFF: keep only people who positively set a VisibilityPreference
      //    field to `everyone`. No row / nothing `everyone` → dropped.
      const result: PublicLeaderDTO[] = [];
      for (const person of people) {
        const pref = await this.repos.visibilityPreference.loadForPerson(churchId, person.id);
        const optedIn = !!pref && (pref.address === "everyone" || pref.phoneNumber === "everyone" || pref.email === "everyone");
        if (!optedIn) continue;

        // 4. Project through the positive-whitelist DTO. NEVER return the raw row.
        result.push(toPublicLeader({ ...person, churchId, role: roleByPerson.get(person.id) ?? null }));
      }

      return result;
    });
  }
}
