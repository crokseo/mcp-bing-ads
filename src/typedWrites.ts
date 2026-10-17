/**
 * Typed write operations: pure planners.
 *
 * Each planner takes the current state (already read from the API) and the
 * tool arguments, applies the guards, and returns everything the runner needs:
 * the before/after views shown to the user, the diff, warnings, the arguments
 * that would put things back (`restore_args`), and the exact requests to send.
 *
 * Planners never call the API. Keeping them pure is what makes every guard
 * unit-testable, and it lets the runner replay a planner after the writes to
 * check that nothing is left to do.
 *
 * Replacement planners (schedule, locations, device bids) compute a minimal
 * diff: criterions that already match the target are left untouched, so
 * replaying the current state sends no request at all.
 */

import type { MutationRequest } from "./mutationRequests.js";

export interface Plan {
  before: unknown;
  after: unknown;
  diff: unknown;
  warnings: string[];
  /** Argument sets that restore the previous state; null for creations. */
  restore_args: Record<string, unknown>[] | null;
  requests: MutationRequest[];
}

/** Microsoft accepts at most 100 campaign criterions per add/update/delete. */
export const MAX_CRITERIONS_PER_CALL = 100;
/** Bid multiplier range for most criterions (DayTime, Location). */
export const MULTIPLIER_MIN = -90;
export const MULTIPLIER_MAX = 900;
/** Device criterions also accept -100, which excludes the device. */
export const DEVICE_MULTIPLIER_MIN = -100;

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

function checkMultiplier(value: number, label: string, min = MULTIPLIER_MIN): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > MULTIPLIER_MAX) {
    throw new Error(`${label} must be a number between ${min} and ${MULTIPLIER_MAX}, got ${value}`);
  }
  return value;
}

function deleteCriterionsRequests(campaignId: number, ids: string[]): MutationRequest[] {
  return chunk(ids, MAX_CRITERIONS_PER_CALL).map(part => ({
    path: "/CampaignCriterions",
    method: "DELETE" as const,
    body: { CampaignCriterionIds: part.map(Number), CampaignId: campaignId, CriterionType: "Targets" },
  }));
}

function criterionsRequests(method: "POST" | "PUT", criterions: Record<string, unknown>[]): MutationRequest[] {
  return chunk(criterions, MAX_CRITERIONS_PER_CALL).map(part => ({
    path: "/CampaignCriterions",
    method,
    body: { CampaignCriterions: part, CriterionType: "Targets" },
  }));
}

/** Raw campaign criterion as returned by /CampaignCriterions/QueryByIds. */
export interface RawCampaignCriterion {
  Id: string;
  Type: string;
  CampaignId?: string;
  Criterion: Record<string, any>;
  CriterionBid?: { Multiplier?: number | null } | null;
}

// ============================================
// 1. AD SCHEDULE (DayTime criterions)
// ============================================

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const FRENCH_DAYS: Record<string, string> = {
  lundi: "Monday", mardi: "Tuesday", mercredi: "Wednesday", jeudi: "Thursday",
  vendredi: "Friday", samedi: "Saturday", dimanche: "Sunday",
};
const MINUTE_ENUM: Record<number, string> = { 0: "Zero", 15: "Fifteen", 30: "Thirty", 45: "FortyFive" };
const MINUTE_VALUE: Record<string, number> = { Zero: 0, Fifteen: 15, Thirty: 30, FortyFive: 45 };

export interface SchedulePlage {
  jour: string;
  debut: string;
  fin: string;
  bid_multiplier?: number;
}

export interface ScheduleSlot {
  day: string;
  from: number; // minutes since midnight
  to: number;
  multiplier: number;
}

function normalizeDay(jour: string): string {
  const key = String(jour).trim();
  const fr = FRENCH_DAYS[key.toLowerCase()];
  if (fr) return fr;
  const en = DAYS.find(d => d.toLowerCase() === key.toLowerCase());
  if (en) return en;
  throw new Error(`jour must be a weekday (lundi..dimanche or Monday..Sunday), got "${jour}"`);
}

function parseTime(value: string, label: string, allowMidnightEnd: boolean): number {
  const m = String(value).trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) throw new Error(`${label} must be "HH:MM", got "${value}"`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!(min in MINUTE_ENUM)) throw new Error(`${label} minutes must be 00, 15, 30 or 45, got "${value}"`);
  if (h > 24 || (h === 24 && (min !== 0 || !allowMidnightEnd)) || (!allowMidnightEnd && h > 23)) {
    throw new Error(`${label} is out of range: "${value}"`);
  }
  return h * 60 + min;
}

function formatTime(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function slotKey(s: { day: string; from: number; to: number }): string {
  return `${s.day} ${s.from}-${s.to}`;
}

/** Validate and normalize the requested plages, refusing overlaps. */
export function parseSchedule(plages: SchedulePlage[]): ScheduleSlot[] {
  if (!Array.isArray(plages)) throw new Error("plages must be an array");
  const slots = plages.map((p, i) => {
    const from = parseTime(p.debut, `plages[${i}].debut`, false);
    const to = parseTime(p.fin, `plages[${i}].fin`, true);
    if (to <= from) throw new Error(`plages[${i}]: fin (${p.fin}) must be after debut (${p.debut})`);
    return {
      day: normalizeDay(p.jour),
      from,
      to,
      multiplier: checkMultiplier(p.bid_multiplier ?? 0, `plages[${i}].bid_multiplier`),
    };
  });
  for (const day of DAYS) {
    const sorted = slots.filter(s => s.day === day).sort((a, b) => a.from - b.from);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].from < sorted[i - 1].to) {
        throw new Error(
          `Overlapping plages on ${day}: ${formatTime(sorted[i - 1].from)}-${formatTime(sorted[i - 1].to)} and ` +
          `${formatTime(sorted[i].from)}-${formatTime(sorted[i].to)}`,
        );
      }
    }
  }
  return slots;
}

