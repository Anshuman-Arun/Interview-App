import { describe, expect, it } from "vitest";
import type {
  BillingVerification,
  DataUsePolicy,
  ModelCapabilities,
  ProviderPolicy
} from "../packages/domain/src/index.js";
import {
  ProviderPolicyError,
  assertProviderPermitted
} from "../packages/providers/src/index.js";

const ADAPTER_VERSION = "fixture-adapter@1.2.3";
const VERIFIED_AT = "2026-08-29T12:00:00.000Z";
const NOW = new Date("2026-08-29T12:00:00.500Z");

const localCapabilities: ModelCapabilities = {
  inputModalities: new Set(["text"]),
  textStreaming: false,
  structuredOutput: "FINAL_ONLY",
  persistentSession: false,
  resumableSession: false,
  cancellation: "DROP_OUTPUT",
  sessionSurvivesClientAbort: false,
  sessionSurvivesProviderCancel: false,
  usageReporting: false,
  dataUse: "LOCAL_ONLY"
};

const noMeteredPolicy: ProviderPolicy = {
  allowMeteredUsage: false,
  maximumDataUse: "LOCAL_ONLY",
  billingVerificationMaxAgeMs: 1_000
};

describe("provider policy hardening", () => {
  it.each(["VERIFIED_FREE_ONLY", "ACCOUNT_QUOTA"] as const)(
    "accepts a fresh %s proof only when spend is technically impossible",
    (billingClass) => {
      expect(() => assertProviderPermitted({
        policy: noMeteredPolicy,
        capabilities: localCapabilities,
        adapterVersion: ADAPTER_VERSION,
        now: NOW,
        billingVerification: verification({ billingClass })
      })).not.toThrow();
    }
  );

  it("accepts a proof exactly on the configured freshness boundary", () => {
    expect(() => assertProviderPermitted({
      policy: noMeteredPolicy,
      capabilities: localCapabilities,
      adapterVersion: ADAPTER_VERSION,
      now: new Date("2026-08-29T12:00:01.000Z"),
      billingVerification: verification()
    })).not.toThrow();
  });

  it("rejects a proof one millisecond beyond the freshness boundary", () => {
    expectPolicyError(() => assertProviderPermitted({
      policy: noMeteredPolicy,
      capabilities: localCapabilities,
      adapterVersion: ADAPTER_VERSION,
      now: new Date("2026-08-29T12:00:01.001Z"),
      billingVerification: verification()
    }), "VERIFICATION_STALE");
  });

  it("rejects a verification timestamp from the future", () => {
    expectPolicyError(() => assertProviderPermitted({
      policy: noMeteredPolicy,
      capabilities: localCapabilities,
      adapterVersion: ADAPTER_VERSION,
      now: new Date("2026-08-29T11:59:59.999Z"),
      billingVerification: verification()
    }), "VERIFICATION_FUTURE");
  });

  it("rejects an invalid application clock", () => {
    expectPolicyError(() => assertProviderPermitted({
      policy: noMeteredPolicy,
      capabilities: localCapabilities,
      adapterVersion: ADAPTER_VERSION,
      now: new Date("not-a-date"),
      billingVerification: verification()
    }), "INVALID_CLOCK");
  });

  it("rejects missing billing verification in no-metered mode", () => {
    expectPolicyError(() => assertProviderPermitted({
      policy: noMeteredPolicy,
      capabilities: localCapabilities,
      adapterVersion: ADAPTER_VERSION,
      now: NOW
    }), "MISSING_BILLING_VERIFICATION");
  });

  it.each(["VERIFIED_FREE_ONLY", "ACCOUNT_QUOTA"] as const)(
    "rejects %s when the evidence does not prove spend impossible",
    (billingClass) => {
      expectPolicyError(() => assertProviderPermitted({
        policy: noMeteredPolicy,
        capabilities: localCapabilities,
        adapterVersion: ADAPTER_VERSION,
        now: NOW,
        billingVerification: verification({
          billingClass,
          spendImpossible: false
        })
      }), "SPEND_NOT_PROVEN_IMPOSSIBLE");
    }
  );

  it.each(["METERED", "UNKNOWN"] as const)(
    "rejects %s even when the evidence claims spend is impossible",
    (billingClass) => {
      expectPolicyError(() => assertProviderPermitted({
        policy: noMeteredPolicy,
        capabilities: localCapabilities,
        adapterVersion: ADAPTER_VERSION,
        now: NOW,
        billingVerification: verification({ billingClass })
      }), "BILLING_CLASS_FORBIDDEN");
    }
  );

  it("binds billing evidence to the exact adapter version", () => {
    expectPolicyError(() => assertProviderPermitted({
      policy: noMeteredPolicy,
      capabilities: localCapabilities,
      adapterVersion: ADAPTER_VERSION,
      now: NOW,
      billingVerification: verification({ adapterVersion: "fixture-adapter@older" })
    }), "ADAPTER_VERSION_MISMATCH");
  });

  it.each([
    {
      name: "unknown extra fields",
      value: {
        ...verification(),
        arbitrary: true
      }
    },
    {
      name: "invalid ISO timestamp",
      value: {
        ...verification(),
        verifiedAt: "yesterday"
      }
    },
    {
      name: "blank enforcement mechanism",
      value: {
        ...verification(),
        enforcementMechanism: "   "
      }
    },
    {
      name: "blank evidence adapter version",
      value: {
        ...verification(),
        adapterVersion: "   "
      }
    }
  ])("fails closed for malformed billing verification: $name", ({ value }) => {
    expectPolicyError(() => assertProviderPermitted({
      policy: noMeteredPolicy,
      capabilities: localCapabilities,
      adapterVersion: ADAPTER_VERSION,
      now: NOW,
      billingVerification: value
    }), "INVALID_BILLING_VERIFICATION");
  });

  it.each([
    {
      name: "oversized enforcement mechanism",
      value: {
        ...verification(),
        enforcementMechanism: "x".repeat(2_049)
      }
    },
    {
      name: "oversized evidence adapter version",
      value: {
        ...verification(),
        adapterVersion: "x".repeat(257)
      }
    },
    {
      name: "oversized timestamp text",
      value: {
        ...verification(),
        verifiedAt: "2".repeat(65)
      }
    }
  ])("bounds billing verification text before schema parsing: $name", ({ value }) => {
    expectPolicyError(() => assertProviderPermitted({
      policy: noMeteredPolicy,
      capabilities: localCapabilities,
      adapterVersion: ADAPTER_VERSION,
      now: NOW,
      billingVerification: value
    }), "INVALID_BILLING_VERIFICATION");
  });

  it("rejects accessor and Proxy policy/billing inputs without invoking traps", () => {
    let getterCalls = 0;
    const accessorPolicy = Object.defineProperty(
      {
        maximumDataUse: "LOCAL_ONLY",
        billingVerificationMaxAgeMs: 1_000
      },
      "allowMeteredUsage",
      {
        enumerable: true,
        get() {
          getterCalls += 1;
          return false;
        }
      }
    );
    expectPolicyError(() => assertProviderPermitted({
      policy: accessorPolicy,
      capabilities: localCapabilities,
      adapterVersion: ADAPTER_VERSION,
      now: NOW,
      billingVerification: verification()
    }), "INVALID_POLICY");
    expect(getterCalls).toBe(0);

    let policyProxyTraps = 0;
    const policyProxy = new Proxy(noMeteredPolicy, {
      ownKeys() {
        policyProxyTraps += 1;
        throw new Error("must-not-run");
      },
      getOwnPropertyDescriptor() {
        policyProxyTraps += 1;
        throw new Error("must-not-run");
      }
    });
    expectPolicyError(() => assertProviderPermitted({
      policy: policyProxy,
      capabilities: localCapabilities,
      adapterVersion: ADAPTER_VERSION,
      now: NOW,
      billingVerification: verification()
    }), "INVALID_POLICY");
    expect(policyProxyTraps).toBe(0);

    let billingProxyTraps = 0;
    const billingProxy = new Proxy(verification(), {
      ownKeys() {
        billingProxyTraps += 1;
        throw new Error("must-not-run");
      },
      getOwnPropertyDescriptor() {
        billingProxyTraps += 1;
        throw new Error("must-not-run");
      }
    });
    expectPolicyError(() => assertProviderPermitted({
      policy: noMeteredPolicy,
      capabilities: localCapabilities,
      adapterVersion: ADAPTER_VERSION,
      now: NOW,
      billingVerification: billingProxy
    }), "INVALID_BILLING_VERIFICATION");
    expect(billingProxyTraps).toBe(0);
  });

  it("fails closed for invalid or Proxy-backed provider data-use capabilities", () => {
    expectPolicyError(() => assertProviderPermitted({
      policy: {
        ...noMeteredPolicy,
        allowMeteredUsage: true
      },
      capabilities: {
        ...localCapabilities,
        dataUse: "UNRECOGNIZED"
      } as unknown as ModelCapabilities,
      adapterVersion: ADAPTER_VERSION,
      now: NOW
    }), "INVALID_CAPABILITIES");

    let capabilityProxyTraps = 0;
    const capabilityProxy = new Proxy(localCapabilities, {
      getOwnPropertyDescriptor() {
        capabilityProxyTraps += 1;
        throw new Error("must-not-run");
      }
    });
    expectPolicyError(() => assertProviderPermitted({
      policy: {
        ...noMeteredPolicy,
        allowMeteredUsage: true
      },
      capabilities: capabilityProxy,
      adapterVersion: ADAPTER_VERSION,
      now: NOW
    }), "INVALID_CAPABILITIES");
    expect(capabilityProxyTraps).toBe(0);
  });

  it.each([0, -1, Number.POSITIVE_INFINITY, Number.NaN])(
    "rejects invalid billing-verification max age %s",
    (billingVerificationMaxAgeMs) => {
      expectPolicyError(() => assertProviderPermitted({
        policy: {
          ...noMeteredPolicy,
          billingVerificationMaxAgeMs
        },
        capabilities: localCapabilities,
        adapterVersion: ADAPTER_VERSION,
        now: NOW,
        billingVerification: verification()
      }), "INVALID_POLICY");
    }
  );

  it("rejects a malformed runtime data-use policy instead of defaulting permissive", () => {
    const malformed = {
      ...noMeteredPolicy,
      maximumDataUse: "UNRECOGNIZED"
    } as unknown as ProviderPolicy;

    expectPolicyError(() => assertProviderPermitted({
      policy: malformed,
      capabilities: localCapabilities,
      adapterVersion: ADAPTER_VERSION,
      now: NOW,
      billingVerification: verification()
    }), "INVALID_POLICY");
  });

  it("rejects an invalid runtime allowMeteredUsage value", () => {
    const malformed = {
      ...noMeteredPolicy,
      allowMeteredUsage: "yes"
    } as unknown as ProviderPolicy;

    expectPolicyError(() => assertProviderPermitted({
      policy: malformed,
      capabilities: localCapabilities,
      adapterVersion: ADAPTER_VERSION,
      now: NOW,
      billingVerification: verification()
    }), "INVALID_POLICY");
  });

  it("requires a nonblank adapter version even when metered usage is allowed", () => {
    expectPolicyError(() => assertProviderPermitted({
      policy: {
        ...noMeteredPolicy,
        allowMeteredUsage: true
      },
      capabilities: localCapabilities,
      adapterVersion: "   ",
      now: NOW
    }), "INVALID_ADAPTER_VERSION");
  });

  it("rejects oversized adapter versions even when metered use is allowed", () => {
    expectPolicyError(() => assertProviderPermitted({
      policy: {
        ...noMeteredPolicy,
        allowMeteredUsage: true
      },
      capabilities: localCapabilities,
      adapterVersion: "x".repeat(257),
      now: NOW
    }), "INVALID_ADAPTER_VERSION");
  });

  it("does not require billing verification when metered usage is explicitly allowed", () => {
    expect(() => assertProviderPermitted({
      policy: {
        ...noMeteredPolicy,
        allowMeteredUsage: true
      },
      capabilities: localCapabilities,
      adapterVersion: ADAPTER_VERSION,
      now: NOW
    })).not.toThrow();
  });

  it.each([
    {
      maximumDataUse: "LOCAL_ONLY" as const,
      providerDataUse: "REMOTE_NO_TRAINING" as const
    },
    {
      maximumDataUse: "LOCAL_ONLY" as const,
      providerDataUse: "REMOTE_MAY_BE_USED_FOR_IMPROVEMENT" as const
    },
    {
      maximumDataUse: "REMOTE_NO_TRAINING" as const,
      providerDataUse: "REMOTE_MAY_BE_USED_FOR_IMPROVEMENT" as const
    }
  ])(
    "rejects $providerDataUse when maximum data use is $maximumDataUse",
    ({ maximumDataUse, providerDataUse }) => {
      expectPolicyError(() => assertProviderPermitted({
        policy: {
          allowMeteredUsage: true,
          maximumDataUse,
          billingVerificationMaxAgeMs: 1_000
        },
        capabilities: capabilitiesWithDataUse(providerDataUse),
        adapterVersion: ADAPTER_VERSION,
        now: NOW
      }), "DATA_USE_EXCEEDS_POLICY");
    }
  );

  it.each([
    ["LOCAL_ONLY", "LOCAL_ONLY"],
    ["REMOTE_NO_TRAINING", "LOCAL_ONLY"],
    ["REMOTE_NO_TRAINING", "REMOTE_NO_TRAINING"],
    ["REMOTE_MAY_BE_USED_FOR_IMPROVEMENT", "LOCAL_ONLY"],
    ["REMOTE_MAY_BE_USED_FOR_IMPROVEMENT", "REMOTE_NO_TRAINING"],
    ["REMOTE_MAY_BE_USED_FOR_IMPROVEMENT", "REMOTE_MAY_BE_USED_FOR_IMPROVEMENT"]
  ] as const)(
    "allows provider data use %s under maximum %s",
    (maximumDataUse, providerDataUse) => {
      expect(() => assertProviderPermitted({
        policy: {
          allowMeteredUsage: true,
          maximumDataUse,
          billingVerificationMaxAgeMs: 1_000
        },
        capabilities: capabilitiesWithDataUse(providerDataUse),
        adapterVersion: ADAPTER_VERSION,
        now: NOW
      })).not.toThrow();
    }
  );

  it("does not reflect billing evidence or secrets into policy errors", () => {
    const secret = "super-secret-provider-key";
    let caught: unknown;

    try {
      assertProviderPermitted({
        policy: noMeteredPolicy,
        capabilities: localCapabilities,
        adapterVersion: ADAPTER_VERSION,
        now: NOW,
        billingVerification: {
          ...verification(),
          verifiedAt: "invalid",
          enforcementMechanism: `apiKey=${secret}`
        }
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ProviderPolicyError);
    expect(String(caught)).not.toContain(secret);
    expect(String(caught)).not.toContain("apiKey=");
  });
});

function verification(
  overrides: Partial<BillingVerification> = {}
): BillingVerification {
  return {
    billingClass: "VERIFIED_FREE_ONLY",
    enforcementMechanism: "provider-specific technical no-spend control",
    verifiedAt: VERIFIED_AT,
    adapterVersion: ADAPTER_VERSION,
    spendImpossible: true,
    ...overrides
  };
}

function capabilitiesWithDataUse(dataUse: DataUsePolicy): ModelCapabilities {
  return {
    ...localCapabilities,
    dataUse
  };
}

function expectPolicyError(
  operation: () => void,
  code: ProviderPolicyError["code"]
): void {
  let caught: unknown;
  try {
    operation();
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(ProviderPolicyError);
  if (!(caught instanceof ProviderPolicyError)) {
    throw new Error("Expected ProviderPolicyError");
  }
  expect(caught.code).toBe(code);
}
