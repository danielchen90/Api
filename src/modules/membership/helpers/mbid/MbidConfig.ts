/**
 * Mary Banks ID (Keycloak) settings for the Api, read from the environment on each use so a
 * restart is the only thing needed after changing them.
 *
 *   KEYCLOAK_BASE_URL               https://id.mbmonline.global
 *   KEYCLOAK_REALM                  marybanks
 *   KEYCLOAK_SERVICE_CLIENT_ID      service client (client credentials; realm-management
 *   KEYCLOAK_SERVICE_CLIENT_SECRET  manage-users / view-users / query-users)
 *   MBID_ALLOWED_AUDIENCES          comma list of client ids whose ID tokens we accept (default huro-app)
 *
 * TEST-ONLY override (never honoured in production): when NODE_ENV === "test" AND the Api's
 * ENVIRONMENT is not prod/production, MBID_TEST_ISSUER + MBID_TEST_JWKS_FILE replace the real
 * issuer and JWKS so a locally generated signing key can drive an end-to-end sign-in.
 */
export class MbidConfig {
  static get baseUrl(): string {
    return (process.env.KEYCLOAK_BASE_URL || "https://id.mbmonline.global").replace(/\/+$/, "");
  }

  static get realm(): string {
    return process.env.KEYCLOAK_REALM || "marybanks";
  }

  static get realIssuer(): string {
    return MbidConfig.baseUrl + "/realms/" + MbidConfig.realm;
  }

  static get serviceClientId(): string {
    return process.env.KEYCLOAK_SERVICE_CLIENT_ID || "";
  }

  static get serviceClientSecret(): string {
    return process.env.KEYCLOAK_SERVICE_CLIENT_SECRET || "";
  }

  static get adminConfigured(): boolean {
    return !!MbidConfig.serviceClientId && !!MbidConfig.serviceClientSecret;
  }

  static get allowedAudiences(): string[] {
    const raw = process.env.MBID_ALLOWED_AUDIENCES || "huro-app";
    return raw.split(",").map((s) => s.trim()).filter(Boolean);
  }

  /** True only in a jest / local test run, never in a deployed Api. */
  static get testOverrideActive(): boolean {
    const env = (process.env.ENVIRONMENT || "").toLowerCase();
    return process.env.NODE_ENV === "test" && env !== "prod" && env !== "production" && !!process.env.MBID_TEST_ISSUER && !!process.env.MBID_TEST_JWKS_FILE;
  }

  static get issuer(): string {
    return MbidConfig.testOverrideActive ? (process.env.MBID_TEST_ISSUER as string) : MbidConfig.realIssuer;
  }

  static get jwksUrl(): string {
    return MbidConfig.realIssuer + "/protocol/openid-connect/certs";
  }
}