function slotFromCriterion(c: RawCampaignCriterion): ScheduleSlot & { id: string } {
  const k = c.Criterion;
  return {
    id: c.Id,
    day: k.Day,
    from: Number(k.FromHour) * 60 + (MINUTE_VALUE[k.FromMinute] ?? 0),
    to: Number(k.ToHour) * 60 + (MINUTE_VALUE[k.ToMinute] ?? 0),
    multiplier: c.CriterionBid?.Multiplier ?? 0,
  };
}

function slotToPlage(s: ScheduleSlot): SchedulePlage {
  return { jour: s.day, debut: formatTime(s.from), fin: formatTime(s.to), bid_multiplier: s.multiplier };
}

function dayTimeCriterion(campaignId: number, s: ScheduleSlot, id?: string): Record<string, unknown> {
  return {
    ...(id ? { Id: Number(id) } : {}),
    Type: "BiddableCampaignCriterion",
    CampaignId: campaignId,
    Criterion: {
      Type: "DayTimeCriterion",
      Day: s.day,
      FromHour: Math.floor(s.from / 60),
      FromMinute: MINUTE_ENUM[s.from % 60],
      ToHour: Math.floor(s.to / 60),
      ToMinute: MINUTE_ENUM[s.to % 60],
    },
    CriterionBid: { Type: "BidMultiplier", Multiplier: s.multiplier },
  };
}

export function planAdSchedule(
  current: Record<string, RawCampaignCriterion[]>,
  args: { campaign_ids: string[]; plages: SchedulePlage[]; diffusion_24_7?: boolean },
): Plan {
  if (!Array.isArray(args.campaign_ids) || args.campaign_ids.length === 0) {
    throw new Error("campaign_ids must contain at least one campaign id");
  }
  const target = parseSchedule(args.plages);
  if (target.length === 0 && args.diffusion_24_7 !== true) {
    throw new Error(
      "plages is empty: that removes the whole schedule and serves 24/7. Pass diffusion_24_7: true if that is the intent.",
    );
  }
  const warnings: string[] = [];
  if (target.length > 0) {
    const closed = DAYS.filter(d => !target.some(s => s.day === d));
    if (closed.length) warnings.push(`No delivery on: ${closed.join(", ")}`);
  }

  const before: Record<string, SchedulePlage[]> = {};
  const diff: Record<string, unknown> = {};
  const requests: MutationRequest[] = [];
  const restoreGroups = new Map<string, { campaign_ids: string[]; plages: SchedulePlage[]; diffusion_24_7?: boolean }>();

  for (const rawId of args.campaign_ids) {
    const campaignId = toNumericId(rawId, "campaign_ids");
    const existing = (current[String(campaignId)] || []).map(slotFromCriterion);
    before[campaignId] = existing.map(slotToPlage);

    const targetKeys = new Map(target.map(s => [slotKey(s), s]));
    const toDelete = existing.filter(s => !targetKeys.has(slotKey(s)));
    const toUpdate = existing.filter(s => {
      const t = targetKeys.get(slotKey(s));
      return t !== undefined && t.multiplier !== s.multiplier;
    });
    const existingKeys = new Set(existing.map(slotKey));
    const toAdd = target.filter(s => !existingKeys.has(slotKey(s)));

    diff[campaignId] = {
      removed: toDelete.map(slotToPlage),
      added: toAdd.map(slotToPlage),
      multiplier_changed: toUpdate.map(s => ({
        ...slotToPlage(s),
        bid_multiplier: { from: s.multiplier, to: targetKeys.get(slotKey(s))!.multiplier },
      })),
    };
    // Delete first: a new slot overlapping an old one would be refused.
    requests.push(...deleteCriterionsRequests(campaignId, toDelete.map(s => s.id)));
    requests.push(...criterionsRequests("PUT", toUpdate.map(s => dayTimeCriterion(campaignId, targetKeys.get(slotKey(s))!, s.id))));
    requests.push(...criterionsRequests("POST", toAdd.map(s => dayTimeCriterion(campaignId, s))));

    // Campaigns sharing the same schedule restore in one call.
    const key = JSON.stringify(before[campaignId]);
    const group = restoreGroups.get(key);
    if (group) group.campaign_ids.push(String(campaignId));
    else restoreGroups.set(key, {
      campaign_ids: [String(campaignId)],
      plages: before[campaignId],
      ...(before[campaignId].length === 0 ? { diffusion_24_7: true } : {}),
    });
  }

  return {
    before,
    after: Object.fromEntries(args.campaign_ids.map(id => [String(toNumericId(id, "campaign_ids")), target.map(slotToPlage)])),
    diff,
    warnings,
    restore_args: [...restoreGroups.values()],
    requests,
  };
}

