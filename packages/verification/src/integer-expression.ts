import { z } from "zod";
import {
  MAX_EXPRESSION_DEPTH,
  MAX_EXPRESSION_NODES,
  MAX_INTEGER_DECIMAL_DIGITS,
  MAX_INTERMEDIATE_INTEGER_DECIMAL_DIGITS,
  MAX_POWER_EXPONENT,
  MAX_VARIADIC_EXPRESSION_TERMS
} from "./limits.js";
import {
  BoundedMathError,
  assertIntermediateIntegerBound,
  isCanonicalIntegerString,
  parseBoundedInteger,
  productIntegers,
  sumIntegers
} from "./math-utils.js";

function boundedIntegerStringSchema(maximumDigits: number) {
  return z.string()
    .min(1)
    .max(maximumDigits + 1)
    .superRefine((value, context) => {
      // The preceding .max() records the resource issue. Avoid scanning an
      // arbitrarily longer direct-schema input again in the lexical check.
      if (value.length > maximumDigits + 1) return;

      if (!isCanonicalIntegerString(value)) {
        context.addIssue({
          code: "custom",
          message: "Integer must use canonical base-10 digits"
        });
        return;
      }

      const digits = value.startsWith("-") ? value.length - 1 : value.length;
      if (digits > maximumDigits) {
        context.addIssue({
          code: "too_big",
          origin: "string",
          maximum: maximumDigits,
          inclusive: true,
          message: `Integer exceeds the configured ${String(maximumDigits)}-digit limit`
        });
      }
    });
}

export const IntegerStringSchema = boundedIntegerStringSchema(MAX_INTEGER_DECIMAL_DIGITS);
export const IntermediateIntegerStringSchema = boundedIntegerStringSchema(MAX_INTERMEDIATE_INTEGER_DECIMAL_DIGITS);

export const PositiveIntegerStringSchema = IntegerStringSchema.refine(
  (value) => value !== "0" && !value.startsWith("-")
);
export const NonZeroIntegerStringSchema = IntegerStringSchema.refine(
  (value) => value !== "0"
);
export const NonZeroIntermediateIntegerStringSchema = IntermediateIntegerStringSchema.refine(
  (value) => value !== "0"
);

export type IntegerExpression =
  | { readonly kind: "INTEGER"; readonly value: string }
  | { readonly kind: "ADD" | "SUBTRACT" | "MULTIPLY"; readonly left: IntegerExpression; readonly right: IntegerExpression }
  | { readonly kind: "NEGATE"; readonly operand: IntegerExpression }
  | { readonly kind: "POWER"; readonly base: IntegerExpression; readonly exponent: number }
  | { readonly kind: "SUM" | "PRODUCT"; readonly terms: readonly IntegerExpression[] };

export const IntegerExpressionSchema: z.ZodType<IntegerExpression> = z.lazy(() => z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("INTEGER"), value: IntegerStringSchema }).strict(),
  z.object({ kind: z.literal("ADD"), left: IntegerExpressionSchema, right: IntegerExpressionSchema }).strict(),
  z.object({ kind: z.literal("SUBTRACT"), left: IntegerExpressionSchema, right: IntegerExpressionSchema }).strict(),
  z.object({ kind: z.literal("MULTIPLY"), left: IntegerExpressionSchema, right: IntegerExpressionSchema }).strict(),
  z.object({ kind: z.literal("NEGATE"), operand: IntegerExpressionSchema }).strict(),
  z.object({
    kind: z.literal("POWER"),
    base: IntegerExpressionSchema,
    exponent: z.number().int().min(0).max(MAX_POWER_EXPONENT)
  }).strict(),
  z.object({
    kind: z.literal("SUM"),
    terms: z.array(IntegerExpressionSchema).min(1).max(MAX_VARIADIC_EXPRESSION_TERMS)
  }).strict(),
  z.object({
    kind: z.literal("PRODUCT"),
    terms: z.array(IntegerExpressionSchema).min(1).max(MAX_VARIADIC_EXPRESSION_TERMS)
  }).strict()
]));

interface EvaluationBudget {
  remainingNodes: number;
}

function consumeNode(budget: EvaluationBudget, depth: number): void {
  if (depth > MAX_EXPRESSION_DEPTH || budget.remainingNodes <= 0) {
    throw new BoundedMathError("INTERMEDIATE_LIMIT_EXCEEDED", "Integer expression exceeds configured resource limits");
  }
  budget.remainingNodes -= 1;
}

function assertTermCount(terms: readonly IntegerExpression[]): void {
  if (terms.length < 1) {
    throw new BoundedMathError("INVALID_EXPRESSION", "Variadic integer expressions require at least one term");
  }
  if (terms.length > MAX_VARIADIC_EXPRESSION_TERMS) {
    throw new BoundedMathError(
      "INTERMEDIATE_LIMIT_EXCEEDED",
      "Variadic integer expression exceeds the configured term limit"
    );
  }
}

function integerPower(base: bigint, exponent: number): bigint {
  assertIntermediateIntegerBound(base);
  if (!Number.isInteger(exponent) || exponent < 0) {
    throw new BoundedMathError("INVALID_EXPRESSION", "Integer exponent must be a non-negative integer");
  }
  if (exponent > MAX_POWER_EXPONENT) {
    throw new BoundedMathError(
      "INTERMEDIATE_LIMIT_EXCEEDED",
      "Integer exponent exceeds the configured resource limit"
    );
  }
  if (base === 0n && exponent === 0) {
    throw new BoundedMathError("UNDEFINED_OPERATION", "Zero to the zero power is not verified by this arithmetic grammar");
  }

  let result = 1n;
  let factor = base;
  let remaining = exponent;
  while (remaining > 0) {
    if (remaining % 2 === 1) result = assertIntermediateIntegerBound(result * factor);
    remaining = Math.floor(remaining / 2);
    if (remaining > 0) factor = assertIntermediateIntegerBound(factor * factor);
  }
  return result;
}

function evaluateNode(expression: IntegerExpression, budget: EvaluationBudget, depth: number): bigint {
  consumeNode(budget, depth);
  switch (expression.kind) {
    case "INTEGER":
      return parseBoundedInteger(expression.value);
    case "ADD":
      return assertIntermediateIntegerBound(
        evaluateNode(expression.left, budget, depth + 1) + evaluateNode(expression.right, budget, depth + 1)
      );
    case "SUBTRACT":
      return assertIntermediateIntegerBound(
        evaluateNode(expression.left, budget, depth + 1) - evaluateNode(expression.right, budget, depth + 1)
      );
    case "MULTIPLY":
      return assertIntermediateIntegerBound(
        evaluateNode(expression.left, budget, depth + 1) * evaluateNode(expression.right, budget, depth + 1)
      );
    case "NEGATE":
      return -evaluateNode(expression.operand, budget, depth + 1);
    case "POWER":
      return integerPower(evaluateNode(expression.base, budget, depth + 1), expression.exponent);
    case "SUM": {
      assertTermCount(expression.terms);
      const values = expression.terms.map((term) => evaluateNode(term, budget, depth + 1));
      return sumIntegers(values);
    }
    case "PRODUCT": {
      assertTermCount(expression.terms);
      const values = expression.terms.map((term) => evaluateNode(term, budget, depth + 1));
      return productIntegers(values);
    }
    default:
      throw new BoundedMathError("INVALID_EXPRESSION", "Unsupported integer expression node");
  }
}

export function evaluateIntegerExpression(expression: IntegerExpression): bigint {
  return evaluateNode(expression, { remainingNodes: MAX_EXPRESSION_NODES }, 1);
}
