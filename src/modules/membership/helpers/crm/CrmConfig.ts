import { Repos } from "../../repositories/Repos.js";

/**
 * CRM settings from the environment.
 *
 *   CRM_CHURCH_SUBDOMAIN   the church that holds the ministry-wide CRM (default "bti")
 *   CRM_SYNC               "off" stops the Keycloak + activity sync timers (default on in Railway)
 *   ANTHROPIC_API_KEY      quick capture, profile summaries, Ask the CRM
 *   CRM_AI_MODEL           Claude model for those (default claude-opus-5-5)
 *   CRM_SERVICE_KEY        shared secret other sites (Global Church) use to call /membership/crm/service/*
 *   CRM_SRC_GTC_URL, CRM_SRC_DPF_URL, CRM_SRC_GC_URL, CRM_SRC_THEATER_URL
 *                          read-only Postgres connection strings for the activity sources
 */
export class CrmConfig {
  private static cached: { id: string; at: number } | null = null;

  static get subDomain(): string {
    return (process.env.CRM_CHURCH_SUBDOMAIN || "bti").trim().toLowerCase();
  }

  static get syncEnabled(): boolean {
    return (process.env.CRM_SYNC || "on").toLowerCase() !== "off";
  }

  static get aiModel(): string {
    return process.env.CRM_AI_MODEL || "claude-opus-5-5";
  }

  static get aiConfigured(): boolean {
    return !!process.env.ANTHROPIC_API_KEY;
  }

  static get serviceKey(): string {
    return process.env.CRM_SERVICE_KEY || "";
  }

  static async churchId(repos: Repos): Promise<string | null> {
    if (CrmConfig.cached && Date.now() - CrmConfig.cached.at < 10 * 60_000) return CrmConfig.cached.id;
    const church = await repos.church.loadBySubDomain(CrmConfig.subDomain);
    if (!church?.id) return null;
    CrmConfig.cached = { id: church.id, at: Date.now() };
    return church.id;
  }
}