// ============================================
// 2. LOCATIONS
// ============================================

export interface LocationInclusion {
  location_id: string;
  bid_multiplier?: number;
}

interface LocationView {
  id: string;
  location_id: string;
  type?: string;
  name?: string;
  multiplier?: number;
}

function locationCriterion(campaignId: number, locationId: string, negative: boolean, multiplier?: number, id?: string): Record<string, unknown> {
  const base: Record<string, unknown> = {
    ...(id ? { Id: Number(id) } : {}),
    Type: negative ? "NegativeCampaignCriterion" : "BiddableCampaignCriterion",
    CampaignId: campaignId,
    Criterion: { Type: "LocationCriterion", LocationId: Number(locationId) },
  };
  if (!negative) base.CriterionBid = { Type: "BidMultiplier", Multiplier: multiplier ?? 0 };
  return base;
}

export function planLocations(
  current: RawCampaignCriterion[],
  args: {
    campaign_id: string;
    inclusions: Array<LocationInclusion | string>;
    exclusions?: string[];
    autoriser_cible_vide?: boolean;
  },
): Plan {
  const campaignId = toNumericId(args.campaign_id, "campaign_id");
  const inclusions = (args.inclusions || []).map((inc, i) => {
    const o = typeof inc === "object" ? inc : { location_id: String(inc) };
    toNumericId(o.location_id, `inclusions[${i}].location_id`);
    if (o.bid_multiplier !== undefined) checkMultiplier(o.bid_multiplier, `inclusions[${i}].bid_multiplier`);
    return { location_id: String(Number(o.location_id)), bid_multiplier: o.bid_multiplier };
  });
  // Omitted exclusions keep the current ones: forgetting the argument must not
  // silently lift every exclusion (a real account carried 200+ of them).
  const requestedExclusions = args.exclusions?.map((id, i) => String(toNumericId(id, `exclusions[${i}]`)));

  if (inclusions.length === 0 && args.autoriser_cible_vide !== true) {
    throw new Error(
      "inclusions is empty: the campaign would target every location. Pass autoriser_cible_vide: true if that is the intent.",
    );
  }
  const incIds = new Set(inclusions.map(i => i.location_id));
  if (incIds.size !== inclusions.length) throw new Error("inclusions contains the same location twice");
  const view = (c: RawCampaignCriterion): LocationView => ({
    id: c.Id,
    location_id: String(c.Criterion.LocationId),
    type: c.Criterion.LocationType,
    name: c.Criterion.DisplayName,
    ...(c.Type === "NegativeCampaignCriterion" ? {} : { multiplier: c.CriterionBid?.Multiplier ?? 0 }),
  });
  const locs = current.filter(c => c.Criterion?.Type === "LocationCriterion");
  const curInc = locs.filter(c => c.Type !== "NegativeCampaignCriterion").map(view);
  const curExc = locs.filter(c => c.Type === "NegativeCampaignCriterion").map(view);
  const known = new Map([...curInc, ...curExc].map(l => [l.location_id, l]));
  const exclusions = requestedExclusions ?? curExc.map(c => c.location_id);
  const both = exclusions.filter(id => incIds.has(id));
  if (both.length) throw new Error(`Locations both included and excluded: ${both.join(", ")}`);

  // Omitted bid_multiplier keeps the current one, so a list of ids does not
  // silently reset adjustments.
  const target = inclusions.map(i => ({
    location_id: i.location_id,
    multiplier: i.bid_multiplier ?? curInc.find(c => c.location_id === i.location_id)?.multiplier ?? 0,
  }));

  const warnings: string[] = [];
  const countries = target.map(t => known.get(t.location_id)).filter(l => l?.type === "Country");
  for (const country of countries) {
    const subs = target
      .map(t => known.get(t.location_id))
      .filter(l => l && l.type !== "Country" && l.name?.endsWith(`, ${country!.name}`));
    if (subs.length) {
      warnings.push(
        `${country!.name} is targeted as a country together with ${subs.length} of its subdivisions ` +
        `(${subs.slice(0, 5).map(s => s!.name).join("; ")}${subs.length > 5 ? "…" : ""}): the country already covers them.`,
      );
    }
  }
  const unknown = [...target.map(t => t.location_id), ...exclusions].filter(id => !known.has(id));
  if (unknown.length) {
    warnings.push(`Location ids not currently on the campaign, type and name unchecked: ${unknown.join(", ")}`);
  }

  const targetInc = new Map(target.map(t => [t.location_id, t]));
  const incDelete = curInc.filter(c => !targetInc.has(c.location_id));
  const incUpdate = curInc.filter(c => targetInc.has(c.location_id) && targetInc.get(c.location_id)!.multiplier !== c.multiplier);
  const incAdd = target.filter(t => !curInc.some(c => c.location_id === t.location_id));
  const excSet = new Set(exclusions);
  const excDelete = curExc.filter(c => !excSet.has(c.location_id));
  const excAdd = exclusions.filter(id => !curExc.some(c => c.location_id === id));

  if (incDelete.length + excDelete.length > 20) {
    warnings.push(`${incDelete.length} inclusions and ${excDelete.length} exclusions would be removed: check that this is the intent.`);
  }

  const label = (id: string) => known.get(id)?.name ?? id;
  return {
    before: { inclusions: curInc, exclusions: curExc },
    after: { inclusions: target, exclusions },
    diff: {
      inclusions_removed: incDelete.map(c => label(c.location_id)),
      inclusions_added: incAdd.map(t => label(t.location_id)),
      multiplier_changed: incUpdate.map(c => ({
        location: label(c.location_id),
        from: c.multiplier,
        to: targetInc.get(c.location_id)!.multiplier,
      })),
      exclusions_removed: excDelete.map(c => label(c.location_id)),
      exclusions_added: excAdd.map(label),
    },
    warnings,
    restore_args: [{
      campaign_id: String(campaignId),
      inclusions: curInc.map(c => ({ location_id: c.location_id, bid_multiplier: c.multiplier })),
      exclusions: curExc.map(c => c.location_id),
      ...(curInc.length === 0 ? { autoriser_cible_vide: true } : {}),
    }],
    requests: [
      ...deleteCriterionsRequests(campaignId, [...incDelete, ...excDelete].map(c => c.id)),
      ...criterionsRequests("PUT", incUpdate.map(c =>
        locationCriterion(campaignId, c.location_id, false, targetInc.get(c.location_id)!.multiplier, c.id))),
      ...criterionsRequests("POST", [
        ...incAdd.map(t => locationCriterion(campaignId, t.location_id, false, t.multiplier)),
        ...excAdd.map(id => locationCriterion(campaignId, id, true)),
      ]),
    ],
  };
}

