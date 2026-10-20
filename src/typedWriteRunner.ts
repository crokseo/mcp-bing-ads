/**
 * Typed write tools: state readers and the dry-run / confirm runner.
 *
 * Every tool follows the contract of gads_modify.py:
 *   1. read the current state, plan, apply guards (always, read-only);
 *   2. confirm=false stops there and returns the plan (dry run);
 *   3. confirm=true requires BING_ADS_MCP_WRITE=true, an explicit account_id
 *      and a snapshot_path; the snapshot is written BEFORE the first mutation;
 *   4. requests run in order and stop at the first failure (including the
 *      per-item errors Bing returns with HTTP 200);
 *   5. the state is read again and re-planned: an empty plan means the account
 *      now matches the request.
 *
 * The API call is injected so the whole sequence is testable without network.
 */

import type { MutationRequest } from "./mutationRequests.js";
import {
  Plan,
  RawCampaignCriterion,
  collectResponseErrors,
  planAdGroupStatus,
  planAdSchedule,
  planAddKeywords,
  planAddNegativeKeywords,
  planAddResponsiveSearchAd,
  planBiddingStrategy,
  planDeviceBid,
  planFinalUrlSuffix,
  planLocations,
} from "./typedWrites.js";
import {
  AUDIENCE_CRITERION_TYPES,
  planAddAudienceCriterion,
  planAdGroupNetwork,
  planAudienceNetworkBid,
  planCampaignStatus,
  planConversionGoal,
} from "./auditWrites.js";
import { PROFILE_TYPES, ProfileType, planProfileBid } from "./profileWrites.js";
import { readFileSync } from "fs";
import { parseEmailFile, planCustomerListAdd } from "./customerListWrites.js";

export interface ApiRequest {
  path: string;
  method: "POST" | "PUT" | "DELETE";
  body: Record<string, unknown>;
}

export type ApiCall = (req: ApiRequest) => Promise<any>;

interface TypedWriteDef {
  read(call: ApiCall, args: any, accountId: string): Promise<any>;
  plan(state: any, args: any, accountId: string): Plan;
  /** Override for tools whose re-plan is never empty (ad creation). */
  verify?(before: any, after: any): { ok: boolean; detail: unknown };
}

const ALL_CAMPAIGN_TYPES = "Search,Shopping,Audience,PerformanceMax";
// InStoreTransaction is left out on purpose: outside its pilot it fails the whole call.
const GOAL_TYPES = "Url,Duration,PagesViewedPerVisit,Event,AppInstall,OfflineConversion";
// Audience object type names (Custom, InMarket, Product), not the criterion type names.
const AUDIENCE_TYPES = "RemarketingList,Custom,InMarket,Product,SimilarRemarketingList,CombinedList,CustomerList,ImpressionBasedRemarketingList";
/** Audience.Type (object) -> criterion type used to read its associations. */
const AUDIENCE_READ_TYPE: Record<string, string> = {
  RemarketingList: "RemarketingList", CustomerList: "CustomerList", SimilarRemarketingList: "SimilarRemarketingList",
  CombinedList: "CombinedList", ImpressionBasedRemarketingList: "ImpressionBasedRemarketingList",
  Custom: "CustomAudience", InMarket: "InMarketAudience", Product: "ProductAudience",
};

function audienceTargetAndBid(settings: any[] | null | undefined): boolean | null {
  for (const s of settings || []) {
    if (s?.Type !== "TargetSetting") continue;
    const d = (s.Details || []).find((x: any) => x?.CriterionTypeGroup === "Audience");
    if (d) return d.TargetAndBid === true;
  }
  return null;
}

async function campaignAudienceCriterions(call: ApiCall, campaignId: string, type: string): Promise<any[]> {
  const r = await call({ path: "/CampaignCriterions/QueryByIds", method: "POST", body: { CampaignId: Number(campaignId), CriterionType: type } });
  return r?.CampaignCriterions || [];
}

async function adGroupAudienceCriterions(call: ApiCall, adGroupId: string, type: string): Promise<any[]> {
  const r = await call({
    path: "/AdGroupCriterions/QueryByIds",
    method: "POST",
    body: { AdGroupCriterionIds: null, AdGroupId: Number(adGroupId), CriterionType: type },
  });
  return r?.AdGroupCriterions || [];
}

async function campaignCriterions(call: ApiCall, campaignId: string, type: string): Promise<RawCampaignCriterion[]> {
  const r = await call({
    path: "/CampaignCriterions/QueryByIds",
    method: "POST",
    body: { CampaignId: Number(campaignId), CriterionType: type },
  });
  return r?.CampaignCriterions || [];
}

