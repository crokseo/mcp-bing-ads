/**
 * LinkedIn profile bid adjustments (company, industry, job function) on a
 * campaign. Same contract as typedWrites.ts: a pure planner that takes the
 * state already read from the API and returns before/after, diff, warnings,
 * restore_args and the exact requests. Nothing here calls the API.
 *
 * Microsoft documents these criteria as "bid only" (help article updated
 * 2026-06-18): targeting a company never stops the ads showing to everyone else.
 */

import type { MutationRequest } from "./mutationRequests.js";
import type { Plan, RawCampaignCriterion } from "./typedWrites.js";

export const PROFILE_TYPES = ["Industry", "JobFunction", "CompanyName"] as const;
export type ProfileType = typeof PROFILE_TYPES[number];

export const PROFILE_MULTIPLIER_MIN = -90;
export const PROFILE_MULTIPLIER_MAX = 900;
const MAX_CRITERIONS_PER_CALL = 100;

export const BID_ONLY_WARNING =
  "Bid only: LinkedIn profile criteria adjust the bid, they never restrict who sees the ads (Microsoft help, 2026-06-18).";

export interface ProfileBidState {
  accountId: string;
  /** Existing Industry / JobFunction / CompanyName criterions of the campaign. */
  existing: RawCampaignCriterion[];
  /**
   * Profile ids published by Microsoft, per type. null = the list could not be
   * read (companies are not downloadable): ids of that type are not verified.
   */
  known: Partial<Record<ProfileType, ReadonlySet<string> | null>>;
}

export interface ProfileBidArg {
  profile_type: string;
  profile_id: string;
  bid_multiplier?: number;
  exclure?: boolean;
}

function toNumericId(id: string | number, label: string): number {
  const n = Number(id);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new Error(`${label} must be a positive numeric id, got "${id}"`);
  }
  return n;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const key = (type: string, id: string) => `${type}:${id}`;