// ============================================
// 3. DEVICE BID ADJUSTMENTS
// ============================================

const DEVICE_ARGS: Record<string, string> = { computers: "Computers", smartphones: "Smartphones", tablets: "Tablets" };

export function planDeviceBid(
  current: RawCampaignCriterion[],
  args: { campaign_id: string; computers?: number; smartphones?: number; tablets?: number },
): Plan {
  const campaignId = toNumericId(args.campaign_id, "campaign_id");
  const devices = current.filter(c => c.Criterion?.Type === "DeviceCriterion");
  const byName = new Map(devices.map(c => [c.Criterion.DeviceName as string, c]));

  const before: Record<string, number> = {};
  const after: Record<string, number> = {};
  const requested = Object.keys(DEVICE_ARGS).filter(k => (args as any)[k] !== undefined);
  if (requested.length === 0) throw new Error("Pass at least one of computers, smartphones, tablets");

  for (const [arg, name] of Object.entries(DEVICE_ARGS)) {
    const cur = byName.get(name)?.CriterionBid?.Multiplier ?? 0;
    before[arg] = cur;
    const value = (args as any)[arg];
    after[arg] = value === undefined ? cur : checkMultiplier(value, arg, DEVICE_MULTIPLIER_MIN);
  }
  if (Object.values(after).every(v => v === DEVICE_MULTIPLIER_MIN)) {
    throw new Error("Every device would be excluded (-100): the campaign would stop serving.");
  }
  const warnings = Object.entries(after)
    .filter(([arg, v]) => v === DEVICE_MULTIPLIER_MIN && before[arg] !== DEVICE_MULTIPLIER_MIN)
    .map(([arg]) => `${DEVICE_ARGS[arg]} set to -100: that device is excluded.`);

  const changed = Object.keys(DEVICE_ARGS).filter(arg => after[arg] !== before[arg]);
  const toUpdate: Record<string, unknown>[] = [];
  const toAdd: Record<string, unknown>[] = [];
  for (const arg of changed) {
    const name = DEVICE_ARGS[arg];
    const existing = byName.get(name);
    const crit = {
      ...(existing ? { Id: Number(existing.Id) } : {}),
      Type: "BiddableCampaignCriterion",
      CampaignId: campaignId,
      Criterion: { Type: "DeviceCriterion", DeviceName: name },
      CriterionBid: { Type: "BidMultiplier", Multiplier: after[arg] },
    };
    (existing ? toUpdate : toAdd).push(crit);
  }

  return {
    before,
    after,
    diff: Object.fromEntries(changed.map(arg => [arg, { from: before[arg], to: after[arg] }])),
    warnings,
    restore_args: [{ campaign_id: String(campaignId), ...Object.fromEntries(changed.map(arg => [arg, before[arg]])) }],
    requests: [...criterionsRequests("PUT", toUpdate), ...criterionsRequests("POST", toAdd)],
  };
}

// ============================================
// 4. AD GROUP STATUS
// ============================================

export interface RawAdGroup {
  Id: string;
  Name: string;
  Status: string;
}