async function keywordsOf(call: ApiCall, adGroupId: string) {
  const r = await call({ path: "/Keywords/QueryByAdGroupId", method: "POST", body: { AdGroupId: Number(adGroupId) } });
  return r?.Keywords || [];
}

async function rsaOf(call: ApiCall, adGroupId: string) {
  const r = await call({
    path: "/Ads/QueryByAdGroupId",
    method: "POST",
    body: { AdGroupId: Number(adGroupId), AdTypes: ["ResponsiveSearch"] },
  });
  return r?.Ads || [];
}

export const TYPED_WRITES: Record<string, TypedWriteDef> = {
  bing_ads_set_ad_schedule: {
    async read(call, args) {
      const out: Record<string, RawCampaignCriterion[]> = {};
      for (const id of args.campaign_ids || []) out[String(Number(id))] = await campaignCriterions(call, id, "DayTime");
      return out;
    },
    plan: (state, args) => planAdSchedule(state, args),
  },

  bing_ads_set_locations: {
    read: (call, args) => campaignCriterions(call, args.campaign_id, "Location"),
    plan: (state, args) => planLocations(state, args),
  },

  bing_ads_set_device_bid: {
    read: (call, args) => campaignCriterions(call, args.campaign_id, "Device"),
    plan: (state, args) => planDeviceBid(state, args),
  },

  bing_ads_set_ad_group_status: {
    async read(call, args) {
      const r = await call({ path: "/AdGroups/QueryByCampaignId", method: "POST", body: { CampaignId: Number(args.campaign_id) } });
      return r?.AdGroups || [];
    },
    plan: (state, args) => planAdGroupStatus(state, args),
  },

  bing_ads_set_final_url_suffix: {
    async read(call, _args, accountId) {
      const props = await call({
        path: "/AccountProperties/Query",
        method: "POST",
        body: { AccountPropertyNames: ["FinalUrlSuffix", "TrackingUrlTemplate"] },
      });
      const value = (name: string) => (props?.AccountProperties || []).find((p: any) => p.Name === name)?.Value ?? "";
      const camps = await call({
        path: "/Campaigns/QueryByAccountId",
        method: "POST",
        body: { AccountId: Number(accountId), CampaignType: ALL_CAMPAIGN_TYPES },
      });
      return {
        suffix: value("FinalUrlSuffix"),
        trackingTemplate: value("TrackingUrlTemplate"),
        campaignSuffixes: (camps?.Campaigns || []).map((c: any) => ({ id: c.Id, name: c.Name, suffix: c.FinalUrlSuffix || "" })),
      };
    },
    plan: (state, args) => planFinalUrlSuffix(state, args),
  },

  bing_ads_set_bidding_strategy: {
    async read(call, args, accountId) {
      const camps = await call({
        path: "/Campaigns/QueryByIds",
        method: "POST",
        body: { AccountId: Number(accountId), CampaignIds: (args.campaign_ids || []).map(Number), CampaignType: ALL_CAMPAIGN_TYPES },
      });
      // A campaign's portfolio is not returned on the campaign itself: list
      // the account's portfolios and the campaigns attached to each.
      const strategies = await call({ path: "/BidStrategies/QueryByIds", method: "POST", body: { BidStrategyIds: null } });
      const ids = (strategies?.BidStrategies || []).map((b: any) => Number(b.Id));
      const portfolioCampaignIds = new Set<string>();
      if (ids.length) {
        const assoc = await call({ path: "/CampaignIds/QueryByBidStrategyIds", method: "POST", body: { BidStrategyIds: ids } });
        for (const col of assoc?.CampaignIdCollection || []) for (const id of col?.Ids || []) portfolioCampaignIds.add(String(id));
      }
      return { campaigns: camps?.Campaigns || [], portfolioCampaignIds };
    },
    plan: (state, args, accountId) => planBiddingStrategy({ ...state, accountId }, args),
  },

  bing_ads_add_keywords: {
    read: (call, args) => keywordsOf(call, args.ad_group_id),
    plan: (state, args) => planAddKeywords(state, args),
  },

  bing_ads_add_negative_keywords: {
    async read(call, args) {
      const isGroup = args.niveau === "ad_group";
      if (isGroup && !args.campaign_id) throw new Error("campaign_id (the parent campaign) is required when niveau is ad_group");
      const r = await call({
        path: "/NegativeKeywords/QueryByEntityIds",
        method: "POST",
        body: {
          EntityIds: [Number(args.entity_id)],
          EntityType: isGroup ? "AdGroup" : "Campaign",
          ...(isGroup ? { ParentEntityId: Number(args.campaign_id) } : {}),
        },
      });
      const existing = (r?.EntityNegativeKeywords || []).flatMap((e: any) => e?.NegativeKeywords || []);
      return { existing, positives: isGroup ? await keywordsOf(call, args.entity_id) : undefined };
    },
    plan: (state, args) => planAddNegativeKeywords(state, args),
  },

  bing_ads_add_responsive_search_ad: {
    read: (call, args) => rsaOf(call, args.ad_group_id),
    plan: (state, args) => planAddResponsiveSearchAd(state, args),
    verify: (before, after) => ({
      ok: after.length === before.length + 1,
      detail: { responsive_search_ads_before: before.length, responsive_search_ads_after: after.length },
    }),
  },
};

