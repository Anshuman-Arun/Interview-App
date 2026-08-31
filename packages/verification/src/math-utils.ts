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
  | "INVALID_COMBINATORIAL_ARGUMENT"
  | "COMBINATORIAL_LIMIT_EXCEEDED"
  | "INVALID_PROBABILITY"
  | "INVALID_EXPRESSION"
  | "UNDEFINED_OPERATION"
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

function parseCanonicalInteger(
  value: string,
  maximumDigits: number,
  limitCode: "INTEGER_LIMIT_EXCEEDED" | "INTERMEDIATE_LIMIT_EXCEEDED"
): bigint {
  if (typeof value !== "string") {
    throw new BoundedMathError("INVALID_INTEGER", "Integer must be supplied as a string");
  }
  const digits = value.startsWith("-") ? value.length - 1 : value.length;
  if (digits > maximumDigits) {
    throw new BoundedMathError(limitCode, "Integer exceeds the configured decimal digit limit");
  }
  if (!/^(?:0|-?[1-9]\d*)$/u.test(value)) {
    throw new BoundedMathError("INVALID_INTEGER", "Integer must use canonical base-10 digits");
  }
  return BigInt(value);
}

export function parseBoundedInteger(value: unknown): bigint {
  return parseCanonicalInteger(value, MAX_INTEGER_DECIMAL_DIGITS, "INTEGER_LIMIT_EXCEEDED");
}

export function parseBoundedIntermediateInteger(value: unknown): bigint {
  return parseCanonicalInteger(
    value,
    MAX_INTERMEDIATE_INTEGER_DECIMAL_DIGITS,
    "INTERMEDIATE_LIMIT_EXCEEDED"
  );
}

export function formatInteger(value: bigint): string {
  return assertIntermediateIntegerBound(value).toString();
}

export function assertIntermediateIntegerBound(value: unknown): bigint {
  if (typeof value !== "bigint") {
    throw new BoundedMathError("INVALID_INTEGER", "Exact integer values must use bigint");
  }
  if (decimalDigitCount(value) > MAX_INTERMEDIATE_INTEGER_DECIMAL_DIGITS) {
    throw new BoundedMathError(
      "INTERMEDIATE_LIMIT_EXCEEDED",
      "Exact arithmetic intermediate exceeds the configured decimal digit limit"
    );
  }
  return value;
}

function gcdUnchecked(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a;
}

export function gcd(left: bigint, right: bigint): bigint {
  return gcdUnchecked(
    assertIntermediateIntegerBound(left),
    assertIntermediateIntegerBound(right)
  );
}

export function lcm(left: bigint, right: bigint): bigint {
  assertIntermediateIntegerBound(left);
  assertIntermediateIntegerBound(right);
  if (left === 0n || right === 0n) return 0n;
  const value = assertIntermediateIntegerBound((left / gcd(left, right)) * right);
  return value < 0n ? -value : value;
}

export function normalizeModulo(value: bigint, modulus: bigint): bigint {
  assertIntermediateIntegerBound(value);
  assertIntermediateIntegerBound(modulus);
  if (modulus <= 0n) {
    throw new BoundedMathError("INVALID_MODULUS", "Modulus must be a positive integer");
  }
  const remainder = value % modulus;
  return remainder < 0n ? remainder + modulus : remainder;
}

export function areCongruent(left: bigint, right: bigint, modulus: bigint): boolean {
  assertIntermediateIntegerBound(left);
  assertIntermediateIntegerBound(right);
  return normalizeModulo(left, modulus) === normalizeModulo(right, modulus);
}

