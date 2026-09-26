// My Church + Mary Banks ID member logic (DB-free). Drives the REAL MemberAccountService over an
// in-memory fake of the membership repos and a fake Keycloak admin port, so linking rules,
// claim safety, email-code limits and the DTO whitelists are all checked without I/O.
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || "test-encryption-key-0123456789abcd";

import { MemberAccountService, MemberError, LINK_REVIEW_TYPE } from "../mbid/MemberAccountService.js";
import { EmailCodeHelper } from "../mbid/EmailCodeHelper.js";
import type { KeycloakUser, MbidAdminPort } from "../mbid/KeycloakAdminClient.js";

const CHURCH = { id: "CHU1", subDomain: "bti" };
const CAMPUSES = [{ id: "CAM1", name: "Main Campus", slug: "main" }, { id: "CAM2", name: "Chatham Campus", slug: "chatham" }];

function makeWorld() {
  const users: any[] = [];
  const people: any[] = [];
  const userChurches: any[] = [];
  const codes: any[] = [];
  const submissions: any[] = [];
  const audits: any[] = [];
  const kcUsers: Record<string, KeycloakUser> = {};
  const sent: { email: string; code: string }[] = [];
  let seq = 0;
  const id = (p: string) => p + String(++seq).padStart(4, "0");
  const lc = (s: string) => (s || "").trim().toLowerCase();

  const repos: any = {
    church: { loadBySubDomain: async (sd: string) => (sd === CHURCH.subDomain ? CHURCH : null) },
    campus: { loadAll: async () => CAMPUSES },
    user: {
      loadByEmail: async (e: string) => users.find((u) => lc(u.email) === lc(e)) || null,
      load: async (uid: string) => users.find((u) => u.id === uid) || null,
      loadByIds: async (ids: string[]) => users.filter((u) => ids.includes(u.id)),
      save: async (u: any) => { u.id = id("USR"); users.push(u); return u; }
    },
    person: {
      load: async (_c: string, pid: string) => people.find((p) => p.id === pid && !p.removed) || null,
      loadByHousehold: async (_c: string, hh: string) => people.filter((p) => p.householdId === hh && !p.removed)
    },
    personOrdination: { loadForPerson: async (_c: string, pid: string) => (pid === "P_MINISTER" ? [{ ordinationTypeId: "OT1", status: "active", grantedDate: "2024-05-12", credentialNumber: "L-1", expirationDate: "2027-05-12" }] : []) },
    ordinationType: { loadAll: async () => [{ id: "OT1", name: "Elder" }] },
    userCampus: { loadCampusIdsForUser: async () => ["CAM2"] },
    formSubmission: { createPublic: async (s: any) => { s.id = id("SUB"); s.unread = true; submissions.push(s); return s; } },
    memberAccount: {
      loadUserByMbidSub: async (sub: string) => users.find((u) => u.mbidSub === sub) || null,
      loadMbidSub: async (uid: string) => users.find((u) => u.id === uid)?.mbidSub || null,
      setMbidSub: async (uid: string, sub: string) => { users.find((u) => u.id === uid).mbidSub = sub; },
      findPeopleByEmails: async (_c: string, emails: string[]) => people.filter((p) => !p.removed && emails.map(lc).includes(lc(p.email))),
      loadLinkedUserIds: async (_c: string, pid: string) => {
        const ids = new Set<string>(userChurches.filter((uc) => uc.personId === pid).map((uc) => uc.userId));
        const p = people.find((x) => x.id === pid);
        if (p?.userId) ids.add(p.userId);
        return [...ids];
      },
      loadUserChurch: async (uid: string) => userChurches.find((uc) => uc.userId === uid) || null,
      ensureUserChurch: async (uid: string, cid: string) => {
        let uc = userChurches.find((x) => x.userId === uid && x.churchId === cid);
        if (!uc) { uc = { id: id("UC"), userId: uid, churchId: cid, personId: null }; userChurches.push(uc); }
        return uc;
      },
      linkPerson: async (cid: string, uid: string, pid: string) => {
        const uc = await repos.memberAccount.ensureUserChurch(uid, cid);
        uc.personId = pid;
        people.find((p) => p.id === pid).userId = uid;
      },
      updatePersonFields: async (_c: string, pid: string, f: any) => Object.assign(people.find((p) => p.id === pid), f),
      loadSubmissionsForEmails: async (_c: string, emails: string[], exclude: string[]) =>
        submissions.filter((s) => emails.map(lc).includes(lc(s.submitterEmail)) && !exclude.includes(s.submissionType)).map((s) => ({ ...s, submissionDate: s.submissionDate || new Date() })),
      countCodesSince: async (uid: string, since: Date) => codes.filter((c) => c.userId === uid && c.createdAt >= since).length,
      insertCode: async (row: any) => { codes.forEach((c) => { if (c.userId === row.userId && c.email === row.email && !c.consumedAt) c.consumedAt = new Date(); }); const r = { ...row, id: id("CODE"), attempts: 0, consumedAt: null, createdAt: new Date() }; codes.push(r); return r.id; },
      loadLatestCode: async (uid: string, email: string) => { const c = [...codes].reverse().find((x) => x.userId === uid && x.email === email); return c ? { ...c } : null; },
      incrementCodeAttempts: async (cid: string) => { codes.find((c) => c.id === cid).attempts++; },
      consumeCode: async (cid: string) => { codes.find((c) => c.id === cid).consumedAt = new Date(); }
    }
  };

  const admin: MbidAdminPort = {
    getUser: async (sub: string) => kcUsers[sub] || null,
    findOtherAccountsWithEmail: async (email: string, exclude: string) =>
      Object.values(kcUsers).filter((u) => u.id !== exclude && (lc(u.email || "") === lc(email) || (u.attributes?.verifiedEmails || []).map(lc).includes(lc(email)))).map((u) => u.id),
    setVerifiedEmails: async (sub: string, emails: string[]) => {
      kcUsers[sub].attributes = { ...(kcUsers[sub].attributes || {}), verifiedEmails: emails };
      return emails.filter((e) => lc(e) !== lc(kcUsers[sub].email || ""));
    }
  };

  const svc = new MemberAccountService({
    repos,
    admin,
    sendCode: async (email, code) => { sent.push({ email, code }); },
    audit: (churchId, userId, category, action, entityType, entityId, details) => { audits.push({ churchId, userId, category, action, entityType, entityId, details }); },
    loadPermissions: async (uid: string) => (uid === "STAFF" ? [{ keyName: "MembershipApi", permissions: [{ contentType: "People", action: "Edit" }] }] : []),
    contentRoot: "https://content.example"
  });
  return { svc, users, people, userChurches, codes, submissions, audits, kcUsers, sent, repos };
}

