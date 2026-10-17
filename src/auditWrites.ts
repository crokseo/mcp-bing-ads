/**
 * Typed write operations, second batch: campaign status, conversion goals,
 * ad group network, Audience Network bid adjustment, audience associations.
 *
 * Same contract as typedWrites.ts: pure planners that take the state already
 * read from the API and return before/after, diff, warnings, restore_args and
 * the exact requests. Nothing here calls the API.
 */

import type { MutationRequest } from "./mutationRequests.js";
import type { Plan } from "./typedWrites.js";

function toNumericId(id: string | number, label: string): number {
  const n = Number(id);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new Error(`${label} must be a positive numeric id, got "${id}"`);
  }
  return n;
}

function idList(ids: unknown, label: string): string[] {
  if (!Array.isArray(ids) || ids.length === 0) throw new Error(`${label} must contain at least one id`);
  return [...new Set(ids.map(id => String(toNumericId(id as string, label))))];
}

function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const it of items) out.set(key(it), [...(out.get(key(it)) || []), it]);
  return out;
}

// ============================================
// 1. CAMPAIGN STATUS
// ============================================

export interface RawCampaignStatus {
  Id: string;
  Name: string;
  Status: string;
  CampaignType?: string;
}

/**
 * Status the campaign should get back on restore. BudgetPaused means the
 * campaign is Active but out of budget for the day; BudgetAndManualPaused
 * means it was also paused by hand.
 */
function restorableStatus(status: string): "Active" | "Paused" {
  if (status === "Active" || status === "BudgetPaused") return "Active";
  return "Paused";
}

export function planCampaignStatus(
  state: { accountId: string; campaigns: RawCampaignStatus[] },
  args: { campaign_ids: string[]; statut: string },
): Plan {
  if (args.statut !== "Active" && args.statut !== "Paused") {
    throw new Error(`statut must be Active or Paused (deletion is not supported), got "${args.statut}"`);
  }
  const ids = idList(args.campaign_ids, "campaign_ids");
  const byId = new Map(state.campaigns.map(c => [String(c.Id), c]));
  const missing = ids.filter(id => !byId.has(id));
  if (missing.length) throw new Error(`Campaigns not found: ${missing.join(", ")}`);
  const odd = ids.filter(id => !["Active", "Paused", "BudgetPaused", "BudgetAndManualPaused"].includes(byId.get(id)!.Status));
  if (odd.length) {
    throw new Error(`Campaigns with status other than Active/Paused cannot be changed here: ${odd.map(id => `${id} (${byId.get(id)!.Status})`).join(", ")}`);
  }

  const changed = ids.filter(id => restorableStatus(byId.get(id)!.Status) !== args.statut);
  const warnings: string[] = [];
  for (const id of ids) {
    const st = byId.get(id)!.Status;
    if (st === "BudgetPaused" || st === "BudgetAndManualPaused") {
      warnings.push(`Campaign "${byId.get(id)!.Name}" is ${st} (out of budget for the day): it is treated as ${restorableStatus(st)}.`);
    }
  }
  if (args.statut === "Paused") {
    const stillActive = state.campaigns.filter(c => !ids.includes(String(c.Id)) && restorableStatus(c.Status) === "Active");
    if (stillActive.length === 0) warnings.push("No campaign of the account would remain active: the account stops serving.");
  }

  const restore = groupBy(changed, id => restorableStatus(byId.get(id)!.Status));
  return {
    before: ids.map(id => ({ id, name: byId.get(id)!.Name, status: byId.get(id)!.Status })),
    after: ids.map(id => ({ id, name: byId.get(id)!.Name, status: changed.includes(id) ? args.statut : byId.get(id)!.Status })),
    diff: changed.map(id => ({ id, name: byId.get(id)!.Name, from: byId.get(id)!.Status, to: args.statut })),
    warnings,
    restore_args: [...restore.entries()].map(([statut, campaignIds]) => ({ campaign_ids: campaignIds, statut })),
    requests: changed.length === 0 ? [] : [{
      path: "/Campaigns",
      method: "PUT",
      body: { AccountId: toNumericId(state.accountId, "account_id"), Campaigns: changed.map(id => ({ Id: Number(id), Status: args.statut })) },
    }],
  };
}

// ============================================
// 2. CONVERSION GOAL (include in bidding, value)
// ============================================

export const REVENUE_TYPES = ["FixedValue", "VariableValue", "NoValue"];

