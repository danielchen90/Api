import crypto from "crypto";
import bcrypt from "bcryptjs";
import { MbidClaims, MbidTokenVerifier, normalizeEmail, EMAIL_RE } from "./MbidTokenVerifier.js";
import { MbidAdminPort, KeycloakUser, verifiedEmailsOf, partnerOf } from "./KeycloakAdminClient.js";
import { EmailCodeHelper } from "./EmailCodeHelper.js";
import type { MatchedPersonRow } from "../../repositories/MemberAccountRepo.js";

/**
 * The member side of the church platform, DB-free so the suites can drive it with fakes:
 *   - Mary Banks ID sign-in (find/link/create the ChurchApps user, link the church record),
 *   - My Church overview, own-record edits, "Is this you?" claims,
 *   - verified extra emails (codes + Keycloak verifiedEmails),
 *   - the member's own submissions.
 * Every response is built field by field (whitelisted DTOs); nothing returns a raw row.
 */

export class MemberError extends Error {
  constructor(public status: number, public code: string) {
    super(code);
  }
}

export interface MemberDeps {
  repos: any; // membership Repos (user, church, campus, person, household, userChurch, userCampus, personOrdination, ordinationType, formSubmission, memberAccount)
  admin: MbidAdminPort | null; // null when the service client is not configured
  sendCode: (email: string, code: string) => Promise<void>;
  audit: (churchId: string, userId: string, category: string, action: string, entityType: string, entityId: string, details?: object) => Promise<void> | void;
  loadPermissions: (userId: string, churchId: string) => Promise<{ keyName?: string; permissions?: { contentType?: string; action?: string }[] }[]>;
  contentRoot?: string;
  now?: () => Date;
}

export const LINK_REVIEW_TYPE = "link_review";

const PERSON_LIMITS: Record<string, [number, string]> = {
  firstName: [50, "First name"],
  lastName: [50, "Last name"],
  phone: [21, "Phone"],
  address1: [50, "Street address"],
  address2: [50, "Address line 2"],
  city: [30, "City"],
  state: [10, "State"],
  zip: [10, "Postal code"]
};

const displayNameOf = (p: any): string => {
  const d = (p?.displayName || "").trim();
  if (d) return d;
  return [p?.firstName, p?.lastName].filter(Boolean).join(" ").trim() || "Church member";
};

export class MemberAccountService {
  constructor(private deps: MemberDeps) {}

  private get repos() {
    return this.deps.repos;
  }

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  // ─────────────────────────── 1. Mary Banks ID sign-in ───────────────────────────
  /**
   * Given VERIFIED claims (MbidTokenVerifier.verify ran first), find or create the ChurchApps user,
   * make sure they belong to the church, and link their church record when exactly one unlinked
   * person carries their primary email. Returns the user (the controller mints the login token).
   */
  public async signIn(claims: MbidClaims, subDomain: string, ip = ""): Promise<{ user: any; churchId: string; linkedPersonId: string | null }> {
    const { primary } = MbidTokenVerifier.emailsOf(claims);
    if (!primary || !EMAIL_RE.test(primary)) throw new MemberError(403, "email_unverified");
    const sd = (subDomain || "").trim().toLowerCase();
    if (!sd || sd.length > 100) throw new MemberError(400, "unknown_church");
    const church = await this.repos.church.loadBySubDomain(sd);
    if (!church || !church.id) throw new MemberError(400, "unknown_church");

    const acct = this.repos.memberAccount;
    let user = await acct.loadUserByMbidSub(claims.sub);
    if (!user) {
      // Only the PRIMARY (Keycloak-verified) email may pick up an existing account.
      const byEmail = await this.repos.user.loadByEmail(primary);
      if (byEmail) {
        const existingSub = await acct.loadMbidSub(byEmail.id);
        if (existingSub && existingSub !== claims.sub) throw new MemberError(409, "account_conflict");
        await acct.setMbidSub(byEmail.id, claims.sub);
        user = byEmail;
        await this.deps.audit(church.id, user.id, "security", "mbid_linked", "user", user.id, { how: "email" });
      } else {
        const unusable = bcrypt.hashSync(crypto.randomBytes(32).toString("hex"), 10);
        user = await this.repos.user.save({
          email: primary,
          firstName: (claims.given_name || "").slice(0, 45) || primary.split("@")[0].slice(0, 45),
          lastName: (claims.family_name || "").slice(0, 45),
          password: unusable,
          registrationDate: this.now()
        });
        await acct.setMbidSub(user.id, claims.sub);
        await this.deps.audit(church.id, user.id, "security", "mbid_user_created", "user", user.id, {});
      }
    }

    const uc = await acct.ensureUserChurch(user.id, church.id);
    let linkedPersonId: string | null = null;
    const current = uc?.personId ? await this.repos.person.load(church.id, uc.personId) : null;
    if (current && !current.removed) {
      linkedPersonId = current.id;
    } else {
      const matches: MatchedPersonRow[] = await acct.findPeopleByEmails(church.id, [primary]);
      if (matches.length === 1) {
        const others = (await acct.loadLinkedUserIds(church.id, matches[0].id)).filter((id: string) => id !== user.id);
        if (others.length === 0) {
          await acct.linkPerson(church.id, user.id, matches[0].id);
          linkedPersonId = matches[0].id;
          await this.deps.audit(church.id, user.id, "person", "person_linked", "person", matches[0].id, { how: "mbid_primary_email", ip });
        }
      }
    }
    return { user, churchId: church.id, linkedPersonId };
  }