const claims = (over: any = {}) => ({ sub: "kc-sub-1", email: "mary@example.org", email_verified: true, given_name: "Mary", family_name: "Banks", ...over });

describe("Mary Banks ID sign-in (signIn)", () => {
  it("creates a user for a new Mary Banks ID, stores the sub, joins the church, creates no person", async () => {
    const w = makeWorld();
    const r = await w.svc.signIn(claims(), "bti");
    expect(r.user.email).toBe("mary@example.org");
    expect(w.users[0].mbidSub).toBe("kc-sub-1");
    expect(w.users[0].password).toMatch(/^\$2/); // an unusable random bcrypt hash, never blank
    expect(w.userChurches).toHaveLength(1);
    expect(w.people).toHaveLength(0);
    expect(r.linkedPersonId).toBeNull();
  });

  it("finds the user again by sub even when the Mary Banks ID email changed", async () => {
    const w = makeWorld();
    await w.svc.signIn(claims(), "bti");
    const r = await w.svc.signIn(claims({ email: "new-address@example.org" }), "bti");
    expect(w.users).toHaveLength(1);
    expect(r.user.id).toBe(w.users[0].id);
  });

  it("links an existing ChurchApps user by PRIMARY email only, never by verified_emails", async () => {
    const w = makeWorld();
    w.users.push({ id: "U_OLD", email: "old@example.org", firstName: "Old" });
    await w.svc.signIn(claims({ verified_emails: ["old@example.org"] }), "bti");
    expect(w.users.find((u) => u.id === "U_OLD").mbidSub).toBeUndefined();
    expect(w.users).toHaveLength(2);
    const w2 = makeWorld();
    w2.users.push({ id: "U_MARY", email: "Mary@Example.org", firstName: "Mary" });
    const r = await w2.svc.signIn(claims(), "bti");
    expect(r.user.id).toBe("U_MARY");
    expect(w2.users[0].mbidSub).toBe("kc-sub-1");
  });

  it("refuses to re-link an account that already belongs to a different Mary Banks ID", async () => {
    const w = makeWorld();
    w.users.push({ id: "U_MARY", email: "mary@example.org", mbidSub: "kc-other" });
    await expect(w.svc.signIn(claims(), "bti")).rejects.toMatchObject({ status: 409, code: "account_conflict" });
  });

  it("auto-links exactly one unlinked person with the primary email", async () => {
    const w = makeWorld();
    w.people.push({ id: "P1", email: "MARY@example.org", firstName: "Mary", lastName: "Banks", campusId: "CAM1" });
    const r = await w.svc.signIn(claims(), "bti");
    expect(r.linkedPersonId).toBe("P1");
    expect(w.people[0].userId).toBe(r.user.id);
    expect(w.audits.some((a) => a.action === "person_linked" && a.entityId === "P1")).toBe(true);
  });

  it("does not auto-link when two people share the email, or the one match belongs to another user", async () => {
    const w = makeWorld();
    w.people.push({ id: "P1", email: "mary@example.org" }, { id: "P2", email: "mary@example.org" });
    expect((await w.svc.signIn(claims(), "bti")).linkedPersonId).toBeNull();
    const w2 = makeWorld();
    w2.people.push({ id: "P1", email: "mary@example.org", userId: "U_SOMEONE" });
    expect((await w2.svc.signIn(claims(), "bti")).linkedPersonId).toBeNull();
    expect(w2.people[0].userId).toBe("U_SOMEONE");
  });

  it("never links a person by an unverified-but-listed extra email", async () => {
    const w = makeWorld();
    w.people.push({ id: "P_OLD", email: "old@example.org" });
    const r = await w.svc.signIn(claims({ verified_emails: ["old@example.org"] }), "bti");
    expect(r.linkedPersonId).toBeNull();
  });

  it("keeps an existing person link", async () => {
    const w = makeWorld();
    w.people.push({ id: "P1", email: "someone-else@example.org" }, { id: "P2", email: "mary@example.org" });
    const first = await w.svc.signIn(claims(), "bti");
    w.userChurches[0].personId = "P1";
    const again = await w.svc.signIn(claims(), "bti");
    expect(first.linkedPersonId).toBe("P2");
    expect(again.linkedPersonId).toBe("P1");
  });

  it("unknown church -> 400 unknown_church", async () => {
    const w = makeWorld();
    await expect(w.svc.signIn(claims(), "nope")).rejects.toMatchObject({ status: 400, code: "unknown_church" });
  });
});

