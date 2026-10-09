import { Repos } from "../../repositories/Repos.js";
import { KeycloakAdminClient, KeycloakUser, attr, verifiedEmailsOf } from "../mbid/KeycloakAdminClient.js";
import { MbidConfig } from "../mbid/MbidConfig.js";
import { CrmPeople, normEmail } from "./CrmPeople.js";
import { CrmConfig } from "./CrmConfig.js";
import { CrmBotCheck } from "./CrmBotCheck.js";

/**
 * Keeps HURO in step with Mary Banks ID (Keycloak realm `marybanks`): every account gets a church
 * person in the CRM church. Runs every 5 minutes from RailwayCron (and on demand from the admin).
 *
 * A full walk of the realm's users is cheap at this size (a page of 500 per call) and needs only the
 * view-users role the service client already has; it also catches accounts made by the Admin API
 * (GTC /start, imports) that never raise a REGISTER event.
 *
 * Writes only what changed: a person is created once, a profile row only when a Keycloak value
 * (location, locale, created date) differs from what is stored. A Keycloak account that disappears
 * marks the profile mbidRemovedAt; the church record is never deleted.
 */

const PAGE = 500;
const regionNames = (() => {
  try { return new Intl.DisplayNames(["en"], { type: "region" }); } catch { return null; }
})();
const langNames = (() => {
  try { return new Intl.DisplayNames(["en"], { type: "language" }); } catch { return null; }
})();