  // ─────────────────────────── shared lookups ───────────────────────────
  private async keycloakUser(userId: string): Promise<{ sub: string | null; kc: KeycloakUser | null }> {
    const sub = await this.repos.memberAccount.loadMbidSub(userId);
    if (!sub || !this.deps.admin) return { sub, kc: null };
    try {
      return { sub, kc: await this.deps.admin.getUser(sub) };
    } catch {
      return { sub, kc: null };
    }
  }

  private async emailsFor(user: any, kc: KeycloakUser | null): Promise<{ primary: string; verified: string[]; all: string[] }> {
    const primary = normalizeEmail(kc?.email || user?.email || "");
    const verified = verifiedEmailsOf(kc).filter((e) => e !== primary);
    return { primary, verified, all: [primary, ...verified].filter(Boolean) };
  }

  private async linkedPerson(userId: string, churchId: string): Promise<any | null> {
    const uc = await this.repos.memberAccount.loadUserChurch(userId, churchId);
    if (!uc?.personId) return null;
    const p = await this.repos.person.load(churchId, uc.personId);
    if (!p || p.removed) return null;
    return p;
  }

  private async campusMap(churchId: string): Promise<Map<string, any>> {
    const rows = ((await this.repos.campus.loadAll(churchId)) as any[]) || [];
    return new Map(rows.map((c: any) => [c.id, c]));
  }

  /** Candidates: people in this church matching one of the member's emails, offered only while no record is linked. */
  public async candidatesFor(_userId: string, churchId: string, emails: string[], linked: any | null, campuses?: Map<string, any>): Promise<{ personId: string; displayName: string; campusName: string | null }[]> {
    if (linked) return [];
    const matches: MatchedPersonRow[] = await this.repos.memberAccount.findPeopleByEmails(churchId, emails);
    const cmap = campuses || (await this.campusMap(churchId));
    return matches.slice(0, 10).map((m) => ({
      personId: m.id,
      displayName: displayNameOf(m),
      campusName: m.campusId ? cmap.get(m.campusId)?.name || null : null
    }));
  }

  private photoUrl(churchId: string, p: any): string | null {
    let photo = "";
    if (p.photoUpdated) photo = "/" + churchId + "/membership/people/" + p.id + ".png?dt=" + new Date(p.photoUpdated).getTime();
    if (!photo) return null;
    const root = (this.deps.contentRoot || "").replace(/\/+$/, "");
    return root + photo;
  }

  private personDto(churchId: string, p: any, campuses: Map<string, any>) {
    const campus = p.campusId ? campuses.get(p.campusId) : null;
    return {
      id: p.id,
      firstName: p.firstName || "",
      lastName: p.lastName || "",
      displayName: displayNameOf(p),
      photo: this.photoUrl(churchId, p),
      email: p.email || "",
      phone: p.mobilePhone || p.homePhone || p.workPhone || "",
      address1: p.address1 || "",
      address2: p.address2 || "",
      city: p.city || "",
      state: p.state || "",
      zip: p.zip || "",
      birthDate: p.birthDate ? new Date(p.birthDate).toISOString().slice(0, 10) : null,
      campusId: campus ? campus.id : null,
      campusName: campus ? campus.name : null,
      campusSlug: campus ? campus.slug || null : null,
      membershipStatus: p.membershipStatus || null,
      householdId: p.householdId || null
    };
  }