async function signedInMember(w: ReturnType<typeof makeWorld>, opts: { verified?: string[] } = {}) {
  const r = await w.svc.signIn(claims(), "bti");
  w.kcUsers["kc-sub-1"] = { id: "kc-sub-1", email: "mary@example.org", attributes: opts.verified ? { verifiedEmails: opts.verified, partner_tier: ["partner"], partner_since: ["2025-01-01"] } : {} };
  return r.user.id as string;
}

describe("My Church overview + candidates", () => {
  it("returns only the caller's data, and candidates carry name + center only", async () => {
    const w = makeWorld();
    w.people.push({ id: "P_OLD", email: "old@example.org", firstName: "Mary", lastName: "Old", displayName: "Mary Old", campusId: "CAM2", mobilePhone: "555-SECRET", address1: "1 Private Ln", householdId: "HH9", birthDate: "1970-01-01" });
    const uid = await signedInMember(w, { verified: ["old@example.org"] });
    const o = await w.svc.overview(uid, "CHU1");
    expect(o.person).toBeNull();
    expect(o.verifiedEmails).toEqual(["old@example.org"]);
    expect(o.partner).toEqual({ tier: "partner", status: null, since: "2025-01-01" });
    expect(o.candidates).toEqual([{ personId: "P_OLD", displayName: "Mary Old", campusName: "Chatham Campus" }]);
    const serialized = JSON.stringify(o.candidates);
    for (const secret of ["555-SECRET", "1 Private Ln", "HH9", "1970", "old@example.org"]) expect(serialized).not.toContain(secret);
    expect(Object.keys(o).sort()).toEqual([
      "candidates", "credentials", "household", "partner", "person", "staff", "user", "verifiedEmails"
    ]);
    expect(o.staff).toEqual({ isAdmin: false, campuses: [] });
  });

  it("offers no candidates once a record is linked, and shows credentials + household", async () => {
    const w = makeWorld();
    w.people.push({ id: "P_MINISTER", email: "mary@example.org", firstName: "Mary", lastName: "Banks", householdId: "HH1", householdRole: "Head", campusId: "CAM1" });
    w.people.push({ id: "P_KID", email: "mary@example.org", firstName: "Kid", lastName: "Banks", householdId: "HH1", householdRole: "Child" });
    w.people[1].email = "kid@example.org";
    const uid = await signedInMember(w, { verified: [] });
    const o = await w.svc.overview(uid, "CHU1");
    expect(o.person?.id).toBe("P_MINISTER");
    expect(o.person?.campusSlug).toBe("main");
    expect(o.candidates).toEqual([]);
    expect(o.household.map((h: any) => h.personId).sort()).toEqual(["P_KID", "P_MINISTER"]);
    expect(Object.keys(o.household[0]).sort()).toEqual(["displayName", "personId", "photo", "role"]);
    expect(o.credentials).toEqual([{ type: "Elder", ordainedOn: "2024-05-12", status: "active", licenseNumber: "L-1", licenseExpires: "2027-05-12" }]);
  });

  it("staff: admins see isAdmin and the centers they may open", async () => {
    const w = makeWorld();
    w.users.push({ id: "STAFF", email: "staff@example.org", firstName: "S" });
    const o = await w.svc.overview("STAFF", "CHU1");
    expect(o.staff).toEqual({ isAdmin: true, campuses: [{ id: "CAM2", name: "Chatham Campus" }] });
  });
});

