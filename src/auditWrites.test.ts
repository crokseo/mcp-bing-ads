import { describe, it, expect } from "vitest";
import {
  planAddAudienceCriterion,
  planAdGroupNetwork,
  planAudienceNetworkBid,
  planCampaignStatus,
  planConversionGoal,
  type AudienceAttachState,
} from "./auditWrites.js";

const ACCOUNT = "111111111";

describe("planCampaignStatus", () => {
  const campaigns = [
    { Id: "11", Name: "Search A", Status: "Active" },
    { Id: "12", Name: "Display B", Status: "BudgetPaused" },
    { Id: "13", Name: "Brand C", Status: "Paused" },
  ];

  it("pauses an active campaign and restores it as Active", () => {
    const plan = planCampaignStatus({ accountId: ACCOUNT, campaigns }, { campaign_ids: ["11"], statut: "Paused" });
    expect(plan.requests).toEqual([{
      path: "/Campaigns", method: "PUT",
      body: { AccountId: 111111111, Campaigns: [{ Id: 11, Status: "Paused" }] },
    }]);
    expect(plan.restore_args).toEqual([{ campaign_ids: ["11"], statut: "Active" }]);
  });

  it("treats BudgetPaused as Active, with a warning", () => {
    const plan = planCampaignStatus({ accountId: ACCOUNT, campaigns }, { campaign_ids: ["12"], statut: "Paused" });
    expect(plan.restore_args).toEqual([{ campaign_ids: ["12"], statut: "Active" }]);
    expect(plan.warnings.join(" ")).toMatch(/BudgetPaused/);
  });

  it("sends nothing when the campaign already has the status", () => {
    expect(planCampaignStatus({ accountId: ACCOUNT, campaigns }, { campaign_ids: ["13"], statut: "Paused" }).requests).toEqual([]);
  });

  it("warns when no campaign would remain active", () => {
    const plan = planCampaignStatus({ accountId: ACCOUNT, campaigns }, { campaign_ids: ["11", "12"], statut: "Paused" });
    expect(plan.warnings.join(" ")).toMatch(/stops serving/);
  });

  it("refuses Deleted and unknown campaigns", () => {
    expect(() => planCampaignStatus({ accountId: ACCOUNT, campaigns }, { campaign_ids: ["11"], statut: "Deleted" })).toThrow(/Active or Paused/);
    expect(() => planCampaignStatus({ accountId: ACCOUNT, campaigns }, { campaign_ids: ["99"], statut: "Paused" })).toThrow(/not found/);
  });
});

describe("planConversionGoal", () => {
  const goals = [
    { Id: "21", Name: "Download", Type: "Url", Status: "Active", ExcludeFromBidding: true, Revenue: { Type: "FixedValue", Value: 10, CurrencyCode: "EUR" } },
    { Id: "22", Name: "Quote", Type: "Url", Status: "Active", ExcludeFromBidding: false, Revenue: { Type: "FixedValue", Value: 5, CurrencyCode: "EUR" } },
    { Id: "23", Name: "Cart", Type: "Event", Status: "Active", ExcludeFromBidding: false, Revenue: { Type: "VariableValue", Value: 1, CurrencyCode: "EUR" } },
  ];

  it("brings a goal into bidding and touches nothing else", () => {
    const plan = planConversionGoal(goals, { goal_ids: ["21"], exclude_from_bidding: false });
    expect(plan.requests).toEqual([{ path: "/ConversionGoals", method: "PUT", body: { ConversionGoals: [{ Id: 21, Type: "Url", ExcludeFromBidding: false }] } }]);
    expect(plan.restore_args).toEqual([{ goal_ids: ["21"], exclude_from_bidding: true }]);
  });

  it("sends the whole revenue object, keeping the currency", () => {
    const plan = planConversionGoal(goals, { goal_ids: ["22"], revenue: { type: "FixedValue", value: 40 } });
    const body = plan.requests[0].body as any;
    expect(body.ConversionGoals[0].Revenue).toEqual({ Type: "FixedValue", Value: 40, CurrencyCode: "EUR" });
    expect(body.ConversionGoals[0].ExcludeFromBidding).toBeUndefined();
    expect(plan.restore_args).toEqual([{ goal_ids: ["22"], revenue: { type: "FixedValue", value: 5 } }]);
  });

  it("warns before replacing a variable value", () => {
    const plan = planConversionGoal(goals, { goal_ids: ["23"], revenue: { type: "FixedValue", value: 20 } });
    expect(plan.warnings.join(" ")).toMatch(/variable value/);
  });

  it("is idempotent: replaying the current state sends nothing", () => {
    expect(planConversionGoal(goals, { goal_ids: ["21"], exclude_from_bidding: true, revenue: { type: "FixedValue", value: 10 } }).requests).toEqual([]);
  });

  it("rejects an empty change and bad values", () => {
    expect(() => planConversionGoal(goals, { goal_ids: ["21"] })).toThrow(/exclude_from_bidding and\/or revenue/);
    expect(() => planConversionGoal(goals, { goal_ids: ["21"], revenue: { type: "FixedValue" } })).toThrow(/revenue.value/);
    expect(() => planConversionGoal(goals, { goal_ids: ["21"], revenue: { type: "Bogus", value: 1 } })).toThrow(/revenue.type/);
    expect(() => planConversionGoal(goals, { goal_ids: ["99"], exclude_from_bidding: false })).toThrow(/not found/);
  });
});