Object.assign(TYPED_WRITES, {
  bing_ads_set_campaign_status: {
    async read(call: ApiCall, _args: any, accountId: string) {
      const r = await call({ path: "/Campaigns/QueryByAccountId", method: "POST", body: { AccountId: Number(accountId), CampaignType: ALL_CAMPAIGN_TYPES } });
      return r?.Campaigns || [];
    },
    plan: (state: any, args: any, accountId: string) => planCampaignStatus({ accountId, campaigns: state }, args),
  },

  bing_ads_set_conversion_goal: {
    async read(call: ApiCall, args: any) {
      const r = await call({
        path: "/ConversionGoals/QueryByIds",
        method: "POST",
        body: { ConversionGoalIds: (args.goal_ids || []).map(Number), ConversionGoalTypes: GOAL_TYPES },
      });
      return r?.ConversionGoals || [];
    },
    plan: (state: any, args: any) => planConversionGoal(state, args),
  },

  bing_ads_set_ad_group_network: {
    async read(call: ApiCall, args: any) {
      const r = await call({ path: "/AdGroups/QueryByCampaignId", method: "POST", body: { CampaignId: Number(args.campaign_id) } });
      return r?.AdGroups || [];
    },
    plan: (state: any, args: any) => planAdGroupNetwork(state, args),
  },

  bing_ads_set_audience_network_bid: {
    async read(call: ApiCall, args: any, accountId: string) {
      const r = await call({
        path: "/Campaigns/QueryByIds",
        method: "POST",
        body: { AccountId: Number(accountId), CampaignIds: [Number(args.campaign_id)], CampaignType: ALL_CAMPAIGN_TYPES },
      });
      return r?.Campaigns || [];
    },
    plan: (state: any, args: any, accountId: string) => planAudienceNetworkBid({ accountId, campaigns: state }, args),
  },

  bing_ads_add_audience_criterion: {
    async read(call: ApiCall, args: any, accountId: string) {
      const aud = await call({ path: "/Audiences/QueryByIds", method: "POST", body: { AudienceIds: [Number(args.audience_id)], Type: AUDIENCE_TYPES } });
      const audience = (aud?.Audiences || []).find((a: any) => a && String(a.Id) === String(Number(args.audience_id)));
      if (!audience) throw new Error(`Audience not found in this account: ${args.audience_id}`);
      const readType = AUDIENCE_READ_TYPE[audience.Type];
      if (!readType) throw new Error(`Unsupported audience type: ${audience.Type}`);
      const camps = await call({
        path: "/Campaigns/QueryByIds",
        method: "POST",
        body: { AccountId: Number(accountId), CampaignIds: [Number(args.campaign_id)], CampaignType: ALL_CAMPAIGN_TYPES, ReturnAdditionalFields: "TargetSetting" },
      });
      const camp = (camps?.Campaigns || [])[0];
      if (!camp) throw new Error(`Campaign not found: ${args.campaign_id}`);
      const ags = await call({ path: "/AdGroups/QueryByCampaignId", method: "POST", body: { CampaignId: Number(args.campaign_id) } });
      const adGroups = (ags?.AdGroups || []).map((a: any) => ({ Id: String(a.Id), Name: a.Name, audienceTargetAndBid: audienceTargetAndBid(a.Settings) }));
      const isGroup = args.niveau === "ad_group";
      const existing: Record<string, any[]> = {};
      if (isGroup) {
        for (const id of args.ad_group_ids || []) existing[String(Number(id))] = await adGroupAudienceCriterions(call, id, readType);
      } else {
        existing.campaign = await campaignAudienceCriterions(call, args.campaign_id, readType);
      }
      // Microsoft refuses biddable audiences at both levels of one campaign
      // (CampaignAlreadyHasAdGroupAudienceCriterion): look for one at the other level.
      const biddableAtOtherLevel: Array<{ entity: string; audience_id: string; type: string }> = [];
      if (args.mode === "observation") {
        if (isGroup) {
          for (const type of AUDIENCE_CRITERION_TYPES) {
            const found = (await campaignAudienceCriterions(call, args.campaign_id, type)).find((c: any) => String(c.Type).startsWith("Biddable"));
            if (found) { biddableAtOtherLevel.push({ entity: camp.Name, audience_id: String(found.Criterion?.AudienceId), type }); break; }
          }
        } else {
          scan: for (const ag of adGroups) {
            for (const type of AUDIENCE_CRITERION_TYPES) {
              const found = (await adGroupAudienceCriterions(call, ag.Id, type)).find((c: any) => String(c.Type).startsWith("Biddable"));
              if (found) { biddableAtOtherLevel.push({ entity: ag.Name, audience_id: String(found.Criterion?.AudienceId), type }); break scan; }
            }
          }
        }
      }
      return {
        accountId,
        audience: { Id: String(audience.Id), Name: audience.Name, Type: audience.Type },
        campaign: { Id: String(camp.Id), Name: camp.Name, CampaignType: camp.CampaignType, audienceTargetAndBid: audienceTargetAndBid(camp.Settings) },
        adGroups,
        existing,
        biddableAtOtherLevel,
      };
    },
    plan: (state: any, args: any) => planAddAudienceCriterion(state, args),
  },
} as Record<string, TypedWriteDef>);

