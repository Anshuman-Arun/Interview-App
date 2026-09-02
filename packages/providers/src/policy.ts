import { types as utilTypes } from "node:util";
import {
  BillingVerificationSchema,
  type DataUsePolicy,
  type ModelCapabilities,
  type ProviderPolicy
} from "../../domain/src/index.js";

export type ProviderPolicyErrorCode =
  | "INVALID_POLICY"
  | "INVALID_CAPABILITIES"
  | "INVALID_ADAPTER_VERSION"
  | "INVALID_CLOCK"
  | "DATA_USE_EXCEEDS_POLICY"
  | "MISSING_BILLING_VERIFICATION"
  | "INVALID_BILLING_VERIFICATION"
  | "ADAPTER_VERSION_MISMATCH"
  | "SPEND_NOT_PROVEN_IMPOSSIBLE"
  | "BILLING_CLASS_FORBIDDEN"
  | "VERIFICATION_FUTURE"
  | "VERIFICATION_STALE";

export class ProviderPolicyError extends Error {
  public readonly code: ProviderPolicyErrorCode;

  public constructor(code: ProviderPolicyErrorCode, message: string) {
    super(message);
    this.name = "ProviderPolicyError";
    this.code = code;
  }
}

const REFLECT_APPLY_INTRINSIC = Reflect.apply;
/* eslint-disable @typescript-eslint/unbound-method -- Captured intrinsic is invoked only through Reflect.apply. */
const DATE_GET_TIME_INTRINSIC = Date.prototype.getTime;
/* eslint-enable @typescript-eslint/unbound-method */
const POLICY_KEYS = new Set([
  "allowMeteredUsage",
  "maximumDataUse",
  "billingVerificationMaxAgeMs"
]);
const MAX_ADAPTER_VERSION_CHARACTERS = 256;
const MAX_ENFORCEMENT_MECHANISM_CHARACTERS = 2_048;
const MAX_VERIFIED_AT_CHARACTERS = 64;

const BILLING_VERIFICATION_KEYS = new Set([
  "billingClass",
  "enforcementMechanism",
  "verifiedAt",
  "adapterVersion",
  "spendImpossible"
]);

const dataUseRank: Record<DataUsePolicy, number> = {
  LOCAL_ONLY: 0,
  REMOTE_NO_TRAINING: 1,
  REMOTE_MAY_BE_USED_FOR_IMPROVEMENT: 2
};

export interface ProviderPolicyPreflight {
  readonly policy: ProviderPolicy;
  readonly now: Date;
  readonly requiresBillingVerification: boolean;
}

export function preflightProviderPolicy(input: {
  readonly policy: unknown;
  readonly capabilities: ModelCapabilities;
  readonly adapterVersion: string;
  readonly now?: Date;
}): ProviderPolicyPreflight {
  const policy = parsePolicyConfiguration(input.policy);
  assertAdapterVersion(input.adapterVersion);
  const now = assertClock(input.now);

  const providerDataUse = readProviderDataUse(input.capabilities);
  const providerDataUseRank = dataUseRank[providerDataUse];
  const maximumDataUseRank = dataUseRank[policy.maximumDataUse];
  if (providerDataUseRank > maximumDataUseRank) {
    throw new ProviderPolicyError(
      "DATA_USE_EXCEEDS_POLICY",
      "Provider data-use policy exceeds the configured maximum"
    );
  }

  return { policy, now, requiresBillingVerification: !policy.allowMeteredUsage };
}