describe("claim (Is this you?)", () => {
  it("refuses a person that does not match one of the caller's verified emails (404, same as unknown)", async () => {
    const w = makeWorld();
    w.people.push({ id: "P_STRANGER", email: "stranger@example.org" });
    const uid = await signedInMember(w, { verified: [] });
    await expect(w.svc.claim(uid, "CHU1", "P_STRANGER")).rejects.toMatchObject({ status: 404, code: "not_found" });
    await expect(w.svc.claim(uid, "CHU1", "P_DOES_NOT_EXIST")).rejects.toMatchObject({ status: 404, code: "not_found" });
    expect(w.people[0].userId).toBeUndefined();
  });

  it("links an unlinked matching person", async () => {
    const w = makeWorld();
    w.people.push({ id: "P_OLD", email: "old@example.org", campusId: "CAM2" });
    const uid = await signedInMember(w, { verified: ["old@example.org"] });
    expect(await w.svc.claim(uid, "CHU1", "P_OLD")).toEqual({ linked: true });
    expect(w.people[0].userId).toBe(uid);
    expect(w.userChurches.find((uc) => uc.userId === uid).personId).toBe("P_OLD");
    expect(w.audits.some((a) => a.action === "person_claimed")).toBe(true);
  });

  it("a person held by another account goes to that center's inbox for review, and is not moved", async () => {
    const w = makeWorld();
    w.users.push({ id: "U_OTHER", email: "other@example.org", firstName: "Jane", lastName: "Other" });
    w.people.push({ id: "P_HELD", email: "old@example.org", firstName: "Mary", lastName: "Old", campusId: "CAM2" });
    w.userChurches.push({ id: "UCX", userId: "U_OTHER", churchId: "CHU1", personId: "P_HELD" });
    const uid = await signedInMember(w, { verified: ["old@example.org"] });
    expect(await w.svc.claim(uid, "CHU1", "P_HELD")).toEqual({ linked: false, review: true });
    expect(w.userChurches.find((uc) => uc.id === "UCX").personId).toBe("P_HELD");
    expect(w.submissions).toHaveLength(1);
    expect(w.submissions[0]).toMatchObject({ submissionType: LINK_REVIEW_TYPE, campusId: "CAM2", churchId: "CHU1" });
    expect(w.submissions[0].message).toContain("Mary Old");
    expect(w.submissions[0].message).not.toMatch(/\u2014/); // no em dashes in user-visible text
    // The review item never shows up in the member's own submissions (it names the other account).
    const mine = await w.svc.submissions(uid, "CHU1");
    expect(mine).toEqual([]);
  });
});

