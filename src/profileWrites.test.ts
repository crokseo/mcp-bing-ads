import { describe, it, expect } from "vitest";
import { BID_ONLY_WARNING, ProfileBidState, planProfileBid } from "./profileWrites.js";

const ACCOUNT = "111111111";

const crit = (id: string, type: string, profileId: string, opts: { negative?: boolean; m?: number } = {}) => ({
  Id: id,
  Type: opts.negative ? "NegativeCampaignCriterion" : "BiddableCampaignCriterion",
  CampaignId: "1",
  Criterion: { Type: "ProfileCriterion", ProfileId: profileId, ProfileType: type },
  ...(opts.negative ? {} : { CriterionBid: { Type: "BidMultiplier", Multiplier: opts.m ?? 0 } }),
});

const state = (over: Partial<ProfileBidState> = {}): ProfileBidState => ({
  accountId: ACCOUNT,
  existing: [crit("71", "Industry", "501"), crit("72", "JobFunction", "601"), crit("73", "Industry", "502", { negative: true })],
  known: { Industry: new Set(["501", "502", "503"]), JobFunction: new Set(["601", "602"]), CompanyName: null },
  ...over,
});

describe("planProfileBid", () => {
  it("updates existing adjustments with a PUT per criterion type, restorable to the old value", () => {
    const plan = planProfileBid(state(), {
      campaign_id: "1",
      profils: [
        { profile_type: "Industry", profile_id: "501", bid_multiplier: 25 },
        { profile_type: "JobFunction", profile_id: "601", bid_multiplier: 25 },
      ],
    });
    expect(plan.requests).toEqual([
      {
        path: "/CampaignCriterions", method: "PUT",
        body: {
          CriterionType: "Targets",
          CampaignCriterions: [{
            Id: 71, Type: "BiddableCampaignCriterion", CampaignId: 1,
            Criterion: { Type: "ProfileCriterion", ProfileId: 501, ProfileType: "Industry" },
            CriterionBid: { Type: "BidMultiplier", Multiplier: 25 },
          }],
        },
      },
      {
        path: "/CampaignCriterions", method: "PUT",
        body: {
          CriterionType: "Targets",
          CampaignCriterions: [{
            Id: 72, Type: "BiddableCampaignCriterion", CampaignId: 1,
            Criterion: { Type: "ProfileCriterion", ProfileId: 601, ProfileType: "JobFunction" },
            CriterionBid: { Type: "BidMultiplier", Multiplier: 25 },
          }],
        },
      },
    ]);
    expect(plan.restore_args).toEqual([{
      campaign_id: "1",
      profils: [
        { profile_type: "Industry", profile_id: "501", bid_multiplier: 0 },
        { profile_type: "JobFunction", profile_id: "601", bid_multiplier: 0 },
      ],
    }]);
    expect(plan.warnings[0]).toBe(BID_ONLY_WARNING);
  });

  it("adds absent profiles as biddable or negative criteria, and never deletes", () => {
    const plan = planProfileBid(state(), {
      campaign_id: "1",
      profils: [
        { profile_type: "Industry", profile_id: "503", bid_multiplier: 40 },
        { profile_type: "JobFunction", profile_id: "602", exclure: true },
      ],
    });
    expect(plan.requests.map(r => [r.method, (r.body as any).CriterionType, (r.body as any).CampaignCriterions[0].Type])).toEqual([
      ["POST", "Targets", "BiddableCampaignCriterion"],
      ["POST", "Targets", "NegativeCampaignCriterion"],
    ]);
    expect((plan.requests[1].body as any).CampaignCriterions[0].CriterionBid).toBeUndefined();
    expect(plan.requests.some(r => (r.method as string) === "DELETE")).toBe(false);
    // The created adjustment restores to 0; the created exclusion cannot be undone.
    expect(plan.restore_args).toEqual([{ campaign_id: "1", profils: [{ profile_type: "Industry", profile_id: "503", bid_multiplier: 0 }] }]);
    expect(plan.warnings.join(" ")).toMatch(/cannot undo/);
  });

  it("is a no-op when everything already matches", () => {
    const plan = planProfileBid(state(), {
      campaign_id: "1",
      profils: [
        { profile_type: "Industry", profile_id: "501", bid_multiplier: 0 },
        { profile_type: "Industry", profile_id: "502", exclure: true },
      ],
    });
    expect(plan.requests).toEqual([]);
    expect(plan.restore_args).toBeNull();
  });

  it("refuses to switch an existing criterion between bid adjustment and exclusion", () => {
    expect(() => planProfileBid(state(), { campaign_id: "1", profils: [{ profile_type: "Industry", profile_id: "502", bid_multiplier: 10 }] })).toThrow(/interface/);
    expect(() => planProfileBid(state(), { campaign_id: "1", profils: [{ profile_type: "Industry", profile_id: "501", exclure: true }] })).toThrow(/interface/);
  });

  it("checks ids against Microsoft's published lists, and warns when a list is unavailable", () => {
    expect(() => planProfileBid(state(), { campaign_id: "1", profils: [{ profile_type: "Industry", profile_id: "999", bid_multiplier: 10 }] })).toThrow(/published Industry list/);
    const plan = planProfileBid(state(), { campaign_id: "1", profils: [{ profile_type: "CompanyName", profile_id: "777", bid_multiplier: 50 }] });
    expect(plan.warnings.join(" ")).toMatch(/CompanyName ids are not verified/);
    expect((plan.requests[0].body as any).CriterionType).toBe("Targets");
  });

  it("rejects malformed requests before anything is sent", () => {
    const one = (p: any) => () => planProfileBid(state(), { campaign_id: "1", profils: [p] });
    expect(() => planProfileBid(state(), { campaign_id: "1", profils: [] })).toThrow(/at least one/);
    expect(one({ profile_type: "Age", profile_id: "501", bid_multiplier: 10 })).toThrow(/profile_type/);
    expect(one({ profile_type: "Industry", profile_id: "501", bid_multiplier: -100 })).toThrow(/between -90 and 900/);
    expect(one({ profile_type: "Industry", profile_id: "501", bid_multiplier: 901 })).toThrow(/between -90 and 900/);
    expect(one({ profile_type: "Industry", profile_id: "501" })).toThrow(/bid_multiplier/);
    expect(one({ profile_type: "Industry", profile_id: "502", exclure: true, bid_multiplier: 5 })).toThrow(/does not apply/);
    expect(one({ profile_type: "Industry", profile_id: "abc", bid_multiplier: 5 })).toThrow(/numeric/);
    expect(() => planProfileBid(state(), {
      campaign_id: "1",
      profils: [
        { profile_type: "Industry", profile_id: "501", bid_multiplier: 10 },
        { profile_type: "Industry", profile_id: "501", bid_multiplier: 20 },
      ],
    })).toThrow(/twice/);
  });
});
