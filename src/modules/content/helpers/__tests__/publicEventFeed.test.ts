// ── PUBLIC EVENTS FEED LEAK GATE (DB-free) ────────────────────────────────────────────────────
// Drives the real PublicEventFeed builder (the projection behind GET /content/events/public/:churchId)
// over fabricated rows stuffed with private columns. Asserts: exact DTO keys, no group/person/tenant
// data, private / unlisted / pending events never appear, campus filter + network-wide inclusion,
// recurring expansion inside the window, exception dates skipped, sort + 200 cap.
import { buildPublicEventFeed, toPublicEvent, PUBLIC_EVENT_KEYS, isPubliclyListed, FEED_MAX } from "../PublicEventFeed.js";

// Mid-May: no DST transition inside the first weeks, so "+7 days" is the next weekly occurrence.
const NOW = new Date("2030-05-01T12:00:00");
const inDays = (n: number, h = 10) => {
  const d = new Date(NOW.getTime() + n * 24 * 60 * 60 * 1000);
  d.setHours(h, 0, 0, 0);
  return d;
};

const CAMPUSES = [
  { id: "CAM_A", name: "Chatham Center", slug: "chatham" },
  { id: "CAM_B", name: "Decatur Center", slug: "decatur" }
];

// Every private column a real events row can carry.
const privateCols = {
  churchId: "CH_secret",
  groupId: "GRP_secret",
  requestedBy: "PER_requester",
  formId: "FORM_secret",
  capacity: 50,
  tags: "internal-tag",
  registrationEnabled: 1,
  approvalStatus: "approved",
  visibility: "public",
  attendeeIds: ["PER_1", "PER_2"],
  email: "leader@example.com"
};

const row = (over: any) => ({
  id: "EVT_" + Math.random().toString(36).slice(2, 8),
  title: "Event",
  description: "Public description",
  start: inDays(3),
  end: new Date(inDays(3).getTime() + 60 * 60 * 1000),
  allDay: Buffer.from([0]),
  recurrenceRule: null,
  publicListing: 1,
  campusId: null,
  location: "Main hall",
  registrationUrl: "https://example.org/register",
  image: null,
  ...privateCols,
  ...over
});

describe("PublicEventFeed (events feed leak gate)", () => {
  it("projects EXACTLY the whitelisted keys, with no group/person/tenant data", () => {
    const dto = toPublicEvent(row({ id: "EVT_1", campusId: "CAM_A" }), null, CAMPUSES[0], false);
    expect(Object.keys(dto).sort()).toEqual([...PUBLIC_EVENT_KEYS].sort());
    const serialized = JSON.stringify(dto);
    for (const secret of ["CH_secret", "GRP_secret", "PER_requester", "FORM_secret", "internal-tag", "PER_1", "leader@example.com"]) {
      expect(serialized).not.toContain(secret);
    }
    expect(dto.campusName).toBe("Chatham Center");
    expect(dto.campusSlug).toBe("chatham");
    expect(dto.allDay).toBe(false);
  });

  it("private, unlisted, pending and rejected events NEVER appear", () => {
    const rows = [
      row({ id: "EVT_ok", title: "Visible" }),
      row({ id: "EVT_private", visibility: "private", title: "Private" }),
      row({ id: "EVT_unlisted", publicListing: 0, title: "Unlisted" }),
      row({ id: "EVT_unlisted2", publicListing: null, title: "Unlisted2" }),
      row({ id: "EVT_pending", approvalStatus: "pending", title: "Pending" }),
      row({ id: "EVT_rejected", approvalStatus: "rejected", title: "Rejected" })
    ];
    const feed = buildPublicEventFeed(rows, {}, CAMPUSES, { now: NOW });
    expect(feed.map((e) => e.id)).toEqual(["EVT_ok"]);
    expect(isPubliclyListed(rows[1])).toBe(false);
  });

  it("an empty / unknown church yields [] (same shape as a church with no public events)", () => {
    expect(buildPublicEventFeed([], {}, [], { now: NOW })).toEqual([]);
    expect(buildPublicEventFeed(undefined as any, {}, undefined as any, { now: NOW })).toEqual([]);
  });

  it("campusId filter returns that center's events PLUS network-wide ones", () => {
    const rows = [
      row({ id: "EVT_net", campusId: null }),
      row({ id: "EVT_a", campusId: "CAM_A" }),
      row({ id: "EVT_b", campusId: "CAM_B" })
    ];
    const feed = buildPublicEventFeed(rows, {}, CAMPUSES, { now: NOW, campusId: "CAM_A" });
    expect(feed.map((e) => e.id).sort()).toEqual(["EVT_a", "EVT_net"]);
    const all = buildPublicEventFeed(rows, {}, CAMPUSES, { now: NOW });
    expect(all).toHaveLength(3);
    expect(all.find((e) => e.id === "EVT_net")?.campusName).toBeNull();
  });

  it("drops events tied to a campus that is not in the church's public campus list", () => {
    const feed = buildPublicEventFeed([row({ id: "EVT_foreign", campusId: "CAM_OTHER_CHURCH" })], {}, CAMPUSES, { now: NOW });
    expect(feed).toEqual([]);
  });

  it("keeps only now-1h .. +180 days", () => {
    const rows = [
      row({ id: "EVT_past", start: inDays(-2), end: inDays(-2, 11) }),
      row({ id: "EVT_soon", start: inDays(1), end: inDays(1, 11) }),
      row({ id: "EVT_far", start: inDays(200), end: inDays(200, 11) })
    ];
    expect(buildPublicEventFeed(rows, {}, CAMPUSES, { now: NOW }).map((e) => e.id)).toEqual(["EVT_soon"]);
  });

  it("expands a weekly series inside the window, ids are eventId:isoStart, exceptions skipped", () => {
    const start = inDays(2, 18);
    const weekly = row({ id: "EVT_weekly", start, end: new Date(start.getTime() + 90 * 60 * 1000), recurrenceRule: "FREQ=WEEKLY;COUNT=4" });
    const skip = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000); // second occurrence
    const feed = buildPublicEventFeed([weekly], { EVT_weekly: [skip] }, CAMPUSES, { now: NOW });
    expect(feed).toHaveLength(3);
    expect(feed[0].id).toBe("EVT_weekly:" + start.toISOString());
    expect(feed.every((e) => e.id.startsWith("EVT_weekly:"))).toBe(true);
    expect(feed.map((e) => e.start)).not.toContain(skip.toISOString());
    // duration preserved
    expect(new Date(feed[0].end as string).getTime() - new Date(feed[0].start).getTime()).toBe(90 * 60 * 1000);
  });

  it("sorts by start and caps at 200", () => {
    const daily = row({ id: "EVT_daily", start: inDays(0, 23), end: inDays(0, 23), recurrenceRule: "FREQ=DAILY" });
    const daily2 = row({ id: "EVT_daily2", start: inDays(0, 22), end: inDays(0, 22), recurrenceRule: "FREQ=DAILY" });
    const early = row({ id: "EVT_first", start: inDays(0, 13), end: inDays(0, 14) });
    const feed = buildPublicEventFeed([daily, daily2, early], {}, CAMPUSES, { now: NOW });
    expect(feed.length).toBe(FEED_MAX);
    expect(feed[0].id).toBe("EVT_first");
    for (let i = 1; i < feed.length; i++) expect(new Date(feed[i].start).getTime()).toBeGreaterThanOrEqual(new Date(feed[i - 1].start).getTime());
  });
});