describe("own record (POST /me/person)", () => {
  it("404 when nothing is linked", async () => {
    const w = makeWorld();
    const uid = await signedInMember(w);
    await expect(w.svc.updatePerson(uid, "CHU1", { firstName: "X" })).rejects.toMatchObject({ status: 404 });
  });

  it("validates lengths, required names and the campus; updates only allowed columns", async () => {
    const w = makeWorld();
    w.people.push({ id: "P1", email: "mary@example.org", firstName: "Mary", lastName: "Banks", homePhone: "111", membershipStatus: "Member" });
    const uid = await signedInMember(w);
    await expect(w.svc.updatePerson(uid, "CHU1", { firstName: "" })).rejects.toMatchObject({ status: 400 });
    await expect(w.svc.updatePerson(uid, "CHU1", { zip: "12345678901" })).rejects.toMatchObject({ status: 400 });
    await expect(w.svc.updatePerson(uid, "CHU1", { campusId: "CAM_OTHER_CHURCH" })).rejects.toMatchObject({ status: 400 });
    const dto = await w.svc.updatePerson(uid, "CHU1", { phone: "222", campusId: "CAM2", membershipStatus: "Staff", email: "hijack@example.org", userId: "U_X" });
    expect(dto.phone).toBe("222");
    expect(w.people[0].homePhone).toBe("222"); // same field the overview showed
    expect(w.people[0].campusId).toBe("CAM2");
    expect(w.people[0].membershipStatus).toBe("Member");
    expect(w.people[0].email).toBe("mary@example.org");
  });
});

