import crypto from "crypto";
import fs from "fs";
import jwt from "jsonwebtoken";
import { MbidConfig } from "./MbidConfig.js";

/**
 * Verifies a Mary Banks ID (Keycloak) ID token:
 *   - signature against the realm JWKS (RS256/RS384/RS512/ES256; keys cached by kid for 10 minutes,
 *     one forced refresh at most every 30 s when an unknown kid shows up, so a key rotation is
 *     picked up without letting junk kids hammer Keycloak),
 *   - `iss` equal to the realm issuer,
 *   - `aud` (string or array) or `azp` in MBID_ALLOWED_AUDIENCES,
 *   - `exp` / `nbf` with 60 s leeway.
 * Uses jsonwebtoken (already a dependency) plus Node's native JWK import, so no ESM-only JWKS
 * library is needed under jest.
 */

export interface MbidClaims {
  sub: string;
  email?: string;
  email_verified?: boolean;
  given_name?: string;
  family_name?: string;
  name?: string;
  verified_emails?: string[];
  [key: string]: any;
}

export class MbidTokenError extends Error {
  constructor(public code: "invalid_token" | "email_unverified", message?: string) {
    super(message || code);
  }
}

interface JwkLike { kid?: string; kty?: string; alg?: string; use?: string; [k: string]: any }
type JwksFetcher = () => Promise<{ keys: JwkLike[] }>;

const ALGORITHMS: jwt.Algorithm[] = ["RS256", "RS384", "RS512", "ES256", "ES384"];

export class MbidTokenVerifier {
  public static CACHE_MS = 10 * 60 * 1000;
  public static REFRESH_FLOOR_MS = 30 * 1000;
  public static LEEWAY_S = 60;

  private static keys: Map<string, crypto.KeyObject> = new Map();
  private static fetchedAt = 0;
  private static inflight: Promise<void> | null = null;

  /** Replaceable in tests. */
  public static fetcher: JwksFetcher = async () => {
    if (MbidConfig.testOverrideActive) {
      return JSON.parse(fs.readFileSync(process.env.MBID_TEST_JWKS_FILE as string, "utf8"));
    }
    const res = await fetch(MbidConfig.jwksUrl, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error("JWKS fetch failed: " + res.status);
    return (await res.json()) as { keys: JwkLike[] };
  };

  public static resetCache() {
    MbidTokenVerifier.keys = new Map();
    MbidTokenVerifier.fetchedAt = 0;
    MbidTokenVerifier.inflight = null;
  }

  private static async refresh(now: number) {
    if (MbidTokenVerifier.inflight) return MbidTokenVerifier.inflight;
    MbidTokenVerifier.inflight = (async () => {
      try {
        const data = await MbidTokenVerifier.fetcher();
        const next = new Map<string, crypto.KeyObject>();
        for (const k of data?.keys || []) {
          if (!k || !k.kid || (k.use && k.use !== "sig")) continue;
          try {
            next.set(k.kid, crypto.createPublicKey({ key: k as any, format: "jwk" }));
          } catch {
            // skip a key Node cannot import
          }
        }
        MbidTokenVerifier.keys = next;
        MbidTokenVerifier.fetchedAt = now;
      } finally {
        MbidTokenVerifier.inflight = null;
      }
    })();
    return MbidTokenVerifier.inflight;
  }

  private static async keyFor(kid: string, now: number): Promise<crypto.KeyObject | null> {
    const stale = now - MbidTokenVerifier.fetchedAt > MbidTokenVerifier.CACHE_MS;
    if (stale) await MbidTokenVerifier.refresh(now);
    let key = MbidTokenVerifier.keys.get(kid) || null;
    if (!key && now - MbidTokenVerifier.fetchedAt > MbidTokenVerifier.REFRESH_FLOOR_MS) {
      await MbidTokenVerifier.refresh(now);
      key = MbidTokenVerifier.keys.get(kid) || null;
    }
    return key;
  }

  /** Verified claims, or throws MbidTokenError. Never logs the token. */
  public static async verify(idToken: string, now = Date.now()): Promise<MbidClaims> {
    if (!idToken || typeof idToken !== "string" || idToken.split(".").length !== 3 || idToken.length > 16384) throw new MbidTokenError("invalid_token");
    const decoded = jwt.decode(idToken, { complete: true });
    const kid = decoded && typeof decoded === "object" ? (decoded.header as any)?.kid : null;
    if (!kid || typeof kid !== "string") throw new MbidTokenError("invalid_token");

    let key: crypto.KeyObject | null = null;
    try {
      key = await MbidTokenVerifier.keyFor(kid, now);
    } catch {
      throw new MbidTokenError("invalid_token", "jwks unavailable");
    }
    if (!key) throw new MbidTokenError("invalid_token");

    let claims: MbidClaims;
    try {
      claims = jwt.verify(idToken, key, {
        algorithms: ALGORITHMS,
        issuer: MbidConfig.issuer,
        clockTolerance: MbidTokenVerifier.LEEWAY_S,
        clockTimestamp: Math.floor(now / 1000)
      }) as MbidClaims;
    } catch {
      throw new MbidTokenError("invalid_token");
    }

    const allowed = MbidConfig.allowedAudiences;
    const aud = Array.isArray(claims.aud) ? claims.aud : claims.aud ? [claims.aud] : [];
    const audOk = aud.some((a: string) => allowed.includes(a)) || (typeof claims.azp === "string" && allowed.includes(claims.azp));
    if (!audOk) throw new MbidTokenError("invalid_token");
    if (!claims.sub || typeof claims.sub !== "string" || claims.sub.length > 64) throw new MbidTokenError("invalid_token");
    if (!claims.exp) throw new MbidTokenError("invalid_token");
    if (claims.email_verified !== true || !claims.email) throw new MbidTokenError("email_unverified");
    return claims;
  }

  /** Lower-cased primary email + verified extras (deduped, primary first). */
  public static emailsOf(claims: MbidClaims): { primary: string; all: string[] } {
    const primary = normalizeEmail(claims.email || "");
    const extras = Array.isArray(claims.verified_emails) ? claims.verified_emails : [];
    const all = [primary];
    for (const e of extras) {
      const n = normalizeEmail(typeof e === "string" ? e : "");
      if (n && !all.includes(n)) all.push(n);
    }
    return { primary, all: all.filter(Boolean) };
  }
}

export function normalizeEmail(email: string): string {
  return (email || "").trim().toLowerCase();
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
