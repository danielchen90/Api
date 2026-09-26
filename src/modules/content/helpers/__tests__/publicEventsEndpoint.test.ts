// ── GET /content/events/public/:churchId ENUMERATION + LEAK GATE (DB-free) ─────────────────────
// Drives the REAL EventController.getPublicFeed handler over mocked repos + a mocked membership
// gateway. Asserts that an unknown church and an existing church with no public events produce
// BYTE-IDENTICAL responses ([] + 200, never a 404), that private rows returned by a (hypothetically
// buggy) repo still never reach the response, and that no group/person data is serialized.

jest.mock("@churchapps/apihelper", () => ({
  CustomBaseController: class {},
  AuthenticatedUser: class {},
  EmailHelper: { sendTemplatedEmail: jest.fn() },
  DateHelper: { toMysqlDate: (d: any) => d },
  UniqueIdHelper: { shortId: () => "sid" }
}));
jest.mock("../../../../shared/infrastructure/index.js", () => ({
  RepoManager: { getRepos: async () => ({}) },
  BaseController: class {
    constructor(_m?: string) {}
    json(body: any, status: number) { return { body, status }; }
    actionWrapperAnon(_req: any, _res: any, action: () => Promise<any>) { return action(); }
    actionWrapper(_req: any, _res: any, action: (au: any) => Promise<any>) { return action({}); }
  }
}));
const loadPublicCampuses = jest.fn(async (churchId: string) => (churchId === "CHU_REAL" ? [{ id: "CAM_A", name: "Chatham Center", slug: "chatham" }] : []));
jest.mock("../../../../shared/modules/index.js", () => ({
  getMembershipModuleGateway: () => ({ loadPublicCampuses, resolveCampusScope: jest.fn(async () => ({ mode: "deny" })) })
}));
jest.mock("../../../../shared/webhooks/index.js", () => ({ WebhookDispatcher: { emit: jest.fn() } }));
jest.mock("../../../../shared/helpers/NotificationService.js", () => ({ NotificationService: { createNotifications: jest.fn() } }));
jest.mock("../index.js", () => ({
  CalendarHelper: { addExceptionDates: jest.fn() },
  HolidayHelper: { getHolidays: jest.fn() },
  Permissions: { content: { edit: {} }, calendars: { admin: {} } }
}));
jest.mock("../ApprovalHelper.js", () => ({ ApprovalHelper: { determineStatus: jest.fn() } }));
jest.mock("../IcsHelper.js", () => ({ IcsHelper: { parseEvents: jest.fn(() => []) } }));
jest.mock("ics", () => ({ createEvents: jest.fn(() => ({ value: "" })) }));

import { EventController } from "../../controllers/EventController.js";
import { PublicReadLimiter } from "../../../../shared/helpers/PublicReadLimiter.js";

const soon = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
const later = new Date(soon.getTime() + 60 * 60 * 1000);

const REAL_ROWS = [
  { id: "EVT_public", churchId: "CHU_REAL", groupId: "GRP_secret", title: "Community picnic", start: soon, end: later, publicListing: 1, visibility: "public", campusId: "CAM_A", requestedBy: "PER_secret", formId: "FORM_secret" },
  { id: "EVT_private", churchId: "CHU_REAL", groupId: "GRP_secret", title: "Elders meeting", start: soon, end: later, publicListing: 1, visibility: "private", campusId: null }
];

function makeController(rowsByChurch: Record<string, any[]>) {
  const controller: any = new EventController();
  controller.repos = {
    event: { loadPublicListed: jest.fn(async (churchId: string) => rowsByChurch[churchId] ?? []) },
    eventException: { loadForEvents: jest.fn(async () => []) }
  };
  controller.json = (body: any, status: number) => ({ body, status });
  return controller;
}

const req = (query: any = {}) => ({ query, headers: {}, ip: "203.0.113." + Math.floor(Math.random() * 250) }) as any;
const res = { set: jest.fn() } as any;

describe("public events feed endpoint (enumeration + leak gate)", () => {
  beforeEach(() => PublicReadLimiter.reset());

  it("unknown churchId and a church with no public events return the same [] (no 404, no difference)", async () => {
    const c = makeController({ CHU_EMPTY: [] });
    const unknown = await c.getPublicFeed("CHU_DOES_NOT_EXIST", req(), res);
    const empty = await c.getPublicFeed("CHU_EMPTY", req(), res);
    expect(unknown).toEqual([]);
    expect(JSON.stringify(unknown)).toBe(JSON.stringify(empty));
    const junk = await c.getPublicFeed("../../etc/passwd", req(), res);
    expect(junk).toEqual([]);
  });

  it("private events never appear, even if the repo returned them", async () => {
    const c = makeController({ CHU_REAL: REAL_ROWS });
    const feed = await c.getPublicFeed("CHU_REAL", req(), res);
    expect(feed.map((e: any) => e.title)).toEqual(["Community picnic"]);
    const serialized = JSON.stringify(feed);
    for (const secret of ["GRP_secret", "PER_secret", "FORM_secret", "CHU_REAL", "Elders meeting", "groupId", "requestedBy"]) expect(serialized).not.toContain(secret);
    expect(feed[0].campusName).toBe("Chatham Center");
    expect(feed[0].campusSlug).toBe("chatham");
  });

  it("sets a cache-friendly Cache-Control header", async () => {
    const r = { set: jest.fn() } as any;
    await makeController({}).getPublicFeed("CHU_REAL", req(), r);
    expect(r.set).toHaveBeenCalledWith("Cache-Control", expect.stringContaining("public"));
  });

  it("is rate limited per IP (429 once the window budget is spent)", async () => {
    const c = makeController({});
    const fixed = { query: {}, headers: { "x-forwarded-for": "198.51.100.7" } } as any;
    const saved = PublicReadLimiter.MAX_HITS;
    PublicReadLimiter.MAX_HITS = 3;
    try {
      for (let i = 0; i < 3; i++) expect(await c.getPublicFeed("CHU_REAL", fixed, res)).toEqual([]);
      const blocked = await c.getPublicFeed("CHU_REAL", fixed, res);
      expect(blocked.status).toBe(429);
    } finally {
      PublicReadLimiter.MAX_HITS = saved;
    }
  });
});