export function planAdGroupStatus(
  adGroups: RawAdGroup[],
  args: { campaign_id: string; ad_group_ids: string[]; statut: string },
): Plan {
  const campaignId = toNumericId(args.campaign_id, "campaign_id");
  if (args.statut !== "Active" && args.statut !== "Paused") {
    throw new Error(`statut must be Active or Paused (deletion is not supported), got "${args.statut}"`);
  }
  if (!Array.isArray(args.ad_group_ids) || args.ad_group_ids.length === 0) {
    throw new Error("ad_group_ids must contain at least one ad group id");
  }
  const byId = new Map(adGroups.map(a => [String(a.Id), a]));
  const ids = args.ad_group_ids.map(id => String(toNumericId(id, "ad_group_ids")));
  const missing = ids.filter(id => !byId.has(id));
  if (missing.length) throw new Error(`Ad groups not found in campaign ${campaignId}: ${missing.join(", ")}`);
  const odd = ids.filter(id => !["Active", "Paused"].includes(byId.get(id)!.Status));
  if (odd.length) {
    throw new Error(`Ad groups with status other than Active/Paused cannot be changed here: ${odd.map(id => `${id} (${byId.get(id)!.Status})`).join(", ")}`);
  }

  const changed = ids.filter(id => byId.get(id)!.Status !== args.statut);
  const finalActive = adGroups.filter(a => (ids.includes(String(a.Id)) ? args.statut : a.Status) === "Active");
  if (args.statut === "Paused" && finalActive.length === 0) {
    throw new Error(`Campaign ${campaignId} would be left without any active ad group: it would stop serving.`);
  }
  const warnings: string[] = [];
  if (args.statut === "Paused" && finalActive.length === 1) {
    warnings.push(`Only one active ad group left in campaign ${campaignId}: ${finalActive[0].Name}`);
  }

  const restore = new Map<string, string[]>();
  for (const id of changed) {
    const st = byId.get(id)!.Status;
    restore.set(st, [...(restore.get(st) || []), id]);
  }
  return {
    before: ids.map(id => ({ id, name: byId.get(id)!.Name, status: byId.get(id)!.Status })),
    after: ids.map(id => ({ id, name: byId.get(id)!.Name, status: args.statut })),
    diff: changed.map(id => ({ id, name: byId.get(id)!.Name, from: byId.get(id)!.Status, to: args.statut })),
    warnings,
    restore_args: [...restore.entries()].map(([statut, groupIds]) => ({
      campaign_id: String(campaignId), ad_group_ids: groupIds, statut,
    })),
    requests: changed.length === 0 ? [] : [{
      path: "/AdGroups",
      method: "PUT",
      body: { CampaignId: campaignId, AdGroups: changed.map(id => ({ Id: Number(id), Status: args.statut })) },
    }],
  };
}

// ============================================
// 5. ACCOUNT FINAL URL SUFFIX
// ============================================

export function planFinalUrlSuffix(
  current: { suffix: string; trackingTemplate: string; campaignSuffixes: Array<{ id: string; name: string; suffix: string }> },
  args: { valeur: string },
): Plan {
  if (typeof args.valeur !== "string") throw new Error("valeur must be a string (empty string clears the suffix)");
  const valeur = args.valeur.trim();
  if (valeur.startsWith("?") || valeur.startsWith("&")) {
    throw new Error('valeur must not start with "?" or "&": Microsoft adds the separator itself.');
  }
  if (/\s/.test(valeur)) throw new Error("valeur must not contain spaces");
  const warnings = current.campaignSuffixes
    .filter(c => c.suffix)
    .map(c => `Campaign "${c.name}" has its own suffix ("${c.suffix}"), which overrides the account suffix.`);
  const changed = valeur !== current.suffix;
  return {
    before: { final_url_suffix: current.suffix, tracking_url_template: current.trackingTemplate },
    after: { final_url_suffix: valeur, tracking_url_template: current.trackingTemplate },
    diff: changed ? { final_url_suffix: { from: current.suffix, to: valeur } } : {},
    warnings,
    restore_args: [{ valeur: current.suffix }],
    // Only FinalUrlSuffix is ever sent: the tracking template is used by
    // click-fraud tools (ClickCease) and must stay as it is.
    requests: changed ? [{
      path: "/AccountProperties/Set",
      method: "POST",
      body: { AccountProperties: [{ Name: "FinalUrlSuffix", Value: valeur }] },
    }] : [],
  };
}

// ============================================
// 6. BIDDING STRATEGY
// ============================================

export const TARGET_STRATEGIES = ["MaxConversions", "MaxConversionValue"];
/** Schemes accepted through `bidding_scheme`, i.e. when restoring a snapshot. */
export const RESTORABLE_SCHEMES = ["MaxConversions", "MaxConversionValue", "TargetCpa", "TargetRoas", "MaxClicks", "EnhancedCpc", "ManualCpc"];

export interface RawCampaign {
  Id: string;
  Name: string;
  BiddingScheme: Record<string, any> | null;
  FinalUrlSuffix?: string | null;
}

function cleanScheme(scheme: Record<string, any>): Record<string, any> {
  // Drop null amounts the API returns on reads (MaxCpc: {Amount: null}).
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(scheme)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "object" && !Array.isArray(v) && "Amount" in v && v.Amount === null) continue;
    out[k] = v;
  }
  return out;
}