describe("planAdGroupNetwork", () => {
  const groups = [
    { Id: "31", Name: "G1", Status: "Active", Network: "OwnedAndOperatedAndSyndicatedSearch" },
    { Id: "32", Name: "G2", Status: "Active", Network: "OwnedAndOperatedOnly" },
    { Id: "33", Name: "Display", Status: "Active", Network: null },
  ];

  it("removes search partners and restores per original network", () => {
    const plan = planAdGroupNetwork(groups, { campaign_id: "1", ad_group_ids: ["31", "32"], reseau: "OwnedAndOperatedOnly" });
    expect(plan.requests).toEqual([{ path: "/AdGroups", method: "PUT", body: { CampaignId: 1, AdGroups: [{ Id: 31, Network: "OwnedAndOperatedOnly" }] } }]);
    expect(plan.restore_args).toEqual([{ campaign_id: "1", ad_group_ids: ["31"], reseau: "OwnedAndOperatedAndSyndicatedSearch" }]);
  });

  it("refuses partners only without the flag, and non-search ad groups", () => {
    expect(() => planAdGroupNetwork(groups, { campaign_id: "1", ad_group_ids: ["31"], reseau: "SyndicatedSearchOnly" })).toThrow(/autoriser_partenaires_seuls/);
    expect(() => planAdGroupNetwork(groups, { campaign_id: "1", ad_group_ids: ["33"], reseau: "OwnedAndOperatedOnly" })).toThrow(/not search/);
  });
});

describe("planAudienceNetworkBid", () => {
  const campaigns = [
    { Id: "41", Name: "Search", CampaignType: "Search", AudienceAdsBidAdjustment: 0 },
    { Id: "42", Name: "Display", CampaignType: "Audience", AudienceAdsBidAdjustment: null },
  ];

  it("refuses any change: Microsoft accepts the update and does not apply it", () => {
    expect(() => planAudienceNetworkBid({ accountId: ACCOUNT, campaigns }, { campaign_id: "41", ajustement: -100 })).toThrow(/February 2023/);
  });

  it("is a no-op when the value already matches", () => {
    const plan = planAudienceNetworkBid({ accountId: ACCOUNT, campaigns }, { campaign_id: "41", ajustement: 0 });
    expect(plan.requests).toEqual([]);
  });

  it("refuses non-Search campaigns and out-of-range values", () => {
    expect(() => planAudienceNetworkBid({ accountId: ACCOUNT, campaigns }, { campaign_id: "42", ajustement: -100 })).toThrow(/Search campaigns/);
    expect(() => planAudienceNetworkBid({ accountId: ACCOUNT, campaigns }, { campaign_id: "41", ajustement: -101 })).toThrow(/between/);
    expect(() => planAudienceNetworkBid({ accountId: ACCOUNT, campaigns }, { campaign_id: "41", ajustement: 2.5 })).toThrow(/integer/);
  });
});

