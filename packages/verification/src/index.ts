import type { DeterministicVerifier, VerificationResult } from "../../domain/src/index.js";

export class AbstainingVerifier implements DeterministicVerifier {
  public async verify(_statement: string, interpretationConfidence: number): Promise<VerificationResult> {
    return {
      status: "UNRESOLVED",
      interpretationConfidence,
      verifier: "phase0-abstaining-verifier@1",
      reason: interpretationConfidence < 1
        ? "Formal interpretation confidence is insufficient"
        : "No deterministic verifier is registered for this proof claim"
    };
  }
}

