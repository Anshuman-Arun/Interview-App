import { z } from "zod";
import type { DataUsePolicy } from "./provider.js";

export const BillingClassSchema = z.enum(["VERIFIED_FREE_ONLY", "ACCOUNT_QUOTA", "METERED", "UNKNOWN"]);
export const BillingVerificationSchema = z.object({
  billingClass: BillingClassSchema,
  enforcementMechanism: z.string().min(1),
  verifiedAt: z.iso.datetime(),
  adapterVersion: z.string().min(1),
  spendImpossible: z.boolean()
}).strict();
export type BillingVerification = z.infer<typeof BillingVerificationSchema>;

export interface ProviderPolicy {
  readonly allowMeteredUsage: boolean;
  readonly maximumDataUse: DataUsePolicy;
  readonly billingVerificationMaxAgeMs: number;
}
