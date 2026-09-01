import type { ZodType } from "zod";
import type { VerificationResult } from "../../domain/src/index.js";
import { normalizeInterpretationConfidence } from "./confidence.js";
import { BoundedMathError } from "./math-utils.js";
import {
  validateStructuredStatement,
  type StructuredStatementValidationCode
} from "./structured-statement-validation.js";

export type VerificationReasonCode =
  | "INVALID_INTERPRETATION_CONFIDENCE"
  | "INSUFFICIENT_INTERPRETATION_CONFIDENCE"
  | "STATEMENT_TOO_LARGE"
  | "INVALID_JSON"
  | "MALFORMED_INTERPRETATION"
  | "ARITHMETIC_UNDEFINED"
  | "RESOURCE_LIMIT"
  | "CLAIM_VERIFIED"
  | "CLAIM_CONTRADICTED";

export function result(
  status: VerificationResult["status"],
  interpretationConfidence: number,
  verifier: string,
  code: VerificationReasonCode,
  detail: string
): VerificationResult {
  return {
    status,
    interpretationConfidence,
    verifier,
    reason: `${code}: ${detail}`
  };
}

export type PreparedStatement<T> =
  | { readonly ok: true; readonly data: T; readonly interpretationConfidence: number }
  | { readonly ok: false; readonly result: VerificationResult };

function statementValidationFailure(
  code: StructuredStatementValidationCode,
  interpretationConfidence: number,
  verifier: string
): VerificationResult {
  switch (code) {
    case "STATEMENT_TOO_LARGE":
      return result(
        "UNRESOLVED",
        interpretationConfidence,
        verifier,
        "STATEMENT_TOO_LARGE",
        "Formal interpretation exceeds the deterministic math statement limit"
      );
    case "INVALID_JSON":
      return result(
        "UNRESOLVED",
        interpretationConfidence,
        verifier,
        "INVALID_JSON",
        "Formal interpretation is not valid JSON"
      );
    case "RESOURCE_LIMIT":
      return result(
        "UNRESOLVED",
        interpretationConfidence,
        verifier,
        "RESOURCE_LIMIT",
        "Formal interpretation exceeds a structured input or schema resource limit"
      );
    case "STATEMENT_NOT_STRING":
      return result(
        "UNRESOLVED",
        interpretationConfidence,
        verifier,
        "MALFORMED_INTERPRETATION",
        "Formal interpretation must be supplied as a string"
      );
    case "MALFORMED_INTERPRETATION":
      return result(
        "UNRESOLVED",
        interpretationConfidence,
        verifier,
        "MALFORMED_INTERPRETATION",
        "Formal interpretation is malformed, unsupported, or incomplete"
      );
  }
}

export function prepareStructuredStatement<T>(
  statement: unknown,
  interpretationConfidence: number,
  verifier: string,
  schema: ZodType<T>
): PreparedStatement<T> {
  const normalized = normalizeInterpretationConfidence(interpretationConfidence);
  if (!normalized.valid) {
    return {
      ok: false,
      result: result(
        "UNRESOLVED",
        normalized.value,
        verifier,
        "INVALID_INTERPRETATION_CONFIDENCE",
        "Interpretation confidence must be a finite value between 0 and 1"
      )
    };
  }
  if (normalized.value < 1) {
    return {
      ok: false,
      result: result(
        "UNRESOLVED",
        normalized.value,
        verifier,
        "INSUFFICIENT_INTERPRETATION_CONFIDENCE",
        "Formal interpretation confidence is insufficient for deterministic verification"
      )
    };
  }

  const validated = validateStructuredStatement(statement, schema);
  if (!validated.ok) {
    return {
      ok: false,
      result: statementValidationFailure(validated.code, normalized.value, verifier)
    };
  }
  return { ok: true, data: validated.data, interpretationConfidence: normalized.value };
}

export function mathFailure(
  error: unknown,
  interpretationConfidence: number,
  verifier: string
): VerificationResult {
  if (error instanceof BoundedMathError) {
    const resource = error.code === "INTEGER_LIMIT_EXCEEDED"
      || error.code === "INTERMEDIATE_LIMIT_EXCEEDED"
      || error.code === "COMBINATORIAL_LIMIT_EXCEEDED"
      || error.code === "CONTAINER_LIMIT_EXCEEDED";
    const malformed = error.code === "INVALID_INTEGER"
      || error.code === "INVALID_MODULUS"
      || error.code === "INVALID_COMBINATORIAL_ARGUMENT"
      || error.code === "INVALID_PROBABILITY"
      || error.code === "INVALID_EXPRESSION";
    return result(
      "UNRESOLVED",
      interpretationConfidence,
      verifier,
      resource ? "RESOURCE_LIMIT" : malformed ? "MALFORMED_INTERPRETATION" : "ARITHMETIC_UNDEFINED",
      error.message
    );
  }
  return result(
    "UNRESOLVED",
    interpretationConfidence,
    verifier,
    "ARITHMETIC_UNDEFINED",
    "Exact arithmetic could not evaluate the supplied structured claim"
  );
}

export function booleanClaimResult(
  verified: boolean,
  interpretationConfidence: number,
  verifier: string,
  verifiedDetail: string,
  contradictedDetail: string
): VerificationResult {
  return verified
    ? result("VERIFIED", interpretationConfidence, verifier, "CLAIM_VERIFIED", verifiedDetail)
    : result("CONTRADICTED", interpretationConfidence, verifier, "CLAIM_CONTRADICTED", contradictedDetail);
}
