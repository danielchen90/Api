import pg from "pg";
import { Repos } from "../../repositories/Repos.js";
import { ActivityInput } from "../../repositories/CrmRepo.js";
import { CrmConfig } from "./CrmConfig.js";
import { CrmPeople, normEmail } from "./CrmPeople.js";

/**
 * Pulls what each person did on the other Mary Banks sites into crmActivities, read-only, straight
 * from each site's own Postgres. Runs every 30 minutes (RailwayCron) and incrementally: each source
 * keeps a cursor in crmSyncState and re-reads a 10-minute overlap so late commits are not missed.
 *
 *   gtc          GTC courses (enrollments + progress) and certificates   key: users.keycloakSub / email
 *   library      Faith Library books read + audiobooks heard              key: user_email
 *   church       Global Church prayer requests, next steps, E-Groups      key: subject (sub) / email
 *   theater      Bible Theater videos watched                             key: user_sub
 *   askmary      Ask Mary conversation TOPICS (the title only, never the  key: keycloakSub
 *                chat text), and only for people who allowed personalization (Dr. Banks'
 *                confidentiality rule, 2026-09-03: admins never see Ask Mary conversations).
 *
 * A source whose connection string is not set is skipped. Rows that match no person are dropped,
 * except Global Church next steps and prayer requests, which are people reaching out to the church:
 * those create a CRM contact (source globalchurch) when they left an email.
 */

type Row = { sub?: string | null; email?: string | null; name?: string | null; activity: ActivityInput; createIfMissing?: boolean };
type Source = { name: string; env: string; query: (db: pg.Pool, since: Date) => Promise<Row[]> };

const OVERLAP_MS = 10 * 60_000;
const LIBRARY = process.env.CRM_LIBRARY_URL || "https://new.mbfaithlibrary.com";
const THEATER = process.env.CRM_THEATER_URL || "https://theater.mbmonline.global";
const pct = (n: any) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));

