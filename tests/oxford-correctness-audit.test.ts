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
    expect(parsed).toHaveLength(75);
  });

  it("pins every current C/D/E review to an author head", () => {
    const raw = readFileSync(
      new URL("../docs/oxford-correctness/existing-bank-review-records.json", import.meta.url),
      "utf8"
    );
    const parsed = JSON.parse(raw) as OxfordCorrectnessReviewRecord[];
    const authorRecords = parsed.filter((record) => record.source.kind === "author-pr");
    expect(authorRecords).toHaveLength(61);
    expect(authorRecords.filter((record) => record.source.authorAgent === "C — Cantor")).toHaveLength(20);
    expect(authorRecords.filter((record) => record.source.authorAgent === "D — Dirichlet")).toHaveLength(22);
    expect(authorRecords.filter((record) => record.source.authorAgent === "E — Euler")).toHaveLength(19);
    expect(authorRecords.filter((record) => record.mathematicalCorrectness === "approved")).toHaveLength(58);
    expect(authorRecords.filter((record) => record.mathematicalCorrectness === "changes-required")).toHaveLength(3);
  });

  it("fails closed when author reviews omit the exact reviewed head", () => {
    const invalid = {
      ...validReviewRecord(),
      source: { kind: "author-pr", authorAgent: "C — Cantor", prNumber: 132 }
    };
    expect(() => assertOxfordCorrectnessReviewRecord(invalid)).toThrow(
      /reviewedAuthorHead/
    );
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


describe("Wave 2 author-family computational spot checks", () => {
  it("verifies the triple-flip circle kernel and image through n=10", () => {
    for (let n = 3; n <= 10; n += 1) {
      const outcomeCounts = new Map<string, number>();
      const moveCount = 1 << n;
      for (let mask = 0; mask < moveCount; mask += 1) {
        const outcome = tripleFlipOutcome(n, mask);
        const key = outcome.join("");
        outcomeCounts.set(key, (outcomeCounts.get(key) ?? 0) + 1);
      }

      const zeroKey = "0".repeat(n);
      expect(outcomeCounts.get(zeroKey)).toBe(n % 3 === 0 ? 4 : 1);

      if (n % 3 !== 0) {
        expect(outcomeCounts.size).toBe(1 << n);
        expect([...outcomeCounts.values()].every((count) => count === 1)).toBe(true);
        continue;
      }

      expect(outcomeCounts.size).toBe(1 << (n - 2));
      for (const [key, count] of outcomeCounts) {
        expect(count).toBe(4);
        const bits = Array.from({ length: key.length }, (_, index) => Number(key[index] ?? "0"));
        const parities = [0, 1, 2].map((residue) =>
          bits.reduce((sum, bit, index) => index % 3 === residue ? sum ^ bit : sum, 0)
        );
        expect(parities[0]).toBe(parities[1]);
        expect(parities[1]).toBe(parities[2]);
      }
    }
  });

  it("matches the diagonal-bisector box section vertex transition", () => {
    expect(boxSectionVertices(1, 2, 4).size).toBe(4);
    expect(boxSectionVertices(1, 2, 3).size).toBe(4);
    expect(boxSectionVertices(1, 2, 2.9).size).toBe(6);
    expect(boxSectionVertices(1, 1, 1).size).toBe(6);
  });

  it("matches the circle-sweep sign condition on a finite grid", () => {
    for (let xi = -10; xi <= 25; xi += 1) {
      for (let yi = -10; yi <= 20; yi += 1) {
        const x = xi / 10;
        const y = yi / 10;
        const rSquared = x * x + y * y;
        const product = (rSquared - y) * (rSquared - 2 * x);
        expect(circleSweepHasParameter(x, y)).toBe(product <= 1e-8);
      }
    }
  });

  it("matches random-subset block expectations by exhaustive enumeration", () => {
    for (let n = 2; n <= 7; n += 1) {
      const subsetCount = 1 << n;
      let lineTotal = 0;
      let circleTotal = 0;

      for (let mask = 0; mask < subsetCount; mask += 1) {
        const bits = Array.from({ length: n }, (_, index) => (mask >> index) & 1);
        lineTotal += lineBlockCount(bits);
        circleTotal += circleBlockCount(bits);
      }

      expect(lineTotal / subsetCount).toBeCloseTo((n + 1) / 4, 12);
      expect(circleTotal / subsetCount).toBeCloseTo(n / 4 + 2 ** (-n), 12);
    }
  });

  it("verifies thirds-closed classification on exhaustive small sets", () => {
    const universe = [-4, -3, -2, -1, 0, 1, 2, 3, 4];
    for (let size = 1; size <= 6; size += 1) {
      for (const subset of combinations(universe, size)) {
        expect(isThirdsClosed(subset)).toBe(matchesThirdsClosedClassification(subset));
      }
    }
  });

  it("matches sliding-window parity counts through n=8", () => {
    for (let n = 1; n <= 8; n += 1) {
      for (let k = 1; k <= n; k += 1) {
        let count = 0;
        for (let mask = 0; mask < (1 << n); mask += 1) {
          const bits = Array.from({ length: n }, (_, index) => (mask >> index) & 1);
          if (hasEqualWindowParity(bits, k)) count += 1;
        }
        expect(count).toBe(2 ** integerGcd(n, k));
      }
    }
  });

  it("matches the stable-binary-word recurrence through n=10", () => {
    const counts: number[] = [];
    for (let n = 0; n <= 10; n += 1) {
      let count = 0;
      for (let mask = 0; mask < (1 << n); mask += 1) {
        const bits = Array.from({ length: n }, (_, index) => (mask >> index) & 1);
        if (isStableBinaryWord(bits)) count += 1;
      }
      counts.push(count);
    }
    expect(counts).toEqual([1, 1, 2, 4, 7, 12, 21, 37, 65, 114, 200]);
    for (let n = 3; n < counts.length; n += 1) {
      expect(counts[n]).toBe(2 * (counts[n - 1] ?? 0) - (counts[n - 2] ?? 0) + (counts[n - 3] ?? 0));
    }
  });

  it("matches random-adjacent linear and circular expectations by enumeration", () => {
    for (let n = 2; n <= 7; n += 1) {
      const values = Array.from({ length: n }, (_, index) => index + 1);
      const orders = permutations(values);
      const lineMean = orders.reduce((total, order) => total + adjacentConsecutiveCount(order, false), 0) / orders.length;
      expect(lineMean).toBeCloseTo(2 * (n - 1) / n, 12);
      if (n >= 3) {
        const circleMean = orders.reduce((total, order) => total + adjacentConsecutiveCount(order, true), 0) / orders.length;
        expect(circleMean).toBeCloseTo(2, 12);
      }
    }
  });

  it("matches the random-chord midpoint expectation through n=14", () => {
    for (let n = 3; n <= 14; n += 1) {
      let sum = 0;
      let pairs = 0;
      for (let i = 0; i < n; i += 1) {
        const angleI = 2 * Math.PI * i / n;
        for (let j = i + 1; j < n; j += 1) {
          const angleJ = 2 * Math.PI * j / n;
          const midpointX = (Math.cos(angleI) + Math.cos(angleJ)) / 2;
          const midpointY = (Math.sin(angleI) + Math.sin(angleJ)) / 2;
          sum += midpointX * midpointX + midpointY * midpointY;
          pairs += 1;
        }
      }
      expect(sum / pairs).toBeCloseTo((n - 2) / (2 * (n - 1)), 12);
    }
  });
});

function tripleFlipOutcome(n: number, mask: number): number[] {
  return Array.from({ length: n }, (_, index) => {
    const current = (mask >> index) & 1;
    const previous = (mask >> ((index - 1 + n) % n)) & 1;
    const previousPrevious = (mask >> ((index - 2 + n) % n)) & 1;
    return current ^ previous ^ previousPrevious;
  });
}

function boxSectionVertices(alpha: number, beta: number, gamma: number): Set<string> {
  const coefficients = [alpha, beta, gamma];
  const vertices = new Set<string>();

  for (let free = 0; free < 3; free += 1) {
    const fixed = [0, 1, 2].filter((index) => index !== free);
    const first = fixed[0];
    const second = fixed[1];
    if (first === undefined || second === undefined) continue;

    for (const firstSign of [-1, 1]) {
      for (const secondSign of [-1, 1]) {
        const point = [0, 0, 0];
        point[first] = firstSign;
        point[second] = secondSign;
        const solved = -(
          (coefficients[first] ?? 0) * firstSign
          + (coefficients[second] ?? 0) * secondSign
        ) / (coefficients[free] ?? 1);
        if (solved < -1 - 1e-12 || solved > 1 + 1e-12) continue;
        point[free] = solved;
        vertices.add(point.map((value) => value.toFixed(10)).join(","));
      }
    }
  }

  return vertices;
}

function circleSweepHasParameter(x: number, y: number): boolean {
  const rSquared = x * x + y * y;
  const slope = x - y / 2;
  if (Math.abs(slope) < 1e-12) return Math.abs(rSquared - y) < 1e-10;
  const parameter = (rSquared - y) / slope;
  return parameter >= -1e-10 && parameter <= 2 + 1e-10;
}

function lineBlockCount(bits: readonly number[]): number {
  let blocks = 0;
  let previous = 0;
  for (const bit of bits) {
    if (bit === 1 && previous === 0) blocks += 1;
    previous = bit;
  }
  return blocks;
}

function circleBlockCount(bits: readonly number[]): number {
  if (bits.every((bit) => bit === 1)) return 1;
  let blocks = 0;
  for (let index = 0; index < bits.length; index += 1) {
    const bit = bits[index] ?? 0;
    const previous = bits[(index - 1 + bits.length) % bits.length] ?? 0;
    if (bit === 1 && previous === 0) blocks += 1;
  }
  return blocks;
}


function isThirdsClosed(values: readonly number[]): boolean {
  const set = new Set(values);
  for (const x of values) {
    for (const y of values) {
      if ((x - y) % 3 !== 0) continue;
      const first = (2 * x + y) / 3;
      const second = (x + 2 * y) / 3;
      if (!set.has(first) || !set.has(second)) return false;
    }
  }
  return true;
}

function matchesThirdsClosedClassification(values: readonly number[]): boolean {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return true;
  const residues = sorted.map((value) => ((value % 3) + 3) % 3);
  if (sorted.length === 2) return residues[0] !== residues[1];
  if (sorted.length === 3) return new Set(residues).size === 3;
  const gap = (sorted[1] ?? 0) - (sorted[0] ?? 0);
  if (gap % 3 === 0) return false;
  for (let index = 2; index < sorted.length; index += 1) {
    if ((sorted[index] ?? 0) - (sorted[index - 1] ?? 0) !== gap) return false;
  }
  return true;
}

function hasEqualWindowParity(bits: readonly number[], k: number): boolean {
  const n = bits.length;
  let parity: number | undefined;
  for (let start = 0; start < n; start += 1) {
    let current = 0;
    for (let offset = 0; offset < k; offset += 1) {
      current ^= bits[(start + offset) % n] ?? 0;
    }
    if (parity === undefined) parity = current;
    else if (parity !== current) return false;
  }
  return true;
}

function integerGcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    const next = x % y;
    x = y;
    y = next;
  }
  return x;
}

function isStableBinaryWord(bits: readonly number[]): boolean {
  let index = 0;
  while (index < bits.length) {
    if ((bits[index] ?? 0) === 0) {
      index += 1;
      continue;
    }
    let end = index;
    while (end < bits.length && (bits[end] ?? 0) === 1) end += 1;
    if (end - index < 2) return false;
    index = end;
  }
  return true;
}

function permutations(values: readonly number[]): number[][] {
  if (values.length === 0) return [[]];
  const result: number[][] = [];
  values.forEach((value, index) => {
    const rest = [...values.slice(0, index), ...values.slice(index + 1)];
    for (const suffix of permutations(rest)) result.push([value, ...suffix]);
  });
  return result;
}

function adjacentConsecutiveCount(order: readonly number[], circular: boolean): number {
  let count = 0;
  const edgeCount = circular ? order.length : Math.max(0, order.length - 1);
  for (let index = 0; index < edgeCount; index += 1) {
    const left = order[index];
    const right = order[(index + 1) % order.length];
    if (left !== undefined && right !== undefined && Math.abs(left - right) === 1) count += 1;
  }
  return count;
}
