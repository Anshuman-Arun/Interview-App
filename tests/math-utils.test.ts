import { describe, expect, it } from "vitest";
import {
  BoundedMathError,
  MAX_INTEGER_DECIMAL_DIGITS,
  areCongruent,
  binomial,
  combinationsWithRepetition,
  equalRationals,
  gcd,
  isDivisibleBy,
  isPermutationOf,
  lcm,
  normalizeModulo,
  parseBoundedInteger,
  parseRationalInput,
  permutations,
  productIntegers,
  sameFiniteMultiset,
  sameFiniteSet,
  serializeRational,
  sumIntegers
} from "../packages/verification/src/index.js";

describe("deterministic math utilities", () => {
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
  });

  it("computes exact finite sums, products, and standard counting formulas", () => {
    expect(sumIntegers([1n, -2n, 5n])).toBe(4n);
    expect(productIntegers([2n, -3n, 4n])).toBe(-24n);
    expect(binomial(10, 3)).toBe(120n);
    expect(binomial(3, 5)).toBe(0n);
    expect(permutations(5, 3)).toBe(60n);
    expect(combinationsWithRepetition(4, 3)).toBe(20n);
    expect(combinationsWithRepetition(0, 0)).toBe(1n);
  });

  it("checks sets, multisets, and permutations without conflating multiplicity", () => {
    expect(sameFiniteSet(["a", "a", "b"], ["b", "a"])).toBe(true);
    expect(sameFiniteMultiset(["a", "a", "b"], ["a", "b", "a"])).toBe(true);
    expect(sameFiniteMultiset(["a", "a", "b"], ["a", "b", "b"])).toBe(false);
    expect(isPermutationOf(["x", "y", "x"], ["x", "x", "y"])).toBe(true);
  });
});