const SOURCES: Source[] = [
  {
    name: "gtc",
    env: "CRM_SRC_GTC_URL",
    query: async (db, since) => {
      const out: Row[] = [];
      const enr = await db.query(
        `SELECT e.id, e.progress, e.completed, e."completionDate", e."enrollmentDate", e."lastAccessedAt", e."updatedAt", c.id AS "courseId", c.title, u."keycloakSub", u.email
           FROM enrollments e JOIN course_offerings o ON o.id = e."courseOfferingId" JOIN courses c ON c.id = o."courseId" JOIN users u ON u.id = e."userId"
          WHERE e."updatedAt" >= $1`, [since]
      );
      for (const r of enr.rows) {
        const done = !!r.completed;
        out.push({
          sub: r.keycloakSub,
          email: r.email,
          activity: {
            site: "gtc",
            type: done ? "course_completed" : "course",
            refKey: "enrollment:" + r.id,
            title: r.title,
            detail: done ? "Completed" : `${pct(r.progress)}% through`,
            occurredAt: new Date(r.completionDate || r.lastAccessedAt || r.enrollmentDate || r.updatedAt)
          }
        });
      }
      const certs = await db.query(
        `SELECT ce.id, ce.title, ce."issuedDate", ce."updatedAt", c.title AS course, u."keycloakSub", u.email
           FROM certificates ce JOIN users u ON u.id = ce."userId" LEFT JOIN courses c ON c.id = ce."courseId"
          WHERE ce."updatedAt" >= $1 AND ce."revokedDate" IS NULL`, [since]
      );
      for (const r of certs.rows) {
        out.push({ sub: r.keycloakSub, email: r.email, activity: { site: "gtc", type: "certificate", refKey: "cert:" + r.id, title: r.course || r.title, detail: r.title, occurredAt: new Date(r.issuedDate || r.updatedAt) } });
      }
      return out;
    }
  },
  {
    name: "library",
    env: "CRM_SRC_DPF_URL",
    query: async (db, since) => {
      const out: Row[] = [];
      const books = await db.query(
        `SELECT id, user_email, product_id, product_slug, product_title, page, pages, max_page, opened_at, finished_at, updated_at
           FROM book_progress WHERE updated_at >= $1`, [since]
      );
      for (const r of books.rows) {
        const done = !!r.finished_at;
        const of = r.pages ? ` of ${r.pages}` : "";
        out.push({
          email: r.user_email,
          activity: {
            site: "library",
            type: done ? "book_finished" : "book",
            refKey: "book:" + r.product_id,
            title: r.product_title || r.product_slug || "A book",
            detail: done ? "Finished" : `Read to page ${r.max_page || r.page}${of}`,
            url: r.product_slug ? `${LIBRARY}/products/${r.product_slug}` : null,
            occurredAt: new Date(r.finished_at || r.opened_at || r.updated_at)
          }
        });
      }
      const audio = await db.query(
        `SELECT s.id, s.user_email, s.product_id, s.progress_ms, s.played_at, s.finished_at, s.saved_at, s.updated_at, a.title
           FROM audiobook_shelf s LEFT JOIN LATERAL (SELECT li.title FROM audiobooks ab JOIN library_items li ON li.id = ab.library_item_id WHERE ab.vendure_product_id = s.product_id LIMIT 1) a ON true
          WHERE s.updated_at >= $1`, [since]
      ).catch(() =>
        db.query(`SELECT id, user_email, product_id, progress_ms, played_at, finished_at, saved_at, updated_at, NULL AS title FROM audiobook_shelf WHERE updated_at >= $1`, [since]));
      for (const r of audio.rows) {
        if (!r.played_at && !r.saved_at) continue;
        const done = !!r.finished_at;
        out.push({
          email: r.user_email,
          activity: {
            site: "library",
            type: done ? "audiobook_finished" : r.played_at ? "audiobook" : "audiobook_saved",
            refKey: "audio:" + r.product_id,
            title: r.title || "An audiobook",
            detail: done ? "Finished listening" : r.played_at ? `Listened ${Math.round((r.progress_ms || 0) / 60000)} min` : "Saved to listen",
            occurredAt: new Date(r.finished_at || r.played_at || r.saved_at || r.updated_at)
          }
        });
      }
      return out;
    }
  },
  {
    name: "church",
    env: "CRM_SRC_GC_URL",
    query: async (db, since) => {
      const out: Row[] = [];
      const prayers = await db.query(`SELECT id, created_at, name, email, text, text_en, private, status, subject FROM prayer_requests WHERE created_at >= $1`, [since]);
      for (const r of prayers.rows) {
        out.push({
          sub: r.subject,
          email: r.email,
          name: r.name,
          createIfMissing: true,
          activity: { site: "church", type: "prayer_request", refKey: "prayer:" + r.id, title: "Prayer request", detail: String(r.text_en || r.text || "").slice(0, 500), occurredAt: new Date(r.created_at) }
        });
      }
      const steps = await db.query(`SELECT id, created_at, kind, name, email, phone, country, message, message_en, subject FROM next_steps WHERE created_at >= $1`, [since]);
      const KIND: Record<string, string> = { salvation: "Gave their life to Christ", baptism: "Asked about baptism", membership: "Asked about membership", serve: "Wants to serve", group: "Wants to join a group", contact: "Asked to be contacted" };
      for (const r of steps.rows) {
        out.push({
          sub: r.subject,
          email: r.email,
          name: r.name,
          createIfMissing: true,
          activity: { site: "church", type: "next_step", refKey: "step:" + r.id, title: KIND[r.kind] || "Next step: " + r.kind, detail: String(r.message_en || r.message || "").slice(0, 500) || null, occurredAt: new Date(r.created_at) }
        });
      }
      const groups = await db.query(
        `SELECT m.group_id, m.subject, m.name, m.email, m.role, m.joined_at, g.name AS group_name, g.slug FROM group_members m JOIN groups g ON g.id = m.group_id WHERE m.joined_at >= $1`, [since]
      );
      for (const r of groups.rows) {
        out.push({ sub: r.subject, email: r.email, activity: { site: "church", type: "group", refKey: "group:" + r.group_id, title: r.group_name, detail: r.role === "leader" ? "Leads this E-Group" : "Joined this E-Group", occurredAt: new Date(r.joined_at) } });
      }
      return out;
    }
  },
  {
    name: "theater",
    env: "CRM_SRC_THEATER_URL",
    query: async (db, since) => {
      const out: Row[] = [];
      const watched = await db.query(
        `SELECT w.user_sub, w.video_id, w.position_s, COALESCE(w.duration_s, v.duration_s) AS duration_s, w.updated_at, v.title
           FROM watch_progress w JOIN videos v ON v.id = w.video_id WHERE w.updated_at >= $1`, [since]
      );
      for (const r of watched.rows) {
        const share = r.duration_s ? pct((100 * r.position_s) / r.duration_s) : null;
        out.push({ sub: r.user_sub, activity: { site: "theater", type: "watched", refKey: "video:" + r.video_id, title: r.title, detail: share === null ? null : share >= 95 ? "Watched to the end" : `Watched ${share}%`, url: `${THEATER}/watch/${r.video_id}`, occurredAt: new Date(r.updated_at) } });
      }
      return out;
    }
  },
  {
    name: "askmary",
    env: "CRM_SRC_GTC_URL",
    query: async (db, since) => {
      // TOPICS ONLY: conversation title + site, never messages or memories. Only people whose
      // shared consent allows personalization.
      const res = await db.query(
        `SELECT c.id, c.title, c.site, c."createdAt", c."updatedAt", p."keycloakSub"
           FROM ask_mary_conversations c JOIN ask_mary_profiles p ON p.id = c."profileId"
          WHERE c."updatedAt" >= $1 AND p."keycloakSub" IS NOT NULL AND c.title IS NOT NULL AND c.title <> ''
            AND (p.consent->>'personalization') = 'true'`, [since]
      );
      return res.rows.map((r: any) => ({ sub: r.keycloakSub, activity: { site: "askmary", type: "topic", refKey: "conv:" + r.id, title: String(r.title).slice(0, 300), detail: "Asked Mary on " + r.site, occurredAt: new Date(r.createdAt) } }));
    }
  }
];

