/**
 * Customer Match: add e-mail addresses to an existing customer list
 * (ApplyCustomerListUserData, REST POST /CustomerListUserData/Apply).
 *
 * Same contract as typedWrites.ts: a pure planner over a state already read.
 * Add only: Remove and Replace are never sent, so a run can only grow a list.
 * The addresses come from a local file and are hashed here (SHA-256 of the
 * lowercased, trimmed address, lowercase hex, as Microsoft requires), so they
 * never travel through the tool arguments or the conversation.
 */

import { createHash } from "crypto";
import type { MutationRequest } from "./mutationRequests.js";
import type { Plan } from "./typedWrites.js";

/** Microsoft accepts at most 1000 items per ApplyCustomerListUserData call. */
export const MAX_ITEMS_PER_CALL = 1000;

const EMAIL = /^[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

export const SIZE_DELAY_WARNING =
  "Microsoft refreshes customer list sizes with a delay (up to 48 h): an unchanged size right after the upload is not a failure.";

export interface ParsedEmails {
  hashes: string[];
  plainCount: number;
  alreadyHashedCount: number;
  invalidCount: number;
  duplicateCount: number;
}

export function hashEmail(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase(), "utf8").digest("hex");
}

/**
 * One address (or one 64-character SHA-256 hex) per line; an "Email" header and
 * surrounding quotes are ignored. Duplicates are counted after normalisation.
 */
export function parseEmailFile(text: string): ParsedEmails {
  const seen = new Set<string>();
  const out: ParsedEmails = { hashes: [], plainCount: 0, alreadyHashedCount: 0, invalidCount: 0, duplicateCount: 0 };
  for (const raw of text.split(/\r?\n/)) {
    const v = raw.trim().replace(/^"|"$/g, "").trim().toLowerCase();
    if (!v || v === "email") continue;
    let hash: string;
    if (SHA256_HEX.test(v)) {
      hash = v;
      out.alreadyHashedCount++;
    } else if (EMAIL.test(v) && !v.includes("..")) {
      hash = hashEmail(v);
      out.plainCount++;
    } else {
      out.invalidCount++;
      continue;
    }
    if (seen.has(hash)) {
      out.duplicateCount++;
      continue;
    }
    seen.add(hash);
    out.hashes.push(hash);
  }
  return out;
}

export interface CustomerListState {
  /** The audience read by id; null when it does not exist on the account. */
  audience: { Id: string; Name: string; Type: string; SearchSize: unknown; AudienceNetworkSize: unknown } | null;
  parsed: ParsedEmails;
}

export interface CustomerListArgs {
  audience_id: string;
  accepter_conditions?: boolean;
}

export function planCustomerListAdd(state: CustomerListState, args: CustomerListArgs): Plan & { preview_requests: unknown[] } {
  const a = state.audience;
  if (!a) throw new Error(`Audience ${args.audience_id} not found on this account.`);
  if (a.Type !== "CustomerList") throw new Error(`Audience ${a.Id} is a ${a.Type}, not a CustomerList: refused.`);
  const p = state.parsed;
  if (p.hashes.length === 0) throw new Error("No valid e-mail address in the file.");

  const requests: MutationRequest[] = [];
  for (let i = 0; i < p.hashes.length; i += MAX_ITEMS_PER_CALL) {
    const data: Record<string, unknown> = {
      ActionType: "Add",
      AudienceId: Number(a.Id),
      CustomerListItemSubType: "Email",
      CustomerListItems: p.hashes.slice(i, i + MAX_ITEMS_PER_CALL),
    };
    if (args.accepter_conditions === true) data.AcceptCustomerMatchTerm = true;
    requests.push({ path: "/CustomerListUserData/Apply", method: "POST", body: { CustomerListUserData: data } });
  }

  const warnings = [SIZE_DELAY_WARNING];
  if (p.invalidCount) warnings.push(`${p.invalidCount} invalid line(s) skipped.`);
  if (p.duplicateCount) warnings.push(`${p.duplicateCount} duplicate(s) skipped.`);
  if (args.accepter_conditions !== true) {
    warnings.push("accepter_conditions not set: the upload only works if the Customer Match terms were accepted in the interface.");
  }

  const before = { audience_id: a.Id, name: a.Name, search_size: a.SearchSize, audience_network_size: a.AudienceNetworkSize };
  return {
    before,
    after: { ...before, addresses_sent: p.hashes.length },
    diff: {
      action: "Add",
      unique_addresses: p.hashes.length,
      plain_addresses: p.plainCount,
      already_hashed: p.alreadyHashedCount,
      invalid_skipped: p.invalidCount,
      duplicates_skipped: p.duplicateCount,
      calls: requests.length,
    },
    warnings,
    // Removing addresses is deliberately not offered: this tool only adds.
    restore_args: null,
    requests,
    // Shown in dry runs and snapshots instead of the requests: no hashes listed.
    preview_requests: requests.map(r => ({
      path: r.path,
      method: r.method,
      items: ((r.body.CustomerListUserData as any).CustomerListItems as string[]).length,
    })),
  };
}
