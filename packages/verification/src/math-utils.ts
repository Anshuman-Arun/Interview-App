import {
  MAX_COMBINATORIAL_N,
  MAX_FINITE_CONTAINER_ITEMS,
  MAX_INTEGER_DECIMAL_DIGITS,
  MAX_INTERMEDIATE_INTEGER_DECIMAL_DIGITS,
  MAX_MATH_STATEMENT_CHARACTERS,
  MAX_VARIADIC_EXPRESSION_TERMS
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

const CANONICAL_INTEGER_PATTERN = /^(?:0|-?[1-9]\d*)$/u;

export function isCanonicalIntegerString(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_INTEGER_PATTERN.test(value);
}

function parseCanonicalInteger(
  value: unknown,
  maximumDigits: number,
  limitCode: "INTEGER_LIMIT_EXCEEDED" | "INTERMEDIATE_LIMIT_EXCEEDED"
): bigint {
  if (typeof value !== "string") {
    throw new BoundedMathError("INVALID_INTEGER", "Integer must be supplied as a string");
  }
  if (value.length > maximumDigits + 1) {
    throw new BoundedMathError(limitCode, "Integer exceeds the configured decimal digit limit");
  }
  if (!isCanonicalIntegerString(value)) {
    throw new BoundedMathError("INVALID_INTEGER", "Integer must use canonical base-10 digits");
  }
  const digits = value.startsWith("-") ? value.length - 1 : value.length;
  if (digits > maximumDigits) {
    throw new BoundedMathError(limitCode, "Integer exceeds the configured decimal digit limit");
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
  // Cross-scaled terms are bounded implementation temporaries: each is the
  // product of two already-bounded exact integers. Do not apply the semantic
  // intermediate bound until after their cancellation, or a bounded reduced
  // sum can spuriously fail only because the common-denominator expansion is
  // larger than the exact result.
  const leftTerm = normalizedLeft.numerator * leftScale;
  const rightTerm = normalizedRight.numerator * rightScale;

  // After reducing denominator cross-factors, any remaining common factor
  // between the numerator sum and denominator must divide commonFactor.
  // Cancel it before enforcing the final intermediate bound.
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

function rationalForComparison(value: ExactRational): ExactRational {
  const numerator = assertIntermediateIntegerBound(value.numerator);
  const denominator = assertIntermediateIntegerBound(value.denominator);
  if (denominator === 0n) {
    throw new BoundedMathError("DIVISION_BY_ZERO", "Rational denominator must be nonzero");
  }
  return denominator < 0n
    ? { numerator: -numerator, denominator: -denominator }
    : { numerator, denominator };
}

export function equalRationals(left: ExactRational, right: ExactRational): boolean {
  const checkedLeft = rationalForComparison(left);
  const checkedRight = rationalForComparison(right);
  return checkedLeft.numerator * checkedRight.denominator
    === checkedRight.numerator * checkedLeft.denominator;
}

export function compareRationals(left: ExactRational, right: ExactRational): -1 | 0 | 1 {
  const checkedLeft = rationalForComparison(left);
  const checkedRight = rationalForComparison(right);

  // Comparison-only cross-products are bounded implementation temporaries:
  // each input component is already capped at 4,096 decimal digits, so each
  // product is at most about 8,192 digits. Reduction is unnecessary for exact
  // ordering/equality, which avoids pathological gcd/continued-fraction work
  // for Fibonacci-shaped inputs while remaining defensive for unreduced or
  // negative-denominator direct utility callers.
  const leftScaled = checkedLeft.numerator * checkedRight.denominator;
  const rightScaled = checkedRight.numerator * checkedLeft.denominator;
  if (leftScaled === rightScaled) return 0;
  return leftScaled < rightScaled ? -1 : 1;
}

function assertFiniteContainerLength(length: number): void {
  if (length > MAX_FINITE_CONTAINER_ITEMS) {
    throw new BoundedMathError("CONTAINER_LIMIT_EXCEEDED", "Finite container exceeds the configured item limit");
  }
}

export function sumIntegers(values: readonly bigint[]): bigint {
  assertFiniteContainerLength(values.length);
  const boundedValues = values.map((value) => assertIntermediateIntegerBound(value));

  // A finite sum is one exact operation. Partial sums are evaluation-order
  // artifacts and can exceed the configured result bound by only a few digits
  // under the container cap, even when cancellation leaves a bounded result.
  const total = boundedValues.reduce((sum, value) => sum + value, 0n);
  return assertIntermediateIntegerBound(total);
}

export function productIntegers(values: readonly bigint[]): bigint {
  assertFiniteContainerLength(values.length);
  const boundedValues = values.map((value) => assertIntermediateIntegerBound(value));
  if (boundedValues.some((value) => value === 0n)) return 0n;

  let product = 1n;
  for (const value of boundedValues) {
    product = assertIntermediateIntegerBound(product * value);
  }
  return product;
}

function rationalKey(value: ExactRational): string {
  return `${value.numerator.toString()}/${value.denominator.toString()}`;
}

function rationalCounts(values: readonly ExactRational[]): Map<string, { value: ExactRational; count: number }> {
  const counts = new Map<string, { value: ExactRational; count: number }>();
  for (const value of values) {
    const key = rationalKey(value);
    const existing = counts.get(key);
    if (existing === undefined) counts.set(key, { value, count: 1 });
    else existing.count += 1;
  }
  return counts;
}

interface WideRationalSum {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

function addWideRational(
  left: WideRationalSum,
  right: ExactRational
): WideRationalSum {
  const commonFactor = gcdUnchecked(left.denominator, right.denominator);
  const leftScale = right.denominator / commonFactor;
  const rightScale = left.denominator / commonFactor;
  const numerator = left.numerator * leftScale + right.numerator * rightScale;
  const denominator = left.denominator * leftScale;
  const cancellation = gcdUnchecked(numerator, denominator);
  return {
    numerator: numerator / cancellation,
    denominator: denominator / cancellation
  };
}

function canUseWideRationalSum(values: readonly ExactRational[]): boolean {
  let denominatorDigits = 0;
  for (const value of values) {
    denominatorDigits += decimalDigitCount(value.denominator);
    if (denominatorDigits > MAX_MATH_STATEMENT_CHARACTERS) return false;
  }
  return true;
}

function boundedCommonDenominator(values: readonly ExactRational[]): bigint | undefined {
  let commonDenominator = 1n;
  for (const value of values) {
    const factor = gcdUnchecked(commonDenominator, value.denominator);
    const candidate = (commonDenominator / factor) * value.denominator;
    if (decimalDigitCount(candidate) > MAX_INTERMEDIATE_INTEGER_DECIMAL_DIGITS) {
      return undefined;
    }
    commonDenominator = candidate;
  }
  return commonDenominator;
}

function sumWithCommonDenominator(
  values: readonly ExactRational[],
  commonDenominator: bigint
): ExactRational {
  let numerator = 0n;
  for (const value of values) {
    numerator += value.numerator * (commonDenominator / value.denominator);
  }

  const cancellation = gcdUnchecked(numerator, commonDenominator);
  return rational(
    assertIntermediateIntegerBound(numerator / cancellation),
    assertIntermediateIntegerBound(commonDenominator / cancellation)
  );
}

export function sumRationals(values: readonly ExactRational[]): ExactRational {
  assertFiniteContainerLength(values.length);
  const normalizedValues = values.map(normalizeRational);

  if (canUseWideRationalSum(normalizedValues)) {
    let total: WideRationalSum = { numerator: 0n, denominator: 1n };
    for (const value of normalizedValues) total = addWideRational(total, value);
    return rational(
      assertIntermediateIntegerBound(total.numerator),
      assertIntermediateIntegerBound(total.denominator)
    );
  }

  const commonDenominator = boundedCommonDenominator(normalizedValues);
  if (commonDenominator !== undefined) {
    return sumWithCommonDenominator(normalizedValues, commonDenominator);
  }

  const counts = rationalCounts(normalizedValues);

  // Remove exact additive-inverse pairs before bounded accumulation. This is
  // algebraically exact and prevents an implementation-order overflow such as
  // [M, M, -M] when M itself is still within the configured rational bound.
  for (const entry of counts.values()) {
    if (entry.count === 0 || entry.value.numerator <= 0n) continue;
    const oppositeKey = rationalKey({
      numerator: -entry.value.numerator,
      denominator: entry.value.denominator
    });
    const opposite = counts.get(oppositeKey);
    if (opposite === undefined || opposite.count === 0) continue;
    const cancelled = Math.min(entry.count, opposite.count);
    entry.count -= cancelled;
    opposite.count -= cancelled;
  }

  let result = rational(0n, 1n);
  for (const entry of counts.values()) {
    if (entry.value.numerator === 0n) continue;
    for (let index = 0; index < entry.count; index += 1) {
      result = addRationals(result, entry.value);
    }
  }
  return result;
}

function canUseWideRationalProduct(values: readonly ExactRational[]): boolean {
  let factorDigits = 0;
  for (const value of values) {
    factorDigits += decimalDigitCount(value.numerator) + decimalDigitCount(value.denominator);
    if (factorDigits > MAX_MATH_STATEMENT_CHARACTERS) return false;
  }
  return true;
}

function wideRationalProduct(values: readonly ExactRational[]): ExactRational {
  let numerator = 1n;
  let denominator = 1n;

  for (const value of values) {
    numerator *= value.numerator;
    denominator *= value.denominator;
    const cancellation = gcdUnchecked(numerator, denominator);
    numerator /= cancellation;
    denominator /= cancellation;
  }

  return rational(
    assertIntermediateIntegerBound(numerator),
    assertIntermediateIntegerBound(denominator)
  );
}

function fullyCancelledRationalProduct(values: readonly ExactRational[]): ExactRational {
  let negative = false;
  const numerators = values.map((value) => {
    if (value.numerator < 0n) negative = !negative;
    return value.numerator < 0n ? -value.numerator : value.numerator;
  });
  const denominators = values.map((value) => value.denominator);

  for (let numeratorIndex = 0; numeratorIndex < numerators.length; numeratorIndex += 1) {
    let numerator = numerators[numeratorIndex];
    if (numerator === undefined || numerator <= 1n) continue;

    for (let denominatorIndex = 0; denominatorIndex < denominators.length; denominatorIndex += 1) {
      const denominator = denominators[denominatorIndex];
      if (denominator === undefined || denominator <= 1n) continue;
      const factor = gcdUnchecked(numerator, denominator);
      if (factor === 1n) continue;

      numerator /= factor;
      numerators[numeratorIndex] = numerator;
      denominators[denominatorIndex] = denominator / factor;
      if (numerator === 1n) break;
    }
  }

  const numeratorProduct = productIntegers(numerators);
  const denominatorProduct = productIntegers(denominators);
  return rational(negative ? -numeratorProduct : numeratorProduct, denominatorProduct);
}

export function productRationals(values: readonly ExactRational[]): ExactRational {
  assertFiniteContainerLength(values.length);
  const normalizedValues = values.map(normalizeRational);
  if (normalizedValues.some((value) => value.numerator === 0n)) return rational(0n, 1n);
  if (canUseWideRationalProduct(normalizedValues)) return wideRationalProduct(normalizedValues);

  const counts = rationalCounts(normalizedValues);
  const visited = new Set<string>();
  for (const [key, entry] of counts) {
    if (entry.count === 0 || visited.has(key)) continue;
    const reciprocal = rational(entry.value.denominator, entry.value.numerator);
    const reciprocalKey = rationalKey(reciprocal);
    visited.add(key);
    visited.add(reciprocalKey);

    if (reciprocalKey === key) {
      if (entry.value.numerator === entry.value.denominator) {
        entry.count = 0;
      } else {
        entry.count %= 2;
      }
      continue;
    }

    const reciprocalEntry = counts.get(reciprocalKey);
    if (reciprocalEntry === undefined || reciprocalEntry.count === 0) continue;
    const cancelled = Math.min(entry.count, reciprocalEntry.count);
    entry.count -= cancelled;
    reciprocalEntry.count -= cancelled;
  }

  const remaining: ExactRational[] = [];
  for (const entry of counts.values()) {
    for (let index = 0; index < entry.count; index += 1) {
      remaining.push(entry.value);
    }
  }

  if (remaining.length <= MAX_VARIADIC_EXPRESSION_TERMS) {
    return fullyCancelledRationalProduct(remaining);
  }

  let result = rational(1n, 1n);
  for (const value of remaining) {
    result = multiplyRationals(result, value);
  }
  return result;
}

function assertCombinatorialInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new BoundedMathError(
      "INVALID_COMBINATORIAL_ARGUMENT",
      `${label} must be a non-negative integer`
    );
  }
  if (value > MAX_COMBINATORIAL_N) {
    throw new BoundedMathError(
      "COMBINATORIAL_LIMIT_EXCEEDED",
      `${label} exceeds the configured combinatorial limit of ${String(MAX_COMBINATORIAL_N)}`
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

  // The stars-and-bars effective n can reach 2 * MAX_COMBINATORIAL_N - 1
  // even though each supplied dimension is independently within its bound.
  // Compute the equivalent binomial directly instead of feeding the derived
  // value back through the public n <= MAX_COMBINATORIAL_N guard.
  const effectiveN = types + selections - 1;
  const reducedK = Math.min(selections, effectiveN - selections);
  let result = 1n;
  for (let index = 1; index <= reducedK; index += 1) {
    result = assertIntermediateIntegerBound(
      (result * BigInt(effectiveN - reducedK + index)) / BigInt(index)
    );
  }
  return result;
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