const pools = new Map<string, pg.Pool>();
function poolFor(url: string): pg.Pool {
  let p = pools.get(url);
  if (!p) {
    // TLS everywhere except localhost. Railway's TCP proxy presents a self-signed chain, so the
    // certificate is checked only for hosts with a public CA (Neon).
    const u = new URL(url);
    for (const k of ["sslmode", "channel_binding", "uselibpqcompat"]) u.searchParams.delete(k);
    const local = /^(localhost|127\.0\.0\.1)$/.test(u.hostname);
    const railway = /(\.rlwy\.net|\.railway\.internal)$/.test(u.hostname);
    p = new pg.Pool({ connectionString: u.toString(), max: 2, idleTimeoutMillis: 30_000, ssl: local ? undefined : { rejectUnauthorized: !railway } });
    p.on("error", (e) => console.error("[crm-activity] pool error:", e.message));
    pools.set(url, p);
  }
  return p;
}

export interface ActivityResult { [source: string]: { rows: number; matched: number; created: number; changed: number; error?: string } }

export class CrmActivitySync {
  constructor(private repos: Repos) {}

  static configuredSources(): string[] {
    return SOURCES.filter((s) => !!process.env[s.env]).map((s) => s.name);
  }

  async run(opts: { full?: boolean } = {}): Promise<ActivityResult> {
    const result: ActivityResult = {};
    const churchId = await CrmConfig.churchId(this.repos);
    if (!churchId) return result;

    const index = await this.repos.crm.loadPeopleIndex(churchId);
    const bySub = new Map<string, string>();
    const byEmail = new Map<string, string>();
    for (const p of index) {
      if (isRemoved(p.removed)) continue;
      if (p.mbidSub) bySub.set(p.mbidSub, p.id);
      const e = normEmail(p.email);
      if (e && !byEmail.has(e)) byEmail.set(e, p.id);
    }

    for (const src of SOURCES) {
      const url = process.env[src.env];
      if (!url) continue;
      const stat = { rows: 0, matched: 0, created: 0, changed: 0 } as ActivityResult[string];
      result[src.name] = stat;
      const cursorKey = "activity." + src.name;
      try {
        const last = opts.full ? null : await this.repos.crm.getState(cursorKey);
        const since = last ? new Date(new Date(last).getTime() - OVERLAP_MS) : new Date(0);
        const startedAt = new Date();
        const rows = await src.query(poolFor(url), since);
        stat.rows = rows.length;
        const perPerson = new Map<string, ActivityInput[]>();
        for (const r of rows) {
          let personId = (r.sub && bySub.get(r.sub)) || (r.email && byEmail.get(normEmail(r.email))) || null;
          if (!personId && r.createIfMissing && normEmail(r.email)) {
            const [first, ...rest] = String(r.name || "").trim().split(/\s+/);
            const made = await CrmPeople.ensure(this.repos, { churchId, sub: r.sub || null, emails: [normEmail(r.email)], firstName: first || null, lastName: rest.join(" ") || null, source: "globalchurch" });
            personId = made.personId;
            if (made.created) stat.created++;
            byEmail.set(normEmail(r.email), personId);
            if (r.sub) bySub.set(r.sub, personId);
          }
          if (!personId) continue;
          stat.matched++;
          if (!perPerson.has(personId)) perPerson.set(personId, []);
          perPerson.get(personId)!.push(r.activity);
        }
        for (const [personId, items] of perPerson) {
          stat.changed += await this.repos.crm.upsertActivities(churchId, personId, items);
          const prof = await this.repos.crm.loadProfile(churchId, personId);
          if (!prof) await this.repos.crm.upsertProfile(churchId, personId, {});
          await this.repos.crm.refreshLastActive(churchId, personId);
        }
        await this.repos.crm.setState(cursorKey, startedAt.toISOString());
      } catch (e: any) {
        stat.error = String(e?.message || e).slice(0, 300);
        console.error("[crm-activity] " + src.name + " failed:", stat.error);
      }
    }
    await this.repos.crm.setState("activity.lastRun", JSON.stringify({ at: new Date().toISOString(), result }));
    return result;
  }
}

function isRemoved(v: any): boolean {
  if (Buffer.isBuffer(v)) return v[0] === 1;
  return v === true || v === 1 || v === "1";
}