export function planProfileBid(
  state: ProfileBidState,
  args: { campaign_id: string; profils: ProfileBidArg[] },
): Plan {
  const campaignId = toNumericId(args.campaign_id, "campaign_id");
  if (!Array.isArray(args.profils) || args.profils.length === 0) {
    throw new Error("profils must contain at least one profile");
  }

  // Normalise and check the request; the same profile twice must agree.
  const wanted = new Map<string, { type: ProfileType; id: string; exclude: boolean; multiplier: number | null }>();
  for (const p of args.profils) {
    if (!(PROFILE_TYPES as readonly string[]).includes(p.profile_type)) {
      throw new Error(`profile_type must be one of ${PROFILE_TYPES.join(", ")}, got "${p.profile_type}"`);
    }
    const type = p.profile_type as ProfileType;
    const id = String(toNumericId(p.profile_id, "profile_id"));
    const exclude = p.exclure === true;
    let multiplier: number | null = null;
    if (exclude) {
      if (p.bid_multiplier !== undefined) throw new Error(`bid_multiplier does not apply to an exclusion (${type} ${id})`);
    } else {
      const m = p.bid_multiplier;
      if (typeof m !== "number" || !Number.isFinite(m) || m < PROFILE_MULTIPLIER_MIN || m > PROFILE_MULTIPLIER_MAX) {
        throw new Error(`bid_multiplier must be a number between ${PROFILE_MULTIPLIER_MIN} and ${PROFILE_MULTIPLIER_MAX} for ${type} ${id}, got ${m}`);
      }
      multiplier = m;
    }
    const k = key(type, id);
    const prev = wanted.get(k);
    if (prev && (prev.exclude !== exclude || prev.multiplier !== multiplier)) {
      throw new Error(`${type} ${id} is requested twice with different settings`);
    }
    wanted.set(k, { type, id, exclude, multiplier });
  }

  const warnings: string[] = [BID_ONLY_WARNING];
  const unverifiedTypes = new Set<string>();
  for (const w of wanted.values()) {
    const list = state.known[w.type];
    if (list === null || list === undefined) {
      unverifiedTypes.add(w.type);
    } else if (!list.has(w.id)) {
      throw new Error(`${w.type} ${w.id} is not in Microsoft's published ${w.type} list`);
    }
  }
  for (const t of unverifiedTypes) {
    warnings.push(`${t} ids are not verified: Microsoft does not publish a downloadable ${t} list. Check them in the interface.`);
  }

  const byKey = new Map<string, RawCampaignCriterion>();
  for (const c of state.existing) {
    const t = c.Criterion?.ProfileType;
    const id = c.Criterion?.ProfileId;
    if (t && id !== undefined && id !== null) byKey.set(key(String(t), String(id)), c);
  }

  const before: unknown[] = [];
  const after: unknown[] = [];
  const diff: unknown[] = [];
  const restore: ProfileBidArg[] = [];
  const toUpdate: Array<{ type: ProfileType; body: Record<string, unknown> }> = [];
  const toAdd: Array<{ type: ProfileType; body: Record<string, unknown> }> = [];
  let createdExclusions = 0;
  let createdBiddable = 0;

  for (const w of wanted.values()) {
    const cur = byKey.get(key(w.type, w.id));
    const curNegative = cur ? String(cur.Type).startsWith("Negative") : false;
    const curMultiplier = cur && !curNegative ? (cur.CriterionBid?.Multiplier ?? 0) : null;
    const label = (neg: boolean, m: number | null) => (neg ? "excluded" : `${m && m > 0 ? "+" : ""}${m ?? 0} %`);
    before.push({ profile_type: w.type, profile_id: w.id, state: cur ? label(curNegative, curMultiplier) : "absent" });
    after.push({ profile_type: w.type, profile_id: w.id, state: label(w.exclude, w.multiplier) });

    const criterion = { Type: "ProfileCriterion", ProfileId: Number(w.id), ProfileType: w.type };
    if (cur) {
      if (curNegative !== w.exclude) {
        throw new Error(
          `${w.type} ${w.id} is already ${curNegative ? "excluded" : "a bid adjustment"} on this campaign: ` +
          `switching it between excluded and bid adjustment means deleting it, which this tool never does. Use the interface.`,
        );
      }
      if (w.exclude || curMultiplier === w.multiplier) continue; // already as requested
      toUpdate.push({
        type: w.type,
        body: {
          Id: Number(cur.Id),
          Type: "BiddableCampaignCriterion",
          CampaignId: campaignId,
          Criterion: criterion,
          CriterionBid: { Type: "BidMultiplier", Multiplier: w.multiplier },
        },
      });
      diff.push({ profile_type: w.type, profile_id: w.id, from: curMultiplier, to: w.multiplier });
      restore.push({ profile_type: w.type, profile_id: w.id, bid_multiplier: curMultiplier ?? 0 });
    } else if (w.exclude) {
      toAdd.push({ type: w.type, body: { Type: "NegativeCampaignCriterion", CampaignId: campaignId, Criterion: criterion } });
      diff.push({ profile_type: w.type, profile_id: w.id, from: "absent", to: "excluded" });
      createdExclusions++;
    } else {
      toAdd.push({
        type: w.type,
        body: {
          Type: "BiddableCampaignCriterion",
          CampaignId: campaignId,
          Criterion: criterion,
          CriterionBid: { Type: "BidMultiplier", Multiplier: w.multiplier },
        },
      });
      diff.push({ profile_type: w.type, profile_id: w.id, from: "absent", to: w.multiplier });
      // Restoring cannot delete: a created adjustment goes back to 0, i.e. no effect.
      restore.push({ profile_type: w.type, profile_id: w.id, bid_multiplier: 0 });
      createdBiddable++;
    }
  }

  if (createdBiddable) {
    warnings.push(`${createdBiddable} new criterion(s): restore_args set them back to 0 %, they stay attached (no deletion).`);
  }
  if (createdExclusions) {
    warnings.push(`${createdExclusions} new exclusion(s): restore_args cannot undo them (that needs a deletion). Remove them in the interface if needed.`);
  }

  // One request per method and profile type: the criterion type is part of the call.
  const requests: MutationRequest[] = [];
  for (const [method, list] of [["PUT", toUpdate], ["POST", toAdd]] as const) {
    for (const type of PROFILE_TYPES) {
      const bodies = list.filter(x => x.type === type).map(x => x.body);
      for (const part of chunk(bodies, MAX_CRITERIONS_PER_CALL)) {
        // Writes take CriterionType "Targets" for profile criteria (probed live: "Industry",
        // "JobFunction" or "CompanyName" return CampaignCriterionTypeInvalid), reads take one profile type per call.
        requests.push({ path: "/CampaignCriterions", method, body: { CampaignCriterions: part, CriterionType: "Targets" } });
      }
    }
  }

  return {
    before,
    after,
    diff,
    warnings,
    restore_args: restore.length ? [{ campaign_id: String(campaignId), profils: restore }] : null,
    requests,
  };
}
