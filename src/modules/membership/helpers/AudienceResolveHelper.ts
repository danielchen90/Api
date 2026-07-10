import { Repos } from "../repositories/index.js";
import { ListRuleGroup } from "../models/ListRules.js";
import { ListRuleHelper } from "./ListRuleHelper.js";

/**
 * Audience descriptor + descriptor→scoped-personIds resolution (Phase 10, AUD-01/02/03 server half).
 *
 * This helper is the id-narrowing half of the scoped `/membership/audiences/resolve` seam. It is
 * deliberately SCOPE-AGNOSTIC: it resolves the candidate personId set the descriptor IMPLIES
 * (group expansion, auxiliary→groups expansion, filterJson intersection) and returns either a
 * `string[]` of candidate ids or `null` ("no id narrowing — the whole scoped church"). Campus
 * scope is NEVER this helper's concern; `PersonRepo.loadForAudience` applies `applyCampusScope`
 * over whatever narrowing this returns, so an out-of-scope person is structurally impossible in
 * the final query no matter what this helper produces.
 *
 * THE AUDIENCE IS type+target+filter — for the filter/target carry types (church/campus/group/
 * auxiliary) person IDs are OUTPUTS, never inputs, and a body `personIds` field is NEVER accepted
 * (Anti-pattern: trusting a client-supplied personId[] on a FILTER descriptor is exactly the
 * cross-campus leak this phase closes).
 *
 * SINGLE EXPLICIT EXCEPTION — `type:"people"`: a campaign may carry an explicit checkbox-selected
 * person set (CONTEXT locks BOTH carry types — filter-based AND explicit personIds). ONLY when
 * `type === "people"` is `personIds` read from the body, and even then it is treated as a mere
 * CANDIDATE narrowing set — NOT a bypass. The candidate set is STILL intersected with campus scope
 * downstream by `PersonRepo.loadForAudience` (applyCampusScope): an out-of-scope explicit id is
 * structurally dropped, never trusted. So the campus-scope doctrine holds for every carry type.
 */
export type AudienceType = "church" | "campus" | "group" | "auxiliary" | "people";

export interface AudienceDescriptor {
  type: AudienceType;
  targetId?: string;
  // RAW filterJson string, stored/forwarded verbatim — parsed ONLY at resolve time, never trusted here.
  filterJson?: string;
  // EXPLICIT checkbox-selected people — read from the body ONLY when type === "people"; a CANDIDATE
  // narrowing set that is still campus-scoped downstream (never trusted as a scope bypass).
  personIds?: string[];
}

const AUDIENCE_TYPES: AudienceType[] = ["church", "campus", "group", "auxiliary", "people"];

/**
 * Coerce a request body into a typed AudienceDescriptor. This is the ONLY place a request body is
 * read into the descriptor: `type` is coerced to the closed union (unknown/missing → "church"),
 * `targetId` is an optional string, `filterJson` is an optional RAW string (never parsed here).
 * A `personIds` field on the body is IGNORED by construction for every carry type EXCEPT
 * `type === "people"` — for the filter/target types a client-supplied personId[] is the exact
 * cross-campus leak this phase closes and is never read. For `type === "people"` ONLY, `personIds`
 * is read (coerced/filtered to strings) as the explicit candidate set — still campus-scoped
 * downstream by loadForAudience, so it is a narrowing input, never a scope bypass.
 */
export function normalizeAudience(body: any): AudienceDescriptor {
  const rawType = body?.type;
  const type: AudienceType = AUDIENCE_TYPES.includes(rawType) ? rawType : "church";
  const descriptor: AudienceDescriptor = { type };
  if (typeof body?.targetId === "string" && body.targetId) descriptor.targetId = body.targetId;
  if (typeof body?.filterJson === "string" && body.filterJson) descriptor.filterJson = body.filterJson;
  // EXPLICIT-people carry type ONLY: read personIds as string[]. For all other types personIds is
  // IGNORED (never read) — trusting a client personId[] on a filter/target descriptor is the leak.
  if (type === "people" && Array.isArray(body?.personIds)) {
    descriptor.personIds = body.personIds.filter((id: any): id is string => typeof id === "string" && !!id);
  }
  return descriptor;
}

