import { PublicFormSubmissionHelper } from "../PublicFormSubmissionHelper.js";

const NOW = new Date("2030-06-15T15:00:00Z");

describe("PublicFormSubmissionHelper: Next Steps types + visit extras", () => {
  it("accepts the Next Steps types alongside prayer/contact", () => {
    expect(PublicFormSubmissionHelper.VALID_TYPES).toEqual(["prayer", "contact", "visit", "salvation", "baptism", "serve", "discipleship"]);
    expect(PublicFormSubmissionHelper.MESSAGE_REQUIRED_TYPES).toEqual(["prayer", "contact"]);
  });

  it("valid visit extras are cleaned and stored", () => {
    const r = PublicFormSubmissionHelper.validateVisitExtra({ visitDate: "2030-06-21", partySize: "4", notes: "  Two kids  " }, NOW);
    expect(r.error).toBeUndefined();
    expect(r.extra).toEqual({ visitDate: "2030-06-21", partySize: 4, notes: "Two kids" });
    expect(PublicFormSubmissionHelper.validateVisitExtra({ visitDate: "2030-06-15T00:00:00.000Z" }, NOW).extra).toEqual({ visitDate: "2030-06-15" });
  });

  it("no extras -> null (the fields are optional)", () => {
    expect(PublicFormSubmissionHelper.validateVisitExtra({}, NOW)).toEqual({ extra: null });
  });

  it("visitDate must be a real date between today and +365 days", () => {
    expect(PublicFormSubmissionHelper.validateVisitExtra({ visitDate: "tomorrow" }, NOW).error).toBeDefined();
    expect(PublicFormSubmissionHelper.validateVisitExtra({ visitDate: "2030-02-30" }, NOW).error).toBeDefined();
    expect(PublicFormSubmissionHelper.validateVisitExtra({ visitDate: "2030-06-01" }, NOW).error).toBe("Visit date cannot be in the past.");
    expect(PublicFormSubmissionHelper.validateVisitExtra({ visitDate: "2031-06-16" }, NOW).error).toBe("Visit date must be within the next year.");
    expect(PublicFormSubmissionHelper.validateVisitExtra({ visitDate: "2031-06-15" }, NOW).error).toBeUndefined();
  });

  it("partySize is a whole number 1..20, notes max 1000", () => {
    for (const bad of [0, 21, 2.5, "abc", -1]) expect(PublicFormSubmissionHelper.validateVisitExtra({ partySize: bad }, NOW).error).toBeDefined();
    expect(PublicFormSubmissionHelper.validateVisitExtra({ partySize: 20 }, NOW).error).toBeUndefined();
    expect(PublicFormSubmissionHelper.validateVisitExtra({ notes: "x".repeat(1001) }, NOW).error).toBeDefined();
    expect(PublicFormSubmissionHelper.validateVisitExtra({ notes: { a: 1 } }, NOW).error).toBeDefined();
  });

  it("honeypot and rate limit behave as before", () => {
    expect(PublicFormSubmissionHelper.isBot({ website: "http://spam" })).toBe(true);
    expect(PublicFormSubmissionHelper.isBot({ website: "" })).toBe(false);
    const ip = "10.9.9." + Math.floor(Math.random() * 200);
    for (let i = 0; i < 5; i++) expect(PublicFormSubmissionHelper.rateLimit(ip, "visit")).toBe(true);
    expect(PublicFormSubmissionHelper.rateLimit(ip, "visit")).toBe(false);
  });
});