export function isDivisibleBy(dividend: bigint, divisor: bigint): boolean {
  assertIntermediateIntegerBound(dividend);
  assertIntermediateIntegerBound(divisor);
  if (divisor === 0n) return dividend === 0n;
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
  assertIntermediateIntegerBound(numerator);
  assertIntermediateIntegerBound(denominator);
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

export function normalizeRational(value: ExactRational): ExactRational {
  return rational(value.numerator, value.denominator);
}

export function parseRationalInput(value: RationalInput): ExactRational {
  return rational(parseBoundedInteger(value.numerator), parseBoundedInteger(value.denominator));
}

export function parseIntermediateRationalInput(value: RationalInput): ExactRational {
  return rational(
    parseBoundedIntermediateInteger(value.numerator),
    parseBoundedIntermediateInteger(value.denominator)
  );
}

export function serializeRational(value: ExactRational): RationalInput {
  const normalized = normalizeRational(value);
  return {
    numerator: normalized.numerator.toString(),
    denominator: normalized.denominator.toString()
  };
}

export function addRationals(left: ExactRational, right: ExactRational): ExactRational {
  const normalizedLeft = normalizeRational(left);
  const normalizedRight = normalizeRational(right);
  const commonFactor = gcd(normalizedLeft.denominator, normalizedRight.denominator);
  const leftScale = normalizedRight.denominator / commonFactor;
  const rightScale = normalizedLeft.denominator / commonFactor;
  const leftTerm = assertIntermediateIntegerBound(normalizedLeft.numerator * leftScale);
  const rightTerm = assertIntermediateIntegerBound(normalizedRight.numerator * rightScale);

  // After reducing denominator cross-factors, any remaining common factor
  // between the numerator sum and denominator must divide commonFactor.
  // Cancel it before enforcing the final intermediate bound so an avoidable
  // one-digit carry cannot cause an otherwise bounded exact result to abstain.
  const numerator = leftTerm + rightTerm;
  const cancellation = gcdUnchecked(numerator, commonFactor);
  return rational(
    assertIntermediateIntegerBound(numerator / cancellation),
    assertIntermediateIntegerBound(
      (normalizedLeft.denominator / cancellation) * leftScale
    )
  );
}

export function subtractRationals(left: ExactRational, right: ExactRational): ExactRational {
  return addRationals(left, negateRational(right));
}

export function multiplyRationals(left: ExactRational, right: ExactRational): ExactRational {
  const normalizedLeft = normalizeRational(left);
  const normalizedRight = normalizeRational(right);
  const leftCancellation = gcd(normalizedLeft.numerator, normalizedRight.denominator);
  const rightCancellation = gcd(normalizedRight.numerator, normalizedLeft.denominator);
  return rational(
    assertIntermediateIntegerBound(
      (normalizedLeft.numerator / leftCancellation) * (normalizedRight.numerator / rightCancellation)
    ),
    assertIntermediateIntegerBound(
      (normalizedLeft.denominator / rightCancellation) * (normalizedRight.denominator / leftCancellation)
    )
  );
}

export function divideRationals(left: ExactRational, right: ExactRational): ExactRational {
  const normalizedRight = normalizeRational(right);
  if (normalizedRight.numerator === 0n) {
    throw new BoundedMathError("DIVISION_BY_ZERO", "Cannot divide by zero");
  }
  return multiplyRationals(normalizeRational(left), rational(normalizedRight.denominator, normalizedRight.numerator));
}

export function negateRational(value: ExactRational): ExactRational {
  const normalized = normalizeRational(value);
  return { numerator: -normalized.numerator, denominator: normalized.denominator };
}

export function equalRationals(left: ExactRational, right: ExactRational): boolean {
  const normalizedLeft = normalizeRational(left);
  const normalizedRight = normalizeRational(right);
  return normalizedLeft.numerator === normalizedRight.numerator
    && normalizedLeft.denominator === normalizedRight.denominator;
}

function comparePositiveFractions(
  leftNumerator: bigint,
  leftDenominator: bigint,
  rightNumerator: bigint,
  rightDenominator: bigint
): -1 | 0 | 1 {
  let leftN = leftNumerator;
  let leftD = leftDenominator;
  let rightN = rightNumerator;
  let rightD = rightDenominator;
  let inverted = false;

  while (true) {
    const leftQuotient = leftN / leftD;
    const rightQuotient = rightN / rightD;
    if (leftQuotient !== rightQuotient) {
      const comparison = leftQuotient < rightQuotient ? -1 : 1;
      return inverted ? (comparison === -1 ? 1 : -1) : comparison;
    }

    const leftRemainder = leftN % leftD;
    const rightRemainder = rightN % rightD;
    if (leftRemainder === 0n || rightRemainder === 0n) {
      const comparison = leftRemainder === rightRemainder
        ? 0
        : leftRemainder === 0n
          ? -1
          : 1;
      return inverted && comparison !== 0 ? (comparison === -1 ? 1 : -1) : comparison;
    }

    leftN = leftD;
    leftD = leftRemainder;
    rightN = rightD;
    rightD = rightRemainder;
    inverted = !inverted;
  }
}

export function compareRationals(left: ExactRational, right: ExactRational): -1 | 0 | 1 {
  const normalizedLeft = normalizeRational(left);
  const normalizedRight = normalizeRational(right);

  if (normalizedLeft.numerator < 0n && normalizedRight.numerator >= 0n) return -1;
  if (normalizedLeft.numerator >= 0n && normalizedRight.numerator < 0n) return 1;

  if (normalizedLeft.numerator < 0n && normalizedRight.numerator < 0n) {
    const absoluteComparison = comparePositiveFractions(
      -normalizedLeft.numerator,
      normalizedLeft.denominator,
      -normalizedRight.numerator,
      normalizedRight.denominator
    );
    return absoluteComparison === 0 ? 0 : absoluteComparison === -1 ? 1 : -1;
  }

  return comparePositiveFractions(
    normalizedLeft.numerator,
    normalizedLeft.denominator,
    normalizedRight.numerator,
    normalizedRight.denominator
  );
}

function assertFiniteContainerLength(length: number): void {
  if (length > MAX_FINITE_CONTAINER_ITEMS) {
    throw new BoundedMathError("CONTAINER_LIMIT_EXCEEDED", "Finite container exceeds the configured item limit");
  }
}

export function sumIntegers(values: readonly bigint[]): bigint {
  assertFiniteContainerLength(values.length);
  let total = 0n;
  for (const value of values) {
    assertIntermediateIntegerBound(value);
    total = assertIntermediateIntegerBound(total + value);
  }
  return total;
}

export function productIntegers(values: readonly bigint[]): bigint {
  assertFiniteContainerLength(values.length);
  let product = 1n;
  for (const value of values) {
    assertIntermediateIntegerBound(value);
    product = assertIntermediateIntegerBound(product * value);
  }
  return product;
}

export function sumRationals(values: readonly ExactRational[]): ExactRational {
  assertFiniteContainerLength(values.length);
  return values.reduce(addRationals, rational(0n, 1n));
}

export function productRationals(values: readonly ExactRational[]): ExactRational {
  assertFiniteContainerLength(values.length);
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
      "COMBINATORIAL_LIMIT_EXCEEDED",
      "Combinations-with-repetition expansion exceeds the configured n limit"
    );
  }
  return binomial(effectiveN, selections);
}

function assertContainerBound(values: readonly string[]): void {
  assertFiniteContainerLength(values.length);
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
