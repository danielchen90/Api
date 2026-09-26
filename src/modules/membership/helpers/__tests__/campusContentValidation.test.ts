import { validateCampusContent, MAX_PHOTOS } from "../CampusContentValidation.js";
import { HIDDEN } from "../CampusContentResolver.js";

describe("campusContent write validation (photos + center contact fields)", () => {
  it("accepts and trims valid values", () => {
    const { content, errors } = validateCampusContent({
      photos: ["  https://cdn.example.org/a.jpg ", "", "http://localhost:8084/content/CHU1/x.jpg"],
      leaders: "  Pastor Jane Doe ",
      phone: " (217) 555-0100 ",
      email: " hello@example.org ",
      whatToExpect: "Line one\r\nLine two",
      mission: "untouched"
    });
    expect(errors).toEqual([]);
    expect(content.photos).toEqual(["https://cdn.example.org/a.jpg", "http://localhost:8084/content/CHU1/x.jpg"]);
    expect(content.leaders).toBe("Pastor Jane Doe");
    expect(content.phone).toBe("(217) 555-0100");
    expect(content.email).toBe("hello@example.org");
    expect(content.whatToExpect).toBe("Line one\nLine two");
    expect(content.mission).toBe("untouched");
  });

  it("rejects non-URL photos, non-string entries and more than 12 photos", () => {
    expect(validateCampusContent({ photos: ["not a url"] }).errors).toHaveLength(1);
    expect(validateCampusContent({ photos: ["javascript:alert(1)"] }).errors).toHaveLength(1);
    expect(validateCampusContent({ photos: [42] }).errors).toHaveLength(1);
    expect(validateCampusContent({ photos: "https://x.org/a.jpg" }).errors).toHaveLength(1);
    const many = Array.from({ length: MAX_PHOTOS + 1 }, (_, i) => `https://x.org/${i}.jpg`);
    expect(validateCampusContent({ photos: many }).errors).toEqual([`A center can have at most ${MAX_PHOTOS} photos.`]);
    expect(validateCampusContent({ photos: many.slice(0, MAX_PHOTOS) }).errors).toEqual([]);
  });

  it("enforces text limits and the email format", () => {
    expect(validateCampusContent({ leaders: "x".repeat(201) }).errors).toHaveLength(1);
    expect(validateCampusContent({ leaders: "x".repeat(200) }).errors).toHaveLength(0);
    expect(validateCampusContent({ phone: "1".repeat(41) }).errors).toHaveLength(1);
    expect(validateCampusContent({ email: "a@" + "b".repeat(116) + ".org" }).errors.length).toBeGreaterThan(0);
    expect(validateCampusContent({ email: "not-an-email" }).errors).toEqual(["Email is not a valid email address."]);
    expect(validateCampusContent({ whatToExpect: "x".repeat(2001) }).errors).toHaveLength(1);
    expect(validateCampusContent({ whatToExpect: 5 }).errors).toHaveLength(1);
  });

  it("allows blanks (inherit) and the HIDDEN sentinel on every new field", () => {
    const { errors, content } = validateCampusContent({ photos: HIDDEN, leaders: HIDDEN, phone: "", email: HIDDEN, whatToExpect: null });
    expect(errors).toEqual([]);
    expect(content.photos).toBe(HIDDEN);
    expect(content.phone).toBe("");
  });
});

describe("center announcements (members round)", () => {
  // Imported lazily so the file header stays as it was.
  const { validateCampusContent: validate, currentAnnouncements, toPublicCampusContent, MAX_ANNOUNCEMENTS } = jest.requireActual("../CampusContentValidation.js");

  it("cleans plain text, assigns ids, keeps optional dates", () => {
    const { content, errors } = validate({
      announcements: [
        { title: "  Harvest <b>Sunday</b> ", body: "Bring food.\r\nLunch after.", startsOn: "2026-09-20", endsOn: "2026-10-12" },
        { id: "keep-me", title: "New members class", body: "" },
        { title: "", body: "", startsOn: "", endsOn: "" }
      ]
    });
    expect(errors).toEqual([]);
    expect(content.announcements).toHaveLength(2);
    expect(content.announcements[0]).toMatchObject({ title: "Harvest Sunday", body: "Bring food.\nLunch after.", startsOn: "2026-09-20", endsOn: "2026-10-12" });
    expect(content.announcements[0].id).toMatch(/^[A-Za-z0-9_-]{1,24}$/);
    expect(content.announcements[1]).toEqual({ id: "keep-me", title: "New members class", body: "" });
  });

  it("enforces title 120, body 1500, max 10, valid dates and order", () => {
    const tooMany = Array.from({ length: MAX_ANNOUNCEMENTS + 1 }, (_, i) => ({ title: "A" + i }));
    expect(validate({ announcements: tooMany }).errors.join(" ")).toContain("at most 10");
    const { errors } = validate({
      announcements: [
        { title: "x".repeat(121) },
        { title: "ok", body: "y".repeat(1501) },
        { title: "", body: "no title" },
        { title: "bad", startsOn: "2026-02-30" },
        { title: "backwards", startsOn: "2026-10-10", endsOn: "2026-10-01" }
      ]
    });
    expect(errors).toHaveLength(5);
    expect(validate({ announcements: "nope" }).errors).toEqual(["Announcements must be a list."]);
    expect(validate({ announcements: HIDDEN }).errors).toEqual([]);
  });

  it("the public DTO keeps only announcements in their window (inclusive, time-zone generous)", () => {
    const list = [
      { id: "a", title: "Always", body: "" },
      { id: "b", title: "Current", body: "", startsOn: "2026-09-20", endsOn: "2026-10-12" },
      { id: "c", title: "Future", body: "", startsOn: "2026-12-01" },
      { id: "d", title: "Past", body: "", endsOn: "2026-07-31" },
      { id: "e", title: "Ends today", body: "", endsOn: "2026-09-26" },
      { id: "f", title: "Starts today", body: "", startsOn: "2026-09-26" }
    ];
    const now = new Date("2026-09-26T12:00:00Z");
    expect(currentAnnouncements(list, now).map((a: any) => a.id)).toEqual(["a", "b", "e", "f"]);
    const dto: any = toPublicCampusContent({ announcements: [...list, { id: "z", title: "Leaky", body: "", secret: "S3CRET" } as any] }, now);
    expect(dto.announcements.map((a: any) => a.id)).toEqual(["a", "b", "e", "f", "z"]);
    expect(JSON.stringify(dto)).not.toContain("S3CRET");
    for (const a of dto.announcements) for (const k of Object.keys(a)) expect(["id", "title", "body", "startsOn", "endsOn"]).toContain(k);
    expect(toPublicCampusContent({ announcements: HIDDEN } as any, now).announcements).toEqual([]);
  });
});
