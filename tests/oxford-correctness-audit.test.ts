import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assertOxfordCorrectnessReviewBatch,
  assertOxfordCorrectnessReviewRecord,
  type OxfordCorrectnessReviewRecord
} from "../packages/problems/src/oxford-correctness-review.js";

describe("Oxford mathematical correctness audit gate", () => {
  it("accepts the retained existing-bank review batch", () => {
    const raw = readFileSync(
      new URL("../docs/oxford-correctness/existing-bank-review-records.json", import.meta.url),
      "utf8"
    );
    const parsed = JSON.parse(raw) as unknown;
    expect(() => assertOxfordCorrectnessReviewBatch(parsed)).not.toThrow();
    if (!Array.isArray(parsed)) throw new Error("Expected review record array");
    expect(parsed).toHaveLength(14);
  });

  it("fails closed when approval carries an unresolved mathematical error", () => {
    const record = validReviewRecord();
    const invalid = {
      ...record,
      findings: [{
        id: "false-hint",
        area: "hint",
        severity: "error",
        status: "open",
        summary: "A protected hint states a false implication.",
        evidence: "Independent derivation gives a counterexample."
      }]
    };
    expect(() => assertOxfordCorrectnessReviewRecord(invalid)).toThrow(
      /cannot coexist with open error findings/
    );
  });

  it("fails closed when approval carries unresolved uncertainty", () => {
    const invalid = {
      ...validReviewRecord(),
      unresolvedUncertainties: ["The endpoint case has not been independently checked."]
    };
    expect(() => assertOxfordCorrectnessReviewRecord(invalid)).toThrow(
      /cannot coexist with unresolved uncertainties/
    );
  });

  it("requires a concrete blocker for changes-required", () => {
    const invalid = {
      ...validReviewRecord(),
      mathematicalCorrectness: "changes-required",
      recommendation: "revise"
    };
    expect(() => assertOxfordCorrectnessReviewRecord(invalid)).toThrow(
      /must identify an open error or unresolved uncertainty/
    );
  });
});

describe("Oxford fragile-claim computational checks", () => {
  it("matches the Catalan count through n=8", () => {
    for (let n = 0; n <= 8; n += 1) {
      expect(countPathsNeverAboveDiagonal(n)).toBe(catalanNumber(n));
    }
  });

  it("finds a divisibility pair in every (n+1)-subset through n=6", () => {
    for (let n = 1; n <= 6; n += 1) {
      const values = Array.from({ length: 2 * n }, (_, index) => index + 1);
      for (const subset of combinations(values, n + 1)) {
        expect(hasDivisibilityPair(subset)).toBe(true);
      }
    }
  });

  it("verifies the prefix-sum theorem on exhaustive small integer sequences", () => {
    const alphabet = [-2, -1, 0, 1, 2];
    for (let n = 1; n <= 5; n += 1) {
      for (const sequence of sequencesOfLength(alphabet, n)) {
        expect(hasDivisibleConsecutiveBlock(sequence, n)).toBe(true);
      }
    }
  });

  it("exhaustively verifies R(3,3)=6 and the five-person lower-bound example", () => {
    const edges = completeGraphEdges(6);
    const triangles = graphTriangles(6);
    const colorings = 1 << edges.length;
    for (let mask = 0; mask < colorings; mask += 1) {
      expect(hasMonochromaticTriangle(mask, edges, triangles)).toBe(true);
    }

    const fiveEdges = completeGraphEdges(5);
    const fiveTriangles = graphTriangles(5);
    let fiveCycleMask = 0;
    const cyclePairs = new Set(["0-1", "1-2", "2-3", "3-4", "0-4"]);
    fiveEdges.forEach(([a, b], index) => {
      if (cyclePairs.has(edgeKey(a, b))) fiveCycleMask |= 1 << index;
    });
    expect(hasMonochromaticTriangle(fiveCycleMask, fiveEdges, fiveTriangles)).toBe(false);
  });

  it("verifies the parity-hat strategy on every assignment for six prisoners", () => {
    const n = 6;
    for (let mask = 0; mask < (1 << n); mask += 1) {
      const hats = Array.from({ length: n }, (_, index) => (mask >> index) & 1);
      const guesses = parityHatGuesses(hats);
      let guaranteedCorrect = 0;
      for (let index = 0; index < n - 1; index += 1) {
        if (guesses[index] === hats[index]) guaranteedCorrect += 1;
      }
      expect(guaranteedCorrect).toBe(n - 1);
    }
  });

  it("checks the nested-radical error identity across its invariant interval", () => {
    for (let step = 0; step <= 20; step += 1) {
      const x = step / 10;
      const next = Math.sqrt(2 + x);
      const left = 2 - next;
      const right = (2 - x) / (2 + next);
      expect(Math.abs(left - right)).toBeLessThan(1e-12);
      expect(next).toBeGreaterThanOrEqual(x);
      expect(next).toBeLessThanOrEqual(2);
    }
  });

  it("retains a composite Euclid-number example", () => {
    const euclidNumber = 2 * 3 * 5 * 7 * 11 * 13 + 1;
    expect(euclidNumber).toBe(30031);
    expect(59 * 509).toBe(euclidNumber);
  });
});

