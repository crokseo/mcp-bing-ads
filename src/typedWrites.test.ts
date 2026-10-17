import { describe, it, expect } from "vitest";
import {
  MAX_CRITERIONS_PER_CALL,
  RawCampaignCriterion,
  collectResponseErrors,
  parseSchedule,
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

const dayTime = (id: string, Day: string, from: [number, string], to: [number, string], Multiplier = 0): RawCampaignCriterion => ({
  Id: id,
  Type: "BiddableCampaignCriterion",
  Criterion: { Type: "DayTimeCriterion", Day, FromHour: from[0], FromMinute: from[1], ToHour: to[0], ToMinute: to[1] },
  CriterionBid: { Multiplier },
});

const weekdays = ["lundi", "mardi", "mercredi", "jeudi", "vendredi"].map(jour => ({ jour, debut: "08:00", fin: "19:00" }));

describe("parseSchedule", () => {
  it("accepts French and English day names and normalizes them", () => {
    const s = parseSchedule([{ jour: "lundi", debut: "08:15", fin: "12:00" }, { jour: "Sunday", debut: "00:00", fin: "24:00" }]);
    expect(s).toEqual([
      { day: "Monday", from: 495, to: 720, multiplier: 0 },
      { day: "Sunday", from: 0, to: 1440, multiplier: 0 },
    ]);
  });

  it.each([
    [{ jour: "lundi", debut: "08:10", fin: "12:00" }, /00, 15, 30 or 45/],
    [{ jour: "lundi", debut: "12:00", fin: "08:00" }, /after debut/],
    [{ jour: "lundi", debut: "24:00", fin: "24:00" }, /out of range/],
    [{ jour: "funday", debut: "08:00", fin: "12:00" }, /weekday/],
    [{ jour: "lundi", debut: "8h", fin: "12:00" }, /HH:MM/],
    [{ jour: "lundi", debut: "08:00", fin: "12:00", bid_multiplier: -95 }, /-90 and 900/],
  ])("rejects %o", (plage, msg) => {
    expect(() => parseSchedule([plage as any])).toThrow(msg);
  });

  it("refuses overlapping plages on the same day", () => {
    expect(() => parseSchedule([
      { jour: "lundi", debut: "08:00", fin: "12:00" },
      { jour: "Monday", debut: "11:45", fin: "14:00" },
    ])).toThrow(/Overlapping plages on Monday/);
  });

  it("allows back-to-back plages", () => {
    expect(parseSchedule([
      { jour: "lundi", debut: "08:00", fin: "12:00" },
      { jour: "lundi", debut: "12:00", fin: "14:00" },
    ])).toHaveLength(2);
  });
});

describe("planAdSchedule", () => {
  it("refuses an empty schedule unless 24/7 is explicit", () => {
    expect(() => planAdSchedule({}, { campaign_ids: ["1"], plages: [] })).toThrow(/diffusion_24_7/);
    const plan = planAdSchedule({ "1": [dayTime("9", "Monday", [8, "Zero"], [12, "Zero"])] }, { campaign_ids: ["1"], plages: [], diffusion_24_7: true });
    expect(plan.requests).toEqual([{ path: "/CampaignCriterions", method: "DELETE", body: { CampaignCriterionIds: [9], CampaignId: 1, CriterionType: "Targets" } }]);
  });

  it("warns about closed days", () => {
    const plan = planAdSchedule({ "1": [] }, { campaign_ids: ["1"], plages: weekdays });
    expect(plan.warnings).toEqual(["No delivery on: Saturday, Sunday"]);
  });

  it("deletes, updates and adds only what differs", () => {
    const current = {
      "1": [
        dayTime("10", "Monday", [8, "Zero"], [19, "Zero"]),           // kept as is
        dayTime("11", "Tuesday", [8, "Zero"], [19, "Zero"], 0),       // multiplier changes
        dayTime("12", "Saturday", [9, "Thirty"], [12, "Zero"]),       // removed
      ],
    };
    const plan = planAdSchedule(current, {
      campaign_ids: ["1"],
      plages: [
        { jour: "lundi", debut: "08:00", fin: "19:00" },
        { jour: "mardi", debut: "08:00", fin: "19:00", bid_multiplier: 20 },
        { jour: "mercredi", debut: "08:00", fin: "19:00" },
      ],
    });
    expect(plan.requests.map(r => r.method)).toEqual(["DELETE", "PUT", "POST"]);
    expect(plan.requests[0].body).toEqual({ CampaignCriterionIds: [12], CampaignId: 1, CriterionType: "Targets" });
    expect((plan.requests[1].body as any).CampaignCriterions[0]).toMatchObject({ Id: 11, CriterionBid: { Type: "BidMultiplier", Multiplier: 20 } });
    expect((plan.requests[2].body as any).CampaignCriterions[0].Criterion).toEqual({
      Type: "DayTimeCriterion", Day: "Wednesday", FromHour: 8, FromMinute: "Zero", ToHour: 19, ToMinute: "Zero",
    });
  });

  it("sends nothing when replaying the current schedule", () => {
    const current = { "1": [dayTime("10", "Monday", [8, "Fifteen"], [19, "FortyFive"], 10)] };
    const plan = planAdSchedule(current, { campaign_ids: ["1"], plages: [{ jour: "Monday", debut: "08:15", fin: "19:45", bid_multiplier: 10 }] });
    expect(plan.requests).toEqual([]);
  });

  it("groups campaigns sharing a schedule in restore_args, and restores an empty one as 24/7", () => {
    const shared = [dayTime("1", "Monday", [8, "Zero"], [12, "Zero"])];
    const plan = planAdSchedule({ "1": shared, "2": shared, "3": [] }, { campaign_ids: ["1", "2", "3"], plages: weekdays });
    expect(plan.restore_args).toEqual([
      { campaign_ids: ["1", "2"], plages: [{ jour: "Monday", debut: "08:00", fin: "12:00", bid_multiplier: 0 }] },
      { campaign_ids: ["3"], plages: [], diffusion_24_7: true },
    ]);
  });

  it("splits large changes into batches of 100 criterions", () => {
    const current: Record<string, RawCampaignCriterion[]> = { "1": [] };
    const plan = planAdSchedule(current, { campaign_ids: ["1"], plages: weekdays });
    expect(plan.requests).toHaveLength(1);
    expect(MAX_CRITERIONS_PER_CALL).toBe(100);
  });
});

const loc = (id: string, LocationId: string, LocationType: string, DisplayName: string, negative = false, Multiplier = 0): RawCampaignCriterion => ({
  Id: id,
  Type: negative ? "NegativeCampaignCriterion" : "BiddableCampaignCriterion",
  Criterion: { Type: "LocationCriterion", LocationId, LocationType, DisplayName },
  CriterionBid: negative ? undefined : { Multiplier },
});

describe("planLocations", () => {
  const current = [
    loc("1", "66", "Country", "France"),
    loc("2", "1276", "State", "Brittany, France", false, 15),
    loc("3", "120", "Country", "Monaco"),
    loc("4", "5000", "City", "Brest, Brittany, France", true),
  ];

  it("refuses an empty target unless explicitly allowed", () => {
    expect(() => planLocations(current, { campaign_id: "9", inclusions: [] })).toThrow(/autoriser_cible_vide/);
    expect(() => planLocations(current, { campaign_id: "9", inclusions: [], autoriser_cible_vide: true })).not.toThrow();
  });

  it("refuses a location both included and excluded", () => {
    expect(() => planLocations(current, { campaign_id: "9", inclusions: ["66"], exclusions: ["66"] })).toThrow(/both included and excluded/);
  });

  it("warns when a country is targeted with its own subdivisions", () => {
    const plan = planLocations(current, { campaign_id: "9", inclusions: ["66", "1276"], exclusions: ["5000"] });
    expect(plan.warnings[0]).toMatch(/France is targeted as a country together with 1 of its subdivisions/);
  });

  it("warns about location ids it cannot name", () => {
    const plan = planLocations(current, { campaign_id: "9", inclusions: ["66", "777"] });
    expect(plan.warnings.some(w => /777/.test(w))).toBe(true);
  });

  it("keeps the current multiplier when bid_multiplier is omitted", () => {
    const plan = planLocations(current, { campaign_id: "9", inclusions: ["66", "1276", "120"], exclusions: ["5000"] });
    expect(plan.requests).toEqual([]);
  });

  it("removes, re-bids and adds with the right criterion types", () => {
    const plan = planLocations(current, {
      campaign_id: "9",
      inclusions: [{ location_id: "66" }, { location_id: "1276", bid_multiplier: 30 }, { location_id: "888" }],
      exclusions: ["5000", "6000"],
    });
    const [del, put, post] = plan.requests;
    expect(del).toEqual({ path: "/CampaignCriterions", method: "DELETE", body: { CampaignCriterionIds: [3], CampaignId: 9, CriterionType: "Targets" } });
    expect((put.body as any).CampaignCriterions[0]).toMatchObject({ Id: 2, CriterionBid: { Multiplier: 30 } });
    expect((post.body as any).CampaignCriterions).toEqual([
      { Type: "BiddableCampaignCriterion", CampaignId: 9, Criterion: { Type: "LocationCriterion", LocationId: 888 }, CriterionBid: { Type: "BidMultiplier", Multiplier: 0 } },
      { Type: "NegativeCampaignCriterion", CampaignId: 9, Criterion: { Type: "LocationCriterion", LocationId: 6000 } },
    ]);
  });

  it("keeps current exclusions when the argument is omitted", () => {
    const plan = planLocations(current, { campaign_id: "9", inclusions: ["66", "1276", "120"] });
    expect(plan.requests).toEqual([]);
  });

  it("refuses including a location that stays excluded", () => {
    expect(() => planLocations(current, { campaign_id: "9", inclusions: ["5000"] })).toThrow(/both included and excluded/);
  });

  it("warns before a mass removal", () => {
    const many = Array.from({ length: 25 }, (_, i) => loc(String(100 + i), String(9000 + i), "City", `C${i}, France`, true));
    const plan = planLocations([...current, ...many], { campaign_id: "9", inclusions: ["66"], exclusions: [] });
    expect(plan.warnings.some(w => /would be removed/.test(w))).toBe(true);
  });

  it("restore_args reproduce the current targeting with multipliers", () => {
    const plan = planLocations(current, { campaign_id: "9", inclusions: ["66"] });
    expect(plan.restore_args).toEqual([{
      campaign_id: "9",
      inclusions: [
        { location_id: "66", bid_multiplier: 0 },
        { location_id: "1276", bid_multiplier: 15 },
        { location_id: "120", bid_multiplier: 0 },
      ],
      exclusions: ["5000"],
    }]);
  });
});

const device = (id: string, DeviceName: string, Multiplier: number): RawCampaignCriterion => ({
  Id: id, Type: "BiddableCampaignCriterion", Criterion: { Type: "DeviceCriterion", DeviceName }, CriterionBid: { Multiplier },
});

describe("planDeviceBid", () => {
  const current = [device("1", "Computers", 0), device("2", "Smartphones", -33), device("3", "Tablets", 0)];

  it("updates only the devices passed and that change", () => {
    const plan = planDeviceBid(current, { campaign_id: "9", smartphones: -20, tablets: 0 });
    expect(plan.requests).toHaveLength(1);
    expect((plan.requests[0].body as any).CampaignCriterions).toEqual([
      { Id: 2, Type: "BiddableCampaignCriterion", CampaignId: 9, Criterion: { Type: "DeviceCriterion", DeviceName: "Smartphones" }, CriterionBid: { Type: "BidMultiplier", Multiplier: -20 } },
    ]);
    expect(plan.restore_args).toEqual([{ campaign_id: "9", smartphones: -33 }]);
  });

  it("accepts -100 for a device, with a warning, but refuses excluding every device", () => {
    expect(planDeviceBid(current, { campaign_id: "9", tablets: -100 }).warnings[0]).toMatch(/Tablets set to -100/);
    expect(() => planDeviceBid(current, { campaign_id: "9", computers: -100, smartphones: -100, tablets: -100 })).toThrow(/stop serving/);
  });

  it("enforces API bounds and requires at least one device", () => {
    expect(() => planDeviceBid(current, { campaign_id: "9", computers: 901 })).toThrow(/-100 and 900/);
    expect(() => planDeviceBid(current, { campaign_id: "9" })).toThrow(/at least one/);
  });

  it("adds a device criterion that does not exist yet", () => {
    const plan = planDeviceBid([device("1", "Computers", 0)], { campaign_id: "9", tablets: 10 });
    expect(plan.requests[0].method).toBe("POST");
  });
});

describe("planAdGroupStatus", () => {
  const groups = [
    { Id: "1", Name: "A", Status: "Active" },
    { Id: "2", Name: "B", Status: "Active" },
    { Id: "3", Name: "C", Status: "Paused" },
  ];

  it("never deletes", () => {
    expect(() => planAdGroupStatus(groups, { campaign_id: "9", ad_group_ids: ["1"], statut: "Deleted" })).toThrow(/Active or Paused/);
  });

  it("refuses leaving the campaign without an active ad group", () => {
    expect(() => planAdGroupStatus(groups, { campaign_id: "9", ad_group_ids: ["1", "2"], statut: "Paused" })).toThrow(/without any active ad group/);
  });

  it("warns when a single active group remains", () => {
    expect(planAdGroupStatus(groups, { campaign_id: "9", ad_group_ids: ["1"], statut: "Paused" }).warnings[0]).toMatch(/Only one active ad group left/);
  });

  it("refuses ad groups that are not in the campaign", () => {
    expect(() => planAdGroupStatus(groups, { campaign_id: "9", ad_group_ids: ["42"], statut: "Paused" })).toThrow(/not found/);
  });

  it("sends only the groups that change, and restores them by original status", () => {
    const plan = planAdGroupStatus(groups, { campaign_id: "9", ad_group_ids: ["1", "3"], statut: "Active" });
    expect(plan.requests).toEqual([{ path: "/AdGroups", method: "PUT", body: { CampaignId: 9, AdGroups: [{ Id: 3, Status: "Active" }] } }]);
    expect(plan.restore_args).toEqual([{ campaign_id: "9", ad_group_ids: ["3"], statut: "Paused" }]);
  });
});

describe("planFinalUrlSuffix", () => {
  const state = { suffix: "", trackingTemplate: "{lpurl}?cc=1", campaignSuffixes: [{ id: "1", name: "Brand", suffix: "x=1" }, { id: "2", name: "Other", suffix: "" }] };

  it("sets only FinalUrlSuffix, never the tracking template", () => {
    const plan = planFinalUrlSuffix(state, { valeur: "utm_source=bing&utm_medium=cpc" });
    expect(plan.requests).toEqual([{
      path: "/AccountProperties/Set",
      method: "POST",
      body: { AccountProperties: [{ Name: "FinalUrlSuffix", Value: "utm_source=bing&utm_medium=cpc" }] },
    }]);
    expect(JSON.stringify(plan.requests)).not.toMatch(/TrackingUrlTemplate/);
    expect(plan.restore_args).toEqual([{ valeur: "" }]);
  });

  it("warns about campaign suffixes that override the account one", () => {
    expect(planFinalUrlSuffix(state, { valeur: "a=b" }).warnings).toEqual([expect.stringMatching(/"Brand" has its own suffix/)]);
  });

  it("refuses a leading separator or spaces", () => {
    expect(() => planFinalUrlSuffix(state, { valeur: "?a=b" })).toThrow(/must not start/);
    expect(() => planFinalUrlSuffix(state, { valeur: "a=b c" })).toThrow(/spaces/);
  });

  it("sends nothing when the suffix is unchanged", () => {
    expect(planFinalUrlSuffix({ ...state, suffix: "a=b" }, { valeur: "a=b" }).requests).toEqual([]);
  });
});

describe("planBiddingStrategy", () => {
  const campaigns = [
    { Id: "1", Name: "Search", BiddingScheme: { Type: "MaxConversions", MaxCpc: { Amount: null } } },
    { Id: "2", Name: "Brand", BiddingScheme: null },
    { Id: "3", Name: "Display", BiddingScheme: { Type: "EnhancedCpc" } },
  ];
  const state = { accountId: "111111111", campaigns, portfolioCampaignIds: new Set<string>(["4"]) };

  it("refuses campaigns whose current scheme the API does not return", () => {
    expect(() => planBiddingStrategy(state, { campaign_ids: ["2"], strategie: "MaxConversions" })).toThrow(/could not be restored/);
  });

  it("refuses portfolio campaigns, even with detacher_portefeuille", () => {
    const s = { ...state, campaigns: [...campaigns, { Id: "4", Name: "P", BiddingScheme: { Type: "TargetCpa" } }] };
    expect(() => planBiddingStrategy(s, { campaign_ids: ["4"], strategie: "MaxConversions", detacher_portefeuille: true })).toThrow(/portfolio/);
  });

  it("validates targets against the strategy", () => {
    expect(() => planBiddingStrategy(state, { campaign_ids: ["1"], strategie: "MaxConversions", target_roas: 4 })).toThrow(/target_roas only/);
    expect(() => planBiddingStrategy(state, { campaign_ids: ["1"], strategie: "MaxConversions", target_cpa: 0 })).toThrow(/positive/);
    expect(() => planBiddingStrategy(state, { campaign_ids: ["1"], strategie: "ManualCpc" })).toThrow(/strategie must be/);
  });

  it("builds the campaign update and a restore with the original scheme", () => {
    const plan = planBiddingStrategy(state, { campaign_ids: ["3"], strategie: "MaxConversions", target_cpa: 40 });
    expect(plan.requests).toEqual([{
      path: "/Campaigns",
      method: "PUT",
      body: { AccountId: 111111111, Campaigns: [{ Id: 3, BiddingScheme: { Type: "MaxConversions", TargetCpa: 40 } }] },
    }]);
    expect(plan.restore_args).toEqual([{ campaign_ids: ["3"], bidding_scheme: { Type: "EnhancedCpc" } }]);
    expect(plan.warnings[0]).toMatch(/learning period/);
  });

  it("ignores null amounts when comparing, so a replay sends nothing", () => {
    expect(planBiddingStrategy(state, { campaign_ids: ["1"], strategie: "MaxConversions" }).requests).toEqual([]);
  });

  it("accepts a restorable bidding_scheme for restores only", () => {
    expect(planBiddingStrategy(state, { campaign_ids: ["1"], bidding_scheme: { Type: "EnhancedCpc" } }).requests).toHaveLength(1);
    expect(() => planBiddingStrategy(state, { campaign_ids: ["1"], bidding_scheme: { Type: "Weird" } })).toThrow(/bidding_scheme.Type/);
  });
});

describe("planAddKeywords", () => {
  const existing = [
    { Id: "1", Text: "cloison amovible", MatchType: "Exact", Status: "Active" },
    { Id: "2", Text: "mur mobile", MatchType: "Broad", Status: "Paused" },
  ];

  it("skips duplicates (existing or repeated) and warns about paused twins", () => {
    const plan = planAddKeywords(existing, {
      ad_group_id: "5",
      keywords: [
        { text: "Cloison  Amovible", match_type: "Exact" },
        { text: "cloison amovible", match_type: "Phrase" },
        { text: "cloison amovible", match_type: "Phrase" },
        { text: "mur mobile", match_type: "Broad" },
      ],
    });
    expect(plan.requests).toEqual([{ path: "/Keywords", method: "POST", body: { AdGroupId: 5, Keywords: [{ Text: "cloison amovible", MatchType: "Phrase" }] } }]);
    expect((plan.diff as any).skipped).toHaveLength(3);
    expect(plan.warnings[0]).toMatch(/reactivate/);
    expect(plan.restore_args).toBeNull();
  });

  it("validates match type, length, word count and bid", () => {
    expect(() => planAddKeywords([], { ad_group_id: "5", keywords: [{ text: "a", match_type: "Fuzzy" }] })).toThrow(/match_type/);
    expect(() => planAddKeywords([], { ad_group_id: "5", keywords: [{ text: "x".repeat(101), match_type: "Exact" }] })).toThrow(/100 characters/);
    expect(() => planAddKeywords([], { ad_group_id: "5", keywords: [{ text: "a b c d e f g h i j k", match_type: "Exact" }] })).toThrow(/10 words/);
    expect(() => planAddKeywords([], { ad_group_id: "5", keywords: [{ text: "a", match_type: "Exact", bid: -1 }] })).toThrow(/bid/);
  });
});

describe("planAddNegativeKeywords", () => {
  it("defaults to phrase, refuses broad, skips existing negatives", () => {
    const plan = planAddNegativeKeywords(
      { existing: [{ Text: "gratuit", MatchType: "Phrase" }] },
      { niveau: "campaign", entity_id: "9", keywords: [{ text: "gratuit" }, { text: "occasion" }] },
    );
    expect(plan.requests).toEqual([{
      path: "/EntityNegativeKeywords",
      method: "POST",
      body: { EntityNegativeKeywords: [{ EntityId: 9, EntityType: "Campaign", NegativeKeywords: [{ Text: "occasion", MatchType: "Phrase" }] }] },
    }]);
    expect(() => planAddNegativeKeywords({ existing: [] }, { niveau: "campaign", entity_id: "9", keywords: [{ text: "x", match_type: "Broad" }] })).toThrow(/no broad/);
  });

  it("warns when an ad group negative blocks an active keyword of the group", () => {
    const plan = planAddNegativeKeywords(
      { existing: [], positives: [{ Id: "1", Text: "cloison amovible bureau", MatchType: "Phrase", Status: "Active" }] },
      { niveau: "ad_group", entity_id: "5", keywords: [{ text: "bureau" }, { text: "cloison amovible", match_type: "Exact" }] },
    );
    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0]).toMatch(/"bureau" \[Phrase\] blocks/);
  });

  it("refuses an unknown level", () => {
    expect(() => planAddNegativeKeywords({ existing: [] }, { niveau: "account", entity_id: "9", keywords: [{ text: "x" }] })).toThrow(/niveau/);
  });
});

