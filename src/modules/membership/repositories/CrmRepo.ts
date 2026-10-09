import { injectable } from "inversify";
import { sql } from "kysely";
import { getDb } from "../db/index.js";
import { UniqueIdHelper } from "@churchapps/apihelper";
import { DateHelper } from "../helpers/index.js";

/**
 * Data access for the ministry-wide CRM (migration 2026-10-08_crm). Kept apart from the stock repos
 * like MemberAccountRepo. Every query is tenancy-filtered on churchId first.
 */

export interface CrmProfileRow {
  personId: string;
  churchId: string;
  country: string | null;
  countryCode: string | null;
  region: string | null;
  city: string | null;
  timezone: string | null;
  languages: string | null;
  ministryRole: string | null;
  organization: string | null;
  contactConsent: "yes" | "no" | "unknown";
  consentSource: string | null;
  consentAt: Date | null;
  summary: string | null;
  summaryUpdatedAt: Date | null;
  mbidCreatedAt: Date | null;
  mbidRemovedAt: Date | null;
  lastActiveAt: Date | null;
  activitySyncedAt: Date | null;
  updatedAt: Date;
}

export const PROFILE_FIELDS = [
  "country", "countryCode", "region", "city", "timezone", "languages", "ministryRole", "organization"
] as const;

export interface ActivityInput {
  site: string;
  type: string;
  refKey: string;
  title: string;
  detail?: string | null;
  url?: string | null;
  occurredAt: Date;
}

const db = () => getDb() as any;
const now = () => DateHelper.toMysqlDate(new Date()) as any;
const clip = (s: any, n: number) => (s === null || s === undefined ? null : String(s).slice(0, n));

@injectable()
export class CrmRepo {
  // ── people lookups ──
  public async loadPersonByMbidSub(churchId: string, sub: string): Promise<any | null> {
    if (!sub) return null;
    return (await db().selectFrom("people").selectAll().where("churchId", "=", churchId).where("mbidSub", "=", sub).executeTakeFirst()) ?? null;
  }

  /** Every (non-removed) person's id, mbidSub, email: the sync's in-memory index. */
  public async loadPeopleIndex(churchId: string): Promise<{ id: string; mbidSub: string | null; email: string | null; userId: string | null; removed: any }[]> {
    return db().selectFrom("people").select(["id", "mbidSub", "email", "userId", "removed"]).where("churchId", "=", churchId).execute();
  }

  public async setPersonMbidSub(churchId: string, personId: string, sub: string, source?: string): Promise<void> {
    const set: any = { mbidSub: sub };
    if (source) set.source = source;
    await db().updateTable("people").set(set).where("churchId", "=", churchId).where("id", "=", personId).execute();
  }

  public async setPersonSource(churchId: string, personId: string, source: string): Promise<void> {
    await db().updateTable("people").set({ source }).where("churchId", "=", churchId).where("id", "=", personId).where("source", "is", null).execute();
  }

  // ── profiles ──
  public async loadProfile(churchId: string, personId: string): Promise<CrmProfileRow | null> {
    return (await db().selectFrom("crmProfiles").selectAll().where("churchId", "=", churchId).where("personId", "=", personId).executeTakeFirst()) ?? null;
  }

  public async loadProfiles(churchId: string, personIds: string[]): Promise<CrmProfileRow[]> {
    if (!personIds.length) return [];
    return db().selectFrom("crmProfiles").selectAll().where("churchId", "=", churchId).where("personId", "in", personIds).execute();
  }

  /** Insert-or-update the given columns only (others keep their values). */
  public async upsertProfile(churchId: string, personId: string, fields: Record<string, any>): Promise<void> {
    const clean: Record<string, any> = {};
    for (const [k, v] of Object.entries(fields)) if (v !== undefined) clean[k] = v instanceof Date ? DateHelper.toMysqlDate(v) : v;
    clean.updatedAt = now();
    const existing = await db().selectFrom("crmProfiles").select("personId").where("personId", "=", personId).executeTakeFirst();
    if (existing) await db().updateTable("crmProfiles").set(clean).where("churchId", "=", churchId).where("personId", "=", personId).execute();
    else await db().insertInto("crmProfiles").values({ personId, churchId, contactConsent: "unknown", ...clean }).execute();
  }

  // ── notes + facts ──
  public async addNote(churchId: string, personId: string, note: { kind: string; body: string | null; images?: string[]; extracted?: any; addedBy?: string | null; addedByName?: string | null }): Promise<string> {
    const id = UniqueIdHelper.shortId();
    await db().insertInto("crmNotes").values({
      id,
      churchId,
      personId,
      kind: note.kind,
      body: note.body,
      images: note.images?.length ? JSON.stringify(note.images) : null,
      extracted: note.extracted ? JSON.stringify(note.extracted) : null,
      addedBy: note.addedBy || null,
      addedByName: clip(note.addedByName, 100),
      createdAt: now()
    }).execute();
    return id;
  }