export function assertProviderPermitted(input: {
  readonly policy: unknown;
  readonly capabilities: ModelCapabilities;
  readonly billingVerification?: unknown;
  readonly adapterVersion: string;
  readonly now?: Date;
}): void {
  const { policy, now } = preflightProviderPolicy(input);

  if (policy.allowMeteredUsage) return;

  if (input.billingVerification === undefined) {
    throw new ProviderPolicyError(
      "MISSING_BILLING_VERIFICATION",
      "Billing verification is missing"
    );
  }

  const parsed = BillingVerificationSchema.safeParse(
    snapshotBillingVerification(input.billingVerification)
  );
  if (!parsed.success) {
    throw new ProviderPolicyError(
      "INVALID_BILLING_VERIFICATION",
      "Billing verification is malformed"
    );
  }
  const verification = parsed.data;

  if (
    verification.enforcementMechanism.trim().length === 0
    || verification.adapterVersion.trim().length === 0
  ) {
    throw new ProviderPolicyError(
      "INVALID_BILLING_VERIFICATION",
      "Billing verification is malformed"
    );
  }

  if (verification.adapterVersion !== input.adapterVersion) {
    throw new ProviderPolicyError(
      "ADAPTER_VERSION_MISMATCH",
      "Billing verification is for a different adapter version"
    );
  }

  if (!verification.spendImpossible) {
    throw new ProviderPolicyError(
      "SPEND_NOT_PROVEN_IMPOSSIBLE",
      "Billing verification does not prove that spend is impossible"
    );
  }

  if (
    verification.billingClass !== "VERIFIED_FREE_ONLY"
    && verification.billingClass !== "ACCOUNT_QUOTA"
  ) {
    throw new ProviderPolicyError(
      "BILLING_CLASS_FORBIDDEN",
      `Billing class ${verification.billingClass} is not permitted in no-metered mode`
    );
  }

  const verifiedAtMs = new Date(verification.verifiedAt).getTime();
  if (!Number.isFinite(verifiedAtMs)) {
    throw new ProviderPolicyError(
      "INVALID_BILLING_VERIFICATION",
      "Billing verification is malformed"
    );
  }

  const ageMs = now.getTime() - verifiedAtMs;
  if (ageMs < 0) {
    throw new ProviderPolicyError(
      "VERIFICATION_FUTURE",
      "Billing verification timestamp is in the future"
    );
  }
  if (ageMs > policy.billingVerificationMaxAgeMs) {
    throw new ProviderPolicyError(
      "VERIFICATION_STALE",
      "Billing verification is stale or invalid"
    );
  }
}

function parsePolicyConfiguration(value: unknown): ProviderPolicy {
  const record = snapshotExactDataRecord(value, POLICY_KEYS, "INVALID_POLICY");
  const allowMeteredUsage = record.allowMeteredUsage;
  const maximumDataUse = record.maximumDataUse;
  const billingVerificationMaxAgeMs = record.billingVerificationMaxAgeMs;

  if (
    typeof allowMeteredUsage !== "boolean"
    || !isDataUsePolicy(maximumDataUse)
    || typeof billingVerificationMaxAgeMs !== "number"
    || !Number.isFinite(billingVerificationMaxAgeMs)
    || !Number.isSafeInteger(billingVerificationMaxAgeMs)
    || billingVerificationMaxAgeMs <= 0
  ) {
    throw invalidPolicy();
  }

  return Object.freeze({
    allowMeteredUsage,
    maximumDataUse,
    billingVerificationMaxAgeMs
  });
}

function readProviderDataUse(capabilities: unknown): DataUsePolicy {
  const record = snapshotExactDataRecordMember(
    capabilities,
    "dataUse",
    "INVALID_CAPABILITIES"
  );
  if (!isDataUsePolicy(record)) {
    throw new ProviderPolicyError(
      "INVALID_CAPABILITIES",
      "Provider capabilities are invalid"
    );
  }
  return record;
}

function snapshotBillingVerification(value: unknown): unknown {
  if (value === undefined) return undefined;
  const snapshot = snapshotExactDataRecord(
    value,
    BILLING_VERIFICATION_KEYS,
    "INVALID_BILLING_VERIFICATION"
  );
  const enforcementMechanism = snapshot.enforcementMechanism;
  const verifiedAt = snapshot.verifiedAt;
  const adapterVersion = snapshot.adapterVersion;
  if (
    typeof enforcementMechanism !== "string"
    || enforcementMechanism.length > MAX_ENFORCEMENT_MECHANISM_CHARACTERS
    || typeof verifiedAt !== "string"
    || verifiedAt.length > MAX_VERIFIED_AT_CHARACTERS
    || typeof adapterVersion !== "string"
    || adapterVersion.length > MAX_ADAPTER_VERSION_CHARACTERS
  ) {
    throw new ProviderPolicyError(
      "INVALID_BILLING_VERIFICATION",
      "Billing verification is malformed"
    );
  }
  return snapshot;
}