export interface RawConversionGoal {
  Id: string;
  Name: string;
  Type: string;
  Status?: string;
  ExcludeFromBidding?: boolean | null;
  Revenue?: { Type: string; Value?: number | null; CurrencyCode?: string | null } | null;
}

export interface RevenueArg {
  type: string;
  value?: number;
}

function revenueView(r: RawConversionGoal["Revenue"]): { type: string; value: number | null } {
  return { type: r?.Type ?? "NoValue", value: r?.Value ?? null };
}

export function planConversionGoal(
  goals: RawConversionGoal[],
  args: { goal_ids: string[]; exclude_from_bidding?: boolean; revenue?: RevenueArg },
): Plan {
  const ids = idList(args.goal_ids, "goal_ids");
  if (args.exclude_from_bidding === undefined && args.revenue === undefined) {
    throw new Error("Pass exclude_from_bidding and/or revenue: nothing else is changed by this tool.");
  }
  if (args.exclude_from_bidding !== undefined && typeof args.exclude_from_bidding !== "boolean") {
    throw new Error("exclude_from_bidding must be true or false");
  }
  if (args.revenue !== undefined) {
    if (!REVENUE_TYPES.includes(args.revenue.type)) {
      throw new Error(`revenue.type must be one of ${REVENUE_TYPES.join(", ")}, got "${args.revenue.type}"`);
    }
    const needsValue = args.revenue.type !== "NoValue";
    if (needsValue && (typeof args.revenue.value !== "number" || !(args.revenue.value >= 0))) {
      throw new Error(`revenue.value must be a number >= 0 for ${args.revenue.type}`);
    }
  }
  const byId = new Map(goals.map(g => [String(g.Id), g]));
  const missing = ids.filter(id => !byId.has(id));
  if (missing.length) throw new Error(`Conversion goals not found: ${missing.join(", ")}`);

  const warnings: string[] = [];
  const updates: Record<string, unknown>[] = [];
  const diff: unknown[] = [];
  const restore: Record<string, unknown>[] = [];
  for (const id of ids) {
    const g = byId.get(id)!;
    const update: Record<string, unknown> = { Id: Number(id), Type: g.Type };
    const change: Record<string, unknown> = {};
    const back: Record<string, unknown> = { goal_ids: [id] };
    const currentExclude = g.ExcludeFromBidding === true;
    if (args.exclude_from_bidding !== undefined && args.exclude_from_bidding !== currentExclude) {
      update.ExcludeFromBidding = args.exclude_from_bidding;
      change.exclude_from_bidding = { from: currentExclude, to: args.exclude_from_bidding };
      back.exclude_from_bidding = currentExclude;
    }
    if (args.revenue !== undefined) {
      const cur = revenueView(g.Revenue);
      const target = { type: args.revenue.type, value: args.revenue.type === "NoValue" ? null : args.revenue.value! };
      if (cur.type !== target.type || cur.value !== target.value) {
        // Revenue is replaced as a whole on update: send every field.
        update.Revenue = {
          Type: target.type,
          ...(target.value !== null ? { Value: target.value } : {}),
          ...(g.Revenue?.CurrencyCode ? { CurrencyCode: g.Revenue.CurrencyCode } : {}),
        };
        change.revenue = { from: cur, to: target };
        back.revenue = cur.type === "NoValue" ? { type: "NoValue" } : { type: cur.type, value: cur.value ?? 0 };
        if (cur.type === "VariableValue" && target.type !== "VariableValue") {
          warnings.push(`Goal "${g.Name}" uses a variable value sent by the tag: switching to ${target.type} discards it.`);
        }
      }
    }
    if (g.Status && g.Status !== "Active") warnings.push(`Goal "${g.Name}" is ${g.Status}: changing it has no effect until it is active.`);
    if (Object.keys(change).length) {
      updates.push(update);
      diff.push({ id, name: g.Name, ...change });
      restore.push(back);
    }
  }
  if (args.exclude_from_bidding === false && updates.some(u => u.ExcludeFromBidding === false)) {
    warnings.push("A goal brought into bidding changes what automated bidding optimises for: expect a learning period.");
  }
  const view = (id: string, after: boolean) => {
    const g = byId.get(id)!;
    const d = (diff as any[]).find(x => x.id === id);
    return {
      id, name: g.Name,
      exclude_from_bidding: after && d?.exclude_from_bidding ? d.exclude_from_bidding.to : g.ExcludeFromBidding === true,
      revenue: after && d?.revenue ? d.revenue.to : revenueView(g.Revenue),
    };
  };
  return {
    before: ids.map(id => view(id, false)),
    after: ids.map(id => view(id, true)),
    diff,
    warnings,
    restore_args: restore,
    requests: updates.length === 0 ? [] : [{ path: "/ConversionGoals", method: "PUT", body: { ConversionGoals: updates } }],
  };
}