  public async loadNotes(churchId: string, personId: string, limit = 200): Promise<any[]> {
    return db().selectFrom("crmNotes").selectAll().where("churchId", "=", churchId).where("personId", "=", personId).orderBy("createdAt", "desc").limit(limit).execute();
  }

  public async deleteNote(churchId: string, id: string): Promise<void> {
    await db().deleteFrom("crmFacts").where("churchId", "=", churchId).where("noteId", "=", id).execute();
    await db().deleteFrom("crmNotes").where("churchId", "=", churchId).where("id", "=", id).execute();
  }

  public async addFact(churchId: string, personId: string, kind: string, text: string, noteId: string | null): Promise<string> {
    const id = UniqueIdHelper.shortId();
    await db().insertInto("crmFacts").values({ id, churchId, personId, kind, text: clip(text, 1000), noteId, status: "open", createdAt: now() }).execute();
    return id;
  }

  public async loadFacts(churchId: string, personId: string): Promise<any[]> {
    return db().selectFrom("crmFacts").selectAll().where("churchId", "=", churchId).where("personId", "=", personId).orderBy("createdAt", "desc").execute();
  }

  public async setFactStatus(churchId: string, id: string, status: "open" | "done"): Promise<void> {
    await db().updateTable("crmFacts").set({ status, resolvedAt: status === "done" ? now() : null }).where("churchId", "=", churchId).where("id", "=", id).execute();
  }

  public async deleteFact(churchId: string, id: string): Promise<void> {
    await db().deleteFrom("crmFacts").where("churchId", "=", churchId).where("id", "=", id).execute();
  }

  // ── tags ──
  public async loadTags(churchId: string): Promise<any[]> {
    return db().selectFrom("crmTags as t")
      .leftJoin("crmPersonTags as pt", (j: any) => j.onRef("pt.tagId", "=", "t.id").onRef("pt.churchId", "=", "t.churchId"))
      .select(["t.id", "t.name", "t.color", sql<number>`COUNT(pt.personId)`.as("people")])
      .where("t.churchId", "=", churchId)
      .groupBy(["t.id", "t.name", "t.color"])
      .orderBy("t.name")
      .execute();
  }

  public async ensureTag(churchId: string, name: string): Promise<string> {
    const clean = name.trim().slice(0, 60);
    const existing = await db().selectFrom("crmTags").select("id").where("churchId", "=", churchId).where("name", "=", clean).executeTakeFirst();
    if (existing) return existing.id;
    const id = UniqueIdHelper.shortId();
    await db().insertInto("crmTags").values({ id, churchId, name: clean, color: null }).execute();
    return id;
  }

  public async loadPersonTags(churchId: string, personId: string): Promise<{ id: string; name: string }[]> {
    return db().selectFrom("crmPersonTags as pt").innerJoin("crmTags as t", "t.id", "pt.tagId")
      .select(["t.id", "t.name"]).where("pt.churchId", "=", churchId).where("pt.personId", "=", personId).orderBy("t.name").execute();
  }

  public async tagPerson(churchId: string, personId: string, tagId: string): Promise<void> {
    await sql`INSERT IGNORE INTO crmPersonTags (churchId, personId, tagId, createdAt) VALUES (${churchId}, ${personId}, ${tagId}, ${now()})`.execute(getDb());
  }

  public async untagPerson(churchId: string, personId: string, tagId: string): Promise<void> {
    await db().deleteFrom("crmPersonTags").where("churchId", "=", churchId).where("personId", "=", personId).where("tagId", "=", tagId).execute();
  }

  public async deleteTag(churchId: string, tagId: string): Promise<void> {
    await db().deleteFrom("crmPersonTags").where("churchId", "=", churchId).where("tagId", "=", tagId).execute();
    await db().deleteFrom("crmTags").where("churchId", "=", churchId).where("id", "=", tagId).execute();
  }

  // ── activities ──
  /** Upsert by (person, site, type, refKey); returns how many rows were new or changed. */
  public async upsertActivities(churchId: string, personId: string, items: ActivityInput[]): Promise<number> {
    let changed = 0;
    for (const a of items) {
      const res: any = await sql`INSERT INTO crmActivities (id, churchId, personId, site, type, refKey, title, detail, url, occurredAt)
        VALUES (${UniqueIdHelper.shortId()}, ${churchId}, ${personId}, ${clip(a.site, 30)}, ${clip(a.type, 40)}, ${clip(a.refKey, 150)}, ${clip(a.title, 300) || "(untitled)"},
                ${clip(a.detail, 500)}, ${clip(a.url, 500)}, ${DateHelper.toMysqlDate(a.occurredAt)})
        ON DUPLICATE KEY UPDATE title = VALUES(title), detail = VALUES(detail), url = VALUES(url), occurredAt = VALUES(occurredAt)`.execute(getDb());
      // MySQL: 1 = inserted, 2 = updated, 0 = unchanged.
      if (Number(res?.numAffectedRows ?? res?.numChangedRows ?? 0) > 0) changed++;
    }
    return changed;
  }