function snapshotExactDataRecordMember(
  value: unknown,
  key: string,
  errorCode: "INVALID_CAPABILITIES"
): unknown {
  if (
    typeof value !== "object"
    || value === null
    || utilTypes.isProxy(value)
    || Array.isArray(value)
  ) {
    throw new ProviderPolicyError(errorCode, "Provider capabilities are invalid");
  }
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    throw new ProviderPolicyError(errorCode, "Provider capabilities are invalid");
  }
  if (
    descriptor === undefined
    || descriptor.enumerable !== true
    || !("value" in descriptor)
  ) {
    throw new ProviderPolicyError(errorCode, "Provider capabilities are invalid");
  }
  return descriptor.value;
}

function snapshotExactDataRecord(
  value: unknown,
  allowedKeys: ReadonlySet<string>,
  errorCode: "INVALID_POLICY" | "INVALID_BILLING_VERIFICATION"
): Readonly<Record<string, unknown>> {
  const fail = (): never => {
    if (errorCode === "INVALID_POLICY") throw invalidPolicy();
    throw new ProviderPolicyError(
      "INVALID_BILLING_VERIFICATION",
      "Billing verification is malformed"
    );
  };
  if (
    typeof value !== "object"
    || value === null
    || utilTypes.isProxy(value)
    || Array.isArray(value)
  ) {
    return fail();
  }

  let prototype: unknown;
  let descriptors: Readonly<Record<string, PropertyDescriptor>>;
  let symbols: readonly symbol[];
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
    symbols = Object.getOwnPropertySymbols(value);
  } catch {
    return fail();
  }
  if (
    (prototype !== Object.prototype && prototype !== null)
    || symbols.length !== 0
    || Object.keys(descriptors).some((key) => !allowedKeys.has(key))
  ) {
    return fail();
  }

  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of allowedKeys) {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined
      || descriptor.enumerable !== true
      || !("value" in descriptor)
    ) {
      return fail();
    }
    output[key] = descriptor.value;
  }
  return Object.freeze(output);
}

function isDataUsePolicy(value: unknown): value is DataUsePolicy {
  return value === "LOCAL_ONLY"
    || value === "REMOTE_NO_TRAINING"
    || value === "REMOTE_MAY_BE_USED_FOR_IMPROVEMENT";
}

function invalidPolicy(): ProviderPolicyError {
  return new ProviderPolicyError(
    "INVALID_POLICY",
    "Provider policy configuration is invalid"
  );
}

function assertAdapterVersion(adapterVersion: string): void {
  if (
    adapterVersion.trim().length === 0
    || adapterVersion.length > MAX_ADAPTER_VERSION_CHARACTERS
  ) {
    throw new ProviderPolicyError(
      "INVALID_ADAPTER_VERSION",
      "Provider adapter version must be non-empty"
    );
  }
}

function assertClock(now: Date | undefined): Date {
  const value: unknown = now ?? new Date();
  if (
    typeof value !== "object"
    || value === null
    || utilTypes.isProxy(value)
  ) {
    throw new ProviderPolicyError(
      "INVALID_CLOCK",
      "Provider policy clock is invalid"
    );
  }
  let milliseconds: unknown;
  try {
    milliseconds = REFLECT_APPLY_INTRINSIC(
      DATE_GET_TIME_INTRINSIC,
      value,
      []
    );
  } catch {
    throw new ProviderPolicyError(
      "INVALID_CLOCK",
      "Provider policy clock is invalid"
    );
  }
  if (
    typeof milliseconds !== "number"
    || !Number.isFinite(milliseconds)
  ) {
    throw new ProviderPolicyError(
      "INVALID_CLOCK",
      "Provider policy clock is invalid"
    );
  }
  return new Date(milliseconds);
}
