import type { ZodType } from "zod";
import {
  MAX_MATH_STATEMENT_CHARACTERS,
  MAX_STRUCTURED_ARRAY_ITEMS,
  MAX_STRUCTURED_INPUT_DEPTH,
  MAX_STRUCTURED_INPUT_NODES
} from "./limits.js";

export type StructuredStatementValidationCode =
  | "STATEMENT_NOT_STRING"
  | "STATEMENT_TOO_LARGE"
  | "INVALID_JSON"
  | "RESOURCE_LIMIT"
  | "MALFORMED_INTERPRETATION";

export type StructuredStatementValidation<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly code: StructuredStatementValidationCode };

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

/**
 * Runtime-validates an untrusted structured math statement using exactly the
 * same generic resource budget and domain schema consumed by deterministic
 * verifiers. It performs no mathematical truth evaluation.
 */
export function validateStructuredStatement<T>(
  statement: unknown,
  schema: ZodType<T>
): StructuredStatementValidation<T> {
  if (typeof statement !== "string") return { ok: false, code: "STATEMENT_NOT_STRING" };
  if (statement.length > MAX_MATH_STATEMENT_CHARACTERS) {
    return { ok: false, code: "STATEMENT_TOO_LARGE" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(statement) as unknown;
  } catch {
    return { ok: false, code: "INVALID_JSON" };
  }

  if (!structuredInputWithinBounds(parsed)) return { ok: false, code: "RESOURCE_LIMIT" };

  let validated: ReturnType<typeof schema.safeParse>;
  try {
    validated = schema.safeParse(parsed);
  } catch {
    return { ok: false, code: "MALFORMED_INTERPRETATION" };
  }
  if (!validated.success) {
    return {
      ok: false,
      code: validated.error.issues.some((issue) => issue.code === "too_big")
        ? "RESOURCE_LIMIT"
        : "MALFORMED_INTERPRETATION"
    };
  }
  return { ok: true, data: validated.data };
}