  // ─────────────────────────── 2. overview ───────────────────────────
  public async overview(userId: string, churchId: string) {
    const user = await this.repos.user.load(userId);
    if (!user) throw new MemberError(401, "unauthorized");
    const { kc } = await this.keycloakUser(userId);
    const emails = await this.emailsFor(user, kc);
    const campuses = await this.campusMap(churchId);
    const person = await this.linkedPerson(userId, churchId);

    let household: any[] = [];
    if (person?.householdId) {
      const members = ((await this.repos.person.loadByHousehold(churchId, person.householdId)) as any[]) || [];
      household = members.filter((m) => !m.removed).slice(0, 30).map((m) => ({
        personId: m.id,
        displayName: displayNameOf(m),
        role: m.householdRole || null,
        photo: this.photoUrl(churchId, m)
      }));
    }

    let credentials: any[] = [];
    if (person) {
      const ords = ((await this.repos.personOrdination.loadForPerson(churchId, person.id, { mode: "all" })) as any[]) || [];
      if (ords.length > 0) {
        const types = ((await this.repos.ordinationType.loadAll(churchId)) as any[]) || [];
        const typeName = new Map(types.map((t: any) => [t.id, t.name]));
        credentials = ords.filter((o) => !o.removed).map((o) => ({
          type: typeName.get(o.ordinationTypeId) || "Ordination",
          ordainedOn: o.grantedDate ? new Date(o.grantedDate).toISOString().slice(0, 10) : null,
          status: o.status || null,
          licenseNumber: o.credentialNumber || null,
          licenseExpires: o.expirationDate ? new Date(o.expirationDate).toISOString().slice(0, 10) : null
        }));
      }
    }

    const staff = await this.staffFor(userId, churchId, campuses);
    const candidates = await this.candidatesFor(userId, churchId, emails.all, person, campuses);

    return {
      user: { firstName: user.firstName || "", lastName: user.lastName || "", email: emails.primary },
      person: person ? this.personDto(churchId, person, campuses) : null,
      household,
      verifiedEmails: emails.verified,
      partner: partnerOf(kc),
      credentials,
      staff,
      candidates
    };
  }

  private async staffFor(userId: string, churchId: string, campuses: Map<string, any>) {
    const apis = (await this.deps.loadPermissions(userId, churchId)) || [];
    const isAdmin = apis.some((a) => (a.permissions || []).length > 0);
    if (!isAdmin) return { isAdmin: false, campuses: [] as { id: string; name: string }[] };
    const orgWide = apis.some((a) => (a.permissions || []).some((p) => p.contentType === "Campus" && p.action === "Admin"));
    const ids: string[] = orgWide ? [...campuses.keys()] : await this.repos.userCampus.loadCampusIdsForUser(churchId, userId);
    return { isAdmin: true, campuses: ids.filter((id) => campuses.has(id)).map((id) => ({ id, name: campuses.get(id).name })) };
  }

  // ─────────────────────────── 3. own record ───────────────────────────
  public async updatePerson(userId: string, churchId: string, body: any) {
    const person = await this.linkedPerson(userId, churchId);
    if (!person) throw new MemberError(404, "no_person");
    const input = body && typeof body === "object" ? body : {};
    const errors: string[] = [];
    const set: Record<string, any> = {};
    const clean: Record<string, string> = {};
    for (const key of Object.keys(PERSON_LIMITS)) {
      if (input[key] === undefined) continue;
      const v = input[key];
      if (v !== null && typeof v !== "string") { errors.push(PERSON_LIMITS[key][1] + " must be text."); continue; }
      const t = (v || "").replace(/[\u0000-\u001f]/g, " ").trim();
      if (t.length > PERSON_LIMITS[key][0]) errors.push(`${PERSON_LIMITS[key][1]} can be at most ${PERSON_LIMITS[key][0]} characters.`);
      if ((key === "firstName" || key === "lastName") && !t) errors.push(PERSON_LIMITS[key][1] + " is required.");
      clean[key] = t;
    }
    if (input.campusId !== undefined) {
      const cid = input.campusId === null ? "" : String(input.campusId).trim();
      if (cid) {
        const campuses = await this.campusMap(churchId);
        if (!campuses.has(cid)) errors.push("Please choose one of our worship centers.");
        else set.campusId = cid;
      } else set.campusId = null;
    }
    if (errors.length > 0) throw Object.assign(new MemberError(400, "invalid"), { errors });

    for (const k of ["firstName", "lastName", "address1", "address2", "city", "state", "zip"]) if (clean[k] !== undefined) set[k] = clean[k] || null;
    if (set.firstName === null) delete set.firstName;
    if (set.lastName === null) delete set.lastName;
    if (clean.phone !== undefined) {
      const field = person.mobilePhone ? "mobilePhone" : person.homePhone ? "homePhone" : person.workPhone ? "workPhone" : "mobilePhone";
      set[field] = clean.phone || null;
    }
    if (set.firstName !== undefined || set.lastName !== undefined) {
      const first = set.firstName ?? person.firstName ?? "";
      const last = set.lastName ?? person.lastName ?? "";
      set.displayName = person.nickName ? `${first} "${person.nickName}" ${last}` : `${first} ${last}`;
    }
    await this.repos.memberAccount.updatePersonFields(churchId, person.id, set);
    await this.deps.audit(churchId, userId, "person", "person_self_updated", "person", person.id, { fields: Object.keys(set) });
    const fresh = await this.repos.person.load(churchId, person.id);
    return this.personDto(churchId, fresh || { ...person, ...set }, await this.campusMap(churchId));
  }

