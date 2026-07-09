import { AuthenticatedUser } from "@churchapps/apihelper";
import axios from "axios";
import { Environment } from "../../../shared/helpers/Environment.js";
import { Repos } from "../repositories/index.js";
import { normalizeEmail, isValidEmail } from "./emailNormalize.js";

// The SINGLE audience resolver (RESEARCH Pattern 2). ONE resolve() is used by
// BOTH preview (counts) and freeze (materialize campaignRecipients) so there is
// NO compose→send drift by construction.
//
// It calls the Plan-01 campus-scoped membership seam POST /membership/audiences/
// resolve over the existing HTTP seam, forwarding the caller JWT VERBATIM — scope
// is re-derived server-side on the membership side from the forwarded identity;
// a scope is NEVER serialized into the body. Messaging therefore never
// re-implements applyCampusScope.
//
// On top of the scoped rows it: dedups by personId FIRST then by normalized
// email, routes missing/invalid emails to skippedNoEmail (never throws), and
// excludes suppressed addresses at resolve time.

export interface ResolvedAudience {
  deliverable: { personId: string; email: string; campusId: string; mergeData: any }[];
  skippedNoEmail: { personId: string; reason: string }[];
  suppressed: { personId: string; email: string }[];
}

export class RecipientResolver {

  static async resolve(au: AuthenticatedUser, repos: Repos, descriptor: any): Promise<ResolvedAudience> {
    const url = Environment.membershipApi + "/audiences/resolve";

    // Forward the caller JWT VERBATIM. axios rejects on non-2xx by default and we
    // DELIBERATELY do NOT catch it here (Pitfall 2): a non-2xx must fail the
    // resolve LOUDLY. An empty audience that looks "safe" but is actually an auth
    // failure is a data-integrity bug.
    const resp = await axios.post(url, descriptor, { headers: { Authorization: "Bearer " + au.jwt } });
    const rows: any[] = resp.data || [];

    const deliverable: ResolvedAudience["deliverable"] = [];
    const skippedNoEmail: ResolvedAudience["skippedNoEmail"] = [];
    const suppressed: ResolvedAudience["suppressed"] = [];

    const seenPerson = new Set<string>();
    const seenEmail = new Set<string>();

    for (const r of rows) {
      // 1. Dedup by personId FIRST (AUD-04).
      if (seenPerson.has(r.personId)) continue;
      seenPerson.add(r.personId);

      // 2. Normalize + skip missing/invalid BEFORE the email-dedup step (AUD-05)
      //    so a bad address never occupies an email slot — and never throws.
      const email = normalizeEmail(r.email);
      if (!email || !isValidEmail(email)) {
        skippedNoEmail.push({ personId: r.personId, reason: email ? "invalid" : "missing" });
        continue;
      }

      // 3. Dedup by normalized email (AUD-04).
      if (seenEmail.has(email)) continue;
      seenEmail.add(email);

      // 4. Exclude suppressed addresses at resolve time on the SAME normalized
      //    email (AUD-06).
      if (await repos.emailSuppression.isSuppressed(au.churchId, email)) {
        suppressed.push({ personId: r.personId, email });
        continue;
      }

      deliverable.push({ personId: r.personId, email, campusId: r.campusId, mergeData: r.mergeData });
    }

    return { deliverable, skippedNoEmail, suppressed };
  }
}