// ============================================
// 3. AD GROUP NETWORK (search partners)
// ============================================

export const AD_GROUP_NETWORKS = ["OwnedAndOperatedOnly", "OwnedAndOperatedAndSyndicatedSearch", "SyndicatedSearchOnly"];

export interface RawAdGroupNetwork {
  Id: string;
  Name: string;
  Status: string;
  Network?: string | null;
}

export function planAdGroupNetwork(
  adGroups: RawAdGroupNetwork[],
  args: { campaign_id: string; ad_group_ids: string[]; reseau: string; autoriser_partenaires_seuls?: boolean },
): Plan {
  const campaignId = toNumericId(args.campaign_id, "campaign_id");
  if (!AD_GROUP_NETWORKS.includes(args.reseau)) {
    throw new Error(`reseau must be one of ${AD_GROUP_NETWORKS.join(", ")}, got "${args.reseau}"`);
  }
  if (args.reseau === "SyndicatedSearchOnly" && args.autoriser_partenaires_seuls !== true) {
    throw new Error("SyndicatedSearchOnly removes Bing itself and keeps only search partners: pass autoriser_partenaires_seuls: true if that is really intended.");
  }
  const ids = idList(args.ad_group_ids, "ad_group_ids");
  const byId = new Map(adGroups.map(a => [String(a.Id), a]));
  const missing = ids.filter(id => !byId.has(id));
  if (missing.length) throw new Error(`Ad groups not found in campaign ${campaignId}: ${missing.join(", ")}`);
  const noNetwork = ids.filter(id => !byId.get(id)!.Network);
  if (noNetwork.length) {
    throw new Error(`Ad groups without a search network setting (not search ad groups): ${noNetwork.join(", ")}`);
  }
  const changed = ids.filter(id => byId.get(id)!.Network !== args.reseau);
  const restore = groupBy(changed, id => byId.get(id)!.Network as string);
  return {
    before: ids.map(id => ({ id, name: byId.get(id)!.Name, network: byId.get(id)!.Network })),
    after: ids.map(id => ({ id, name: byId.get(id)!.Name, network: args.reseau })),
    diff: changed.map(id => ({ id, name: byId.get(id)!.Name, from: byId.get(id)!.Network, to: args.reseau })),
    warnings: [],
    restore_args: [...restore.entries()].map(([reseau, groupIds]) => ({
      campaign_id: String(campaignId), ad_group_ids: groupIds, reseau,
      ...(reseau === "SyndicatedSearchOnly" ? { autoriser_partenaires_seuls: true } : {}),
    })),
    requests: changed.length === 0 ? [] : [{
      path: "/AdGroups",
      method: "PUT",
      body: { CampaignId: campaignId, AdGroups: changed.map(id => ({ Id: Number(id), Network: args.reseau })) },
    }],
  };
}

// ============================================
// 4. AUDIENCE NETWORK BID ADJUSTMENT (Search campaigns)
// ============================================

export const AUDIENCE_ADS_MIN = -100;
export const AUDIENCE_ADS_MAX = 900;

export interface RawCampaignAudienceAds {
  Id: string;
  Name: string;
  CampaignType?: string;
  AudienceAdsBidAdjustment?: number | null;
}