  // ─────────────────────────── 4. claim ───────────────────────────
  public async claim(userId: string, churchId: string, personId: string, ip = "") {
    if (!personId || typeof personId !== "string") throw new MemberError(400, "invalid");
    const user = await this.repos.user.load(userId);
    if (!user) throw new MemberError(401, "unauthorized");
    const { kc } = await this.keycloakUser(userId);
    const emails = await this.emailsFor(user, kc);
    const linked = await this.linkedPerson(userId, churchId);
    const candidates = await this.candidatesFor(userId, churchId, emails.all, linked);
    // Only a record that matches one of the member's VERIFIED emails can be claimed; anything
    // else answers exactly like an unknown id.
    if (!candidates.some((c) => c.personId === personId)) throw new MemberError(404, "not_found");

    const others = (await this.repos.memberAccount.loadLinkedUserIds(churchId, personId)).filter((id: string) => id !== userId);
    if (others.length === 0) {
      await this.repos.memberAccount.linkPerson(churchId, userId, personId);
      await this.deps.audit(churchId, userId, "person", "person_claimed", "person", personId, { ip });
      return { linked: true };
    }

    // Held by another account: ask that person's center to review instead of moving it.
    const person = await this.repos.person.load(churchId, personId);
    const otherUsers = ((await this.repos.user.loadByIds(others)) as any[]) || [];
    const callerName = [user.firstName, user.lastName].filter(Boolean).join(" ").trim() || emails.primary;
    const recordName = displayNameOf(person);
    const otherLabel = otherUsers.map((u: any) => [u.firstName, u.lastName].filter(Boolean).join(" ").trim() + (u.email ? " (" + u.email + ")" : "")).join(", ") || "another account";
    const message = `${callerName} (${emails.primary}) signed in with a Mary Banks ID and says the church record "${recordName}" is theirs. `
      + `That record is already linked to ${otherLabel}. If both are the same person, link the record to the new account; if not, no change is needed.`;
    await this.repos.formSubmission.createPublic({
      churchId,
      campusId: person?.campusId || null,
      submissionType: LINK_REVIEW_TYPE,
      submitterName: callerName.slice(0, 200),
      submitterEmail: emails.primary.slice(0, 200),
      message,
      extra: { personId, requestedByUserId: userId, linkedUserIds: others },
      submissionDate: this.now()
    });
    await this.deps.audit(churchId, userId, "person", "person_claim_review", "person", personId, { linkedUserIds: others, ip });
    return { linked: false, review: true };
  }

  // ─────────────────────────── 5. verified extra emails ───────────────────────────
  private async requireMbid(userId: string): Promise<{ sub: string; kc: KeycloakUser; user: any }> {
    if (!this.deps.admin) throw new MemberError(503, "unavailable");
    const user = await this.repos.user.load(userId);
    if (!user) throw new MemberError(401, "unauthorized");
    const sub = await this.repos.memberAccount.loadMbidSub(userId);
    if (!sub) throw new MemberError(400, "no_mbid");
    let kc: KeycloakUser | null = null;
    try {
      kc = await this.deps.admin.getUser(sub);
    } catch {
      throw new MemberError(503, "unavailable");
    }
    if (!kc) throw new MemberError(400, "no_mbid");
    return { sub, kc, user };
  }

  private normalizeInputEmail(raw: any): string {
    const email = normalizeEmail(typeof raw === "string" ? raw : "");
    if (!email || email.length > 191 || !EMAIL_RE.test(email)) throw new MemberError(400, "invalid_email");
    return email;
  }

