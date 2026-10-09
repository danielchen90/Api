import crypto from "crypto";
import { sql } from "kysely";
import { FileStorageHelper } from "@churchapps/apihelper";
import { KyselyPool } from "../../../../shared/infrastructure/KyselyPool.js";
import { getDb } from "../../db/index.js";
import { DateHelper } from "../../../../shared/helpers/DateHelper.js";

/**
 * Mary Banks ID account deletion (POST /membership/mbid/account-deleted, see MbidController).
 *
 * The Keycloak user is already gone when this runs, so the person is found by the Keycloak
 * subject alone: users.mbidSub (Mary Banks ID sign-ins), their userChurches, and people.mbidSub
 * (the CRM's Keycloak sync). Policy for this site:
 *
 *   DELETED     the login user and everything keyed by it (userChurches, roleMembers, campus and
 *               auxiliary assignments, user settings, API keys, OAuth tokens/codes, email codes);
 *               CRM profile, notes, facts, tags, activities, bot verdict; CRM event registrations
 *               and their send records; group memberships, join requests, list memberships,
 *               visibility preferences, member permissions, photo crops and the photo file;
 *               form submissions about the person or sent from their email (with answers);
 *               devices, notifications, notification preferences, live connections, delivery
 *               logs, staff notes in the person's notes conversation; content-module event
 *               registrations.
 *   ANONYMIZED  the people row (name "Deleted account", contact/address/birth fields cleared,
 *               mbidSub and userId cleared, removed + optedOut), because donations, attendance,
 *               group history and serving assignments keep pointing at personId for the church's
 *               records and giving totals; chat and private messages they sent (content emptied,
 *               sender shown as "Deleted account"); a household left with no one else in it.
 *   KEPT        donations, giving customers/subscriptions, attendance visits, groupMemberHistory,
 *               ordinations and license cards, access and audit logs, email suppressions.
 *
 * Order matters for retries: the rows that map the sub to the person (users, people.mbidSub)
 * are cleared last, so a call that fails halfway finds the same person again on the next try.
 *
 * Tombstones: crmSyncState rows "erased:<hash>" for the sub and every email, holding the erase
 * time. The CRM activity pull skips rows from an erased sub, and email-only rows from before the
 * erase, so it can never re-create the person from another site's history.
 */

export const DELETED_NAME = "Deleted account";
const TOMBSTONE_PREFIX = "erased:";

export type EraseCounts = Record<string, number>;
export interface EraseResult { found: boolean; erased: EraseCounts }

const norm = (e: any): string => String(e || "").trim().toLowerCase();
const mdb = () => getDb() as any;
const dbOf = (name: string) => KyselyPool.getDb<any>(name);

function tombstoneName(kind: "sub" | "email", value: string): string {
  // 7 + 56 = 63 chars: fits crmSyncState.name VARCHAR(64).
  return TOMBSTONE_PREFIX + crypto.createHash("sha256").update(kind + ":" + value).digest("hex").slice(0, 56);
}

function n(result: any): number {
  const rows = Array.isArray(result) ? result : [result];
  let total = 0;
  for (const r of rows) total += Number(r?.numDeletedRows ?? r?.numUpdatedRows ?? r?.numAffectedRows ?? 0);
  return total;
}

export class MbidAccountErasure {
  /** Erased subs and emails (hash -> erase time) for the CRM activity pull. */
  static async loadTombstones(): Promise<Map<string, Date>> {
    const rows = await mdb().selectFrom("crmSyncState").select(["name", "value"]).where("name", "like", TOMBSTONE_PREFIX + "%").execute();
    const out = new Map<string, Date>();
    for (const r of rows) out.set(r.name, new Date(r.value));
    return out;
  }

  /** True when an activity row must not be stored (or create anyone) because its person was erased. */
  static isErased(tombstones: Map<string, Date>, row: { sub?: string | null; email?: string | null; occurredAt?: Date | null }): boolean {
    if (!tombstones.size) return false;
    if (row.sub && tombstones.has(tombstoneName("sub", row.sub))) return true;
    const email = norm(row.email);
    if (email) {
      const at = tombstones.get(tombstoneName("email", email));
      // Only history from before the erase: a later sign-up with the same address is a new start.
      if (at && (!row.occurredAt || row.occurredAt.getTime() <= at.getTime())) return true;
    }
    return false;
  }

  private static async writeTombstone(name: string, at: string): Promise<void> {
    await sql`INSERT INTO crmSyncState (name, value, updatedAt) VALUES (${name}, ${at}, ${DateHelper.toMysqlDate(new Date())})
      ON DUPLICATE KEY UPDATE value = VALUES(value), updatedAt = VALUES(updatedAt)`.execute(getDb());
  }