export function planBiddingStrategy(
  state: { accountId: string; campaigns: RawCampaign[]; portfolioCampaignIds: Set<string> },
  args: {
    campaign_ids: string[];
    strategie?: string;
    target_cpa?: number;
    target_roas?: number;
    detacher_portefeuille?: boolean;
    bidding_scheme?: Record<string, any>;
  },
): Plan {
  if (!Array.isArray(args.campaign_ids) || args.campaign_ids.length === 0) {
    throw new Error("campaign_ids must contain at least one campaign id");
  }
  let target: Record<string, any>;
  if (args.bidding_scheme) {
    if (args.strategie) throw new Error("Pass either strategie or bidding_scheme (restore), not both");
    if (!RESTORABLE_SCHEMES.includes(args.bidding_scheme.Type)) {
      throw new Error(`bidding_scheme.Type must be one of ${RESTORABLE_SCHEMES.join(", ")}`);
    }
    target = cleanScheme(args.bidding_scheme);
  } else {
    if (!TARGET_STRATEGIES.includes(args.strategie as string)) {
      throw new Error(`strategie must be one of ${TARGET_STRATEGIES.join(", ")}, got "${args.strategie}"`);
    }
    if (args.target_cpa !== undefined && args.strategie !== "MaxConversions") {
      throw new Error("target_cpa only applies to MaxConversions");
    }
    if (args.target_roas !== undefined && args.strategie !== "MaxConversionValue") {
      throw new Error("target_roas only applies to MaxConversionValue");
    }
    for (const [k, v] of [["target_cpa", args.target_cpa], ["target_roas", args.target_roas]] as const) {
      if (v !== undefined && (typeof v !== "number" || !(v > 0))) throw new Error(`${k} must be a positive number`);
    }
    target = { Type: args.strategie };
    if (args.target_cpa !== undefined) target.TargetCpa = args.target_cpa;
    if (args.target_roas !== undefined) target.TargetRoas = args.target_roas;
  }

  const byId = new Map(state.campaigns.map(c => [String(c.Id), c]));
  const ids = args.campaign_ids.map(id => String(toNumericId(id, "campaign_ids")));
  const missing = ids.filter(id => !byId.has(id));
  if (missing.length) throw new Error(`Campaigns not found: ${missing.join(", ")}`);

  const inPortfolio = ids.filter(id => state.portfolioCampaignIds.has(id));
  if (inPortfolio.length) {
    throw new Error(
      `Campaigns using a portfolio bid strategy: ${inPortfolio.join(", ")}. Detaching them through the API is not ` +
      `supported by this tool (detacher_portefeuille is not implemented): detach in the Microsoft Ads interface first.`,
    );
  }
  const unknownScheme = ids.filter(id => !byId.get(id)!.BiddingScheme);
  if (unknownScheme.length) {
    throw new Error(
      `The API returns no bidding scheme for campaigns ${unknownScheme.map(id => `${id} (${byId.get(id)!.Name})`).join(", ")} ` +
      `(strategy not exposed in v13, e.g. target impression share): it could not be restored, so it is not changed here.`,
    );
  }

  const changed = ids.filter(id => JSON.stringify(cleanScheme(byId.get(id)!.BiddingScheme!)) !== JSON.stringify(target));
  const warnings: string[] = [];
  if (!args.bidding_scheme && changed.some(id => byId.get(id)!.BiddingScheme!.Type !== target.Type)) {
    warnings.push("Switching strategy restarts the learning period: expect a few days of unstable performance.");
  }
  return {
    before: ids.map(id => ({ id, name: byId.get(id)!.Name, bidding_scheme: cleanScheme(byId.get(id)!.BiddingScheme!) })),
    after: ids.map(id => ({ id, name: byId.get(id)!.Name, bidding_scheme: target })),
    diff: changed.map(id => ({ id, name: byId.get(id)!.Name, from: cleanScheme(byId.get(id)!.BiddingScheme!), to: target })),
    warnings,
    restore_args: changed.map(id => ({ campaign_ids: [id], bidding_scheme: cleanScheme(byId.get(id)!.BiddingScheme!) })),
    requests: changed.length === 0 ? [] : [{
      path: "/Campaigns",
      method: "PUT",
      body: { AccountId: toNumericId(state.accountId, "account_id"), Campaigns: changed.map(id => ({ Id: Number(id), BiddingScheme: target })) },
    }],
  };
}

// ============================================
// 7. ADD KEYWORDS
// ============================================

export const MATCH_TYPES = ["Exact", "Phrase", "Broad"];
export const MAX_KEYWORD_LENGTH = 100;
export const MAX_KEYWORD_WORDS = 10;

export interface RawKeyword {
  Id: string;
  Text: string;
  MatchType: string;
  Status: string;
}

function kwKey(text: string, match: string): string {
  return `${text.trim().toLowerCase().replace(/\s+/g, " ")}|${match}`;
}

