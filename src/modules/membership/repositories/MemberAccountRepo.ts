import { injectable } from "inversify";
import { sql } from "kysely";
import { getDb } from "../db/index.js";
import { UniqueIdHelper } from "@churchapps/apihelper";
import { DateHelper } from "../helpers/index.js";

/**
 * Data access for the member side of the church platform (Mary Banks ID sign-in, My Church,
 * verified extra emails). Kept apart from the stock repos so the upstream files stay untouched.
 * Every query that reads people is tenancy-filtered on churchId first.
 */

export interface EmailCodeRow {
  id: string;
  userId: string;
  email: string;
  codeHash: string;
  salt: string;
  attempts: number;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
}

export interface MatchedPersonRow {
  id: string;
  churchId: string;
  displayName: string;
  firstName: string;
  lastName: string;
  email: string;
  campusId: string | null;
  userId: string | null;
}

@injectable()
export class MemberAccountRepo {
  // ── Mary Banks ID link on users ──
  public async loadUserByMbidSub(sub: string): Promise<any | null> {
    if (!sub) return null;
    return (await getDb().selectFrom("users").selectAll().where("mbidSub" as any, "=", sub).executeTakeFirst()) ?? null;
  }

  public async loadMbidSub(userId: string): Promise<string | null> {
    const row: any = await getDb().selectFrom("users").select("mbidSub" as any).where("id", "=", userId).executeTakeFirst();
    return row?.mbidSub || null;
  }

  public async setMbidSub(userId: string, sub: string): Promise<void> {
    await getDb().updateTable("users").set({ mbidSub: sub } as any).where("id", "=", userId).execute();
  }

  // ── People matching ──
  /** Non-removed people in the church whose email equals one of `emails` (case-insensitive). */
  public async findPeopleByEmails(churchId: string, emails: string[]): Promise<MatchedPersonRow[]> {
    const list = [...new Set(emails.map((e) => (e || "").trim().toLowerCase()).filter(Boolean))];
    if (!churchId || list.length === 0) return [];
    const rows = await getDb().selectFrom("people")
      .select([
        "id", "churchId", "displayName", "firstName", "lastName", "email", "campusId", "userId"
      ] as any)
      .where("churchId", "=", churchId)
      .where(sql<boolean>`LOWER(TRIM(email)) IN (${sql.join(list)})`)
      .where((eb) => eb.or([eb("removed", "=", false as any), eb("removed", "is", null)]))
      .limit(50)
      .execute();
    return rows as any;
  }

  /** Every user id that holds this person: userChurches rows plus people.userId. */
  public async loadLinkedUserIds(churchId: string, personId: string): Promise<string[]> {
    const ucs = await getDb().selectFrom("userChurches").select("userId").where("churchId", "=", churchId).where("personId", "=", personId).execute();
    const p: any = await getDb().selectFrom("people").select("userId" as any).where("churchId", "=", churchId).where("id", "=", personId).executeTakeFirst();
    const ids = new Set<string>();
    ucs.forEach((r: any) => { if (r.userId) ids.add(r.userId); });
    if (p?.userId) ids.add(p.userId);
    return [...ids];
  }

  public async loadUserChurch(userId: string, churchId: string): Promise<any | null> {
    return (await getDb().selectFrom("userChurches").selectAll().where("userId", "=", userId).where("churchId", "=", churchId).executeTakeFirst()) ?? null;
  }

  /** Ensure a userChurches row exists (personId untouched when it already exists). */
  public async ensureUserChurch(userId: string, churchId: string): Promise<any> {
    const existing = await this.loadUserChurch(userId, churchId);
    if (existing) return existing;
    const row = { id: UniqueIdHelper.shortId(), userId, churchId, personId: null as any, lastAccessed: DateHelper.toMysqlDate(new Date()) as any };
    await getDb().insertInto("userChurches").values(row).execute();
    return row;
  }

