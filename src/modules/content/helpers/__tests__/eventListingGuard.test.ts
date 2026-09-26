// Write-side campus scoping for the public-website listing fields on events (mirrors the
// membership assertWritableCampus rules): campus admins publish only for their own center.
import { canWriteListing, changedListingKeys, validateListingFields, type ListingScope } from "../EventListingGuard.js";

const ALL: ListingScope = { mode: "all" };
const A: ListingScope = { mode: "scoped", campusIds: ["CAM_A"] };
const DENY: ListingScope = { mode: "deny" };

describe("EventListingGuard", () => {
  it("org-wide scope may publish network-wide and to any center", () => {
    expect(canWriteListing(ALL, { publicListing: true, campusId: null }, null)).toBe(true);
    expect(canWriteListing(ALL, { publicListing: true, campusId: "CAM_B" }, null)).toBe(true);
  });

  it("a campus admin may publish only to their own center, never network-wide", () => {
    expect(canWriteListing(A, { publicListing: true, campusId: "CAM_A" }, null)).toBe(true);
    expect(canWriteListing(A, { publicListing: true, campusId: "CAM_B" }, null)).toBe(false);
    expect(canWriteListing(A, { publicListing: true, campusId: null }, null)).toBe(false);
  });

  it("a campus admin cannot unpublish, re-home or edit the listing of another center's event", () => {
    const listedB = { id: "E1", publicListing: 1, campusId: "CAM_B", location: "Hall" };
    expect(canWriteListing(A, { publicListing: false }, listedB)).toBe(false);
    expect(canWriteListing(A, { campusId: "CAM_A" }, listedB)).toBe(false);
    expect(canWriteListing(A, { location: "Elsewhere" }, listedB)).toBe(false);
  });

  it("round-tripping unchanged listing values is not a listing change (group leaders can still edit titles)", () => {
    const listedB = { id: "E1", publicListing: 1, campusId: "CAM_B", location: "Hall", registrationUrl: null, image: null };
    const incoming = { id: "E1", title: "New title", publicListing: true, campusId: "CAM_B", location: "Hall", registrationUrl: "", image: null };
    expect(changedListingKeys(incoming, listedB)).toEqual([]);
    expect(canWriteListing(DENY, incoming, listedB)).toBe(true);
  });

  it("a deny scope cannot publish anything", () => {
    expect(canWriteListing(DENY, { publicListing: true, campusId: "CAM_A" }, null)).toBe(false);
    expect(canWriteListing(DENY, { campusId: "CAM_A" }, null)).toBe(false);
    // plain events without listing fields are unaffected
    expect(canWriteListing(DENY, { title: "Group night" }, null)).toBe(true);
  });

  it("validates listing fields: known campus, http(s) links, lengths", () => {
    const ev: any = { publicListing: "1", campusId: "CAM_X", registrationUrl: "javascript:alert(1)", image: "ftp://x", location: " Hall " };
    const errors = validateListingFields(ev, ["CAM_A"]);
    expect(errors).toEqual(expect.arrayContaining(["Unknown worship center."]));
    expect(errors.some((e) => e.startsWith("Registration link"))).toBe(true);
    expect(errors.some((e) => e.startsWith("Image link"))).toBe(true);
    expect(ev.publicListing).toBe(true);
    expect(ev.location).toBe("Hall");

    const ok: any = { publicListing: true, campusId: "CAM_A", registrationUrl: "https://x.org/r", location: "x".repeat(255) };
    expect(validateListingFields(ok, ["CAM_A"])).toEqual([]);
    expect(validateListingFields({ location: "x".repeat(256) }, [])).toHaveLength(1);
  });
});
