import type {
  BillingVerification,
  DataUsePolicy,
  ModelCapabilities,
  ProviderPolicy
} from "../../domain/src/index.js";

export class ProviderPolicyError extends Error {}

const dataUseRank: Record<DataUsePolicy, number> = {
  LOCAL_ONLY: 0,
  REMOTE_NO_TRAINING: 1,
  REMOTE_MAY_BE_USED_FOR_IMPROVEMENT: 2
};

export function assertProviderPermitted(input: {
  readonly policy: ProviderPolicy;
  readonly capabilities: ModelCapabilities;
  readonly billingVerification?: BillingVerification;
  readonly adapterVersion: string;
  readonly now?: Date;
}): void {
  if (dataUseRank[input.capabilities.dataUse] > dataUseRank[input.policy.maximumDataUse]) {
    throw new ProviderPolicyError("Provider data-use policy exceeds the configured maximum");
  }
  if (input.policy.allowMeteredUsage) return;
  const verification = input.billingVerification;
  if (verification === undefined) throw new ProviderPolicyError("Billing verification is missing");
  if (verification.adapterVersion !== input.adapterVersion) throw new ProviderPolicyError("Billing verification is for a different adapter version");
  if (!verification.spendImpossible) throw new ProviderPolicyError("Billing verification does not prove that spend is impossible");
  if (verification.billingClass !== "VERIFIED_FREE_ONLY" && verification.billingClass !== "ACCOUNT_QUOTA") {
    throw new ProviderPolicyError(`Billing class ${verification.billingClass} is not permitted in no-metered mode`);
  }
  const age = (input.now ?? new Date()).getTime() - new Date(verification.verifiedAt).getTime();
  if (!Number.isFinite(age) || age < 0 || age > input.policy.billingVerificationMaxAgeMs) {
    throw new ProviderPolicyError("Billing verification is stale or invalid");
  }
}

