import { sql } from "kysely";
import { Repos } from "../../repositories/Repos.js";
import { getDb } from "../../db/index.js";
import { DateHelper } from "../index.js";

/**
 * Find-or-create a church person for the CRM. Every way someone enters the CRM goes through here
 * (Mary Banks ID sync, quick capture, event registration, Global Church join) so matching is the
 * same everywhere:
 *   1. the person already carrying this Mary Banks ID,
 *   2. else people whose email equals one of the given emails (not yet tied to another ID),
 *   3. else a new person, membershipStatus "Contact" (unless told otherwise), no campus.
 */

export const CONTACT_STATUS = "Contact";

export interface EnsurePersonInput {
  churchId: string;
  sub?: string | null;
  emails?: string[];
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
  source: string;
  status?: string;
  campusId?: string | null;
  dateAdded?: Date | null;
}

export const normEmail = (e: any): string => String(e || "").trim().toLowerCase();

const RANK: Record<string, number> = { Staff: 0, Member: 1, "Regular Attendee": 2, Visitor: 3, Guest: 4, Contact: 5 };

/** Several people share the email: prefer the strongest church tie, then the oldest record. */
export function pickBest<T extends { membershipStatus?: string | null; id: string }>(rows: T[]): T {
  return [...rows].sort((a, b) => (RANK[a.membershipStatus || ""] ?? 9) - (RANK[b.membershipStatus || ""] ?? 9) || a.id.localeCompare(b.id))[0];
}

export class CrmPeople {
  static async findByEmails(churchId: string, emails: string[]): Promise<any[]> {
    const list = [...new Set(emails.map(normEmail).filter(Boolean))];
    if (!list.length) return [];
    const rows = await (getDb() as any).selectFrom("people")
      .select([
        "id", "mbidSub", "email", "membershipStatus", "userId", "firstName", "lastName", "mobilePhone"
      ])
      .where("churchId", "=", churchId)
      .where(sql<boolean>`LOWER(TRIM(email)) IN (${sql.join(list)})`)
      .where((eb: any) => eb.or([eb("removed", "=", false), eb("removed", "is", null)]))
      .limit(20).execute();
    return rows;
  }

  static async ensure(repos: Repos, input: EnsurePersonInput): Promise<{ personId: string; created: boolean; linked: boolean }> {
    const { churchId } = input;
    if (input.sub) {
      const bySub = await repos.crm.loadPersonByMbidSub(churchId, input.sub);
      if (bySub && !bySub.removed) return { personId: bySub.id, created: false, linked: false };
    }
    const emails = (input.emails || []).map(normEmail).filter(Boolean);
    const matches = (await CrmPeople.findByEmails(churchId, emails)).filter((p: any) => !p.mbidSub || p.mbidSub === input.sub);
    if (matches.length) {
      const best = pickBest(matches);
      if (input.sub && !best.mbidSub) await repos.crm.setPersonMbidSub(churchId, best.id, input.sub);
      // Fill a missing phone, never overwrite one the church already has.
      if (input.phone && !best.mobilePhone) await (getDb() as any).updateTable("people").set({ mobilePhone: String(input.phone).slice(0, 21) }).where("churchId", "=", churchId).where("id", "=", best.id).execute();
      return { personId: best.id, created: false, linked: !!input.sub && !best.mbidSub };
    }

    const first = (input.firstName || "").trim() || (emails[0] ? emails[0].split("@")[0] : "Friend");
    const last = (input.lastName || "").trim();
    const household: any = { churchId, name: last || first };
    await repos.household.save(household);
    const person: any = {
      churchId,
      householdId: household.id,
      householdRole: "Head",
      name: { first: first.slice(0, 50), last: last.slice(0, 50) },
      membershipStatus: input.status || CONTACT_STATUS,
      campusId: input.campusId || undefined,
      contactInfo: {} as any
    };
    if (emails[0]) person.contactInfo.email = emails[0].slice(0, 100);
    if (input.phone) person.contactInfo.mobilePhone = String(input.phone).slice(0, 21);
    const saved = await repos.person.save(person);
    const set: any = { source: input.source };
    if (input.sub) set.mbidSub = input.sub;
    if (input.dateAdded) set.dateAdded = DateHelper.toMysqlDate(input.dateAdded);
    await (getDb() as any).updateTable("people").set(set).where("churchId", "=", churchId).where("id", "=", saved.id).execute();
    return { personId: saved.id, created: true, linked: false };
  }
}