export const countryName = (code: string | null | undefined): string | null => {
  const c = String(code || "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(c)) return null;
  try { return regionNames?.of(c) || c; } catch { return c; }
};

export const languageName = (code: string | null | undefined): string | null => {
  const c = String(code || "").trim();
  if (!c) return null;
  try { return langNames?.of(c) || c; } catch { return c; }
};

export interface SyncResult { users: number; created: number; linked: number; updated: number; removed: number; skipped: number; bots: number; ms: number }


export class CrmSyncService {
  constructor(private repos: Repos, private admin = new KeycloakAdminClient()) {}

  static isServiceAccount(u: KeycloakUser): boolean {
    return (u.username || "").startsWith("service-account-");
  }

  /** Every user in the realm, all pages. Throws if any page fails (never a partial "removed" pass). */
  async fetchAllUsers(): Promise<KeycloakUser[]> {
    const out: KeycloakUser[] = [];
    for (let first = 0; first < 200000; first += PAGE) {
      const page = await this.admin.listUsers(first, PAGE);
      out.push(...page);
      if (page.length < PAGE) break;
    }
    return out.filter((u) => u?.id && !CrmSyncService.isServiceAccount(u));
  }

  /** The profile columns that come from Keycloak for this user. */
  static profileFrom(u: KeycloakUser): Record<string, any> {
    const code = (attr(u, "country")[0] || "").trim().toUpperCase();
    const locale = (attr(u, "locale")[0] || "").trim();
    return {
      countryCode: /^[A-Z]{2}$/.test(code) ? code : undefined,
      country: /^[A-Z]{2}$/.test(code) ? countryName(code) : undefined,
      region: attr(u, "region")[0]?.slice(0, 80) || undefined,
      city: attr(u, "city")[0]?.slice(0, 80) || undefined,
      locale: locale || undefined,
      mbidCreatedAt: u.createdTimestamp ? new Date(Number(u.createdTimestamp)) : undefined
    };
  }

  /** Create or link the person for one Keycloak user, then refresh their profile. */
  async syncUser(churchId: string, u: KeycloakUser, existing?: any | null): Promise<"created" | "linked" | "updated" | "same"> {
    const fromKc = CrmSyncService.profileFrom(u);
    let personId: string;
    let outcome: "created" | "linked" | "updated" | "same" = "same";
    if (existing) {
      personId = existing.id;
    } else {
      const res = await CrmPeople.ensure(this.repos, {
        churchId,
        sub: u.id,
        emails: [normEmail(u.email), ...verifiedEmailsOf(u)],
        firstName: u.firstName,
        lastName: u.lastName,
        source: "mbid",
        dateAdded: fromKc.mbidCreatedAt || null
      });
      personId = res.personId;
      outcome = res.created ? "created" : "linked";
      if (!res.created) await this.repos.crm.setPersonSource(churchId, personId, "mbid");
    }

    const profile = await this.repos.crm.loadProfile(churchId, personId);
    const patch: Record<string, any> = {};
    // Keycloak values only fill blanks: what staff typed or capture learned always wins.
    if (fromKc.countryCode && !profile?.countryCode && !profile?.country) { patch.countryCode = fromKc.countryCode; patch.country = fromKc.country; }
    if (fromKc.city && !profile?.city) patch.city = fromKc.city;
    if (fromKc.region && !profile?.region) patch.region = fromKc.region;
    if (fromKc.locale && !profile?.languages) patch.languages = languageName(fromKc.locale);
    if (fromKc.mbidCreatedAt && !profile?.mbidCreatedAt) patch.mbidCreatedAt = fromKc.mbidCreatedAt;
    if (profile?.mbidRemovedAt) patch.mbidRemovedAt = null;
    if (!profile || Object.keys(patch).length) {
      await this.repos.crm.upsertProfile(churchId, personId, patch);
      if (outcome === "same") outcome = "updated";
    }
    return outcome;
  }

  /** One user by Keycloak id (used right after a Global Church join or event sign-up). */
  async syncOne(sub: string): Promise<string | null> {
    const churchId = await CrmConfig.churchId(this.repos);
    if (!churchId || !MbidConfig.adminConfigured) return null;
    const u = await this.admin.getUser(sub);
    if (!u || (await CrmBotCheck.verdicts([u])).get(u.id)) return null;
    await this.syncUser(churchId, u, await this.repos.crm.loadPersonByMbidSub(churchId, sub));
    return (await this.repos.crm.loadPersonByMbidSub(churchId, sub))?.id || null;
  }

  async run(): Promise<SyncResult> {
    const started = Date.now();
    const result: SyncResult = { users: 0, created: 0, linked: 0, updated: 0, removed: 0, skipped: 0, bots: 0, ms: 0 };
    if (!MbidConfig.adminConfigured) return result;
    const churchId = await CrmConfig.churchId(this.repos);
    if (!churchId) return result;

    const users = await this.fetchAllUsers();
    result.users = users.length;
    const index = await this.repos.crm.loadPeopleIndex(churchId);
    const bySub = new Map<string, any>();
    for (const p of index) if (p.mbidSub && !isRemoved(p.removed)) bySub.set(p.mbidSub, p);

    // Spam sign-ups get no record (an account already linked to a church record is never dropped).
    const verdicts = await CrmBotCheck.verdicts(users.filter((u) => !bySub.has(u.id)));
    for (const u of users) {
      if (verdicts.get(u.id)) { result.bots++; continue; }
      try {
        const outcome = await this.syncUser(churchId, u, bySub.get(u.id) || null);
        if (outcome === "created") result.created++;
        else if (outcome === "linked") result.linked++;
        else if (outcome === "updated") result.updated++;
      } catch (e: any) {
        result.skipped++;
        console.error("[crm-sync] user " + u.id + " failed:", e?.message || e);
      }
    }

    // Accounts gone from Mary Banks ID: keep the church record, mark the profile.
    const live = new Set(users.map((u) => u.id));
    for (const [sub, p] of bySub) {
      if (live.has(sub)) continue;
      const prof = await this.repos.crm.loadProfile(churchId, p.id);
      if (!prof?.mbidRemovedAt) {
        await this.repos.crm.upsertProfile(churchId, p.id, { mbidRemovedAt: new Date() });
        result.removed++;
      }
    }

    result.ms = Date.now() - started;
    await this.repos.crm.setState("keycloak.lastRun", JSON.stringify({ at: new Date().toISOString(), ...result }));
    return result;
  }
}

function isRemoved(v: any): boolean {
  if (Buffer.isBuffer(v)) return v[0] === 1;
  return v === true || v === 1 || v === "1";
}