function validReviewRecord(): OxfordCorrectnessReviewRecord {
  return {
    schemaVersion: 1,
    familyId: "fixture-family",
    problemVersion: "1.0.0",
    reviewerAgent: "I — Itô",
    reviewedAt: "2026-09-04",
    source: { kind: "existing-bank" },
    mathematicalCorrectness: "approved",
    recommendation: "approve",
    independentlySolved: true,
    statementChecked: true,
    approachesChecked: true,
    canonicalSolutionChecked: true,
    hintsChecked: true,
    extensionsChecked: true,
    prerequisitesChecked: true,
    independentSolutionSummary: "Independent derivation establishes the stated claim.",
    computationalChecks: [],
    findings: [],
    unresolvedUncertainties: []
  };
}

function countPathsNeverAboveDiagonal(n: number): number {
  let count = 0;
  function visit(right: number, up: number): void {
    if (up > right) return;
    if (right === n && up === n) {
      count += 1;
      return;
    }
    if (right < n) visit(right + 1, up);
    if (up < n) visit(right, up + 1);
  }
  visit(0, 0);
  return count;
}

function catalanNumber(n: number): number {
  return Math.round(binomial(2 * n, n) / (n + 1));
}

function binomial(n: number, k: number): number {
  let result = 1;
  const reducedK = Math.min(k, n - k);
  for (let i = 1; i <= reducedK; i += 1) {
    result = (result * (n - reducedK + i)) / i;
  }
  return result;
}

function combinations(values: readonly number[], size: number): number[][] {
  const result: number[][] = [];
  function visit(start: number, chosen: number[]): void {
    if (chosen.length === size) {
      result.push([...chosen]);
      return;
    }
    for (let index = start; index < values.length; index += 1) {
      const value = values[index];
      if (value === undefined) continue;
      chosen.push(value);
      visit(index + 1, chosen);
      chosen.pop();
    }
  }
  visit(0, []);
  return result;
}

function hasDivisibilityPair(values: readonly number[]): boolean {
  for (let left = 0; left < values.length; left += 1) {
    for (let right = left + 1; right < values.length; right += 1) {
      const a = values[left];
      const b = values[right];
      if (a === undefined || b === undefined) continue;
      if (a % b === 0 || b % a === 0) return true;
    }
  }
  return false;
}

function sequencesOfLength(alphabet: readonly number[], length: number): number[][] {
  const result: number[][] = [];
  function visit(sequence: number[]): void {
    if (sequence.length === length) {
      result.push([...sequence]);
      return;
    }
    for (const value of alphabet) {
      sequence.push(value);
      visit(sequence);
      sequence.pop();
    }
  }
  visit([]);
  return result;
}

function hasDivisibleConsecutiveBlock(sequence: readonly number[], modulus: number): boolean {
  for (let start = 0; start < sequence.length; start += 1) {
    let sum = 0;
    for (let end = start; end < sequence.length; end += 1) {
      sum += sequence[end] ?? 0;
      if (((sum % modulus) + modulus) % modulus === 0) return true;
    }
  }
  return false;
}

type Edge = readonly [number, number];

function completeGraphEdges(n: number): Edge[] {
  const edges: Edge[] = [];
  for (let a = 0; a < n; a += 1) {
    for (let b = a + 1; b < n; b += 1) edges.push([a, b]);
  }
  return edges;
}

function graphTriangles(n: number): readonly [number, number, number][] {
  const triangles: Array<[number, number, number]> = [];
  for (let a = 0; a < n; a += 1) {
    for (let b = a + 1; b < n; b += 1) {
      for (let c = b + 1; c < n; c += 1) triangles.push([a, b, c]);
    }
  }
  return triangles;
}

function edgeKey(a: number, b: number): string {
  return `${String(a)}-${String(b)}`;
}

function hasMonochromaticTriangle(
  mask: number,
  edges: readonly Edge[],
  triangles: readonly (readonly [number, number, number])[]
): boolean {
  const edgeIndex = new Map<string, number>();
  edges.forEach(([a, b], index) => edgeIndex.set(edgeKey(a, b), index));

  for (const [a, b, c] of triangles) {
    const indices = [
      edgeIndex.get(edgeKey(a, b)),
      edgeIndex.get(edgeKey(a, c)),
      edgeIndex.get(edgeKey(b, c))
    ];
    if (indices.some((index) => index === undefined)) continue;
    const first = indices[0];
    const second = indices[1];
    const third = indices[2];
    if (first === undefined || second === undefined || third === undefined) continue;
    const colorA = (mask >> first) & 1;
    const colorB = (mask >> second) & 1;
    const colorC = (mask >> third) & 1;
    if (colorA === colorB && colorB === colorC) return true;
  }
  return false;
}

function parityHatGuesses(hats: readonly number[]): number[] {
  const n = hats.length;
  if (n < 2) throw new Error("Need at least two prisoners");
  const guesses = Array.from({ length: n }, () => 0);
  let announcedParity = 0;
  for (let index = 0; index < n - 1; index += 1) {
    announcedParity = (announcedParity + (hats[index] ?? 0)) % 2;
  }
  guesses[n - 1] = announcedParity;

  for (let prisoner = n - 2; prisoner >= 0; prisoner -= 1) {
    let known = 0;
    for (let visible = 0; visible < prisoner; visible += 1) {
      known = (known + (hats[visible] ?? 0)) % 2;
    }
    for (let alreadyGuessed = prisoner + 1; alreadyGuessed < n - 1; alreadyGuessed += 1) {
      known = (known + (guesses[alreadyGuessed] ?? 0)) % 2;
    }
    guesses[prisoner] = (announcedParity - known + 2) % 2;
  }
  return guesses;
}
