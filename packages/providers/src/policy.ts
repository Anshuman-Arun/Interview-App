import {
  BillingVerificationSchema,
  type DataUsePolicy,
  type ModelCapabilities,
  type ProviderPolicy
} from "../../domain/src/index.js";

export type ProviderPolicyErrorCode =
  | "INVALID_POLICY"
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

const dataUseRank: Record<DataUsePolicy, number> = {
  LOCAL_ONLY: 0,
  REMOTE_NO_TRAINING: 1,
  REMOTE_MAY_BE_USED_FOR_IMPROVEMENT: 2
};

export function assertProviderPermitted(input: {
  readonly policy: ProviderPolicy;
  readonly capabilities: ModelCapabilities;
  readonly billingVerification?: unknown;
  readonly adapterVersion: string;
  readonly now?: Date;
}): void {
  assertPolicyConfiguration(input.policy);
  assertAdapterVersion(input.adapterVersion);
  const now = assertClock(input.now);

  const providerDataUseRank = dataUseRank[input.capabilities.dataUse];
  const maximumDataUseRank = dataUseRank[input.policy.maximumDataUse];
  if (providerDataUseRank === undefined || maximumDataUseRank === undefined) {
    throw new ProviderPolicyError(
      "INVALID_POLICY",
      "Provider data-use configuration is invalid"
    );
  }
  if (providerDataUseRank > maximumDataUseRank) {
    throw new ProviderPolicyError(
      "DATA_USE_EXCEEDS_POLICY",
      "Provider data-use policy exceeds the configured maximum"
    );
  }

  if (input.policy.allowMeteredUsage) return;

  if (input.billingVerification === undefined) {
    throw new ProviderPolicyError(
      "MISSING_BILLING_VERIFICATION",
      "Billing verification is missing"
    );
  }

  const parsed = BillingVerificationSchema.safeParse(input.billingVerification);
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
  if (ageMs > input.policy.billingVerificationMaxAgeMs) {
    throw new ProviderPolicyError(
      "VERIFICATION_STALE",
      "Billing verification is stale or invalid"
    );
  }
}

function assertPolicyConfiguration(policy: ProviderPolicy): void {
  if (
    typeof policy.allowMeteredUsage !== "boolean"
    || dataUseRank[policy.maximumDataUse] === undefined
    || !Number.isFinite(policy.billingVerificationMaxAgeMs)
    || policy.billingVerificationMaxAgeMs <= 0
  ) {
    throw new ProviderPolicyError(
      "INVALID_POLICY",
      "Provider policy configuration is invalid"
    );
  }
}

function assertAdapterVersion(adapterVersion: string): void {
  if (adapterVersion.trim().length === 0) {
    throw new ProviderPolicyError(
      "INVALID_ADAPTER_VERSION",
      "Provider adapter version must be non-empty"
    );
  }
}

function assertClock(now: Date | undefined): Date {
  const value = now ?? new Date();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new ProviderPolicyError(
      "INVALID_CLOCK",
      "Provider policy clock is invalid"
    );
  }
  return value;
}