  public async loadActivities(churchId: string, personId: string, limit = 300): Promise<any[]> {
    return db().selectFrom("crmActivities").selectAll().where("churchId", "=", churchId).where("personId", "=", personId).orderBy("occurredAt", "desc").limit(limit).execute();
  }

  public async refreshLastActive(churchId: string, personId: string): Promise<void> {
    await sql`UPDATE crmProfiles SET lastActiveAt = (SELECT MAX(occurredAt) FROM crmActivities WHERE churchId = ${churchId} AND personId = ${personId}), activitySyncedAt = ${now()}
      WHERE churchId = ${churchId} AND personId = ${personId}`.execute(getDb());
  }

  // ── sync state ──
  public async getState(name: string): Promise<string | null> {
    const row = await db().selectFrom("crmSyncState").select("value").where("name", "=", name).executeTakeFirst();
    return row?.value ?? null;
  }

  public async setState(name: string, value: string): Promise<void> {
    await sql`INSERT INTO crmSyncState (name, value, updatedAt) VALUES (${name}, ${value}, ${now()}) ON DUPLICATE KEY UPDATE value = VALUES(value), updatedAt = VALUES(updatedAt)`.execute(getDb());
  }

  // ── list / search ──
  public async search(churchId: string, f: { q?: string; status?: string; source?: string; countryCode?: string; tagId?: string; consent?: string; campusIds?: string[] | null; limit?: number; offset?: number }): Promise<{ rows: any[]; total: number }> {
    let q = db().selectFrom("people as p")
      .leftJoin("crmProfiles as c", (j: any) => j.onRef("c.personId", "=", "p.id"))
      .where("p.churchId", "=", churchId)
      .where((eb: any) => eb.or([eb("p.removed", "=", false), eb("p.removed", "is", null)]));
    if (f.campusIds) q = f.campusIds.length ? q.where("p.campusId", "in", f.campusIds) : q.where(sql`1 = 0`);
    if (f.status) q = q.where("p.membershipStatus", "=", f.status);
    if (f.source === "mbid") q = q.where("p.mbidSub", "is not", null);
    else if (f.source === "church") q = q.where("p.source", "is", null);
    else if (f.source) q = q.where("p.source", "=", f.source);
    if (f.countryCode) q = q.where("c.countryCode", "=", f.countryCode);
    if (f.consent) q = q.where("c.contactConsent", "=", f.consent);
    if (f.tagId) q = q.where("p.id", "in", db().selectFrom("crmPersonTags").select("personId").where("churchId", "=", churchId).where("tagId", "=", f.tagId));
    if (f.q && f.q.trim()) {
      const like = "%" + f.q.trim().replace(/[%_]/g, "") + "%";
      q = q.where((eb: any) => eb.or([
        eb("p.displayName", "like", like),
        eb("p.email", "like", like),
        eb("p.mobilePhone", "like", like),
        eb("c.country", "like", like),
        eb("c.city", "like", like),
        eb("c.organization", "like", like),
        eb("c.ministryRole", "like", like)
      ]));
    }
    const totalRow = await q.select(sql<number>`COUNT(*)`.as("n")).executeTakeFirst();
    const rows = await q.select([
      "p.id",
      "p.displayName",
      "p.firstName",
      "p.lastName",
      "p.email",
      "p.mobilePhone",
      "p.membershipStatus",
      "p.campusId",
      "p.mbidSub",
      "p.source",
      "p.photoUpdated",
      "p.dateAdded",
      "c.country",
      "c.countryCode",
      "c.city",
      "c.timezone",
      "c.languages",
      "c.ministryRole",
      "c.organization",
      "c.contactConsent",
      "c.lastActiveAt",
      "c.mbidCreatedAt"
    ])
      .orderBy(sql`COALESCE(c.lastActiveAt, c.mbidCreatedAt, p.dateAdded)`, "desc")
      .limit(Math.min(f.limit || 50, 5000)).offset(f.offset || 0)
      .execute();
    return { rows, total: Number(totalRow?.n || 0) };
  }