  public async startEmail(userId: string, rawEmail: any) {
    const email = this.normalizeInputEmail(rawEmail);
    const { sub, kc } = await this.requireMbid(userId);
    const primary = normalizeEmail(kc.email || "");
    if (email === primary || verifiedEmailsOf(kc).includes(email)) throw new MemberError(409, "already_yours");
    const others = await this.deps.admin!.findOtherAccountsWithEmail(email, sub);
    if (others.length > 0) throw new MemberError(409, "other_account");

    const acct = this.repos.memberAccount;
    const sent = await acct.countCodesSince(userId, new Date(this.now().getTime() - 60 * 60 * 1000));
    if (sent >= EmailCodeHelper.MAX_SENDS_PER_HOUR) throw new MemberError(429, "too_many");

    const code = EmailCodeHelper.generate();
    const salt = EmailCodeHelper.newSalt();
    await acct.insertCode({
      userId,
      email,
      salt,
      codeHash: EmailCodeHelper.hash(code, salt, userId, email),
      expiresAt: new Date(this.now().getTime() + EmailCodeHelper.TTL_MS)
    });
    await this.deps.sendCode(email, code);
    return { sent: true };
  }

  public async verifyEmail(userId: string, churchId: string, rawEmail: any, rawCode: any) {
    const email = this.normalizeInputEmail(rawEmail);
    const code = typeof rawCode === "string" ? rawCode.trim() : String(rawCode ?? "");
    const acct = this.repos.memberAccount;
    const row = await acct.loadLatestCode(userId, email);
    if (!row || row.consumedAt) throw new MemberError(400, "wrong_code");
    if (row.attempts >= EmailCodeHelper.MAX_ATTEMPTS) throw new MemberError(429, "too_many");
    if (row.expiresAt.getTime() < this.now().getTime()) throw new MemberError(410, "expired");
    if (!EmailCodeHelper.matches(code, row.salt, userId, email, row.codeHash)) {
      await acct.incrementCodeAttempts(row.id);
      if (row.attempts + 1 >= EmailCodeHelper.MAX_ATTEMPTS) throw new MemberError(429, "too_many");
      throw new MemberError(400, "wrong_code");
    }
    await acct.consumeCode(row.id);

    const { sub, kc, user } = await this.requireMbid(userId);
    const primary = normalizeEmail(kc.email || "");
    const current = verifiedEmailsOf(kc);
    let verifiedEmails = current;
    if (email !== primary && !current.includes(email)) {
      // Re-check at the moment of writing: another account may have claimed it since the send.
      const others = await this.deps.admin!.findOtherAccountsWithEmail(email, sub);
      if (others.length > 0) throw new MemberError(409, "other_account");
      verifiedEmails = await this.deps.admin!.setVerifiedEmails(sub, [...current, email]);
      await this.deps.audit(churchId, userId, "security", "verified_email_added", "user", userId, { email });
    }
    const linked = await this.linkedPerson(userId, churchId);
    const candidates = await this.candidatesFor(userId, churchId, [normalizeEmail(kc.email || user.email || ""), ...verifiedEmails], linked);
    return { verifiedEmails: verifiedEmails.filter((e) => e !== primary), candidates };
  }

  public async removeEmail(userId: string, churchId: string, rawEmail: any) {
    const email = this.normalizeInputEmail(rawEmail);
    const { sub, kc } = await this.requireMbid(userId);
    const current = verifiedEmailsOf(kc);
    if (!current.includes(email)) return { verifiedEmails: current };
    const verifiedEmails = await this.deps.admin!.setVerifiedEmails(sub, current.filter((e) => e !== email));
    await this.deps.audit(churchId, userId, "security", "verified_email_removed", "user", userId, { email });
    return { verifiedEmails };
  }

  // ─────────────────────────── 6. own submissions ───────────────────────────
  public async submissions(userId: string, churchId: string) {
    const user = await this.repos.user.load(userId);
    if (!user) throw new MemberError(401, "unauthorized");
    const { kc } = await this.keycloakUser(userId);
    const emails = await this.emailsFor(user, kc);
    const rows = ((await this.repos.memberAccount.loadSubmissionsForEmails(churchId, emails.all, [LINK_REVIEW_TYPE])) as any[]) || [];
    const campuses = await this.campusMap(churchId);
    return rows.map((r) => ({
      id: r.id,
      type: r.submissionType,
      campusName: r.campusId ? campuses.get(r.campusId)?.name || null : null,
      createdAt: r.submissionDate ? new Date(r.submissionDate).toISOString() : null,
      message: r.message || "",
      status: r.unread === 0 || r.unread === false ? "read" : "new"
    }));
  }
}