/**
 * Resolve the NARROWING personId set the descriptor implies, WITHOUT campus scope (the repo query
 * applies scope). Returns:
 *   - `null`      → "no id-list narrowing; the whole scoped church" (church/campus with no filter).
 *                   A `campus` target is applied as an extra `campusId=targetId` predicate INSIDE
 *                   the repo query so it composes WITH applyCampusScope (out-of-scope target → zero
 *                   rows, never a widener — Pitfall 7). So campus contributes no id narrowing here.
 *   - `string[]`  → the candidate personId set (group/auxiliary expansion and/or filterJson match).
 *                   An empty array means "resolved to zero candidates" — the repo returns [] for it
 *                   (an empty candidate set must NEVER degrade into an unfiltered church-wide load,
 *                   the id-side mirror of the applyCampusScope empty-IN pitfall).
 */
export async function resolveDescriptorPersonIds(
  churchId: string,
  descriptor: AudienceDescriptor,
  repos: Repos
): Promise<string[] | null> {
  let ids: string[] | null = null;

  switch (descriptor.type) {
    case "church":
    case "campus":
      // No id narrowing — whole scoped church (campus target is a repo-query predicate, not an id set).
      ids = null;
      break;
    case "group": {
      if (!descriptor.targetId) { ids = []; break; }
      const members = (await repos.groupMember.loadForGroup(churchId, descriptor.targetId)) as any[];
      ids = distinctIds(members.map((m) => m.personId));
      break;
    }
    case "auxiliary": {
      if (!descriptor.targetId) { ids = []; break; }
      // Auxiliary → its groups via groups.auxiliaryId (mirrors AuxiliaryScopeHelper / AuxiliaryController).
      const groups = (await repos.group.loadAll(churchId)) as any[];
      const groupIds = groups.filter((g) => g.auxiliaryId === descriptor.targetId).map((g) => g.id);
      if (!groupIds.length) { ids = []; break; }
      const members = (await repos.groupMember.loadForGroups(churchId, groupIds)) as any[];
      ids = distinctIds(members.map((m) => m.personId));
      break;
    }
    case "people": {
      // EXPLICIT checkbox-selected people: the descriptor's personIds ARE the candidate set (like
      // group/auxiliary expansion produces a candidate set). This is the SINGLE place a body-supplied
      // personId[] is honored, and it is honored ONLY as a candidate — loadForAudience STILL runs it
      // through applyCampusScope, so an out-of-scope explicit id is structurally dropped (never a
      // scope bypass). An empty list resolves to zero candidates (never a church-wide widener).
      ids = distinctIds(descriptor.personIds ?? []);
      break;
    }
  }

  // filterJson NARROWS (AUD-02) — it intersects the descriptor id set, never widens it. If the
  // descriptor id set was null (church/campus), the filter-matched ids BECOME the narrowing set.
  if (descriptor.filterJson) {
    const rules = parseRules(descriptor.filterJson);
    if (rules) {
      const matched = await ListRuleHelper.evaluate(churchId, rules, undefined, repos);
      if (ids === null) {
        ids = distinctIds(matched);
      } else {
        const matchSet = new Set(matched);
        ids = ids.filter((id) => matchSet.has(id));
      }
    }
  }

  return ids;
}

// Distinct, falsy-stripped id list.
function distinctIds(raw: (string | undefined | null)[]): string[] {
  return Array.from(new Set(raw.filter((id): id is string => !!id)));
}

// Tolerant filterJson parse: accepts a bare rules group OR a { rules } wrapper. Bad JSON → null
// (the filter is silently ignored rather than throwing — a malformed saved filter must not 500).
function parseRules(filterJson: string): ListRuleGroup | null {
  try {
    const parsed = JSON.parse(filterJson);
    const rules = parsed?.rules ?? parsed;
    if (rules && typeof rules === "object" && ("match" in rules || "conditions" in rules || "groups" in rules)) {
      return rules as ListRuleGroup;
    }
    return null;
  } catch {
    return null;
  }
}