export function planAddKeywords(
  existing: RawKeyword[],
  args: { ad_group_id: string; keywords: Array<{ text: string; match_type: string; bid?: number }> },
): Plan {
  const adGroupId = toNumericId(args.ad_group_id, "ad_group_id");
  if (!Array.isArray(args.keywords) || args.keywords.length === 0) throw new Error("keywords must not be empty");
  const existingKeys = new Map(existing.map(k => [kwKey(k.Text, k.MatchType), k]));
  const seen = new Set<string>();
  const toAdd: Array<{ text: string; match_type: string; bid?: number }> = [];
  const skipped: Array<{ text: string; match_type: string; reason: string }> = [];
  const warnings: string[] = [];

  args.keywords.forEach((k, i) => {
    const text = String(k.text ?? "").trim().replace(/\s+/g, " ");
    if (!text) throw new Error(`keywords[${i}].text is empty`);
    if (text.length > MAX_KEYWORD_LENGTH) throw new Error(`keywords[${i}] is longer than ${MAX_KEYWORD_LENGTH} characters: "${text}"`);
    if (text.split(" ").length > MAX_KEYWORD_WORDS) throw new Error(`keywords[${i}] has more than ${MAX_KEYWORD_WORDS} words: "${text}"`);
    if (!MATCH_TYPES.includes(k.match_type)) throw new Error(`keywords[${i}].match_type must be one of ${MATCH_TYPES.join(", ")}`);
    if (k.bid !== undefined && !(typeof k.bid === "number" && k.bid > 0)) throw new Error(`keywords[${i}].bid must be a positive number`);
    const key = kwKey(text, k.match_type);
    if (seen.has(key)) { skipped.push({ text, match_type: k.match_type, reason: "duplicate in request" }); return; }
    seen.add(key);
    const ex = existingKeys.get(key);
    if (ex) {
      skipped.push({ text, match_type: k.match_type, reason: `already exists (${ex.Status})` });
      if (ex.Status !== "Active") warnings.push(`"${text}" [${k.match_type}] already exists with status ${ex.Status}: reactivate it rather than add it.`);
      return;
    }
    toAdd.push({ text, match_type: k.match_type, ...(k.bid !== undefined ? { bid: k.bid } : {}) });
  });

  return {
    before: { ad_group_id: String(adGroupId), keyword_count: existing.length },
    after: { ad_group_id: String(adGroupId), keyword_count: existing.length + toAdd.length },
    diff: { added: toAdd, skipped },
    warnings,
    restore_args: null,
    requests: chunk(toAdd, 1000).map(part => ({
      path: "/Keywords",
      method: "POST" as const,
      body: {
        AdGroupId: adGroupId,
        Keywords: part.map(k => ({ Text: k.text, MatchType: k.match_type, ...(k.bid !== undefined ? { Bid: { Amount: k.bid } } : {}) })),
      },
    })),
  };
}

// ============================================
// 8. ADD NEGATIVE KEYWORDS
// ============================================

export const NEGATIVE_MATCH_TYPES = ["Exact", "Phrase"];

export function planAddNegativeKeywords(
  state: { existing: Array<{ Text: string; MatchType: string }>; positives?: RawKeyword[] },
  args: { niveau: string; entity_id: string; keywords: Array<{ text: string; match_type?: string }> },
): Plan {
  if (args.niveau !== "campaign" && args.niveau !== "ad_group") {
    throw new Error(`niveau must be "campaign" or "ad_group", got "${args.niveau}"`);
  }
  const entityId = toNumericId(args.entity_id, "entity_id");
  if (!Array.isArray(args.keywords) || args.keywords.length === 0) throw new Error("keywords must not be empty");
  const existingKeys = new Set(state.existing.map(k => kwKey(k.Text, k.MatchType)));
  const seen = new Set<string>();
  const toAdd: Array<{ text: string; match_type: string }> = [];
  const skipped: Array<{ text: string; match_type: string; reason: string }> = [];

  args.keywords.forEach((k, i) => {
    const text = String(k.text ?? "").trim().replace(/\s+/g, " ");
    const match = k.match_type || "Phrase";
    if (!text) throw new Error(`keywords[${i}].text is empty`);
    if (text.length > MAX_KEYWORD_LENGTH) throw new Error(`keywords[${i}] is longer than ${MAX_KEYWORD_LENGTH} characters`);
    if (!NEGATIVE_MATCH_TYPES.includes(match)) throw new Error(`keywords[${i}].match_type must be Exact or Phrase (no broad negatives)`);
    const key = kwKey(text, match);
    if (seen.has(key)) { skipped.push({ text, match_type: match, reason: "duplicate in request" }); return; }
    seen.add(key);
    if (existingKeys.has(key)) { skipped.push({ text, match_type: match, reason: "already a negative" }); return; }
    toAdd.push({ text, match_type: match });
  });

  const warnings: string[] = [];
  for (const neg of toAdd) {
    const negText = neg.text.toLowerCase();
    const blocked = (state.positives || []).filter(p => {
      if (p.Status !== "Active") return false;
      const pos = p.Text.trim().toLowerCase().replace(/\s+/g, " ");
      return neg.match_type === "Exact" ? pos === negText : ` ${pos} `.includes(` ${negText} `);
    });
    if (blocked.length) {
      warnings.push(`Negative "${neg.text}" [${neg.match_type}] blocks active keywords of this ad group: ${blocked.map(b => `"${b.Text}" [${b.MatchType}]`).join(", ")}`);
    }
  }

  return {
    before: { niveau: args.niveau, entity_id: String(entityId), negative_count: state.existing.length },
    after: { niveau: args.niveau, entity_id: String(entityId), negative_count: state.existing.length + toAdd.length },
    diff: { added: toAdd, skipped },
    warnings,
    restore_args: null,
    // The API takes a single EntityNegativeKeyword per request.
    requests: toAdd.length === 0 ? [] : [{
      path: "/EntityNegativeKeywords",
      method: "POST",
      body: {
        EntityNegativeKeywords: [{
          EntityId: entityId,
          EntityType: args.niveau === "campaign" ? "Campaign" : "AdGroup",
          NegativeKeywords: toAdd.map(k => ({ Text: k.text, MatchType: k.match_type })),
        }],
      },
    }],
  };
}

