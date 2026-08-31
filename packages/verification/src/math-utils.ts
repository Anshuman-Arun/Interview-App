import {
  MAX_COMBINATORIAL_N,
  MAX_FINITE_CONTAINER_ITEMS,
  MAX_INTEGER_DECIMAL_DIGITS,
  MAX_INTERMEDIATE_INTEGER_DECIMAL_DIGITS
} from "./limits.js";

export type BoundedMathErrorCode =
  | "INVALID_INTEGER"
  | "INTEGER_LIMIT_EXCEEDED"
  | "INTERMEDIATE_LIMIT_EXCEEDED"
  | "DIVISION_BY_ZERO"
  | "INVALID_MODULUS"
  | "INVALID_DIVISOR"
  | "INVALID_COMBINATORIAL_ARGUMENT"
  | "CONTAINER_LIMIT_EXCEEDED";

export class BoundedMathError extends Error {
  public constructor(
    public readonly code: BoundedMathErrorCode,
    message: string
  ) {
    super(message);
    this.name = "BoundedMathError";
  }
}

function decimalDigitCount(value: bigint): number {
  const text = value < 0n ? (-value).toString() : value.toString();
  return text.length;
}

export function parseBoundedInteger(value: string): bigint {
  if (!/^-?(?:0|[1-9]\d*)$/u.test(value)) {
    throw new BoundedMathError("INVALID_INTEGER", "Integer must use canonical base-10 digits");
  }
  const digits = value.startsWith("-") ? value.length - 1 : value.length;
  if (digits > MAX_INTEGER_DECIMAL_DIGITS) {
    throw new BoundedMathError("INTEGER_LIMIT_EXCEEDED", "Integer exceeds the configured decimal digit limit");
  }
  return BigInt(value);
}

export function formatInteger(value: bigint): string {
  return value.toString();
}

export function assertIntermediateIntegerBound(value: bigint): bigint {
  if (decimalDigitCount(value) > MAX_INTERMEDIATE_INTEGER_DECIMAL_DIGITS) {
    throw new BoundedMathError(
      "INTERMEDIATE_LIMIT_EXCEEDED",
      "Exact arithmetic intermediate exceeds the configured decimal digit limit"
    );
  }
  return value;
}

export function gcd(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a;
}

export function lcm(left: bigint, right: bigint): bigint {
  if (left === 0n || right === 0n) return 0n;
  const value = assertIntermediateIntegerBound((left / gcd(left, right)) * right);
  return value < 0n ? -value : value;
}

export function normalizeModulo(value: bigint, modulus: bigint): bigint {
  if (modulus <= 0n) {
    throw new BoundedMathError("INVALID_MODULUS", "Modulus must be a positive integer");
  }
  const remainder = value % modulus;
  return remainder < 0n ? remainder + modulus : remainder;
}

export function areCongruent(left: bigint, right: bigint, modulus: bigint): boolean {
  return normalizeModulo(left - right, modulus) === 0n;
}

export function isDivisibleBy(dividend: bigint, divisor: bigint): boolean {
  if (divisor === 0n) {
    throw new BoundedMathError("INVALID_DIVISOR", "Divisor must be nonzero");
  }
  return dividend % divisor === 0n;
}

