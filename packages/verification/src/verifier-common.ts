import type { ZodType } from "zod";
import type { VerificationResult } from "../../domain/src/index.js";
import { normalizeInterpretationConfidence } from "./confidence.js";
import { BoundedMathError } from "./math-utils.js";
import {
  MAX_MATH_STATEMENT_CHARACTERS,
  MAX_STRUCTURED_ARRAY_ITEMS,
  MAX_STRUCTURED_INPUT_DEPTH,
  MAX_STRUCTURED_INPUT_NODES
} from "./limits.js";

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

interface JsonBudgetItem {
  readonly value: unknown;
  readonly depth: number;
}

function structuredInputWithinBounds(value: unknown): boolean {
  const pending: JsonBudgetItem[] = [{ value, depth: 1 }];
  let visitedNodes = 0;
  while (pending.length > 0) {
    const item = pending.pop();
    if (item === undefined) break;
    visitedNodes += 1;
    if (item.depth > MAX_STRUCTURED_INPUT_DEPTH || visitedNodes > MAX_STRUCTURED_INPUT_NODES) return false;
    if (Array.isArray(item.value)) {
      if (item.value.length > MAX_STRUCTURED_ARRAY_ITEMS) return false;
      for (const child of item.value) pending.push({ value: child, depth: item.depth + 1 });
      continue;
    }
    if (item.value !== null && typeof item.value === "object") {
      for (const child of Object.values(item.value as Record<string, unknown>)) {
        pending.push({ value: child, depth: item.depth + 1 });
      }
    }
  }
  return true;
}

export type PreparedStatement<T> =
  | { readonly ok: true; readonly data: T; readonly interpretationConfidence: number }
  | { readonly ok: false; readonly result: VerificationResult };

export function prepareStructuredStatement<T>(
  statement: string,
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
  if (statement.length > MAX_MATH_STATEMENT_CHARACTERS) {
    return {
      ok: false,
      result: result(
        "UNRESOLVED",
        normalized.value,
        verifier,
        "STATEMENT_TOO_LARGE",
        "Formal interpretation exceeds the deterministic math statement limit"
      )
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(statement) as unknown;
  } catch {
    return {
      ok: false,
      result: result(
        "UNRESOLVED",
        normalized.value,
        verifier,
        "INVALID_JSON",
        "Formal interpretation is not valid JSON"
      )
    };
  }

  if (!structuredInputWithinBounds(parsed)) {
    return {
      ok: false,
      result: result(
        "UNRESOLVED",
        normalized.value,
        verifier,
        "RESOURCE_LIMIT",
        "Formal interpretation exceeds the structured input depth, node, or container limits"
      )
    };
  }

  let validated: ReturnType<typeof schema.safeParse>;
  try {
    validated = schema.safeParse(parsed);
  } catch {
    return {
      ok: false,
      result: result(
        "UNRESOLVED",
        normalized.value,
        verifier,
        "MALFORMED_INTERPRETATION",
        "Formal interpretation could not be validated safely"
      )
    };
  }
  if (!validated.success) {
    return {
      ok: false,
      result: result(
        "UNRESOLVED",
        normalized.value,
        verifier,
        "MALFORMED_INTERPRETATION",
        "Formal interpretation is malformed, unsupported, or incomplete"
      )
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
      || error.code === "CONTAINER_LIMIT_EXCEEDED";
    return result(
      "UNRESOLVED",
      interpretationConfidence,
      verifier,
      resource ? "RESOURCE_LIMIT" : "ARITHMETIC_UNDEFINED",
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