describe("verified extra emails", () => {
  it("start: already_yours / other_account / invalid", async () => {
    const w = makeWorld();
    const uid = await signedInMember(w, { verified: ["old@example.org"] });
    w.kcUsers["kc-2"] = { id: "kc-2", email: "taken@example.org", attributes: { verifiedEmails: ["claimed@example.org"] } };
    await expect(w.svc.startEmail(uid, "MARY@example.org")).rejects.toMatchObject({ status: 409, code: "already_yours" });
    await expect(w.svc.startEmail(uid, "old@example.org")).rejects.toMatchObject({ status: 409, code: "already_yours" });
    await expect(w.svc.startEmail(uid, "taken@example.org")).rejects.toMatchObject({ status: 409, code: "other_account" });
    await expect(w.svc.startEmail(uid, "Claimed@Example.org")).rejects.toMatchObject({ status: 409, code: "other_account" });
    await expect(w.svc.startEmail(uid, "not-an-email")).rejects.toMatchObject({ status: 400 });
    expect(w.sent).toHaveLength(0);
  });

  it("start stores only a hash, sends the code, and limits sends to 5 per hour", async () => {
    const w = makeWorld();
    const uid = await signedInMember(w);
    for (let i = 0; i < 5; i++) expect(await w.svc.startEmail(uid, "new@example.org")).toEqual({ sent: true });
    await expect(w.svc.startEmail(uid, "new@example.org")).rejects.toMatchObject({ status: 429 });
    const code = w.sent[4].code;
    expect(code).toMatch(/^\d{6}$/);
    for (const row of w.codes) {
      expect(JSON.stringify(row)).not.toContain(code);
      expect(row.codeHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("verify: wrong code 400, then 429 after 5 tries", async () => {
    const w = makeWorld();
    const uid = await signedInMember(w);
    await w.svc.startEmail(uid, "new@example.org");
    const wrong = w.sent[0].code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 4; i++) await expect(w.svc.verifyEmail(uid, "CHU1", "new@example.org", wrong)).rejects.toMatchObject({ status: 400, code: "wrong_code" });
    await expect(w.svc.verifyEmail(uid, "CHU1", "new@example.org", wrong)).rejects.toMatchObject({ status: 429 });
    await expect(w.svc.verifyEmail(uid, "CHU1", "new@example.org", w.sent[0].code)).rejects.toMatchObject({ status: 429 });
  });

  it("verify: expired -> 410", async () => {
    const w = makeWorld();
    const uid = await signedInMember(w);
    await w.svc.startEmail(uid, "new@example.org");
    w.codes[0].expiresAt = new Date(Date.now() - 1000);
    await expect(w.svc.verifyEmail(uid, "CHU1", "new@example.org", w.sent[0].code)).rejects.toMatchObject({ status: 410, code: "expired" });
  });

  it("verify: success writes Keycloak verifiedEmails and returns fresh candidates; the code is single-use", async () => {
    const w = makeWorld();
    w.people.push({ id: "P_NEW", email: "new@example.org", firstName: "Mary", lastName: "New", campusId: "CAM1" });
    const uid = await signedInMember(w);
    await w.svc.startEmail(uid, "New@Example.org");
    const r = await w.svc.verifyEmail(uid, "CHU1", "new@example.org", w.sent[0].code);
    expect(r.verifiedEmails).toEqual(["new@example.org"]);
    expect(r.candidates).toEqual([{ personId: "P_NEW", displayName: "Mary New", campusName: "Main Campus" }]);
    expect(w.kcUsers["kc-sub-1"].attributes?.verifiedEmails).toEqual(["new@example.org"]);
    await expect(w.svc.verifyEmail(uid, "CHU1", "new@example.org", w.sent[0].code)).rejects.toMatchObject({ status: 400, code: "wrong_code" });
  });

  it("verify re-checks for another account at write time", async () => {
    const w = makeWorld();
    const uid = await signedInMember(w);
    await w.svc.startEmail(uid, "new@example.org");
    w.kcUsers["kc-2"] = { id: "kc-2", email: "new@example.org" };
    await expect(w.svc.verifyEmail(uid, "CHU1", "new@example.org", w.sent[0].code)).rejects.toMatchObject({ status: 409, code: "other_account" });
    expect(w.kcUsers["kc-sub-1"].attributes?.verifiedEmails).toBeUndefined();
  });

  it("remove drops the address from Keycloak but keeps linked records linked", async () => {
    const w = makeWorld();
    w.people.push({ id: "P_OLD", email: "old@example.org" });
    const uid = await signedInMember(w, { verified: ["old@example.org"] });
    await w.svc.claim(uid, "CHU1", "P_OLD");
    expect(await w.svc.removeEmail(uid, "CHU1", "old@example.org")).toEqual({ verifiedEmails: [] });
    expect(w.people[0].userId).toBe(uid);
  });

  it("the code hash depends on the server key, the salt, the user and the address", () => {
    const h = EmailCodeHelper.hash("123456", "salt", "U1", "a@b.co");
    expect(h).toHaveLength(64);
    expect(EmailCodeHelper.hash("123456", "salt2", "U1", "a@b.co")).not.toBe(h);
    expect(EmailCodeHelper.hash("123456", "salt", "U2", "a@b.co")).not.toBe(h);
    expect(EmailCodeHelper.matches("123456", "salt", "U1", "a@b.co", h)).toBe(true);
    expect(EmailCodeHelper.matches("654321", "salt", "U1", "a@b.co", h)).toBe(false);
    expect(EmailCodeHelper.bodyText("123456")).toBe("Your code is 123456. Enter it to add this email to your Mary Banks ID. If you didn't ask for this, ignore this email.");
    expect(EmailCodeHelper.subject).toBe("Your Bible Teachers International code");
  });
});

describe("own submissions", () => {
  it("matches primary + verified emails, newest first, whitelisted fields, status from the inbox", async () => {
    const w = makeWorld();
    const uid = await signedInMember(w, { verified: ["old@example.org"] });
    w.submissions.push(
      { id: "S1", submissionType: "prayer", submitterEmail: "OLD@example.org", campusId: "CAM2", message: "Pray", unread: 0, submissionDate: new Date("2026-09-01"), submitterPhone: "555-SECRET" },
      { id: "S2", submissionType: "visit", submitterEmail: "someone@else.org", campusId: "CAM1", message: "Not mine", unread: 1 }
    );
    const mine = await w.svc.submissions(uid, "CHU1");
    expect(mine).toEqual([{ id: "S1", type: "prayer", campusName: "Chatham Campus", createdAt: "2026-09-01T00:00:00.000Z", message: "Pray", status: "read" }]);
  });
});

describe("MemberError", () => {
  it("carries a status and a code", () => {
    const e = new MemberError(409, "other_account");
    expect(e.status).toBe(409);
    expect(e.code).toBe("other_account");
  });
});
