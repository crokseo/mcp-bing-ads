import { describe, it, expect } from "vitest";
import { hashEmail, parseEmailFile, planCustomerListAdd, MAX_ITEMS_PER_CALL } from "./customerListWrites.js";

const LIST = { Id: "123", Name: "Clients", Type: "CustomerList", SearchSize: "200", AudienceNetworkSize: "190" };

describe("hashEmail", () => {
  it("hashes the lowercased, trimmed address as lowercase hex SHA-256", () => {
    expect(hashEmail("  Jane.Doe@Example.COM ")).toBe(hashEmail("jane.doe@example.com"));
    expect(hashEmail("jane.doe@example.com")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("parseEmailFile", () => {
  it("skips the header, invalid lines and duplicates, keeps existing hashes", () => {
    const hashed = hashEmail("c@example.org");
    const p = parseEmailFile(`Email\r\na@example.com\n"B@Example.com"\nA@EXAMPLE.COM\nnot-an-email\nx..y@example.com\n${hashed}\nc@example.org\n\n`);
    expect(p.hashes).toHaveLength(3);
    expect(p.plainCount).toBe(4);
    expect(p.alreadyHashedCount).toBe(1);
    expect(p.invalidCount).toBe(2);
    expect(p.duplicateCount).toBe(2);
  });
});

describe("planCustomerListAdd", () => {
  const parsed = parseEmailFile(Array.from({ length: 2500 }, (_, i) => `user${i}@example.com`).join("\n"));

  it("sends Add only, in batches of at most 1000 hashed e-mails", () => {
    const plan = planCustomerListAdd({ audience: LIST, parsed }, { audience_id: "123" });
    expect(plan.requests).toHaveLength(3);
    for (const r of plan.requests) {
      const d = (r.body as any).CustomerListUserData;
      expect(r.path).toBe("/CustomerListUserData/Apply");
      expect(d.ActionType).toBe("Add");
      expect(d.AudienceId).toBe(123);
      expect(d.CustomerListItemSubType).toBe("Email");
      expect(d.CustomerListItems.length).toBeLessThanOrEqual(MAX_ITEMS_PER_CALL);
      expect(d).not.toHaveProperty("AcceptCustomerMatchTerm");
    }
    expect(plan.restore_args).toBeNull();
    expect(plan.preview_requests).toEqual([
      { path: "/CustomerListUserData/Apply", method: "POST", items: 1000 },
      { path: "/CustomerListUserData/Apply", method: "POST", items: 1000 },
      { path: "/CustomerListUserData/Apply", method: "POST", items: 500 },
    ]);
  });

  it("accepts the Customer Match terms only when asked explicitly", () => {
    const plan = planCustomerListAdd({ audience: LIST, parsed }, { audience_id: "123", accepter_conditions: true });
    expect((plan.requests[0].body as any).CustomerListUserData.AcceptCustomerMatchTerm).toBe(true);
  });

  it("refuses a missing audience, a non customer list, and an empty file", () => {
    expect(() => planCustomerListAdd({ audience: null, parsed }, { audience_id: "9" })).toThrow(/not found/);
    expect(() => planCustomerListAdd({ audience: { ...LIST, Type: "RemarketingList" }, parsed }, { audience_id: "123" })).toThrow(/not a CustomerList/);
    expect(() => planCustomerListAdd({ audience: LIST, parsed: parseEmailFile("Email\n") }, { audience_id: "123" })).toThrow(/No valid/);
  });
});
