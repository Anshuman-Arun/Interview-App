export type VerificationStatus = "VERIFIED" | "CONTRADICTED" | "UNRESOLVED";
export interface VerificationResult {
  readonly status: VerificationStatus;
  readonly interpretationConfidence: number;
  readonly verifier: string;
  readonly reason: string;
}
export interface DeterministicVerifier {
  readonly verify: (statement: string, interpretationConfidence: number) => Promise<VerificationResult>;
}

