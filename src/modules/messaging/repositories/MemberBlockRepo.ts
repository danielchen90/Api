import { injectable } from "inversify";
import { UniqueIdHelper } from "@churchapps/apihelper";
import { getDb } from "../db/index.js";

// A signed-in member's own block list (App Store guideline 1.2). Blocking hides the blocked
// person's messages from the member in group chat and private messages, and stops the blocked
// person from sending the member private messages.
@injectable()
export class MemberBlockRepo {
  public async loadBlockedIds(churchId: string, personId: string): Promise<string[]> {
    if (!churchId || !personId) return [];
    try {
      const rows = await getDb().selectFrom("memberBlocks").select("blockedPersonId")
        .where("churchId", "=", churchId).where("personId", "=", personId).execute();
      return rows.map((r) => r.blockedPersonId);
    } catch (e) {
      // Reads never break chat (e.g. before the memberBlocks migration is applied).
      console.warn("[chat-safety] memberBlocks read failed", (e as any)?.message || e);
      return [];
    }
  }

  /** TRUE when `personId` has blocked `otherPersonId`. */
  public async hasBlocked(churchId: string, personId: string, otherPersonId: string): Promise<boolean> {
    if (!churchId || !personId || !otherPersonId) return false;
    try {
      const row = await getDb().selectFrom("memberBlocks").select("id")
        .where("churchId", "=", churchId).where("personId", "=", personId).where("blockedPersonId", "=", otherPersonId)
        .executeTakeFirst();
      return !!row;
    } catch (e) {
      console.warn("[chat-safety] memberBlocks read failed", (e as any)?.message || e);
      return false;
    }
  }

  public async block(churchId: string, personId: string, blockedPersonId: string) {
    const existing = await getDb().selectFrom("memberBlocks").select("id")
      .where("churchId", "=", churchId).where("personId", "=", personId).where("blockedPersonId", "=", blockedPersonId)
      .executeTakeFirst();
    if (existing) return;
    await getDb().insertInto("memberBlocks").values({
      id: UniqueIdHelper.shortId(),
      churchId,
      personId,
      blockedPersonId,
      createdAt: new Date()
    }).execute();
  }

  public async unblock(churchId: string, personId: string, blockedPersonId: string) {
    await getDb().deleteFrom("memberBlocks")
      .where("churchId", "=", churchId).where("personId", "=", personId).where("blockedPersonId", "=", blockedPersonId)
      .execute();
  }
}
