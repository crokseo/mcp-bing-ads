/**
 * Request builders for Campaign Management v13 REST reads that need a body.
 *
 * Same rationale as mutationRequests.ts: kept as pure functions so the
 * URL/method/body of each call is unit-testable without spawning the server or
 * mocking fetch. The REST API maps SOAP operations onto resource-style URLs —
 * `AddListItemsToSharedList` is `POST /ListItems`, so its read counterpart
 * `GetListItemsBySharedList` is `POST /ListItems/QueryBySharedList`.
 *
 * Ids are coerced to numbers and validated here rather than at the call site:
 * the API responds to a string or NaN id with a generic error that reads like
 * an auth or permissions failure, which is expensive to diagnose.
 */

export interface ReadRequest {
  /** Path relative to the CampaignManagement v13 base URL, e.g. "/ListItems". */
  path: string;
  method: "POST";
  body: Record<string, unknown>;
}

function toNumericId(id: string, label: string): number {
  const n = Number(id);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new Error(`${label} must be numeric, got "${id}"`);
  }
  return n;
}

/**
 * Negative keywords held in a shared list — the contents that determine what a
 * list actually blocks. Pairs with buildAddSharedNegativesRequest.
 */
export function buildGetListItemsRequest(
  sharedListId: string,
  sharedListType: string = "NegativeKeywordList",
): ReadRequest {
  return {
    path: "/ListItems/QueryBySharedList",
    method: "POST",
    body: {
      SharedList: {
        Id: toNumericId(sharedListId, "shared_list_id"),
        Type: sharedListType,
      },
    },
  };
}

/**
 * Which campaigns (or ad groups) a shared list is attached to.
 *
 * `bing_ads_list_shared_entities` returns only an AssociationCount, so without
 * this there is no way to tell whether a negative list is attached to the very
 * campaign built to target those terms — a failure mode that silently zeroed a
 * conquest campaign on the Google side.
 */
export function buildGetSharedEntityAssociationsRequest(
  sharedEntityId: string,
  entityType: string = "Campaign",
  sharedEntityType: string = "NegativeKeywordList",
): ReadRequest {
  return {
    path: "/SharedEntityAssociations/QueryBySharedEntityIds",
    method: "POST",
    body: {
      // Both type fields are required. EntityType is what the list is attached
      // TO (Campaign); SharedEntityType is what the list IS. Omitting the
      // latter returns CampaignServiceSharedEntityTypeNullOrEmpty, which reads
      // like a malformed request rather than a missing field.
      EntityType: entityType,
      SharedEntityType: sharedEntityType,
      SharedEntityIds: [toNumericId(sharedEntityId, "shared_entity_id")],
    },
  };
}

/**
 * The API accepts exactly one shared entity id per call, despite the plural
 * field name. Probed live 2026-07-22: n=1 returns 200, every n>=2 returns
 * CampaignServiceSharedEntityBatchLimitExceeded.
 */
export const MAX_SHARED_ENTITY_IDS_PER_CALL = 1;

/** Fan a list of ids out to one request each, respecting the batch limit. */
export function buildGetSharedEntityAssociationsRequests(
  sharedEntityIds: string[],
  entityType: string = "Campaign",
  sharedEntityType: string = "NegativeKeywordList",
): ReadRequest[] {
  if (sharedEntityIds.length === 0) {
    throw new Error("shared_entity_ids must contain at least one id");
  }
  return sharedEntityIds.map(id =>
    buildGetSharedEntityAssociationsRequest(id, entityType, sharedEntityType),
  );
}

export interface AssociationResponse {
  Associations?: unknown[];
  OperationErrors?: unknown[];
  BatchErrors?: unknown[];
  [key: string]: unknown;
}

/**
 * Merge the fanned-out responses back into one payload. Per-request failures
 * are surfaced under `Errors` rather than dropped — a partial result that looks
 * complete is the failure mode this whole tool exists to prevent.
 */
