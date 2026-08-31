import { z } from "zod";
import { MAX_EXPRESSION_DEPTH, MAX_EXPRESSION_NODES, MAX_VARIADIC_EXPRESSION_TERMS } from "./limits.js";
import { NonZeroIntegerStringSchema, IntegerStringSchema } from "./integer-expression.js";
import {
  BoundedMathError,
  addRationals,
  divideRationals,
  multiplyRationals,
  negateRational,
  parseRationalInput,
  productRationals,
  subtractRationals,
  sumRationals,
  type ExactRational,
  type RationalInput
} from "./math-utils.js";

export const RationalInputSchema = z.object({
  numerator: IntegerStringSchema,
  denominator: NonZeroIntegerStringSchema
}).strict();

export type RationalExpression =
  | { readonly kind: "RATIONAL"; readonly value: RationalInput }
  | { readonly kind: "ADD" | "SUBTRACT" | "MULTIPLY" | "DIVIDE"; readonly left: RationalExpression; readonly right: RationalExpression }
  | { readonly kind: "NEGATE"; readonly operand: RationalExpression }
  | { readonly kind: "SUM" | "PRODUCT"; readonly terms: readonly RationalExpression[] };

export const RationalExpressionSchema: z.ZodType<RationalExpression> = z.lazy(() => z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("RATIONAL"), value: RationalInputSchema }).strict(),
  z.object({ kind: z.literal("ADD"), left: RationalExpressionSchema, right: RationalExpressionSchema }).strict(),
  z.object({ kind: z.literal("SUBTRACT"), left: RationalExpressionSchema, right: RationalExpressionSchema }).strict(),
  z.object({ kind: z.literal("MULTIPLY"), left: RationalExpressionSchema, right: RationalExpressionSchema }).strict(),
  z.object({ kind: z.literal("DIVIDE"), left: RationalExpressionSchema, right: RationalExpressionSchema }).strict(),
  z.object({ kind: z.literal("NEGATE"), operand: RationalExpressionSchema }).strict(),
  z.object({ kind: z.literal("SUM"), terms: z.array(RationalExpressionSchema).min(1).max(MAX_VARIADIC_EXPRESSION_TERMS) }).strict(),
  z.object({ kind: z.literal("PRODUCT"), terms: z.array(RationalExpressionSchema).min(1).max(MAX_VARIADIC_EXPRESSION_TERMS) }).strict()
]));

interface EvaluationBudget { remainingNodes: number; }

function evaluateNode(expression: RationalExpression, budget: EvaluationBudget, depth: number): ExactRational {
  if (depth > MAX_EXPRESSION_DEPTH || budget.remainingNodes <= 0) {
    throw new BoundedMathError("INTERMEDIATE_LIMIT_EXCEEDED", "Rational expression exceeds configured resource limits");
  }
  budget.remainingNodes -= 1;
  switch (expression.kind) {
    case "RATIONAL": return parseRationalInput(expression.value);
    case "ADD": return addRationals(evaluateNode(expression.left, budget, depth + 1), evaluateNode(expression.right, budget, depth + 1));
    case "SUBTRACT": return subtractRationals(evaluateNode(expression.left, budget, depth + 1), evaluateNode(expression.right, budget, depth + 1));
    case "MULTIPLY": return multiplyRationals(evaluateNode(expression.left, budget, depth + 1), evaluateNode(expression.right, budget, depth + 1));
    case "DIVIDE": return divideRationals(evaluateNode(expression.left, budget, depth + 1), evaluateNode(expression.right, budget, depth + 1));
    case "NEGATE": return negateRational(evaluateNode(expression.operand, budget, depth + 1));
    case "SUM": return sumRationals(expression.terms.map((term) => evaluateNode(term, budget, depth + 1)));
    case "PRODUCT": return productRationals(expression.terms.map((term) => evaluateNode(term, budget, depth + 1)));
  }
}

export function evaluateRationalExpression(expression: RationalExpression): ExactRational {
  return evaluateNode(expression, { remainingNodes: MAX_EXPRESSION_NODES }, 1);
}
