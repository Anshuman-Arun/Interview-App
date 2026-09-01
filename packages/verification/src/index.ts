import type { DeterministicVerifier, VerificationResult } from "../../domain/src/index.js";
import { normalizeInterpretationConfidence } from "./confidence.js";

export * from "./combinatorial-counting-verifier.js";
export * from "./integer-expression.js";
export * from "./rational-expression.js";
export * from "./structured-statement-validation.js";
export * from "./finite-recurrence-verifier.js";
export * from "./limits.js";
export * from "./math-utils.js";
export * from "./math-verifier-registry.js";
export * from "./modular-arithmetic-verifier.js";
export * from "./probability-arithmetic-verifier.js";
export * from "./rational-arithmetic-verifier.js";
export * from "./two-colour-graph-verifier.js";

export class AbstainingVerifier implements DeterministicVerifier {
  public async verify(_statement: string, interpretationConfidence: number): Promise<VerificationResult> {
    const normalized = normalizeInterpretationConfidence(interpretationConfidence);
    return {
      status: "UNRESOLVED",
      interpretationConfidence: normalized.value,
      verifier: "phase0-abstaining-verifier@1",
      reason: !normalized.valid
        ? "Interpretation confidence must be a finite value between 0 and 1"
        : normalized.value < 1
        ? "Formal interpretation confidence is insufficient"
        : "No deterministic verifier is registered for this proof claim"
    };
  }
}
