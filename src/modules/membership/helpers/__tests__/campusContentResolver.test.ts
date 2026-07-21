// CMS-01 — CampusContentResolver field-level merge. TEST-ONLY (no product code) and
// DB-FREE — drives the REAL resolveForCampus over plain in-memory field objects,
// mirroring the DB-free pattern of recipientScopeIsolation.test.ts.
//
// Covers the CONTEXT-locked semantics:
//   1. no-override      → resolved equals the org default (per field).
//   2. explicit-hide    → resolved field blank though the org default is set.
//   3. non-empty override → resolved field equals the campus value.
//   4. list field override → WHOLE list replaced (not merged per-entry).
//   5. sparse           → overriding one field leaves the rest inherited, and
//                         changing the org default reflects in resolved for every
//                         non-overriding field (live propagation).

import {
  resolveForCampus,
  HIDDEN,
  type CampusContentFields,
  type ServiceTime
} from "../CampusContentResolver.js";

describe("CampusContentResolver.resolveForCampus (CMS-01 field-level merge)", () => {
  const ORG_TIMES: ServiceTime[] = [
    { day: "Sunday", time: "09:00", label: "First Service" },
    { day: "Sunday", time: "11:00", label: "Second Service" }
  ];

  const orgDefault: CampusContentFields = {
    mission: "Reach the city",
    about: "We are a church",
    pastorNote: "Welcome from Pastor Org",
    heroImage: "files/org-hero.jpg",
    serviceTimes: ORG_TIMES,
    facebookUrl: "https://facebook.com/org",
    givingUrl: "https://give.org",
    extraLinks: [{ label: "Blog", url: "https://org/blog" }]
  };

  // 1. no-override → resolved equals the org default (per field).
  describe("no override", () => {
    it("resolves to the org default for every field (empty override)", () => {
      const resolved = resolveForCampus(orgDefault, {});
      expect(resolved).toEqual(orgDefault);
    });

    it("resolves to the org default when the override is null/undefined", () => {
      expect(resolveForCampus(orgDefault, null)).toEqual(orgDefault);
      expect(resolveForCampus(orgDefault, undefined)).toEqual(orgDefault);
    });
  });

  // 2. explicit-hide → resolved field blank though the org default is set.
  describe("explicit hide", () => {
    it("a HIDDEN scalar override forces the resolved field to '' even though the org default is set", () => {
      const resolved = resolveForCampus(orgDefault, { pastorNote: HIDDEN });
      expect(resolved.pastorNote).toBe(""); // blank, NOT the org "Welcome from Pastor Org"
      // sibling fields still inherit.
      expect(resolved.mission).toBe("Reach the city");
    });

    it("a HIDDEN list override forces the resolved list to [] (blank list, not inherited)", () => {
      const resolved = resolveForCampus(orgDefault, { serviceTimes: HIDDEN });
      expect(resolved.serviceTimes).toEqual([]);
    });
  });

  // 3. non-empty override → resolved field equals the campus value.
  describe("non-empty override", () => {
    it("a scalar override replaces the org default for that field only", () => {
      const resolved = resolveForCampus(orgDefault, { mission: "Serve the north side" });
      expect(resolved.mission).toBe("Serve the north side");
      expect(resolved.about).toBe("We are a church"); // untouched → inherited
    });
  });

  // 4. list field override → WHOLE list replaced (not merged per-entry).
  describe("list field override (whole-list replacement)", () => {
    it("replaces the entire serviceTimes list — no per-entry merge with the org default", () => {
      const campusTimes: ServiceTime[] = [{ day: "Saturday", time: "18:00", label: "Evening" }];
      const resolved = resolveForCampus(orgDefault, { serviceTimes: campusTimes });
      expect(resolved.serviceTimes).toEqual(campusTimes); // exactly the campus list
      expect(resolved.serviceTimes).toHaveLength(1);      // org's 2 entries are GONE, not merged
    });

    it("replaces the entire extraLinks list wholesale", () => {
      const campusLinks = [{ label: "Events", url: "https://campus/events" }];
      const resolved = resolveForCampus(orgDefault, { extraLinks: campusLinks });
      expect(resolved.extraLinks).toEqual(campusLinks);
      expect(resolved.extraLinks).toHaveLength(1);
    });
  });

  // 5. sparse: one override leaves the rest inherited; an org-default change
  //    reflects in resolved for every non-overriding field (live propagation).
  describe("sparse override + live org-default propagation", () => {
    it("overriding only heroImage leaves mission/service-times inherited from the org default", () => {
      const resolved = resolveForCampus(orgDefault, { heroImage: "files/campus-hero.jpg" });
      expect(resolved.heroImage).toBe("files/campus-hero.jpg"); // the one override
      expect(resolved.mission).toBe("Reach the city");          // inherited
      expect(resolved.serviceTimes).toEqual(ORG_TIMES);         // inherited whole list
    });

    it("changing the org default propagates to resolved for a non-overriding field", () => {
      const sparseOverride: CampusContentFields = { heroImage: "files/campus-hero.jpg" };

      const before = resolveForCampus(orgDefault, sparseOverride);
      expect(before.mission).toBe("Reach the city");

      // Org changes its mission; the campus never overrode mission → it inherits.
      const orgV2: CampusContentFields = { ...orgDefault, mission: "Reach the whole region" };
      const after = resolveForCampus(orgV2, sparseOverride);

      expect(after.mission).toBe("Reach the whole region"); // propagated live
      expect(after.heroImage).toBe("files/campus-hero.jpg"); // the campus override held
    });

    it("an override-only field (absent from the org default) still resolves to the campus value", () => {
      const resolved = resolveForCampus({}, { instagramUrl: "https://instagram.com/campus" });
      expect(resolved.instagramUrl).toBe("https://instagram.com/campus");
    });
  });
});
