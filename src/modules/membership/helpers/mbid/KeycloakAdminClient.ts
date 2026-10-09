import { MbidConfig } from "./MbidConfig.js";
import { normalizeEmail } from "./MbidTokenVerifier.js";

/**
 * Minimal Keycloak Admin REST client for the Mary Banks ID realm, authenticated with the Api's
 * service client (client credentials). Only what the member endpoints need:
 *   - read a user (verifiedEmails + partner_* attributes),
 *   - find accounts whose PRIMARY email or verifiedEmails contain an address,
 *   - add / remove an entry in the admin-write-only `verifiedEmails` attribute.
 *
 * The service token is cached until 30 s before it expires. Secrets are never logged.
 */

export interface KeycloakUser {
  id: string;
  username?: string;
  email?: string;
  emailVerified?: boolean;
  firstName?: string;
  lastName?: string;
  enabled?: boolean;
  attributes?: Record<string, string[]>;
  [key: string]: any;
}

export interface MbidAdminPort {
  getUser(sub: string): Promise<KeycloakUser | null>;
  findOtherAccountsWithEmail(email: string, excludeSub: string): Promise<string[]>;
  setVerifiedEmails(sub: string, emails: string[]): Promise<string[]>;
}

export class KeycloakAdminError extends Error {}

export function attr(user: KeycloakUser | null, name: string): string[] {
  const v = user?.attributes?.[name];
  if (!v) return [];
  return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [String(v)];
}

export function verifiedEmailsOf(user: KeycloakUser | null): string[] {
  const primary = normalizeEmail(user?.email || "");
  const out: string[] = [];
  for (const e of attr(user, "verifiedEmails")) {
    const n = normalizeEmail(e);
    if (n && n !== primary && !out.includes(n)) out.push(n);
  }
  return out;
}

export function partnerOf(user: KeycloakUser | null): { tier: string; status: string | null; since: string | null } | null {
  if (!user) return null;
  const tier = attr(user, "partner_tier")[0];
  if (!tier) return null;
  return { tier, status: attr(user, "partner_status")[0] || null, since: attr(user, "partner_since")[0] || null };
}

export class KeycloakAdminClient implements MbidAdminPort {
  private static token: { value: string; expiresAt: number } | null = null;

  public static resetToken() {
    KeycloakAdminClient.token = null;
  }

  private get adminBase(): string {
    return MbidConfig.baseUrl + "/admin/realms/" + encodeURIComponent(MbidConfig.realm);
  }

  private async serviceToken(): Promise<string> {
    const now = Date.now();
    if (KeycloakAdminClient.token && KeycloakAdminClient.token.expiresAt > now + 30_000) return KeycloakAdminClient.token.value;
    if (!MbidConfig.adminConfigured) throw new KeycloakAdminError("Mary Banks ID service client is not configured");
    const res = await fetch(MbidConfig.realIssuer + "/protocol/openid-connect/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: MbidConfig.serviceClientId, client_secret: MbidConfig.serviceClientSecret })
    });
    if (!res.ok) throw new KeycloakAdminError("service token failed: " + res.status);
    const data = (await res.json()) as { access_token: string; expires_in: number };
    KeycloakAdminClient.token = { value: data.access_token, expiresAt: now + (data.expires_in || 60) * 1000 };
    return data.access_token;
  }

  private async call(method: string, path: string, body?: any): Promise<any> {
    const token = await this.serviceToken();
    const res = await fetch(this.adminBase + path, {
      method,
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", accept: "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new KeycloakAdminError(method + " " + path.split("?")[0] + " failed: " + res.status);
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  }

  public async getUser(sub: string): Promise<KeycloakUser | null> {
    if (!sub) return null;
    return (await this.call("GET", "/users/" + encodeURIComponent(sub) + "?userProfileMetadata=false")) as KeycloakUser | null;
  }

  /** One page of realm users with attributes and createdTimestamp (the CRM sync walks every page). */
  public async listUsers(first: number, max: number): Promise<KeycloakUser[]> {
    return ((await this.call("GET", "/users?briefRepresentation=false&first=" + first + "&max=" + max)) || []) as KeycloakUser[];
  }

  public async countUsers(): Promise<number> {
    return Number(await this.call("GET", "/users/count")) || 0;
  }

  /** Ids of OTHER accounts whose primary email or verifiedEmails equal `email` (exact, case-insensitive). */
  public async findOtherAccountsWithEmail(email: string, excludeSub: string): Promise<string[]> {
    const target = normalizeEmail(email);
    const byPrimary = ((await this.call("GET", "/users?exact=true&briefRepresentation=true&email=" + encodeURIComponent(target))) || []) as KeycloakUser[];
    const byAttr = ((await this.call("GET", "/users?briefRepresentation=false&max=20&q=" + encodeURIComponent("verifiedEmails:" + target))) || []) as KeycloakUser[];
    const ids = new Set<string>();
    for (const u of byPrimary) if (u?.id && u.id !== excludeSub && normalizeEmail(u.email || "") === target) ids.add(u.id);
    for (const u of byAttr) if (u?.id && u.id !== excludeSub && attr(u, "verifiedEmails").some((e) => normalizeEmail(e) === target)) ids.add(u.id);
    return [...ids];
  }

  /**
   * Replace the `verifiedEmails` attribute. Keycloak's PUT replaces the whole attribute map, so the
   * current representation is read first and every other attribute is sent back unchanged.
   */
  public async setVerifiedEmails(sub: string, emails: string[]): Promise<string[]> {
    const user = await this.getUser(sub);
    if (!user) throw new KeycloakAdminError("user not found");
    const attributes = { ...(user.attributes || {}) };
    const clean = [...new Set(emails.map(normalizeEmail).filter(Boolean))];
    if (clean.length > 0) attributes.verifiedEmails = clean;
    else delete attributes.verifiedEmails;
    const rep: KeycloakUser = {
      id: user.id,
      username: user.username,
      email: user.email,
      emailVerified: user.emailVerified,
      firstName: user.firstName,
      lastName: user.lastName,
      enabled: user.enabled,
      attributes
    };
    await this.call("PUT", "/users/" + encodeURIComponent(sub), rep);
    const fresh = await this.getUser(sub);
    return verifiedEmailsOf(fresh);
  }
}
