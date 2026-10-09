import { injectable } from "inversify";
import { sql } from "kysely";
import { getDb } from "../db/index.js";
import { UniqueIdHelper } from "@churchapps/apihelper";
import { DateHelper } from "../helpers/index.js";

/** Data access for the CRM event planner (migration 2026-10-09_crmEvents). churchId first, always. */

const db = () => getDb() as any;
const now = () => DateHelper.toMysqlDate(new Date()) as any;
const JSON_COLS = ["topics", "speakers", "page", "questions", "answers", "audience"];

export function parseRow<T = any>(row: any): T {
  if (!row) return row;
  const out: any = { ...row };
  for (const c of JSON_COLS) if (typeof out[c] === "string") { try { out[c] = JSON.parse(out[c]); } catch { out[c] = null; } }
  for (const c of ["registrationOpen", "contactConsent", "enabled"]) if (c in out) out[c] = !!Number(out[c]);
  return out;
}

function toDb(fields: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    if (JSON_COLS.includes(k)) out[k] = v === null ? null : JSON.stringify(v);
    else if (v instanceof Date) out[k] = DateHelper.toMysqlDate(v);
    else if (typeof v === "boolean") out[k] = v ? 1 : 0;
    else out[k] = v;
  }
  return out;
}

@injectable()
export class CrmEventRepo {
  // ── events ──
  public async list(churchId: string): Promise<any[]> {
    const rows = await sql<any>`SELECT e.*, (SELECT COUNT(*) FROM crmEventRegistrations r WHERE r.eventId = e.id AND r.status <> 'cancelled') AS registrations
      FROM crmEvents e WHERE e.churchId = ${churchId} ORDER BY COALESCE(e.startsAt, e.createdAt) DESC`.execute(getDb());
    return rows.rows.map((r: any) => ({ ...parseRow(r), registrations: Number(r.registrations || 0) }));
  }

  public async load(churchId: string, id: string): Promise<any | null> {
    return parseRow(await db().selectFrom("crmEvents").selectAll().where("churchId", "=", churchId).where("id", "=", id).executeTakeFirst()) ?? null;
  }

  public async loadBySlug(churchId: string, slug: string): Promise<any | null> {
    return parseRow(await db().selectFrom("crmEvents").selectAll().where("churchId", "=", churchId).where("slug", "=", slug).executeTakeFirst()) ?? null;
  }

  public async slugTaken(churchId: string, slug: string, exceptId?: string): Promise<boolean> {
    let q = db().selectFrom("crmEvents").select("id").where("churchId", "=", churchId).where("slug", "=", slug);
    if (exceptId) q = q.where("id", "!=", exceptId);
    return !!(await q.executeTakeFirst());
  }

  public async create(churchId: string, fields: Record<string, any>): Promise<string> {
    const id = UniqueIdHelper.shortId();
    await db().insertInto("crmEvents").values({ id, churchId, ...toDb(fields), createdAt: now(), updatedAt: now() }).execute();
    return id;
  }

  public async update(churchId: string, id: string, fields: Record<string, any>): Promise<void> {
    await db().updateTable("crmEvents").set({ ...toDb(fields), updatedAt: now() }).where("churchId", "=", churchId).where("id", "=", id).execute();
  }

  public async remove(churchId: string, id: string): Promise<void> {
    const emails = await db().selectFrom("crmEventEmails").select("id").where("churchId", "=", churchId).where("eventId", "=", id).execute();
    if (emails.length) await db().deleteFrom("crmEventEmailSends").where("emailId", "in", emails.map((e: any) => e.id)).execute();
    await db().deleteFrom("crmEventEmails").where("churchId", "=", churchId).where("eventId", "=", id).execute();
    await db().deleteFrom("crmEventRegistrations").where("churchId", "=", churchId).where("eventId", "=", id).execute();
    await db().deleteFrom("crmEvents").where("churchId", "=", churchId).where("id", "=", id).execute();
  }

  // ── registrations ──
  public async registrations(churchId: string, eventId: string): Promise<any[]> {
    const rows = await db().selectFrom("crmEventRegistrations").selectAll().where("churchId", "=", churchId).where("eventId", "=", eventId).orderBy("createdAt", "desc").execute();
    return rows.map(parseRow);
  }

  public async registrationByEmail(eventId: string, email: string): Promise<any | null> {
    return parseRow(await db().selectFrom("crmEventRegistrations").selectAll().where("eventId", "=", eventId).where("email", "=", email).executeTakeFirst()) ?? null;
  }

  public async loadRegistration(churchId: string, id: string): Promise<any | null> {
    return parseRow(await db().selectFrom("crmEventRegistrations").selectAll().where("churchId", "=", churchId).where("id", "=", id).executeTakeFirst()) ?? null;
  }

  public async countRegistrations(eventId: string): Promise<number> {
    const r = await db().selectFrom("crmEventRegistrations").select(sql<number>`COUNT(*)`.as("n")).where("eventId", "=", eventId).where("status", "!=", "cancelled").executeTakeFirst();
    return Number(r?.n || 0);
  }

