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