  /** Counts for the CRM home: totals by status/source/consent and the top countries. */
  public async stats(churchId: string): Promise<any> {
    const r = await sql<any>`SELECT
        COUNT(*) AS total,
        SUM(p.mbidSub IS NOT NULL) AS withMbid,
        SUM(p.membershipStatus = 'Contact') AS contacts,
        SUM(p.membershipStatus = 'Member') AS members,
        SUM(c.contactConsent = 'yes') AS consentYes,
        SUM(p.dateAdded >= NOW() - INTERVAL 30 DAY) AS newLast30
      FROM people p LEFT JOIN crmProfiles c ON c.personId = p.id
      WHERE p.churchId = ${churchId} AND (p.removed = 0 OR p.removed IS NULL)`.execute(getDb());
    const countries = await sql<any>`SELECT c.countryCode, MAX(c.country) AS country, COUNT(*) AS n FROM crmProfiles c
      JOIN people p ON p.id = c.personId AND (p.removed = 0 OR p.removed IS NULL)
      WHERE c.churchId = ${churchId} AND c.countryCode IS NOT NULL GROUP BY c.countryCode ORDER BY n DESC LIMIT 40`.execute(getDb());
    const zones = await sql<any>`SELECT c.timezone, COUNT(*) AS n FROM crmProfiles c
      JOIN people p ON p.id = c.personId AND (p.removed = 0 OR p.removed IS NULL)
      WHERE c.churchId = ${churchId} AND c.timezone IS NOT NULL GROUP BY c.timezone ORDER BY n DESC LIMIT 40`.execute(getDb());
    const row = r.rows[0] || {};
    const num = (v: any) => Number(v || 0);
    return {
      total: num(row.total),
      withMbid: num(row.withMbid),
      contacts: num(row.contacts),
      members: num(row.members),
      consentYes: num(row.consentYes),
      newLast30: num(row.newLast30),
      countries: countries.rows.map((c: any) => ({ countryCode: c.countryCode, country: c.country, people: num(c.n) })),
      timezones: zones.rows.map((z: any) => ({ timezone: z.timezone, people: num(z.n) }))
    };
  }

  /**
   * "Ask the CRM" search: every word must match somewhere about the person (name, contact, place,
   * ministry, tags, facts, notes, activity titles). Returns up to 25 people, most recently active first.
   */
  public async aiSearch(churchId: string, words: string[]): Promise<any[]> {
    if (!words.length) return [];
    const conds = words.map((w) => {
      const like = "%" + w.replace(/[%_\\]/g, "") + "%";
      return sql`(
        p.displayName LIKE ${like} OR p.email LIKE ${like} OR p.mobilePhone LIKE ${like} OR p.homePhone LIKE ${like} OR p.membershipStatus LIKE ${like}
        OR c.country LIKE ${like} OR c.countryCode = ${w.toUpperCase().slice(0, 2)} AND LENGTH(${w}) = 2 OR c.city LIKE ${like} OR c.region LIKE ${like}
        OR c.organization LIKE ${like} OR c.ministryRole LIKE ${like} OR c.languages LIKE ${like} OR c.summary LIKE ${like}
        OR EXISTS (SELECT 1 FROM crmPersonTags pt JOIN crmTags t ON t.id = pt.tagId WHERE pt.churchId = p.churchId AND pt.personId = p.id AND t.name LIKE ${like})
        OR EXISTS (SELECT 1 FROM crmFacts f WHERE f.churchId = p.churchId AND f.personId = p.id AND f.text LIKE ${like})
        OR EXISTS (SELECT 1 FROM crmNotes n WHERE n.churchId = p.churchId AND n.personId = p.id AND n.body LIKE ${like})
        OR EXISTS (SELECT 1 FROM crmActivities a WHERE a.churchId = p.churchId AND a.personId = p.id AND a.title LIKE ${like})
      )`;
    });
    const first = "%" + words[0].replace(/[%_\\]/g, "") + "%";
    const res = await sql<any>`SELECT p.id, p.displayName, p.firstName, p.lastName, p.email, p.mobilePhone, p.membershipStatus,
        c.country, c.countryCode, c.city, c.ministryRole, c.organization,
        (SELECT GROUP_CONCAT(t.name SEPARATOR ', ') FROM crmPersonTags pt JOIN crmTags t ON t.id = pt.tagId WHERE pt.churchId = p.churchId AND pt.personId = p.id) AS tags,
        (SELECT CONCAT(f.kind, ': ', LEFT(f.text, 160)) FROM crmFacts f WHERE f.churchId = p.churchId AND f.personId = p.id AND f.text LIKE ${first} ORDER BY f.createdAt DESC LIMIT 1) AS hit
      FROM people p LEFT JOIN crmProfiles c ON c.personId = p.id
      WHERE p.churchId = ${churchId} AND (p.removed = 0 OR p.removed IS NULL) AND ${sql.join(conds, sql` AND `)}
      ORDER BY COALESCE(c.lastActiveAt, c.updatedAt, p.dateAdded) DESC
      LIMIT 25`.execute(getDb());
    return res.rows;
  }
}
