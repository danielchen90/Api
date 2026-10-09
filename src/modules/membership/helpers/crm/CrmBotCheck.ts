import Anthropic from "@anthropic-ai/sdk";
import { sql } from "kysely";
import { getDb } from "../../db/index.js";
import { KeycloakUser, attr } from "../mbid/KeycloakAdminClient.js";
import { CrmConfig } from "./CrmConfig.js";

/**
 * Spam sign-ups on Mary Banks ID (seen since 2026-09, and among the store customers imported
 * earlier): a bot registers real people's email addresses under random-letter names such as
 * "Qwpy Hwuwhdcg", often with the first country in the list (AF) and a random city. Some even
 * get verified (the stranger clicks the link). None of them is a person the ministry knows, so
 * they get no CRM record.
 *
 * Two passes, one verdict per account kept in crmBotChecks:
 *   1. letter patterns: two or more signs of random letters across first + last name -> bot;
 *   2. everything else is judged by Claude in batches ("a real name in any language, or random
 *      letters?"), which keeps real names from every culture (Nkrumah, Mthembu, Arabic script).
 * Without the AI configured, pass 1 alone decides and the rest count as people.
 */

const VOWELS = new Set("aeiouy");
const RARE = new Set(("bq bx cx cj cv cf dq dx fq fx fz fv fj fk gq gx gv gz hx jq jx jz jb jc jd jf jg jh jj jk jl jm jn jp jr js jt jv jw kq kx kz mq mx pq px pv pz " +
  "qa qb qc qd qe qf qg qh qi qj qk ql qm qn qo qp qq qr qs qt qv qw qx qy qz sx tq tx vb vc vd vf vg vh vj vk vm vn vp vq vt vw vx vz wq wx wj wv wz " +
  "xb xc xd xf xg xj xk xl xm xn xp xq xr xs xv xw xz yq yx yj zb zc zd zf zg zj zk zm zp zq zr zs zt zv zw zx dk dz fw gk hq hz kc kd kg kj kp kv " +
  "lq lx lz mj mz nx pj pk sz tz vl vr vs vv wb wc wd wf wg wk wm wp xx yv yz zh zz").split(" "));

/** Signs of random letters in one Latin-script word (0 for short or non-Latin words). */
export function weirdness(word: string | null | undefined): number {
  const w = String(word || "").toLowerCase();
  if (!/^[a-z]+$/.test(w) || w.length < 4) return 0;
  let s = 0;
  for (let i = 0; i < w.length - 1; i++) if (RARE.has(w[i] + w[i + 1])) s++;
  s += (w.match(/[^aeiouy]{4,}/g) || []).length;
  if ([...w].filter((c) => VOWELS.has(c)).length / w.length < 0.2) s++;
  return s;
}

export const patternScore = (u: KeycloakUser) => weirdness(u.firstName) + weirdness(u.lastName);

const BATCH = 120;

export class CrmBotCheck {
  /** Verdicts for these accounts (true = bot), checking any not yet judged. */
  static async verdicts(users: KeycloakUser[]): Promise<Map<string, boolean>> {
    const out = new Map<string, boolean>();
    if (!users.length) return out;
    const ids = users.map((u) => u.id);
    for (let i = 0; i < ids.length; i += 1000) {
      const rows = await sql<any>`SELECT sub, bot FROM crmBotChecks WHERE sub IN (${sql.join(ids.slice(i, i + 1000))})`.execute(getDb());
      rows.rows.forEach((r: any) => out.set(r.sub, !!Number(r.bot)));
    }
    const todo = users.filter((u) => !out.has(u.id));
    if (!todo.length) return out;

    const save = async (sub: string, bot: boolean, how: string) => {
      out.set(sub, bot);
      await sql`INSERT INTO crmBotChecks (sub, bot, how, checkedAt) VALUES (${sub}, ${bot ? 1 : 0}, ${how}, NOW())
        ON DUPLICATE KEY UPDATE bot = VALUES(bot), how = VALUES(how), checkedAt = VALUES(checkedAt)`.execute(getDb());
    };

    const unsure: KeycloakUser[] = [];
    for (const u of todo) {
      if (patternScore(u) >= 2) await save(u.id, true, "pattern");
      else if (!(u.firstName || "").trim() && !(u.lastName || "").trim()) await save(u.id, false, "no-name");
      else unsure.push(u);
    }
    if (!unsure.length) return out;
    if (!CrmConfig.aiConfigured) {
      // No AI: let them through this run without recording, so the AI judges them once it is set up.
      unsure.forEach((u) => out.set(u.id, false));
      return out;
    }
    for (let i = 0; i < unsure.length; i += BATCH) {
      const batch = unsure.slice(i, i + BATCH);
      try {
        const bots = await CrmBotCheck.askAi(batch);
        for (const u of batch) await save(u.id, bots.has(u.id), "ai");
      } catch (e: any) {
        console.error("[crm-botcheck] AI batch failed, letting them through for now:", e?.message || e);
        batch.forEach((u) => out.set(u.id, false));
      }
    }
    return out;
  }

  private static async askAi(users: KeycloakUser[]): Promise<Set<string>> {
    const lines = users.map((u, n) => `${n + 1}\t${(u.firstName || "").slice(0, 40)}\t${(u.lastName || "").slice(0, 40)}\t${(attr(u, "city")[0] || "").slice(0, 40)}\t${attr(u, "country")[0] || ""}`);
    const msg = await new Anthropic().beta.messages.create({
      model: CrmConfig.aiModel,
      max_tokens: 4000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: {
        effort: "low",
        format: { type: "json_schema", schema: { type: "object", additionalProperties: false, required: ["random"], properties: { random: { type: "array", items: { type: "integer" } } } } }
      },
      system: [
        "You screen sign-ups to a Christian ministry's website for spam bots.",
        "The bot fills the name (and sometimes the city) with random letters, like 'Qwpy Hwuwhdcg' or 'Gpuy Rbwyk' or city 'Xqezw'.",
        "Real people write names from every culture and script: African (Nkrumah, Mthembu, Okello), Asian, Arabic, Hebrew, Haitian Creole, nicknames, lowercase, initials, one word only, or a misspelling. Those are NOT random.",
        "Return the row numbers whose name is random letters. When unsure, leave it out."
      ].join("\n"),
      messages: [{ role: "user", content: "row\tfirst\tlast\tcity\tcountry\n" + lines.join("\n") }]
    });
    if (msg.stop_reason === "refusal") throw new Error("refused");
    const text = msg.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join("");
    const rows: number[] = JSON.parse(text || "{}").random || [];
    return new Set(rows.filter((n) => n >= 1 && n <= users.length).map((n) => users[n - 1].id));
  }
}