/**
 * Profile ids Microsoft publishes for a type, from GetProfileDataFileUrl (a CSV
 * whose first column is the id). Companies are not downloadable: the API
 * answers InvalidProfileType for CompanyName (probed 2026-10-19), so null.
 */
async function publishedProfileIds(call: ApiCall, type: ProfileType): Promise<ReadonlySet<string> | null> {
  if (type === "CompanyName") return null;
  try {
    const r = await call({ path: "/ProfileDataFileUrl/Query", method: "POST", body: { LanguageLocale: "fr", ProfileType: type } });
    if (!r?.FileUrl) return null;
    const resp = await fetch(r.FileUrl, { signal: AbortSignal.timeout(30_000) });
    if (!resp.ok) return null;
    const lines = (await resp.text()).split("\n").map(l => l.replace("\r", ""));
    const ids = lines.slice(1).map(l => l.split(",")[0].trim()).filter(Boolean);
    return ids.length ? new Set(ids) : null;
  } catch {
    return null;
  }
}

Object.assign(TYPED_WRITES, {
  bing_ads_set_profile_bid: {
    async read(call: ApiCall, args: any, accountId: string) {
      const types = [...new Set((args.profils || []).map((p: any) => p?.profile_type))]
        .filter((t): t is ProfileType => (PROFILE_TYPES as readonly string[]).includes(t as string));
      const existing: RawCampaignCriterion[] = [];
      const known: Partial<Record<ProfileType, ReadonlySet<string> | null>> = {};
      for (const t of types) {
        existing.push(...await campaignCriterions(call, args.campaign_id, t));
        known[t] = await publishedProfileIds(call, t);
      }
      return { accountId, existing, known };
    },
    plan: (state: any, args: any) => planProfileBid(state, args),
  },
} as Record<string, TypedWriteDef>);

Object.assign(TYPED_WRITES, {
  bing_ads_add_customer_list_emails: {
    async read(call: ApiCall, args: any) {
      if (!args.fichier_emails || !isAbsolute(String(args.fichier_emails))) {
        throw new Error("fichier_emails must be the absolute path of a local file, one address per line.");
      }
      const r = await call({ path: "/Audiences/QueryByIds", method: "POST", body: { AudienceIds: [Number(args.audience_id)], Type: "CustomerList" } });
      const a = (r?.Audiences || []).find((x: any) => x && String(x.Id) === String(Number(args.audience_id)));
      return {
        audience: a ? { Id: String(a.Id), Name: a.Name, Type: a.Type, SearchSize: a.SearchSize, AudienceNetworkSize: a.AudienceNetworkSize } : null,
        parsed: parseEmailFile(readFileSync(String(args.fichier_emails), "utf-8")),
      };
    },
    plan: (state: any, args: any) => planCustomerListAdd(state, args),
    // Members cannot be read back and sizes refresh with a delay: re-planning
    // would always propose the same Add, so check only that the list is intact.
    verify: (before: any, after: any) => ({
      ok: !!after.audience,
      detail: after.audience
        ? { size_before: before.audience?.SearchSize, size_now: after.audience.SearchSize, note: "sizes refresh within 48 h" }
        : "customer list not found after the upload",
    }),
  },
} as Record<string, TypedWriteDef>);