export function planAudienceNetworkBid(
  state: { accountId: string; campaigns: RawCampaignAudienceAds[] },
  args: { campaign_id: string; ajustement: number },
): Plan {
  const id = String(toNumericId(args.campaign_id, "campaign_id"));
  const a = args.ajustement;
  if (typeof a !== "number" || !Number.isInteger(a) || a < AUDIENCE_ADS_MIN || a > AUDIENCE_ADS_MAX) {
    throw new Error(`ajustement must be an integer between ${AUDIENCE_ADS_MIN} and ${AUDIENCE_ADS_MAX}, got ${a}`);
  }
  const c = state.campaigns.find(x => String(x.Id) === id);
  if (!c) throw new Error(`Campaign not found: ${id}`);
  if (c.CampaignType && c.CampaignType !== "Search") {
    throw new Error(`AudienceAdsBidAdjustment only applies to Search campaigns; "${c.Name}" is ${c.CampaignType}.`);
  }
  const warnings: string[] = [];
  const current = c.AudienceAdsBidAdjustment;
  if (current === null || current === undefined) {
    warnings.push("The current adjustment is unset (system default, 0 today): restore sets it to 0 explicitly.");
  }
  const cur = current ?? 0;
  // Probed live 2026-10-17: PUT returns 200 with no error but the value stays 0, at campaign and
  // ad group level. Microsoft retired the audience ads bid modifier for Search in February 2023.
  if (a !== cur) {
    throw new Error("Microsoft ignores AudienceAdsBidAdjustment on Search campaigns since February 2023: the update is accepted and not applied. Check the Audience Network setting in the Microsoft Ads interface instead.");
  }
  const changed = current !== a;
  return {
    before: { id, name: c.Name, audience_ads_bid_adjustment: current ?? null },
    after: { id, name: c.Name, audience_ads_bid_adjustment: a },
    diff: changed ? { audience_ads_bid_adjustment: { from: current ?? null, to: a } } : {},
    warnings,
    restore_args: [{ campaign_id: id, ajustement: cur }],
    requests: changed ? [{
      path: "/Campaigns",
      method: "PUT",
      body: { AccountId: toNumericId(state.accountId, "account_id"), Campaigns: [{ Id: Number(id), AudienceAdsBidAdjustment: a }] },
    }] : [],
  };
}

// ============================================
// 5. AUDIENCE ASSOCIATION (observation or exclusion)
// ============================================

/** Criterion types an audience association can be read with, one per call. */
export const AUDIENCE_CRITERION_TYPES = [
  "RemarketingList", "CustomerList", "InMarketAudience", "CustomAudience",
  "ProductAudience", "SimilarRemarketingList", "CombinedList", "ImpressionBasedRemarketingList",
];

export interface RawAudienceCriterion {
  Id?: string;
  Type: string; // BiddableCampaignCriterion | NegativeCampaignCriterion | BiddableAdGroupCriterion | NegativeAdGroupCriterion
  Criterion: { AudienceId: string | number; AudienceType?: string };
}

export interface AudienceAttachState {
  accountId: string;
  audience: { Id: string; Name: string; Type: string };
  campaign: { Id: string; Name: string; CampaignType?: string; audienceTargetAndBid: boolean | null };
  /** Ad groups of the campaign with their own audience TargetSetting, if any. */
  adGroups: Array<{ Id: string; Name: string; audienceTargetAndBid: boolean | null }>;
  /** Existing associations of this audience, by entity id ("campaign" key for campaign level). */
  existing: Record<string, RawAudienceCriterion[]>;
  /** Biddable audience associations found at the OTHER level (conflict check). */
  biddableAtOtherLevel: Array<{ entity: string; audience_id: string; type: string }>;
}