  /** Link a person to a user: userChurches.personId (created if missing) and people.userId. */
  public async linkPerson(churchId: string, userId: string, personId: string): Promise<void> {
    const uc = await this.ensureUserChurch(userId, churchId);
    await getDb().updateTable("userChurches").set({ personId }).where("id", "=", uc.id).where("churchId", "=", churchId).execute();
    await getDb().updateTable("people").set({ userId } as any).where("id", "=", personId).where("churchId", "=", churchId).execute();
  }

  /** Targeted update of the member-editable columns only. */
  public async updatePersonFields(churchId: string, personId: string, fields: Record<string, any>): Promise<void> {
    if (Object.keys(fields).length === 0) return;
    await getDb().updateTable("people").set(fields as any).where("id", "=", personId).where("churchId", "=", churchId).execute();
  }

  // ── Own submissions ──
  public async loadSubmissionsForEmails(churchId: string, emails: string[], excludeTypes: string[]): Promise<any[]> {
    const list = [...new Set(emails.map((e) => (e || "").trim().toLowerCase()).filter(Boolean))];
    if (!churchId || list.length === 0) return [];
    let q = getDb().selectFrom("formSubmissions")
      .select(["id", "campusId", "submissionType", "submissionDate", "message", "unread"])
      .where("churchId", "=", churchId)
      .where("submissionType", "is not", null as any)
      .where(sql<boolean>`LOWER(TRIM(submitterEmail)) IN (${sql.join(list)})`);
    if (excludeTypes.length > 0) q = q.where("submissionType", "not in", excludeTypes as any);
    return q.orderBy("submissionDate", "desc").limit(50).execute();
  }

  // ── Email verification codes ──
  public async countCodesSince(userId: string, since: Date): Promise<number> {
    const row: any = await getDb().selectFrom("emailVerificationCodes" as any)
      .select(sql`COUNT(*)`.as("n"))
      .where("userId" as any, "=", userId)
      .where("createdAt" as any, ">=", DateHelper.toMysqlDate(since) as any)
      .executeTakeFirst();
    return parseInt(row?.n ?? "0", 10);
  }

  public async insertCode(row: Omit<EmailCodeRow, "id" | "attempts" | "consumedAt" | "createdAt">): Promise<string> {
    const id = UniqueIdHelper.shortId();
    // A new code replaces any earlier open code for the same address.
    await getDb().updateTable("emailVerificationCodes" as any)
      .set({ consumedAt: DateHelper.toMysqlDate(new Date()) } as any)
      .where("userId" as any, "=", row.userId).where("email" as any, "=", row.email).where("consumedAt" as any, "is", null)
      .execute();
    await getDb().insertInto("emailVerificationCodes" as any).values({
      id,
      userId: row.userId,
      email: row.email,
      codeHash: row.codeHash,
      salt: row.salt,
      attempts: 0,
      expiresAt: DateHelper.toMysqlDate(row.expiresAt),
      consumedAt: null,
      createdAt: DateHelper.toMysqlDate(new Date())
    } as any).execute();
    return id;
  }

  /** The newest code sent to this user for this address (open or not). */
  public async loadLatestCode(userId: string, email: string): Promise<EmailCodeRow | null> {
    const row: any = await getDb().selectFrom("emailVerificationCodes" as any).selectAll()
      .where("userId" as any, "=", userId).where("email" as any, "=", email)
      .orderBy("createdAt" as any, "desc").orderBy("id" as any, "desc")
      .executeTakeFirst();
    if (!row) return null;
    return { ...row, attempts: Number(row.attempts || 0), expiresAt: new Date(row.expiresAt), consumedAt: row.consumedAt ? new Date(row.consumedAt) : null, createdAt: new Date(row.createdAt) };
  }

  public async incrementCodeAttempts(id: string): Promise<void> {
    await getDb().updateTable("emailVerificationCodes" as any).set({ attempts: sql`attempts + 1` } as any).where("id" as any, "=", id).execute();
  }

  public async consumeCode(id: string): Promise<void> {
    await getDb().updateTable("emailVerificationCodes" as any).set({ consumedAt: DateHelper.toMysqlDate(new Date()) } as any).where("id" as any, "=", id).execute();
  }
}