describe("planAddAudienceCriterion", () => {
  const base = (over: Partial<AudienceAttachState> = {}): AudienceAttachState => ({
    accountId: ACCOUNT,
    audience: { Id: "51", Name: "Customers", Type: "CustomerList" },
    campaign: { Id: "1", Name: "Search", audienceTargetAndBid: false },
    adGroups: [
      { Id: "61", Name: "G1", audienceTargetAndBid: null },
      { Id: "62", Name: "G2", audienceTargetAndBid: true },
    ],
    existing: {},
    biddableAtOtherLevel: [],
    ...over,
  });

  it("attaches in observation at ad group level with a zero multiplier", () => {
    const plan = planAddAudienceCriterion(base(), { niveau: "ad_group", campaign_id: "1", ad_group_ids: ["61"], audience_id: "51", mode: "observation" });
    expect(plan.requests).toEqual([{
      path: "/AdGroupCriterions", method: "POST",
      body: {
        CriterionType: "Audience",
        AdGroupCriterions: [{
          Criterion: { Type: "AudienceCriterion", AudienceId: 51, AudienceType: "CustomerList" },
          Type: "BiddableAdGroupCriterion", AdGroupId: 61,
          CriterionBid: { Type: "BidMultiplier", Multiplier: 0 },
        }],
      },
    }]);
    expect(plan.restore_args).toBeNull();
    expect(plan.warnings.join(" ")).toMatch(/GDPR/);
  });

  it("refuses an observation where audiences are in Targeting mode, unless allowed", () => {
    const args = { niveau: "ad_group", campaign_id: "1", ad_group_ids: ["62"], audience_id: "51", mode: "observation" };
    expect(() => planAddAudienceCriterion(base(), args)).toThrow(/Targeting mode/);
    expect(planAddAudienceCriterion(base(), { ...args, autoriser_ciblage: true }).requests).toHaveLength(1);
  });

  it("refuses campaign-level associations on an Audience campaign (ad group level only)", () => {
    const st = base({ campaign: { Id: "1", Name: "Display", CampaignType: "Audience", audienceTargetAndBid: true } });
    expect(() => planAddAudienceCriterion(st, { niveau: "campaign", campaign_id: "1", audience_id: "51", mode: "exclusion" })).toThrow(/ad_group/);
  });

  it("allows an exclusion even in Targeting mode, at campaign level", () => {
    const st = base({ campaign: { Id: "1", Name: "Display", audienceTargetAndBid: true } });
    const plan = planAddAudienceCriterion(st, { niveau: "campaign", campaign_id: "1", audience_id: "51", mode: "exclusion" });
    expect(plan.requests[0]).toEqual({
      path: "/CampaignCriterions", method: "POST",
      body: {
        CriterionType: "Audience",
        CampaignCriterions: [{ Criterion: { Type: "AudienceCriterion", AudienceId: 51, AudienceType: "CustomerList" }, Type: "NegativeCampaignCriterion", CampaignId: 1 }],
      },
    });
  });

  it("refuses a biddable association when the other level already has one", () => {
    const st = base({ biddableAtOtherLevel: [{ entity: "G1", audience_id: "77", type: "InMarketAudience" }] });
    expect(() => planAddAudienceCriterion(st, { niveau: "campaign", campaign_id: "1", audience_id: "51", mode: "observation" })).toThrow(/both levels/);
  });

  it("skips entities that already carry the audience", () => {
    const st = base({ existing: { "61": [{ Type: "BiddableAdGroupCriterion", Criterion: { AudienceId: "51" } }] } });
    const plan = planAddAudienceCriterion(st, { niveau: "ad_group", campaign_id: "1", ad_group_ids: ["61"], audience_id: "51", mode: "observation" });
    expect(plan.requests).toEqual([]);
  });

  it("warns when the audience is already attached in the other mode", () => {
    const st = base({ existing: { campaign: [{ Type: "NegativeCampaignCriterion", Criterion: { AudienceId: "51" } }] } });
    const plan = planAddAudienceCriterion(st, { niveau: "campaign", campaign_id: "1", audience_id: "51", mode: "observation" });
    expect(plan.requests).toEqual([]);
    expect(plan.warnings.join(" ")).toMatch(/already attached/);
  });

  it("validates its arguments", () => {
    expect(() => planAddAudienceCriterion(base(), { niveau: "account", campaign_id: "1", audience_id: "51", mode: "observation" })).toThrow(/niveau/);
    expect(() => planAddAudienceCriterion(base(), { niveau: "campaign", campaign_id: "1", audience_id: "51", mode: "exclusion", bid_multiplier: 10 })).toThrow(/exclusion/);
    expect(() => planAddAudienceCriterion(base(), { niveau: "ad_group", campaign_id: "1", ad_group_ids: ["99"], audience_id: "51", mode: "exclusion" })).toThrow(/not found/);
  });
});
