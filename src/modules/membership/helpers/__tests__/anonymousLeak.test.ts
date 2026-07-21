// ── PUB-02 ANONYMOUS-LEAK GATE (DB-free, CI-gated) ───────────────────────────────────────────
// This suite is the REGRESSION GATE for the public website's #1 hazard: leaking member PII on an
// anonymous surface. It drives the REAL Plan-01 whitelist DTO builders (`toPublicLeader`,
// `resolvePublicPhoto`, `pickWhitelist`) — the positive-whitelist projection every `/public/`
// read MUST go through — over a fabricated row that is DELIBERATELY stuffed with every private
// key. If a future edit widens a public DTO to carry a PII key (email/phone/address/householdId/
// birthDate/contactInfo), these assertions FAIL and `yarn test` (.github/workflows/test.yml)
// fails the build. It is TEST-ONLY (no product code) and DB-FREE: `getPhotoPath` is a pure static
// string builder, so no DB/env is touched.
//
// Phase 20 EXTENDS this file: every new `toPublicX` builder gets a fabricated-row assertion here.

// PublicDto imports the membership PersonHelper (which extends the apihelper PersonHelper and pulls
// in the shared infrastructure/Environment ESM chain that Jest's CommonJS transform can't require).
// Mock it to a MINIMAL stand-in exposing the ONE method PublicDto uses — getPhotoPath — with the
// same pure logic as @churchapps/helpers PersonHelper.getPhotoPath (a stored photo → a path;
// no photoUpdated → empty). This keeps the suite DB-free and import-clean.
jest.mock("../PersonHelper.js", () => ({
  PersonHelper: {
    getPhotoPath: (churchId: string, person: { id?: string; photoUpdated?: any }) =>
      person?.photoUpdated ? `/${churchId}/membership/people/${person.id}.png?dt=${new Date(person.photoUpdated).getTime()}` : ""
  }
}));

import { toPublicLeader, resolvePublicPhoto, pickWhitelist, toPublicCampus, toPublicCampusEvent, type PublicLeaderDTO } from "../PublicDto.js";

// The exhaustive set of keys a public DTO must NEVER carry. Adding a builder that emits any of
// these makes the "no forbidden key" assertions below fail.
const FORBIDDEN_KEYS = [
  "email",
  "phone",
  "phoneNumber",
  "contactInfo",
  "address",
  "address1",
  "address2",
  "city",
  "state",
  "zip",
  "householdId",
  "birthDate",
  "nationalId",
  "photoUpdated"
];

// The ONLY keys the leadership DTO is allowed to expose.
const ALLOWED_LEADER_KEYS = ["id", "displayName", "role", "photo"];

// A fabricated leader row carrying EVERYTHING private a real Person row could carry. An adult
// birthDate so the photo path is allowed unless suppressed for another reason.
const adultBirthDate = new Date(Date.now() - 40 * 365.25 * 24 * 60 * 60 * 1000).toISOString();
const minorBirthDate = new Date(Date.now() - 12 * 365.25 * 24 * 60 * 60 * 1000).toISOString();

const leakyAdultRow: any = {
  id: "PER_adult_1",
  churchId: "CH1",
  displayName: "Pastor Jane Doe",
  role: "Lead Pastor",
  photoUpdated: new Date().toISOString(),
  // ── everything below MUST NOT survive projection ──
  email: "jane@example.com",
  phone: "555-111-2222",
  phoneNumber: "555-111-2222",
  contactInfo: { email: "jane@example.com", homePhone: "555-000-0000", address1: "1 Private Ln" },
  address: "1 Private Ln",
  address1: "1 Private Ln",
  city: "Nowhere",
  state: "NA",
  zip: "00000",
  householdId: "HH_secret_1",
  birthDate: adultBirthDate,
  nationalId: "AAA-BB-CCCC",
  name: { first: "Jane", last: "Doe", display: "Pastor Jane Doe" }
};

const leakyMinorRow: any = {
  ...leakyAdultRow,
  id: "PER_minor_1",
  displayName: "Timmy Minor",
  role: "Youth Helper",
  birthDate: minorBirthDate
};

