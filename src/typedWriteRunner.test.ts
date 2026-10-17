import { describe, it, expect } from "vitest";
import { ApiRequest, RunDeps, runTypedWrite } from "./typedWriteRunner.js";

/**
 * Fake account for set_device_bid: one campaign with three device criterions.
 * Records every call and applies PUTs, so the post-write re-read sees them.
 */
function fakeAccount(opts: { failOn?: string; partialError?: boolean } = {}) {
  const multipliers: Record<string, number> = { Computers: 0, Smartphones: -33, Tablets: 0 };
  const ids: Record<string, string> = { Computers: "1", Smartphones: "2", Tablets: "3" };
  const log: string[] = [];
  const files = new Map<string, string>();
  const call = async (req: ApiRequest) => {
    log.push(`${req.method} ${req.path}`);
    if (req.path === "/CampaignCriterions/QueryByIds") {
      return {
        CampaignCriterions: Object.keys(multipliers).map(name => ({
          Id: ids[name], Type: "BiddableCampaignCriterion",
          Criterion: { Type: "DeviceCriterion", DeviceName: name },
          CriterionBid: { Multiplier: multipliers[name] },
        })),
      };
    }
    if (opts.failOn === req.method) throw new Error("boom");
    if (opts.partialError) return { PartialErrors: [{ Code: 1, Message: "nope" }] };
    for (const c of (req.body as any).CampaignCriterions) multipliers[c.Criterion.DeviceName] = c.CriterionBid.Multiplier;
    return { PartialErrors: [] };
  };
  const deps = (over: Partial<RunDeps> = {}): RunDeps => ({
    call,
    accountId: "111111111",
    writeEnabled: true,
    fileExists: p => files.has(p),
    writeFile: (p, c) => { log.push(`WRITE ${p}`); files.set(p, c); },
    now: () => new Date("2026-10-17T10:00:00Z"),
    ...over,
  });
  return { log, files, deps, multipliers };
}

const SNAP = "C:/clients/exemple/etats/2026-10-17-device.json";
const base = { campaign_id: "222222222", smartphones: -20 };

describe("runTypedWrite", () => {
  it("dry run only reads and returns the plan", async () => {
    const a = fakeAccount();
    const out = await runTypedWrite("bing_ads_set_device_bid", base, a.deps({ writeEnabled: false }));
    expect(out.mode).toBe("dry_run");
    expect(out.diff).toEqual({ smartphones: { from: -33, to: -20 } });
    expect(out.restore_args).toEqual([{ campaign_id: "222222222", smartphones: -33 }]);
    expect((out.planned_requests as unknown[]).length).toBe(1);
    expect(a.log).toEqual(["POST /CampaignCriterions/QueryByIds"]);
  });

  it.each([
    [{ writeEnabled: false }, { account_id: "111111111", snapshot_path: SNAP }, /BING_ADS_MCP_WRITE/],
    [{}, { snapshot_path: SNAP }, /account_id is required/],
    [{}, { account_id: "111111111" }, /snapshot_path is required/],
    [{}, { account_id: "111111111", snapshot_path: "etats/x.json" }, /absolute path/],
    [{}, { account_id: "111111111", snapshot_path: "C:/x.txt" }, /\.json/],
  ])("refuses confirm without its prerequisites (%o %o) before any call", async (depOver, argOver, msg) => {
    const a = fakeAccount();
    await expect(runTypedWrite("bing_ads_set_device_bid", { ...base, confirm: true, ...argOver }, a.deps(depOver))).rejects.toThrow(msg);
    expect(a.log).toEqual([]);
  });

  it("refuses to overwrite an existing snapshot", async () => {
    const a = fakeAccount();
    a.files.set(SNAP, "{}");
    await expect(runTypedWrite("bing_ads_set_device_bid", { ...base, confirm: true, account_id: "111111111", snapshot_path: SNAP }, a.deps()))
      .rejects.toThrow(/already exists/);
    expect(a.log).toEqual([]);
  });

  it("writes the snapshot before the first mutation, then verifies by re-reading", async () => {
    const a = fakeAccount();
    const out = await runTypedWrite("bing_ads_set_device_bid", { ...base, confirm: true, account_id: "111111111", snapshot_path: SNAP }, a.deps());
    expect(a.log).toEqual([
      "POST /CampaignCriterions/QueryByIds",
      `WRITE ${SNAP}`,
      "PUT /CampaignCriterions",
      "POST /CampaignCriterions/QueryByIds",
    ]);
    expect(out).toMatchObject({ mode: "confirmed", requests_sent: 1, verification: { ok: true } });
    const snap = JSON.parse(a.files.get(SNAP)!);
    expect(snap).toMatchObject({
      tool: "bing_ads_set_device_bid",
      account_id: "111111111",
      taken_at: "2026-10-17T10:00:00.000Z",
      before: { smartphones: -33 },
      restore_args: [{ campaign_id: "222222222", smartphones: -33 }],
    });
    expect(a.multipliers.Smartphones).toBe(-20);
  });

  it("reports a thrown API error as a failure that points at the snapshot", async () => {
    const a = fakeAccount({ failOn: "PUT" });
    const out = await runTypedWrite("bing_ads_set_device_bid", { ...base, confirm: true, account_id: "111111111", snapshot_path: SNAP }, a.deps());
    expect(out).toMatchObject({ mode: "failed", error: true, requests_sent: 0, errors: ["boom"], snapshot_path: SNAP });
  });

  it("treats per-item errors returned with HTTP 200 as a failure", async () => {
    const a = fakeAccount({ partialError: true });
    const out = await runTypedWrite("bing_ads_set_device_bid", { ...base, confirm: true, account_id: "111111111", snapshot_path: SNAP }, a.deps());
    expect(out.mode).toBe("failed");
    expect(out.errors).toEqual([{ Code: 1, Message: "nope" }]);
  });

  it("confirming a no-op still snapshots but sends nothing", async () => {
    const a = fakeAccount();
    const out = await runTypedWrite("bing_ads_set_device_bid", { campaign_id: "222222222", smartphones: -33, confirm: true, account_id: "111111111", snapshot_path: SNAP }, a.deps());
    expect(out).toMatchObject({ mode: "confirmed", requests_sent: 0, verification: { ok: true } });
    expect(a.log.filter(l => !l.includes("QueryByIds"))).toEqual([`WRITE ${SNAP}`]);
  });

  it("rejects an unknown tool", async () => {
    await expect(runTypedWrite("bing_ads_drop_everything", {}, fakeAccount().deps())).rejects.toThrow(/Unknown typed write/);
  });
});
