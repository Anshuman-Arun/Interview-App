import { describe, expect, it } from "vitest";
import { MockModelAdapter, ProviderPolicyError, assertProviderPermitted } from "../packages/providers/src/index.js";

const provider = new MockModelAdapter({
  proposal: { realizedAction: "WAIT", claimedDisclosureLevel: 0, claimedDisclosureIds: [], speechText: "Please continue." }
});
const policy = { allowMeteredUsage: false, maximumDataUse: "LOCAL_ONLY" as const, billingVerificationMaxAgeMs: 1_000 };

describe("provider billing and data policy", () => {
  it("fails closed for missing billing verification", () => {
    expect(() => assertProviderPermitted({ policy, capabilities: provider.capabilities, adapterVersion: provider.adapterVersion })).toThrow(ProviderPolicyError);
  });

  it.each(["UNKNOWN", "METERED"] as const)("rejects %s billing class", (billingClass) => {
    expect(() => assertProviderPermitted({
      policy,
      capabilities: provider.capabilities,
      adapterVersion: provider.adapterVersion,
      billingVerification: {
        billingClass,
        enforcementMechanism: "none",
        verifiedAt: new Date().toISOString(),
        adapterVersion: provider.adapterVersion,
        spendImpossible: false
      }
    })).toThrow(ProviderPolicyError);
  });

  it("rejects stale verification", () => {
    expect(() => assertProviderPermitted({
      policy,
      capabilities: provider.capabilities,
      adapterVersion: provider.adapterVersion,
      now: new Date("2026-01-01T00:00:02.000Z"),
      billingVerification: {
        billingClass: "VERIFIED_FREE_ONLY",
        enforcementMechanism: "provider-specific no-spend control",
        verifiedAt: "2026-01-01T00:00:00.000Z",
        adapterVersion: provider.adapterVersion,
        spendImpossible: true
      }
    })).toThrow(/stale/);
  });
});

