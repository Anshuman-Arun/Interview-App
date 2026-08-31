import { describe, expect, it } from "vitest";
import {
  BoundedMathError,
  MAX_COMBINATORIAL_N,
  MAX_FINITE_CONTAINER_ITEMS,
  MAX_INTEGER_DECIMAL_DIGITS,
  addRationals,
  areCongruent,
  binomial,
  combinationsWithRepetition,
  compareRationals,
  divideRationals,
  equalRationals,
  factorial,
  gcd,
  isCanonicalIntegerString,
  isDivisibleBy,
  isPermutationOf,
  lcm,
  multiplyRationals,
  normalizeModulo,
  parseBoundedInteger,
  parseRationalInput,
  permutations,
  rational,
  productIntegers,
  productRationals,
  sameFiniteMultiset,
  sameFiniteSet,
  serializeRational,
  sumIntegers,
  sumRationals
} from "../packages/verification/src/index.js";

describe("deterministic math utilities", () => {
  it("checks canonical integer syntax without runtime coercion", () => {
    expect(isCanonicalIntegerString("17")).toBe(true);
    expect(isCanonicalIntegerString("-17")).toBe(true);
    expect(isCanonicalIntegerString("-0")).toBe(false);
    expect(isCanonicalIntegerString(17)).toBe(false);
    expect(isCanonicalIntegerString(null)).toBe(false);
  });

  it("parses positive, negative, zero, and large bounded integers exactly", () => {
    expect(parseBoundedInteger("0")).toBe(0n);
    expect(parseBoundedInteger("-17")).toBe(-17n);
    const largestText = "9".repeat(MAX_INTEGER_DECIMAL_DIGITS);
    expect(parseBoundedInteger(largestText).toString()).toBe(largestText);
    expect(() => parseBoundedInteger("9".repeat(MAX_INTEGER_DECIMAL_DIGITS + 1))).toThrow(BoundedMathError);
    expect(() => parseBoundedInteger("01")).toThrow(BoundedMathError);
  });

  it("handles gcd/lcm and divisibility zero/sign edge cases", () => {
    expect(gcd(-54n, 24n)).toBe(6n);
    expect(gcd(0n, 0n)).toBe(0n);
    expect(lcm(-6n, 15n)).toBe(30n);
    expect(lcm(0n, 15n)).toBe(0n);
    expect(isDivisibleBy(-21n, -7n)).toBe(true);
    expect(isDivisibleBy(0n, 0n)).toBe(true);
    expect(isDivisibleBy(4n, 0n)).toBe(false);
  });

  it("normalizes modular arithmetic for negative integers", () => {
    expect(normalizeModulo(-1n, 5n)).toBe(4n);
    expect(normalizeModulo(-12n, 5n)).toBe(3n);
    expect(areCongruent(-12n, 3n, 5n)).toBe(true);
    expect(() => normalizeModulo(3n, 0n)).toThrow(BoundedMathError);
  });

  it("normalizes rationals exactly", () => {
    const half = parseRationalInput({ numerator: "-2", denominator: "-4" });
    expect(serializeRational(half)).toEqual({ numerator: "1", denominator: "2" });
    expect(equalRationals(half, parseRationalInput({ numerator: "3", denominator: "6" }))).toBe(true);

    const unreducedNegativeDenominator = { numerator: 2n, denominator: -4n };
    expect(equalRationals(unreducedNegativeDenominator, rational(-1n, 2n))).toBe(true);
    expect(compareRationals(unreducedNegativeDenominator, rational(-1n, 3n))).toBe(-1);

    expect(addRationals(
      { numerator: 2n, denominator: 4n },
      { numerator: 1n, denominator: -2n }
    )).toEqual(rational(0n, 1n));
    expect(multiplyRationals(
      { numerator: 2n, denominator: 4n },
      { numerator: 4n, denominator: 2n }
    )).toEqual(rational(1n, 1n));
    expect(divideRationals(
      { numerator: 2n, denominator: 4n },
      { numerator: 4n, denominator: 8n }
    )).toEqual(rational(1n, 1n));
  });

  it("computes exact finite sums, products, and standard counting formulas", () => {
    expect(sumIntegers([])).toBe(0n);
    expect(productIntegers([])).toBe(1n);
    expect(sumRationals([])).toEqual(rational(0n, 1n));
    expect(productRationals([])).toEqual(rational(1n, 1n));
    expect(sumIntegers([1n, -2n, 5n])).toBe(4n);
    expect(productIntegers([2n, -3n, 4n])).toBe(-24n);
    expect(factorial(0)).toBe(1n);
    expect(binomial(10, 3)).toBe(120n);
    expect(binomial(3, 5)).toBe(0n);
    expect(permutations(5, 3)).toBe(60n);
    expect(permutations(3, 5)).toBe(0n);
    expect(combinationsWithRepetition(4, 3)).toBe(20n);
    expect(combinationsWithRepetition(0, 0)).toBe(1n);
    expect(combinationsWithRepetition(0, 3)).toBe(0n);
  });

  it("distinguishes malformed combinatorial arguments from configured resource limits", () => {
    for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      try {
        factorial(value);
        throw new Error("Expected invalid combinatorial input to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(BoundedMathError);
        expect((error as BoundedMathError).code).toBe("INVALID_COMBINATORIAL_ARGUMENT");
      }
    }

    try {
      factorial(MAX_COMBINATORIAL_N + 1);
      throw new Error("Expected combinatorial resource limit to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(BoundedMathError);
      expect((error as BoundedMathError).code).toBe("COMBINATORIAL_LIMIT_EXCEEDED");
    }
  });

  it("matches exact rational identities across a deterministic small exhaustive domain", () => {
    for (let leftNumerator = -3; leftNumerator <= 3; leftNumerator += 1) {
      for (let leftDenominator = 1; leftDenominator <= 4; leftDenominator += 1) {
        const left = rational(BigInt(leftNumerator), BigInt(leftDenominator));
        for (let rightNumerator = -3; rightNumerator <= 3; rightNumerator += 1) {
          for (let rightDenominator = 1; rightDenominator <= 4; rightDenominator += 1) {
            const right = rational(BigInt(rightNumerator), BigInt(rightDenominator));
            const expectedAdd = rational(
              BigInt(leftNumerator * rightDenominator + rightNumerator * leftDenominator),
              BigInt(leftDenominator * rightDenominator)
            );
            const expectedMultiply = rational(
              BigInt(leftNumerator * rightNumerator),
              BigInt(leftDenominator * rightDenominator)
            );
            const crossDifference = leftNumerator * rightDenominator - rightNumerator * leftDenominator;
            const expectedComparison = crossDifference === 0 ? 0 : crossDifference < 0 ? -1 : 1;

            expect(addRationals(left, right)).toEqual(expectedAdd);
            expect(multiplyRationals(left, right)).toEqual(expectedMultiply);
            expect(compareRationals(left, right)).toBe(expectedComparison);

            if (rightNumerator !== 0) {
              expect(divideRationals(left, right)).toEqual(rational(
                BigInt(leftNumerator * rightDenominator),
                BigInt(leftDenominator * rightNumerator)
              ));
            }
          }
        }
      }
    }
  });

  it("handles unreduced aggregate inputs without requiring eager normalization", () => {
    const halfUnreduced = { numerator: 2n, denominator: 4n };
    const negativeHalf = { numerator: 1n, denominator: -2n };
    expect(sumRationals([halfUnreduced, negativeHalf])).toEqual(rational(0n, 1n));

    const twoUnreduced = { numerator: 4n, denominator: 2n };
    expect(productRationals([halfUnreduced, twoUnreduced])).toEqual(rational(1n, 1n));

    expect(() => sumRationals([
      { numerator: 0n, denominator: 0n }
    ])).toThrow(BoundedMathError);
    expect(() => productRationals([
      { numerator: 0n, denominator: 0n }
    ])).toThrow(BoundedMathError);
  });

  it("matches exact three-term rational aggregates independent of order", () => {
    const inputs: readonly (readonly [bigint, bigint])[] = [
      [-2n, 3n],
      [-1n, 2n],
      [0n, 1n],
      [1n, 3n],
      [2n, 1n]
    ];

    for (const left of inputs) {
      for (const middle of inputs) {
        for (const right of inputs) {
          const values = [left, middle, right].map(([numerator, denominator]) =>
            rational(numerator, denominator)
          );
          const commonDenominator = left[1] * middle[1] * right[1];
          const expectedSum = rational(
            left[0] * middle[1] * right[1]
              + middle[0] * left[1] * right[1]
              + right[0] * left[1] * middle[1],
            commonDenominator
          );
          const expectedProduct = rational(
            left[0] * middle[0] * right[0],
            commonDenominator
          );

          expect(sumRationals(values)).toEqual(expectedSum);
          expect(sumRationals([...values].reverse())).toEqual(expectedSum);
          expect(productRationals(values)).toEqual(expectedProduct);
          expect(productRationals([...values].reverse())).toEqual(expectedProduct);
        }
      }
    }
  });

  it("cancels across finite rational helpers beyond the expression-term limit", () => {
    const primes = [
      2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n,
      37n, 41n, 43n, 47n, 53n, 59n, 61n, 67n, 71n, 73n, 79n,
      83n, 89n, 97n, 101n, 103n, 107n, 109n, 113n, 127n, 131n,
      137n, 139n, 149n, 151n, 157n, 163n, 167n, 173n, 179n, 181n, 191n
    ];
    const denominators = primes.map((prime) => prime ** 55n);
    const largeSum = [
      ...denominators.flatMap((denominator) => [
        rational(1n, denominator),
        rational(1n, denominator)
      ]),
      ...denominators.map((denominator) => rational(-2n, denominator))
    ];
    expect(largeSum).toHaveLength(129);
    expect(sumRationals(largeSum)).toEqual(rational(0n, 1n));

    const scale = 10n ** 120n;
    const leftFactors = Array.from({ length: 33 }, (_, index) =>
      scale + BigInt(2 * index + 1)
    );
    const rightFactors = Array.from({ length: 33 }, (_, index) =>
      scale + BigInt(1001 + 2 * index)
    );
    const largeProduct = [
      ...leftFactors.map((value) => rational(2n * value, 1n)),
      ...rightFactors.map((value) => rational(value, 1n)),
      ...leftFactors.map((value) => rational(1n, value)),
      ...rightFactors.map((value) => rational(1n, 2n * value))
    ];
    expect(largeProduct).toHaveLength(132);
    expect(productRationals(largeProduct)).toEqual(rational(1n, 1n));
  });

  it("matches stars-and-bars counts throughout a deterministic small domain", () => {
    for (let types = 0; types <= 12; types += 1) {
      for (let selections = 0; selections <= 12; selections += 1) {
        const expected = selections === 0
          ? 1n
          : types === 0
            ? 0n
            : binomial(types + selections - 1, selections);
        expect(combinationsWithRepetition(types, selections)).toBe(expected);
      }
    }
    expect(combinationsWithRepetition(MAX_COMBINATORIAL_N, 2)).toBe(500500n);
  });

  it("enforces finite set and multiset helper item boundaries", () => {
    const atLimit = Array.from({ length: MAX_FINITE_CONTAINER_ITEMS }, (_, index) => `v-${String(index)}`);
    expect(sameFiniteSet(atLimit, [...atLimit].reverse())).toBe(true);
    expect(sameFiniteMultiset(atLimit, [...atLimit].reverse())).toBe(true);

    const overLimit = [...atLimit, "overflow"];
    expect(() => sameFiniteSet(overLimit, overLimit)).toThrow(BoundedMathError);
    expect(() => sameFiniteMultiset(overLimit, overLimit)).toThrow(BoundedMathError);
    expect(() => isPermutationOf(overLimit, overLimit)).toThrow(BoundedMathError);
  });

  it("checks sets, multisets, and permutations without conflating multiplicity", () => {
    expect(sameFiniteSet(["a", "a", "b"], ["b", "a"])).toBe(true);
    expect(sameFiniteMultiset(["a", "a", "b"], ["a", "b", "a"])).toBe(true);
    expect(sameFiniteMultiset(["a", "a", "b"], ["a", "b", "b"])).toBe(false);
    expect(isPermutationOf(["x", "y", "x"], ["x", "x", "y"])).toBe(true);
  });
});