  static async erase(sub: string): Promise<EraseResult> {
    const counts: EraseCounts = {};
    const add = (table: string, k: number) => { if (k) counts[table] = (counts[table] || 0) + k; };

    // ── who: users by sub, their church links, people by sub / user ──
    const users: any[] = await mdb().selectFrom("users").select(["id", "email"]).where("mbidSub", "=", sub).execute();
    const userIds = users.map((u) => u.id);
    const ucs: any[] = userIds.length ? await mdb().selectFrom("userChurches").select(["id", "churchId", "personId"]).where("userId", "in", userIds).execute() : [];
    const ucPersonIds = ucs.map((u) => u.personId).filter(Boolean);
    const people: any[] = await mdb().selectFrom("people")
      .select(["id", "churchId", "email", "householdId", "conversationId"])
      .where((eb: any) => {
        const ors = [eb("mbidSub", "=", sub)];
        if (userIds.length) ors.push(eb("userId", "in", userIds));
        if (ucPersonIds.length) ors.push(eb("id", "in", ucPersonIds));
        return eb.or(ors);
      })
      .execute();
    const persons = people;

    if (!users.length && !persons.length) return { found: false, erased: {} };

    const personIds = [...new Set(persons.map((p) => p.id))];
    const churchIds = [...new Set([...persons.map((p) => p.churchId), ...ucs.map((u) => u.churchId)])];
    const emails = [...new Set([...users.map((u) => norm(u.email)), ...persons.map((p) => norm(p.email))].filter(Boolean))];
    const ucIds = ucs.map((u) => u.id);
    const erasedAt = new Date().toISOString();

    // ── tombstones first, so a sync running alongside cannot bring the person back ──
    await MbidAccountErasure.writeTombstone(tombstoneName("sub", sub), erasedAt);
    for (const e of emails) await MbidAccountErasure.writeTombstone(tombstoneName("email", e), erasedAt);

    if (personIds.length) {
      await MbidAccountErasure.eraseMessaging(personIds, persons, add);
      await MbidAccountErasure.eraseContent(personIds, add);
      await MbidAccountErasure.eraseCrm(personIds, churchIds, emails, add);
      await MbidAccountErasure.eraseMembershipSide(personIds, churchIds, emails, add);
    }
    add("crmBotChecks", n(await mdb().deleteFrom("crmBotChecks").where("sub", "=", sub).execute()));

    // ── the login user and its sessions ──
    if (userIds.length) {
      if (ucIds.length) {
        add("oAuthTokens", n(await mdb().deleteFrom("oAuthTokens").where("userChurchId", "in", ucIds).execute()));
        add("oAuthCodes", n(await mdb().deleteFrom("oAuthCodes").where("userChurchId", "in", ucIds).execute()));
        add("oAuthDeviceCodes", n(await mdb().deleteFrom("oAuthDeviceCodes").where("userChurchId", "in", ucIds).execute()));
      }
      add("apiKeys", n(await mdb().deleteFrom("apiKeys").where("userId", "in", userIds).execute()));
      add("settings", n(await mdb().deleteFrom("settings").where("userId", "in", userIds).execute()));
      add("userCampuses", n(await mdb().deleteFrom("userCampuses").where("userId", "in", userIds).execute()));
      add("userAuxiliaries", n(await mdb().deleteFrom("userAuxiliaries").where("userId", "in", userIds).execute()));
      add("emailVerificationCodes", n(await mdb().deleteFrom("emailVerificationCodes").where("userId", "in", userIds).execute()));
      add("roleMembers", n(await mdb().deleteFrom("roleMembers").where("userId", "in", userIds).execute()));
      add("userChurches", n(await mdb().deleteFrom("userChurches").where("userId", "in", userIds).execute()));
      add("users", n(await mdb().deleteFrom("users").where("id", "in", userIds).execute()));
    }

    // ── last: anonymize the church records (clears mbidSub, the retry key) ──
    if (personIds.length) await MbidAccountErasure.anonymizePeople(persons, add);

    return { found: true, erased: counts };
  }

  private static async eraseMessaging(personIds: string[], persons: any[], add: (t: string, k: number) => void) {
    const db = dbOf("messaging");
    add("devices", n(await db.deleteFrom("devices").where("personId", "in", personIds).execute()));
    add("notifications", n(await db.deleteFrom("notifications").where("personId", "in", personIds).execute()));
    add("notificationPreferences", n(await db.deleteFrom("notificationPreferences").where("personId", "in", personIds).execute()));
    add("connections", n(await db.deleteFrom("connections").where("personId", "in", personIds).execute()));
    add("deliveryLogs", n(await db.deleteFrom("deliveryLogs").where("personId", "in", personIds).execute()));
    // Staff notes kept in the person's own notes conversation.
    const noteConvs = [...new Set(persons.map((p) => p.conversationId).filter(Boolean))];
    if (noteConvs.length) add("messages(personNotes)", n(await db.deleteFrom("messages").where("conversationId", "in", noteConvs).execute()));
    // Chat and private messages they wrote: others keep the thread, the words and name go.
    add("messages(anonymized)", n(await db.updateTable("messages").set({ content: "", displayName: DELETED_NAME }).where("personId", "in", personIds).execute()));
  }

  private static async eraseContent(personIds: string[], add: (t: string, k: number) => void) {
    const db = dbOf("content");
    const regs: any[] = await db.selectFrom("registrations").select("id").where("personId", "in", personIds).execute();
    const regIds = regs.map((r) => r.id);
    if (regIds.length) add("registrationMembers", n(await db.deleteFrom("registrationMembers").where("registrationId", "in", regIds).execute()));
    add("registrationMembers", n(await db.deleteFrom("registrationMembers").where("personId", "in", personIds).execute()));
    if (regIds.length) add("registrations", n(await db.deleteFrom("registrations").where("id", "in", regIds).execute()));
  }

