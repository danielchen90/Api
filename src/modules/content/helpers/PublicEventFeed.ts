import { RecurrenceHelper } from "./RecurrenceHelper.js";

/**
 * PublicEventFeed: the pure (DB-free) builder behind GET /content/events/public/:churchId.
 *
 * Takes the church's publicListing event rows (EventRepo.loadPublicListed), their exception dates
 * and the church's public campus list (via the membership gateway), and produces the anonymous
 * feed: upcoming occurrences (now-1h through +180 days), recurring series expanded, sorted by
 * start, capped at 200, each projected through the POSITIVE whitelist below.
 *
 * The whitelist is the data-safety gate: a fresh object naming only public keys, so groupId,
 * churchId, requestedBy, formId, capacity, tags, approval data or any future column can never
 * reach a visitor.
 */

export type PublicEventDTO = {
  id: string;
  title: string;
  description: string | null;
  start: string;
  end: string | null;
  allDay: boolean;
  location: string | null;
  campusId: string | null;
  campusName: string | null;
  campusSlug: string | null;
  registrationUrl: string | null;
  image: string | null;
};

export const PUBLIC_EVENT_KEYS: (keyof PublicEventDTO)[] = [
  "id",
  "title",
  "description",
  "start",
  "end",
  "allDay",
  "location",
  "campusId",
  "campusName",
  "campusSlug",
  "registrationUrl",
  "image"
];

export interface PublicCampusRef {
  id: string;
  name?: string | null;
  slug?: string | null;
}

export interface FeedOptions {
  now?: Date;
  campusId?: string | null;
  lookBackMs?: number; // default 1 hour
  lookAheadDays?: number; // default 180
  max?: number; // default 200
}

export const FEED_MAX = 200;

// mysql2 returns bit(1) columns as a Buffer; tinyint as a number.
export function toBool(v: any): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v === "1" || v.toLowerCase() === "true";
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(v)) return v.length > 0 && v[0] === 1;
  if (v?.type === "Buffer" && Array.isArray(v.data)) return v.data[0] === 1;
  return !!v;
}

/** An event row is eligible for the public site only when explicitly opted in and not private/pending. */
export function isPubliclyListed(row: any): boolean {
  if (!row) return false;
  if (!toBool(row.publicListing)) return false;
  if ((row.visibility || "").toString().toLowerCase() === "private") return false;
  const status = (row.approvalStatus || "").toString().toLowerCase();
  if (status === "pending" || status === "rejected") return false;
  return true;
}

const str = (v: any): string | null => (v === null || v === undefined || v === "" ? null : v.toString());
const iso = (d: any): string | null => {
  if (!d) return null;
  const dt = d instanceof Date ? d : new Date(d);
  return isNaN(dt.getTime()) ? null : dt.toISOString();
};

/** Project one occurrence of an event into the ONLY anonymous-safe shape. Fresh object, named keys only. */
export function toPublicEvent(row: any, occurrence: { start: Date; end: Date } | null, campus: PublicCampusRef | null, recurring: boolean): PublicEventDTO {
  const start = occurrence ? occurrence.start : row?.start;
  const end = occurrence ? occurrence.end : row?.end;
  const startIso = iso(start) ?? "";
  return {
    id: recurring ? `${row?.id}:${startIso}` : (row?.id ?? null),
    title: row?.title ? row.title.toString() : "",
    description: str(row?.description),
    start: startIso,
    end: iso(end),
    allDay: toBool(row?.allDay),
    location: str(row?.location),
    campusId: campus ? campus.id : null,
    campusName: campus ? str(campus.name) : null,
    campusSlug: campus ? str(campus.slug) : null,
    registrationUrl: str(row?.registrationUrl),
    image: str(row?.image)
  };
}

/**
 * Build the feed. `exceptions` maps eventId -> exception dates (skipped occurrences).
 * Events whose campusId is set but is not one of the church's public campuses are dropped
 * (removed campus / foreign id), so a campus lookup miss can never leak a raw id.
 */
export function buildPublicEventFeed(
  rows: any[],
  exceptions: Record<string, (Date | string)[]>,
  campuses: PublicCampusRef[],
  opts: FeedOptions = {}
): PublicEventDTO[] {
  const now = opts.now ?? new Date();
  const windowStart = new Date(now.getTime() - (opts.lookBackMs ?? 60 * 60 * 1000));
  const windowEnd = new Date(now.getTime() + (opts.lookAheadDays ?? 180) * 24 * 60 * 60 * 1000);
  const max = Math.min(opts.max ?? FEED_MAX, FEED_MAX);
  const campusMap = new Map<string, PublicCampusRef>();
  (campuses || []).forEach((c) => { if (c?.id) campusMap.set(c.id, c); });

  const result: PublicEventDTO[] = [];
  for (const row of rows || []) {
    if (!isPubliclyListed(row)) continue;
    const eventCampusId: string | null = row.campusId || null;
    if (opts.campusId && eventCampusId && eventCampusId !== opts.campusId) continue;
    let campus: PublicCampusRef | null = null;
    if (eventCampusId) {
      campus = campusMap.get(eventCampusId) ?? null;
      if (!campus) continue;
    }
    if (!row.start) continue;
    const recurring = !!row.recurrenceRule;
    const occurrences = RecurrenceHelper.getOccurrences(
      { start: row.start, end: row.end || row.start, recurrenceRule: row.recurrenceRule || undefined },
      windowStart,
      windowEnd,
      max
    );
    const skip = (exceptions?.[row.id] || []).map((d) => new Date(d).getTime()).filter((t) => !isNaN(t));
    for (const occ of occurrences) {
      if (skip.some((t) => Math.abs(t - occ.start.getTime()) < 60 * 1000)) continue;
      result.push(toPublicEvent(row, occ, campus, recurring));
    }
  }
  result.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
  return result.slice(0, max);
}