export interface ExactRational {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

export interface RationalInput {
  readonly numerator: string;
  readonly denominator: string;
}

function boundRational(value: ExactRational): ExactRational {
  assertIntermediateIntegerBound(value.numerator);
  assertIntermediateIntegerBound(value.denominator);
  return value;
}

export function rational(numerator: bigint, denominator: bigint): ExactRational {
  if (denominator === 0n) {
    throw new BoundedMathError("DIVISION_BY_ZERO", "Rational denominator must be nonzero");
  }
  if (numerator === 0n) return { numerator: 0n, denominator: 1n };
  const sign = denominator < 0n ? -1n : 1n;
  const normalizedNumerator = numerator * sign;
  const normalizedDenominator = denominator * sign;
  const factor = gcd(normalizedNumerator, normalizedDenominator);
  return boundRational({
    numerator: normalizedNumerator / factor,
    denominator: normalizedDenominator / factor
  });
}

export function parseRationalInput(value: RationalInput): ExactRational {
  return rational(parseBoundedInteger(value.numerator), parseBoundedInteger(value.denominator));
}

export function serializeRational(value: ExactRational): RationalInput {
  return {
    numerator: value.numerator.toString(),
    denominator: value.denominator.toString()
  };
}

export function addRationals(left: ExactRational, right: ExactRational): ExactRational {
  return rational(
    assertIntermediateIntegerBound(left.numerator * right.denominator + right.numerator * left.denominator),
    assertIntermediateIntegerBound(left.denominator * right.denominator)
  );
}

export function subtractRationals(left: ExactRational, right: ExactRational): ExactRational {
  return addRationals(left, negateRational(right));
}

export function multiplyRationals(left: ExactRational, right: ExactRational): ExactRational {
  return rational(
    assertIntermediateIntegerBound(left.numerator * right.numerator),
    assertIntermediateIntegerBound(left.denominator * right.denominator)
  );
}

export function divideRationals(left: ExactRational, right: ExactRational): ExactRational {
  if (right.numerator === 0n) {
    throw new BoundedMathError("DIVISION_BY_ZERO", "Cannot divide by zero");
  }
  return rational(
    assertIntermediateIntegerBound(left.numerator * right.denominator),
    assertIntermediateIntegerBound(left.denominator * right.numerator)
  );
}

export function negateRational(value: ExactRational): ExactRational {
  return { numerator: -value.numerator, denominator: value.denominator };
}

export function equalRationals(left: ExactRational, right: ExactRational): boolean {
  return left.numerator === right.numerator && left.denominator === right.denominator;
}

export function compareRationals(left: ExactRational, right: ExactRational): -1 | 0 | 1 {
  const leftScaled = assertIntermediateIntegerBound(left.numerator * right.denominator);
  const rightScaled = assertIntermediateIntegerBound(right.numerator * left.denominator);
  const difference = assertIntermediateIntegerBound(leftScaled - rightScaled);
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

export function sumIntegers(values: readonly bigint[]): bigint {
  let total = 0n;
  for (const value of values) total = assertIntermediateIntegerBound(total + value);
  return total;
}

export function productIntegers(values: readonly bigint[]): bigint {
  let product = 1n;
  for (const value of values) product = assertIntermediateIntegerBound(product * value);
  return product;
}

export function sumRationals(values: readonly ExactRational[]): ExactRational {
  return values.reduce(addRationals, rational(0n, 1n));
}

export function productRationals(values: readonly ExactRational[]): ExactRational {
  return values.reduce(multiplyRationals, rational(1n, 1n));
}

function assertCombinatorialInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > MAX_COMBINATORIAL_N) {
    throw new BoundedMathError(
      "INVALID_COMBINATORIAL_ARGUMENT",
      `${label} must be an integer between 0 and ${String(MAX_COMBINATORIAL_N)}`
    );
  }
}

export function factorial(n: number): bigint {
  assertCombinatorialInteger(n, "n");
  let result = 1n;
  for (let value = 2; value <= n; value += 1) {
    result = assertIntermediateIntegerBound(result * BigInt(value));
  }
  return result;
}

export function permutations(n: number, k: number): bigint {
  assertCombinatorialInteger(n, "n");
  assertCombinatorialInteger(k, "k");
  if (k > n) return 0n;
  let result = 1n;
  for (let offset = 0; offset < k; offset += 1) {
    result = assertIntermediateIntegerBound(result * BigInt(n - offset));
  }
  return result;
}

export function binomial(n: number, k: number): bigint {
  assertCombinatorialInteger(n, "n");
  assertCombinatorialInteger(k, "k");
  if (k > n) return 0n;
  const reducedK = Math.min(k, n - k);
  let result = 1n;
  for (let index = 1; index <= reducedK; index += 1) {
    result = assertIntermediateIntegerBound(
      (result * BigInt(n - reducedK + index)) / BigInt(index)
    );
  }
  return result;
}

export function combinationsWithRepetition(types: number, selections: number): bigint {
  assertCombinatorialInteger(types, "types");
  assertCombinatorialInteger(selections, "selections");
  if (selections === 0) return 1n;
  if (types === 0) return 0n;
  const effectiveN = types + selections - 1;
  if (effectiveN > MAX_COMBINATORIAL_N) {
    throw new BoundedMathError(
      "INVALID_COMBINATORIAL_ARGUMENT",
      "Combinations-with-repetition expansion exceeds the configured n limit"
    );
  }
  return binomial(effectiveN, selections);
}

function assertContainerBound(values: readonly string[]): void {
  if (values.length > MAX_FINITE_CONTAINER_ITEMS) {
    throw new BoundedMathError("CONTAINER_LIMIT_EXCEEDED", "Finite container exceeds the configured item limit");
  }
}

export function sameFiniteSet(left: readonly string[], right: readonly string[]): boolean {
  assertContainerBound(left);
  assertContainerBound(right);
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return leftSet.size === rightSet.size && [...leftSet].every((value) => rightSet.has(value));
}

export function sameFiniteMultiset(left: readonly string[], right: readonly string[]): boolean {
  assertContainerBound(left);
  assertContainerBound(right);
  if (left.length !== right.length) return false;
  const counts = new Map<string, number>();
  for (const value of left) counts.set(value, (counts.get(value) ?? 0) + 1);
  for (const value of right) {
    const count = counts.get(value);
    if (count === undefined) return false;
    if (count === 1) counts.delete(value);
    else counts.set(value, count - 1);
  }
  return counts.size === 0;
}

export const isPermutationOf = sameFiniteMultiset;