export function mergeAssociationResponses(
  responses: AssociationResponse[],
): { Associations: unknown[]; Errors?: unknown[] } {
  const associations: unknown[] = [];
  const errors: unknown[] = [];
  for (const r of responses) {
    if (Array.isArray(r?.Associations)) associations.push(...r.Associations);
    if (Array.isArray(r?.OperationErrors)) errors.push(...r.OperationErrors);
    if (Array.isArray(r?.BatchErrors)) errors.push(...r.BatchErrors);
  }
  return errors.length ? { Associations: associations, Errors: errors } : { Associations: associations };
}

/**
 * Generic Campaign Management read. The REST API exposes every Get* operation
 * as `POST /<Resource>/Query...` (GetAdsByAdGroupId → /Ads/QueryByAdGroupId,
 * GetCampaignCriterionsByIds → /CampaignCriterions/QueryByIds). Writes use
 * other shapes (POST /<Resource> to add, PUT to update, DELETE to remove), so
 * requiring the last segment to start with "Query" keeps this tool read-only
 * without enumerating every read operation.
 */
const QUERY_PATH = /^(\/[A-Z][A-Za-z]*)+\/Query[A-Za-z]*$/;

export function buildCampaignQueryRequest(path: string, body: Record<string, unknown> = {}): ReadRequest {
  if (!QUERY_PATH.test(path)) {
    throw new Error(
      `path must be a Campaign Management query such as "/Ads/QueryByAdGroupId" (last segment starting with "Query"), got "${path}"`,
    );
  }
  return { path, method: "POST", body };
}

export interface ReportOptions {
  accountId: string;
  /** "AdPerformance" or "AdPerformanceReportRequest". */
  reportType: string;
  columns: string[];
  startDate: string;
  endDate: string;
  aggregation?: string;
  campaignIds?: string[];
  /**
   * The existing report tools hardcode Pacific time, which shifts a French
   * account's days by 9 hours. Default to the Paris zone instead.
   */
  timeZone?: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function toReportDate(date: string, label: string): { Year: number; Month: number; Day: number } {
  if (!ISO_DATE.test(date)) {
    throw new Error(`${label} must be YYYY-MM-DD, got "${date}"`);
  }
  const [Year, Month, Day] = date.split("-").map(Number);
  return { Year, Month, Day };
}

/** ReportRequest body for any Reporting v13 report type. */
export function buildReportRequest(options: ReportOptions): Record<string, unknown> {
  const base = options.reportType.replace(/ReportRequest$/, "");
  if (!/^[A-Z][A-Za-z]+$/.test(base)) {
    throw new Error(`report_type must look like "AdPerformance", got "${options.reportType}"`);
  }
  if (!options.columns || options.columns.length === 0) {
    throw new Error("columns must contain at least one column");
  }
  const accountId = toNumericId(options.accountId, "account_id");
  const scope: Record<string, unknown> = { AccountIds: [accountId] };
  if (options.campaignIds && options.campaignIds.length > 0) {
    scope.Campaigns = options.campaignIds.map(id => ({
      AccountId: accountId,
      CampaignId: toNumericId(id, "campaign_ids"),
    }));
    // Bing ignores Scope.Campaigns when AccountIds is also set (see index.ts).
    delete scope.AccountIds;
  }
  return {
    Type: `${base}ReportRequest`,
    ReportName: base,
    Format: "Csv",
    FormatVersion: "2.0",
    ExcludeColumnHeaders: false,
    ExcludeReportFooter: true,
    ExcludeReportHeader: true,
    ReturnOnlyCompleteData: false,
    Aggregation: options.aggregation || "Summary",
    Columns: options.columns,
    Scope: scope,
    Time: {
      CustomDateRangeStart: toReportDate(options.startDate, "start_date"),
      CustomDateRangeEnd: toReportDate(options.endDate, "end_date"),
      ReportTimeZone: options.timeZone || "BrusselsCopenhagenMadridParis",
    },
  };
}
