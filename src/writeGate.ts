import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { createWriteGate } from "mcp-write-gate";

/**
 * Tools that mutate Bing Ads state. These are hidden from the tool list
 * and refused at call time unless BING_ADS_MCP_WRITE=true.
 *
 * Adding a new tool? Put it in this set if it creates, modifies, pauses,
 * enables, removes, links, unlinks, or applies anything.
 */
export const WRITE_TOOLS: ReadonlySet<string> = new Set([
  "bing_ads_add_shared_negatives",
  "bing_ads_pause_keywords",
  "bing_ads_update_campaign_budget",
  "bing_ads_update_ad_group_cpc_bid",
]);

/**
 * Typed write tools (bing_ads_set_*, bing_ads_add_*): dry run first, write on
 * confirm. They stay listed and callable without BING_ADS_MCP_WRITE, because
 * their default (confirm=false) only reads; confirm=true is refused unless
 * writes are enabled (see assertConfirmAllowed). They are deliberately NOT in
 * WRITE_TOOLS, which would hide the dry run along with the write.
 */
export const DRY_RUN_THEN_WRITE_TOOLS: ReadonlySet<string> = new Set([
  "bing_ads_set_ad_schedule",
  "bing_ads_set_locations",
  "bing_ads_set_device_bid",
  "bing_ads_set_ad_group_status",
  "bing_ads_set_final_url_suffix",
  "bing_ads_set_bidding_strategy",
  "bing_ads_add_keywords",
  "bing_ads_add_negative_keywords",
  "bing_ads_add_responsive_search_ad",
]);

const gate = createWriteGate({
  writeTools: WRITE_TOOLS,
  envPrefix: "BING_ADS",
});

export function isWriteTool(name: string): boolean {
  return gate.isWriteTool(name);
}

export function isWriteEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return gate.isWriteEnabled(env);
}

export function filterTools(
  allTools: readonly Tool[],
  env: NodeJS.ProcessEnv = process.env,
): Tool[] {
  return gate.filterTools(allTools, env);
}

export const WRITE_DISABLED_MESSAGE =
  "Write operations are disabled. Set BING_ADS_MCP_WRITE=true in the MCP server environment to enable mutating tools (create/update/pause/enable/remove/apply).";

/**
 * Assert that a tool call is allowed under the current write-mode setting.
 * Throws a clear Error if the tool mutates state and writes are disabled.
 */
export function assertWriteAllowed(
  toolName: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  try {
    gate.assertWriteAllowed(toolName, env);
  } catch (e) {
    throw new Error(
      `Tool "${toolName}" is a write operation. ${WRITE_DISABLED_MESSAGE}`,
    );
  }
}

/**
 * Refuse a confirmed (mutating) call of a dry-run-then-write tool unless
 * writes are enabled. Dry runs always pass.
 */
export function assertConfirmAllowed(
  toolName: string,
  confirm: unknown,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!DRY_RUN_THEN_WRITE_TOOLS.has(toolName) || confirm !== true) return;
  if (!isWriteEnabled(env)) {
    throw new Error(
      `Tool "${toolName}" with confirm=true writes to the account. ${WRITE_DISABLED_MESSAGE} Without confirm it runs as a dry run.`,
    );
  }
}
