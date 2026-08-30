export interface NormalizedInterpretationConfidence {
  readonly value: number;
  readonly valid: boolean;
}

/**
 * Verifier results must remain valid at the runtime boundary even when a caller
 * supplies a non-finite or out-of-range confidence value.
 */
export function normalizeInterpretationConfidence(
  interpretationConfidence: number
): NormalizedInterpretationConfidence {
  if (
    Number.isFinite(interpretationConfidence)
    && interpretationConfidence >= 0
    && interpretationConfidence <= 1
  ) {
    return { value: interpretationConfidence, valid: true };
  }

  return { value: 0, valid: false };
}