  private static async eraseCrm(personIds: string[], churchIds: string[], emails: string[], add: (t: string, k: number) => void) {
    const db = mdb();
    add("crmFacts", n(await db.deleteFrom("crmFacts").where("personId", "in", personIds).execute()));
    add("crmNotes", n(await db.deleteFrom("crmNotes").where("personId", "in", personIds).execute()));
    add("crmPersonTags", n(await db.deleteFrom("crmPersonTags").where("personId", "in", personIds).execute()));
    add("crmActivities", n(await db.deleteFrom("crmActivities").where("personId", "in", personIds).execute()));
    add("crmProfiles", n(await db.deleteFrom("crmProfiles").where("personId", "in", personIds).execute()));

    const regs: any[] = await db.selectFrom("crmEventRegistrations").select("id")
      .where("churchId", "in", churchIds)
      .where((eb: any) => {
        const ors = [eb("personId", "in", personIds)];
        if (emails.length) ors.push(sql<boolean>`LOWER(TRIM(email)) IN (${sql.join(emails)})`);
        return eb.or(ors);
      })
      .execute();
    const keys = [...regs.map((r) => "reg:" + r.id), ...personIds.map((id) => "p:" + id)];
    add("crmEventEmailSends", n(await db.deleteFrom("crmEventEmailSends").where("recipientKey", "in", keys).execute()));
    if (regs.length) add("crmEventRegistrations", n(await db.deleteFrom("crmEventRegistrations").where("id", "in", regs.map((r) => r.id)).execute()));
  }

  private static async eraseMembershipSide(personIds: string[], churchIds: string[], emails: string[], add: (t: string, k: number) => void) {
    const db = mdb();
    add("groupMembers", n(await db.deleteFrom("groupMembers").where("personId", "in", personIds).execute()));
    add("groupJoinRequests", n(await db.deleteFrom("groupJoinRequests").where("personId", "in", personIds).execute()));
    add("listMembers", n(await db.deleteFrom("listMembers").where("personId", "in", personIds).execute()));
    add("visibilityPreferences", n(await db.deleteFrom("visibilityPreferences").where("personId", "in", personIds).execute()));
    add("memberPermissions", n(await db.deleteFrom("memberPermissions").where("memberId", "in", personIds).execute()));
    add("personPhotoCrops", n(await db.deleteFrom("personPhotoCrops").where("personId", "in", personIds).execute()));

    // Forms about the person, and anything they sent in from their own address (prayer requests, contact forms).
    const subs: any[] = await db.selectFrom("formSubmissions").select("id")
      .where("churchId", "in", churchIds)
      .where((eb: any) => {
        const ors = [eb.and([eb("contentType", "=", "person"), eb("contentId", "in", personIds)])];
        if (emails.length) ors.push(sql<boolean>`LOWER(TRIM(submitterEmail)) IN (${sql.join(emails)})`);
        return eb.or(ors);
      })
      .execute();
    const subIds = subs.map((s) => s.id);
    if (subIds.length) {
      add("answers", n(await db.deleteFrom("answers").where("formSubmissionId", "in", subIds).execute()));
      add("formSubmissions", n(await db.deleteFrom("formSubmissions").where("id", "in", subIds).execute()));
    }
  }

  private static async anonymizePeople(persons: any[], add: (t: string, k: number) => void) {
    const db = mdb();
    for (const p of persons) {
      try {
        await FileStorageHelper.remove("/" + p.churchId + "/membership/people/" + p.id + ".png");
      } catch {
        // No photo stored: nothing to remove.
      }
      add("people(anonymized)", n(await db.updateTable("people").set({
        displayName: DELETED_NAME,
        firstName: "Deleted",
        middleName: null,
        lastName: "account",
        nickName: null,
        prefix: null,
        suffix: null,
        birthDate: null,
        anniversary: null,
        gender: null,
        maritalStatus: null,
        homePhone: null,
        mobilePhone: null,
        workPhone: null,
        email: null,
        address1: null,
        address2: null,
        city: null,
        state: null,
        zip: null,
        photoUpdated: null,
        nametagNotes: null,
        userId: null,
        mbidSub: null,
        optedOut: true,
        removed: true
      }).where("churchId", "=", p.churchId).where("id", "=", p.id).execute()));

      // A household with nobody else left in it carries their surname: rename it.
      if (p.householdId) {
        const others = await db.selectFrom("people").select("id")
          .where("churchId", "=", p.churchId).where("householdId", "=", p.householdId).where("id", "!=", p.id)
          .where((eb: any) => eb.or([eb("removed", "=", false), eb("removed", "is", null)]))
          .limit(1).execute();
        if (!others.length) add("households(anonymized)", n(await db.updateTable("households").set({ name: DELETED_NAME }).where("churchId", "=", p.churchId).where("id", "=", p.householdId).execute()));
      }
    }
  }
}