describe("planAddResponsiveSearchAd", () => {
  const titres = ["Cloison amovible", "Mur mobile", { texte: "Exemple", epingle: 1 }];
  const descriptions = ["Fabricant français de cloisons amovibles.", "Devis gratuit sous 48 h."];

  it("builds the ad with pins and paths", () => {
    const plan = planAddResponsiveSearchAd([], { ad_group_id: "5", titres, descriptions, final_url: "https://example.com/", path1: "Cloison", path2: "Amovible" });
    const ad = (plan.requests[0].body as any).Ads[0];
    expect(plan.requests[0]).toMatchObject({ path: "/Ads", method: "POST", body: { AdGroupId: 5 } });
    expect(ad.Headlines[2]).toEqual({ Asset: { Type: "TextAsset", Text: "Exemple" }, PinnedField: "Headline1" });
    expect(ad.Headlines[0]).toEqual({ Asset: { Type: "TextAsset", Text: "Cloison amovible" } });
    expect(ad).toMatchObject({ Type: "ResponsiveSearch", FinalUrls: ["https://example.com/"], Path1: "Cloison", Path2: "Amovible" });
  });

  it.each([
    [{ titres: ["a", "b"] }, /between 3 and 15/],
    [{ titres: ["x".repeat(31), "b", "c"] }, /max 30/],
    [{ titres: ["a", "A", "c"] }, /duplicate/],
    [{ descriptions: ["only one"] }, /between 2 and 4/],
    [{ descriptions: ["y".repeat(91), "ok"] }, /max 90/],
    [{ final_url: "http://example.com" }, /https/],
    [{ path2: "Amovible" }, /path2 requires path1/],
    [{ path1: "x".repeat(16) }, /15 characters/],
    [{ titres: ["a", "b", { texte: "c", epingle: 4 }] }, /epingle/],
  ])("rejects %o", (override, msg) => {
    expect(() => planAddResponsiveSearchAd([], { ad_group_id: "5", titres, descriptions, final_url: "https://example.com/", ...override } as any)).toThrow(msg);
  });

  it("warns about a full ad group and an identical existing ad", () => {
    const existing = [1, 2, 3].map(i => ({ Id: String(i), Status: "Active", Headlines: titres.map(t => ({ Asset: { Text: typeof t === "string" ? t : t.texte } })) }));
    const plan = planAddResponsiveSearchAd(existing, { ad_group_id: "5", titres, descriptions, final_url: "https://example.com/" });
    expect(plan.warnings.some(w => /3 active responsive search ads/.test(w))).toBe(true);
    expect(plan.warnings.some(w => /exactly these headlines/.test(w))).toBe(true);
  });
});

describe("collectResponseErrors", () => {
  it("finds per-item errors returned with HTTP 200 and ignores null slots", () => {
    expect(collectResponseErrors({ CampaignCriterionIds: [1], NestedPartialErrors: [] })).toEqual([]);
    expect(collectResponseErrors({ PartialErrors: [null, { Code: 1 }] })).toEqual([{ Code: 1 }]);
    expect(collectResponseErrors({ NestedPartialErrors: [{ Code: 2 }], BatchErrors: [{ Code: 3 }] })).toHaveLength(2);
    expect(collectResponseErrors({})).toEqual([]);
  });
});
