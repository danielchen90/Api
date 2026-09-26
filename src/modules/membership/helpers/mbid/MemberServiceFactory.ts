import { Environment } from "../../../../shared/helpers/Environment.js";
import { TransactionalEmailSender } from "../../../../shared/helpers/TransactionalEmailSender.js";
import { AuditLogHelper } from "../AuditLogHelper.js";
import { UserHelper } from "../UserHelper.js";
import { Repos } from "../../repositories/index.js";
import { MbidConfig } from "./MbidConfig.js";
import { KeycloakAdminClient } from "./KeycloakAdminClient.js";
import { EmailCodeHelper } from "./EmailCodeHelper.js";
import { MemberAccountService } from "./MemberAccountService.js";

/** Wires MemberAccountService to the real repos, Keycloak, mail and audit log. */
export function buildMemberAccountService(repos: Repos, ip = ""): MemberAccountService {
  return new MemberAccountService({
    repos,
    admin: MbidConfig.adminConfigured ? new KeycloakAdminClient() : null,
    contentRoot: Environment.contentRoot,
    sendCode: async (email: string, code: string) => {
      if (!Environment.isMailConfigured) {
        // Local dev (MAIL_SYSTEM empty): print instead of sending, like the rest of the Api.
        console.log("****Email server not configured: ");
        console.log("To: " + email);
        console.log(EmailCodeHelper.subject);
        console.log(EmailCodeHelper.bodyText(code));
        return;
      }
      const siteUrl = process.env.PUBLIC_SITE_URL || "https://church.chensolutions.com";
      await TransactionalEmailSender.sendTemplatedEmail(Environment.supportEmail, email, "Bible Teachers International", siteUrl, EmailCodeHelper.subject, EmailCodeHelper.bodyHtml(code));
    },
    audit: (churchId, userId, category, action, entityType, entityId, details) =>
      AuditLogHelper.log(repos, churchId, userId, category, action, entityType, entityId, details, ip),
    loadPermissions: (userId, churchId) => UserHelper.loadExpandedPermissions(userId, churchId, repos) as any
  });
}