  public async saveRegistration(churchId: string, fields: Record<string, any>, id?: string): Promise<string> {
    if (id) {
      await db().updateTable("crmEventRegistrations").set(toDb(fields)).where("churchId", "=", churchId).where("id", "=", id).execute();
      return id;
    }
    const newId = UniqueIdHelper.shortId();
    await db().insertInto("crmEventRegistrations").values({ id: newId, churchId, ...toDb(fields), createdAt: now() }).execute();
    return newId;
  }

  public async setRegistrationStatus(churchId: string, id: string, status: string): Promise<void> {
    await db().updateTable("crmEventRegistrations").set({ status }).where("churchId", "=", churchId).where("id", "=", id).execute();
  }

  /** Time zones of an event's registrants, most common first. */
  public async registrantZones(churchId: string, eventId: string): Promise<{ timezone: string; people: number }[]> {
    const r = await sql<any>`SELECT timezone, COUNT(*) AS n FROM crmEventRegistrations WHERE churchId = ${churchId} AND eventId = ${eventId}
      AND status <> 'cancelled' AND timezone IS NOT NULL GROUP BY timezone ORDER BY n DESC`.execute(getDb());
    return r.rows.map((x: any) => ({ timezone: x.timezone, people: Number(x.n) }));
  }

  // ── emails ──
  public async emails(churchId: string, eventId: string): Promise<any[]> {
    const rows = await db().selectFrom("crmEventEmails").selectAll().where("churchId", "=", churchId).where("eventId", "=", eventId).orderBy("createdAt").execute();
    return rows.map(parseRow);
  }

  public async loadEmail(churchId: string, id: string): Promise<any | null> {
    return parseRow(await db().selectFrom("crmEventEmails").selectAll().where("churchId", "=", churchId).where("id", "=", id).executeTakeFirst()) ?? null;
  }

  public async saveEmail(churchId: string, fields: Record<string, any>, id?: string): Promise<string> {
    if (id) {
      await db().updateTable("crmEventEmails").set({ ...toDb(fields), updatedAt: now() }).where("churchId", "=", churchId).where("id", "=", id).execute();
      return id;
    }
    const newId = UniqueIdHelper.shortId();
    await db().insertInto("crmEventEmails").values({ id: newId, churchId, ...toDb(fields), createdAt: now(), updatedAt: now() }).execute();
    return newId;
  }

  public async removeEmail(churchId: string, id: string): Promise<void> {
    await db().deleteFrom("crmEventEmailSends").where("emailId", "=", id).execute();
    await db().deleteFrom("crmEventEmails").where("churchId", "=", churchId).where("id", "=", id).execute();
  }

  /** Every enabled email of every published event, with its event (for the scheduler). */
  public async activeEmails(): Promise<any[]> {
    const rows = await sql<any>`SELECT m.*, e.startsAt AS eventStartsAt, e.endsAt AS eventEndsAt, e.status AS eventStatus
      FROM crmEventEmails m JOIN crmEvents e ON e.id = m.eventId
      WHERE m.enabled = 1 AND e.status IN ('published', 'closed')`.execute(getDb());
    return rows.rows.map(parseRow);
  }

  /** Claim a send slot; false when this recipient already got this email. */
  public async claimSend(churchId: string, emailId: string, recipientKey: string): Promise<boolean> {
    const r: any = await sql`INSERT IGNORE INTO crmEventEmailSends (emailId, recipientKey, churchId, status, sentAt) VALUES (${emailId}, ${recipientKey}, ${churchId}, 'sending', ${now()})`.execute(getDb());
    return Number(r?.numAffectedRows ?? 0) > 0;
  }

  public async finishSend(emailId: string, recipientKey: string, ok: boolean, error?: string): Promise<void> {
    await db().updateTable("crmEventEmailSends").set({ status: ok ? "sent" : "failed", error: error ? error.slice(0, 300) : null }).where("emailId", "=", emailId).where("recipientKey", "=", recipientKey).execute();
  }

  public async markEmailSent(churchId: string, id: string, count: number): Promise<void> {
    await sql`UPDATE crmEventEmails SET sentAt = COALESCE(sentAt, ${now()}), sentCount = sentCount + ${count} WHERE churchId = ${churchId} AND id = ${id}`.execute(getDb());
  }

  public async sendStats(emailIds: string[]): Promise<Record<string, { sent: number; failed: number }>> {
    if (!emailIds.length) return {};
    const r = await sql<any>`SELECT emailId, SUM(status = 'sent') AS sent, SUM(status = 'failed') AS failed FROM crmEventEmailSends WHERE emailId IN (${sql.join(emailIds)}) GROUP BY emailId`.execute(getDb());
    const out: Record<string, { sent: number; failed: number }> = {};
    r.rows.forEach((x: any) => { out[x.emailId] = { sent: Number(x.sent || 0), failed: Number(x.failed || 0) }; });
    return out;
  }
}