export function planAddAudienceCriterion(
  state: AudienceAttachState,
  args: {
    niveau: string;
    campaign_id: string;
    ad_group_ids?: string[];
    audience_id: string;
    mode: string;
    bid_multiplier?: number;
    autoriser_ciblage?: boolean;
  },
): Plan {
  if (args.niveau !== "campaign" && args.niveau !== "ad_group") {
    throw new Error(`niveau must be campaign or ad_group, got "${args.niveau}"`);
  }
  if (args.mode !== "observation" && args.mode !== "exclusion") {
    throw new Error(`mode must be observation or exclusion, got "${args.mode}"`);
  }
  const campaignId = toNumericId(args.campaign_id, "campaign_id");
  const audienceId = toNumericId(args.audience_id, "audience_id");
  const multiplier = args.bid_multiplier ?? 0;
  if (args.mode === "exclusion" && args.bid_multiplier !== undefined) {
    throw new Error("bid_multiplier does not apply to an exclusion");
  }
  if (typeof multiplier !== "number" || multiplier < -90 || multiplier > 900) {
    throw new Error(`bid_multiplier must be between -90 and 900, got ${multiplier}`);
  }
  const biddable = args.mode === "observation";
  const isGroup = args.niveau === "ad_group";

  let targets: Array<{ id: string; name: string; targetAndBid: boolean | null }>;
  if (isGroup) {
    const ids = idList(args.ad_group_ids, "ad_group_ids");
    const byId = new Map(state.adGroups.map(a => [String(a.Id), a]));
    const missing = ids.filter(id => !byId.has(id));
    if (missing.length) throw new Error(`Ad groups not found in campaign ${campaignId}: ${missing.join(", ")}`);
    // An ad group without its own audience TargetSetting follows the campaign.
    targets = ids.map(id => ({
      id, name: byId.get(id)!.Name,
      targetAndBid: byId.get(id)!.audienceTargetAndBid ?? state.campaign.audienceTargetAndBid,
    }));
  } else {
    if (args.ad_group_ids && args.ad_group_ids.length) throw new Error("ad_group_ids only applies when niveau is ad_group");
    // Probed live 2026-10-17: AIMCampaignLevelAudienceTargetingNotEnabled on an Audience campaign.
    if (state.campaign.CampaignType === "Audience") {
      throw new Error(`"${state.campaign.Name}" is an Audience campaign: Microsoft refuses campaign-level audience associations there. Use niveau: "ad_group".`);
    }
    targets = [{ id: String(campaignId), name: state.campaign.Name, targetAndBid: state.campaign.audienceTargetAndBid }];
  }

  if (biddable) {
    const targeting = targets.filter(t => t.targetAndBid === true);
    if (targeting.length && args.autoriser_ciblage !== true) {
      throw new Error(
        `Audiences are in Targeting mode (target and bid) on ${targeting.map(t => `"${t.name}"`).join(", ")}: ` +
        `adding "${state.audience.Name}" there restricts who sees the ads instead of observing. ` +
        `Pass autoriser_ciblage: true only if that is intended.`,
      );
    }
    if (state.biddableAtOtherLevel.length) {
      const where = isGroup ? "at campaign level" : "at ad group level";
      throw new Error(
        `The campaign already has biddable audience associations ${where} (${state.biddableAtOtherLevel.length}, ` +
        `e.g. ${state.biddableAtOtherLevel[0].type} ${state.biddableAtOtherLevel[0].audience_id} on ${state.biddableAtOtherLevel[0].entity}). ` +
        `Microsoft does not allow biddable audiences at both levels: attach it ${isGroup ? "at campaign level" : "to the ad groups"} instead.`,
      );
    }
  }

  const warnings: string[] = [];
  if (state.audience.Type === "CustomerList") {
    warnings.push("Customer list: make sure the client agreed to this use of their customer data (GDPR) and that the list complies with the Customer Match policy.");
  }
  const toAdd: typeof targets = [];
  const skipped: unknown[] = [];
  for (const t of targets) {
    const ex = state.existing[isGroup ? t.id : "campaign"] || [];
    const same = ex.find(c => String(c.Criterion.AudienceId) === String(audienceId));
    if (!same) { toAdd.push(t); continue; }
    const sameMode = same.Type.startsWith("Biddable") === biddable;
    skipped.push({ entity: t.name, reason: sameMode ? "already attached in this mode" : `already attached as ${same.Type}` });
    if (!sameMode) warnings.push(`"${state.audience.Name}" is already attached to "${t.name}" as ${same.Type}: left as it is.`);
  }

  const criterion = (entityId: string) => {
    const base: Record<string, unknown> = {
      Criterion: { Type: "AudienceCriterion", AudienceId: audienceId, AudienceType: state.audience.Type },
      Type: `${biddable ? "Biddable" : "Negative"}${isGroup ? "AdGroup" : "Campaign"}Criterion`,
      ...(isGroup ? { AdGroupId: Number(entityId) } : { CampaignId: Number(entityId) }),
    };
    if (biddable) base.CriterionBid = { Type: "BidMultiplier", Multiplier: multiplier };
    return base;
  };
  const requests: MutationRequest[] = [];
  for (let i = 0; i < toAdd.length; i += 100) {
    const part = toAdd.slice(i, i + 100).map(t => criterion(t.id));
    requests.push(isGroup
      ? { path: "/AdGroupCriterions", method: "POST", body: { AdGroupCriterions: part, CriterionType: "Audience" } }
      : { path: "/CampaignCriterions", method: "POST", body: { CampaignCriterions: part, CriterionType: "Audience" } });
  }
  const label = biddable ? `observation (${multiplier} %)` : "exclusion";
  return {
    before: targets.map(t => ({ entity: t.name, attached: (state.existing[isGroup ? t.id : "campaign"] || []).some(c => String(c.Criterion.AudienceId) === String(audienceId)) })),
    after: targets.map(t => ({ entity: t.name, attached: true })),
    diff: { audience: state.audience.Name, mode: label, added: toAdd.map(t => t.name), skipped },
    warnings,
    // Creation only: undoing means removing the association in the interface.
    restore_args: null,
    requests,
  };
}
