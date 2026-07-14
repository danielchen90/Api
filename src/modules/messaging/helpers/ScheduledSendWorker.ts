import { EmailCampaign } from "../models/EmailCampaign.js";

// Scheduled-send poller (Phase 15, SND-04). Finds due scheduled campaigns and
// OCC-claims each scheduled→sending exactly once. The claim is the SAME
// version-guarded UPDATE /send uses (EmailCampaignController + updateWithVersion),
// so exactly-once holds across a Railway restart/redeploy: a lost/late tick just
// re-claims on the next pass ("send late, always"). This worker NEVER sends and
// NEVER touches a `sending` campaign — CampaignSendWorker (the 15s drain) owns
// the actual SES sends and the stuck-`sending` handling.
export class ScheduledSendWorker {
  public static async process(repos: any): Promise<{ due: number; claimed: number }> {
    const now = new Date();
    const due: EmailCampaign[] = await repos.emailCampaign.loadDueScheduled(now);
    let claimed = 0;
    for (const campaign of due) {
      // OCC claim scheduled→sending. Carries the campaign's OWN churchId in the
      // guard (updateWithVersion WHERE churchId=?) so the cross-tenant read never
      // leaks tenancy. 0n (BigInt) == another tick or a manual /send won → skip.
      const bumped = await repos.emailCampaign.updateWithVersion(
        { ...campaign, status: "sending" },
        campaign.version
      );
      if (bumped === 0n) continue; // exactly-once: lost the claim, someone else fired it
      claimed++;
      // Winner does nothing else: CampaignSendWorker.process (loadAllByStatus("sending"))
      // drains this row and sends per-recipient off-thread.
    }
    return { due: due.length, claimed };
  }
}