// ============================================
// 9. ADD RESPONSIVE SEARCH AD
// ============================================

export const RSA_LIMITS = {
  headlines: { min: 3, max: 15, length: 30 },
  descriptions: { min: 2, max: 4, length: 90 },
  path: 15,
};

type TextInput = string | { texte: string; epingle?: number };

function parseTexts(items: TextInput[], kind: "headlines" | "descriptions", label: string, maxPin: number) {
  const lim = RSA_LIMITS[kind];
  if (!Array.isArray(items) || items.length < lim.min || items.length > lim.max) {
    throw new Error(`${label} must contain between ${lim.min} and ${lim.max} items`);
  }
  const seen = new Set<string>();
  return items.map((it, i) => {
    const o = typeof it === "string" ? { texte: it } : it;
    const text = String(o.texte ?? "").trim();
    if (!text) throw new Error(`${label}[${i}] is empty`);
    if (text.length > lim.length) throw new Error(`${label}[${i}] is ${text.length} characters, max ${lim.length}: "${text}"`);
    const key = text.toLowerCase();
    if (seen.has(key)) throw new Error(`${label}[${i}] is a duplicate: "${text}"`);
    seen.add(key);
    if (o.epingle !== undefined && !(Number.isInteger(o.epingle) && o.epingle >= 1 && o.epingle <= maxPin)) {
      throw new Error(`${label}[${i}].epingle must be between 1 and ${maxPin}`);
    }
    return { text, pin: o.epingle };
  });
}

export function planAddResponsiveSearchAd(
  existingAds: Array<{ Id: string; Status: string; Headlines?: Array<{ Asset: { Text: string } }> }>,
  args: {
    ad_group_id: string;
    titres: TextInput[];
    descriptions: TextInput[];
    final_url: string;
    path1?: string;
    path2?: string;
  },
): Plan {
  const adGroupId = toNumericId(args.ad_group_id, "ad_group_id");
  const headlines = parseTexts(args.titres, "headlines", "titres", 3);
  const descriptions = parseTexts(args.descriptions, "descriptions", "descriptions", 2);
  if (!/^https:\/\/[^\s]+$/.test(String(args.final_url || ""))) throw new Error("final_url must be an https:// URL");
  for (const p of ["path1", "path2"] as const) {
    const v = args[p];
    if (v !== undefined && (v.length > RSA_LIMITS.path || /\s/.test(v))) {
      throw new Error(`${p} must be at most ${RSA_LIMITS.path} characters without spaces`);
    }
  }
  if (args.path2 && !args.path1) throw new Error("path2 requires path1");

  const warnings: string[] = [];
  for (const [kind, items, n] of [["headline", headlines, 3], ["description", descriptions, 2]] as const) {
    for (let pos = 1; pos <= n; pos++) {
      const pinned = items.filter(it => it.pin === pos);
      if (pinned.length === items.length) warnings.push(`All ${kind}s are pinned to position ${pos}: no rotation left.`);
    }
  }
  const active = existingAds.filter(a => a.Status === "Active");
  if (active.length >= 3) warnings.push(`The ad group already has ${active.length} active responsive search ads; Microsoft may refuse a new one.`);
  const newSet = headlines.map(h => h.text.toLowerCase()).sort().join("|");
  const twin = existingAds.find(a => (a.Headlines || []).map(h => h.Asset.Text.toLowerCase()).sort().join("|") === newSet);
  if (twin) warnings.push(`An existing ad (${twin.Id}) already has exactly these headlines.`);

  const asset = (it: { text: string; pin?: number }, prefix: string) => ({
    Asset: { Type: "TextAsset", Text: it.text },
    ...(it.pin ? { PinnedField: `${prefix}${it.pin}` } : {}),
  });
  const ad = {
    Type: "ResponsiveSearch",
    Headlines: headlines.map(h => asset(h, "Headline")),
    Descriptions: descriptions.map(d => asset(d, "Description")),
    FinalUrls: [args.final_url],
    ...(args.path1 ? { Path1: args.path1 } : {}),
    ...(args.path2 ? { Path2: args.path2 } : {}),
  };
  return {
    before: { ad_group_id: String(adGroupId), responsive_search_ads: existingAds.length },
    after: { ad_group_id: String(adGroupId), responsive_search_ads: existingAds.length + 1 },
    diff: { added: { headlines: headlines.length, descriptions: descriptions.length, final_url: args.final_url, path1: args.path1, path2: args.path2 } },
    warnings,
    restore_args: null,
    requests: [{ path: "/Ads", method: "POST", body: { AdGroupId: adGroupId, Ads: [ad] } }],
  };
}

/**
 * Bing reports most per-item failures with HTTP 200 and the error inside the
 * body. Collect them so a partial failure is never mistaken for success.
 */
export function collectResponseErrors(response: any): unknown[] {
  const errors: unknown[] = [];
  const visit = (v: any) => {
    if (!v || typeof v !== "object") return;
    for (const key of ["PartialErrors", "NestedPartialErrors", "BatchErrors", "OperationErrors"]) {
      const list = v[key];
      if (Array.isArray(list)) for (const e of list) if (e) errors.push(e);
    }
  };
  visit(response);
  return errors;
}