export const TYPED_WRITE_TOOLS: ReadonlySet<string> = new Set(Object.keys(TYPED_WRITES));

export interface RunDeps {
  call: ApiCall;
  accountId: string;
  writeEnabled: boolean;
  fileExists(path: string): boolean;
  writeFile(path: string, content: string): void;
  now(): Date;
}

function isAbsolute(p: string): boolean {
  return /^([A-Za-z]:[\\/]|\/)/.test(p);
}

export async function runTypedWrite(name: string, rawArgs: Record<string, any>, deps: RunDeps): Promise<Record<string, unknown>> {
  const def = TYPED_WRITES[name];
  if (!def) throw new Error(`Unknown typed write tool: ${name}`);
  const { confirm, snapshot_path, account_id, ...args } = rawArgs || {};

  if (confirm === true) {
    // Checked before any read so a refused call costs nothing.
    if (!deps.writeEnabled) {
      throw new Error("confirm=true needs BING_ADS_MCP_WRITE=true in the MCP server environment. Run without confirm for a dry run.");
    }
    if (!account_id) throw new Error("account_id is required with confirm=true, to rule out writing to the wrong account.");
    if (!snapshot_path || typeof snapshot_path !== "string") {
      throw new Error("snapshot_path is required with confirm=true: the current state is saved there before any change.");
    }
    if (!isAbsolute(snapshot_path) || !snapshot_path.endsWith(".json")) {
      throw new Error(`snapshot_path must be an absolute path to a .json file, got "${snapshot_path}"`);
    }
    if (deps.fileExists(snapshot_path)) {
      throw new Error(`snapshot_path already exists, refusing to overwrite an earlier snapshot: ${snapshot_path}`);
    }
  }

  const state = await def.read(deps.call, args, deps.accountId);
  const plan = def.plan(state, args, deps.accountId);
  const summary = {
    before: plan.before,
    after: plan.after,
    diff: plan.diff,
    warnings: plan.warnings,
    restore_args: plan.restore_args,
  };

  if (confirm !== true) {
    return {
      mode: "dry_run",
      ...summary,
      planned_requests: (plan as any).preview_requests ?? plan.requests,
      next_step: plan.requests.length === 0
        ? "Nothing to change: the account already matches."
        : "Show the diff to the user; after an explicit go, call again with confirm: true, account_id and snapshot_path.",
    };
  }

  deps.writeFile(snapshot_path, JSON.stringify({
    tool: name,
    account_id: deps.accountId,
    taken_at: deps.now().toISOString(),
    args,
    before: plan.before,
    restore_args: plan.restore_args,
    planned_requests: (plan as any).preview_requests ?? plan.requests,
  }, null, 2));

  const executed: Array<{ request: MutationRequest; response: unknown }> = [];
  for (const req of plan.requests) {
    let response: any;
    try {
      response = await deps.call(req);
    } catch (e: any) {
      return failure(name, summary, executed, req, [String(e?.message ?? e)], snapshot_path);
    }
    const errors = collectResponseErrors(response);
    if (errors.length) return failure(name, summary, executed, req, errors, snapshot_path);
    executed.push({ request: req, response });
  }

  const stateAfter = await def.read(deps.call, args, deps.accountId);
  let verification: { ok: boolean; detail: unknown };
  if (def.verify) {
    verification = def.verify(state, stateAfter);
  } else {
    const replan = def.plan(stateAfter, args, deps.accountId);
    verification = { ok: replan.requests.length === 0, detail: replan.requests.length === 0 ? "account matches the request" : replan.diff };
  }

  return {
    mode: "confirmed",
    ...summary,
    snapshot_path,
    requests_sent: executed.length,
    verification,
  };
}

function failure(
  name: string,
  summary: Record<string, unknown>,
  executed: unknown[],
  failed: MutationRequest,
  errors: unknown[],
  snapshotPath: string,
): Record<string, unknown> {
  return {
    mode: "failed",
    error: true,
    message: `${name} stopped at request ${executed.length + 1}: the account may be partially changed. ` +
      `Re-read it, then replay restore_args from ${snapshotPath} if needed.`,
    ...summary,
    snapshot_path: snapshotPath,
    requests_sent: executed.length,
    failed_request: failed,
    errors,
  };
}