describe("anonymousLeak (PUB-02 leak gate) — whitelist DTOs never carry PII", () => {
  describe("toPublicLeader projects ONLY the whitelisted shape", () => {
    const dto = toPublicLeader(leakyAdultRow);

    it("emits EXACTLY the allowed keys (no extra, no widened projection)", () => {
      expect(Object.keys(dto).sort()).toEqual([...ALLOWED_LEADER_KEYS].sort());
    });

    it("carries NONE of the forbidden PII keys", () => {
      for (const k of FORBIDDEN_KEYS) {
        expect(Object.prototype.hasOwnProperty.call(dto, k)).toBe(false);
      }
    });

    it("no VALUE anywhere in the DTO equals a private field's value (deep serialize check)", () => {
      const serialized = JSON.stringify(dto);
      expect(serialized).not.toContain("jane@example.com");
      expect(serialized).not.toContain("555-111-2222");
      expect(serialized).not.toContain("1 Private Ln");
      expect(serialized).not.toContain("HH_secret_1");
      expect(serialized).not.toContain("AAA-BB-CCCC");
      expect(serialized).not.toContain(adultBirthDate);
    });

    it("still exposes the intended safe fields", () => {
      expect(dto.id).toBe("PER_adult_1");
      expect(dto.displayName).toBe("Pastor Jane Doe");
      expect(dto.role).toBe("Lead Pastor");
    });
  });

  describe("resolvePublicPhoto — adult-only, minors and unknown-age suppressed", () => {
    it("an adult with a stored photo gets a non-null photo path", () => {
      expect(resolvePublicPhoto(leakyAdultRow)).not.toBeNull();
    });

    it("a MINOR birthDate → photo is null (never a minor's photo)", () => {
      expect(resolvePublicPhoto(leakyMinorRow)).toBeNull();
      expect(toPublicLeader(leakyMinorRow).photo).toBeNull();
    });

    it("an UNKNOWN age (no/invalid birthDate) → photo is null (conservative)", () => {
      expect(resolvePublicPhoto({ id: "PER_x", churchId: "CH1", photoUpdated: new Date().toISOString() })).toBeNull();
      expect(resolvePublicPhoto({ id: "PER_x", churchId: "CH1", photoUpdated: new Date().toISOString(), birthDate: "not-a-date" })).toBeNull();
    });
  });

  describe("toPublicCampus projects ONLY the whitelisted campus shape (SITE-02/03, MAP)", () => {
    // A campus is a PUBLIC physical location: address1/city/state/zip ARE allowed here
    // (rendered server-side). churchId / importKey / a private website / any person key
    // must NEVER survive.
    const ALLOWED_CAMPUS_KEYS = ["id", "slug", "name", "latitude", "longitude", "address1", "city", "state", "zip"];
    // Forbidden set for a campus EXCLUDES the intentionally-public address columns.
    const CAMPUS_FORBIDDEN_KEYS = ["churchId", "importKey", "email", "phone", "phoneNumber", "contactInfo", "householdId", "birthDate", "website", "country", "timezone", "removed"];

    const leakyCampusRow: any = {
      id: "CMP_1",
      slug: "main-campus",
      name: "Main Campus",
      latitude: 40.1,
      longitude: -74.2,
      address1: "100 Church St",
      city: "Trenton",
      state: "NJ",
      zip: "08608",
      // ── everything below MUST NOT survive projection ──
      churchId: "CH_secret",
      importKey: "IMPORT_secret",
      country: "US",
      timezone: "America/New_York",
      website: "https://private-admin.example",
      email: "campus@example.com",
      phone: "555-999-8888",
      phoneNumber: "555-999-8888",
      contactInfo: { email: "campus@example.com" },
      householdId: "HH_x",
      birthDate: new Date().toISOString(),
      removed: false
    };

    const dto = toPublicCampus(leakyCampusRow);

    it("emits EXACTLY the allowed campus keys (no widened projection)", () => {
      expect(Object.keys(dto).sort()).toEqual([...ALLOWED_CAMPUS_KEYS].sort());
    });

    it("carries NONE of the forbidden tenant/PII keys (address keys are the one allowed exception)", () => {
      for (const k of CAMPUS_FORBIDDEN_KEYS) {
        expect(Object.prototype.hasOwnProperty.call(dto, k)).toBe(false);
      }
    });

    it("no private VALUE survives serialization (churchId/importKey/website/PII)", () => {
      const serialized = JSON.stringify(dto);
      expect(serialized).not.toContain("CH_secret");
      expect(serialized).not.toContain("IMPORT_secret");
      expect(serialized).not.toContain("private-admin.example");
      expect(serialized).not.toContain("campus@example.com");
      expect(serialized).not.toContain("555-999-8888");
      expect(serialized).not.toContain("HH_x");
    });

    it("still exposes the intended public location fields (slug/name/address survive)", () => {
      expect(dto.id).toBe("CMP_1");
      expect(dto.slug).toBe("main-campus");
      expect(dto.name).toBe("Main Campus");
      expect(dto.address1).toBe("100 Church St");
      expect(dto.city).toBe("Trenton");
      expect(dto.latitude).toBe(40.1);
    });
  });

  describe("toPublicCampusEvent projects ONLY a display-only event shape (EVT-01)", () => {
    const ALLOWED_EVENT_KEYS = ["id", "title", "start", "end", "allDay"];
    const EVENT_FORBIDDEN_KEYS = ["groupId", "churchId", "attendeeIds", "description", "visibility", "formId", "requestedBy", "capacity"];

    const leakyEventRow: any = {
      id: "EVT_1",
      title: "Sunday Service",
      start: "2030-01-01T10:00:00Z",
      end: "2030-01-01T11:00:00Z",
      allDay: false,
      // ── everything below MUST NOT survive projection ──
      groupId: "GRP_secret",
      churchId: "CH_secret",
      attendeeIds: ["PER_1", "PER_2"],
      description: "internal notes",
      visibility: "private",
      formId: "FORM_x",
      requestedBy: "PER_admin",
      capacity: 50
    };

    const dto = toPublicCampusEvent(leakyEventRow);

    it("emits EXACTLY the allowed event keys", () => {
      expect(Object.keys(dto).sort()).toEqual([...ALLOWED_EVENT_KEYS].sort());
    });

    it("carries NONE of the forbidden event keys (no groupId / attendee / tenant leak)", () => {
      for (const k of EVENT_FORBIDDEN_KEYS) {
        expect(Object.prototype.hasOwnProperty.call(dto, k)).toBe(false);
      }
    });

    it("no private VALUE survives serialization", () => {
      const serialized = JSON.stringify(dto);
      expect(serialized).not.toContain("GRP_secret");
      expect(serialized).not.toContain("CH_secret");
      expect(serialized).not.toContain("PER_1");
      expect(serialized).not.toContain("internal notes");
      expect(serialized).not.toContain("FORM_x");
    });

    it("still exposes the intended display fields", () => {
      expect(dto.id).toBe("EVT_1");
      expect(dto.title).toBe("Sunday Service");
      expect(dto.allDay).toBe(false);
    });
  });

  describe("pickWhitelist — the generic projector never emits a non-listed key", () => {
    it("copies ONLY the named keys into a fresh object, dropping every un-listed (private) column", () => {
      type SafeContent = { id: string; title: string };
      const out = pickWhitelist<SafeContent>(leakyAdultRow, ["id", "title"]);
      expect(Object.keys(out).sort()).toEqual(["id", "title"].sort());
      for (const k of FORBIDDEN_KEYS) {
        expect(Object.prototype.hasOwnProperty.call(out, k)).toBe(false);
      }
      // A newly-added private column on the source row can never pass through an unchanged whitelist.
      const outAfterNewColumn = pickWhitelist<SafeContent>({ ...leakyAdultRow, ssn: "123-45-6789" }, ["id", "title"]);
      expect(JSON.stringify(outAfterNewColumn)).not.toContain("123-45-6789");
    });

    it("returns an empty object for a null/undefined row (never throws on a missing source)", () => {
      expect(pickWhitelist<PublicLeaderDTO>(null, ["id"])).toEqual({});
      expect(pickWhitelist<PublicLeaderDTO>(undefined, ["id"])).toEqual({});
    });
  });
});
