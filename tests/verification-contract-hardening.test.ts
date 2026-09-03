import { describe, expect, it } from "vitest";
import { VerificationResultSchema } from "../packages/domain/src/index.js";
import { VerificationWorkItemSchema } from "../packages/interview-engine/src/index.js";
import {
  AbstainingVerifier,
  MAX_TWO_COLOUR_GRAPH_STATEMENT_CHARACTERS,
  MAX_TWO_COLOUR_GRAPH_VERTICES,
  TWO_COLOUR_GRAPH_PROTOCOL,
  TWO_COLOUR_GRAPH_PROTOCOL_VERSION,
  TwoColourGraphInterpretationSchema,
  TwoColourGraphVerifier,
  findMonochromaticTriangle,
  type TwoColourGraphInterpretation,
  type TwoColourRelation
} from "../packages/verification/src/index.js";

const K6_VERTICES = ["A", "B", "C", "D", "E", "F"] as const;

function graph(
  vertices: readonly string[],
  relationForPair: (left: string, right: string) => TwoColourRelation
): TwoColourGraphInterpretation {
  const edges: Array<{
    endpoints: [string, string];
    relation: TwoColourRelation;
  }> = [];

  for (let left = 0; left < vertices.length - 1; left += 1) {
    for (let right = left + 1; right < vertices.length; right += 1) {
      const leftVertex = vertices[left];
      const rightVertex = vertices[right];
      if (leftVertex !== undefined && rightVertex !== undefined) {
        edges.push({
          endpoints: [leftVertex, rightVertex],
          relation: relationForPair(leftVertex, rightVertex)
        });
      }
    }
  }

  return TwoColourGraphInterpretationSchema.parse({
    protocol: TWO_COLOUR_GRAPH_PROTOCOL,
    protocolVersion: TWO_COLOUR_GRAPH_PROTOCOL_VERSION,
    problemId: "oxford-six-people",
    problemVersion: "1.0.0",
    claim: "ENCODED_GRAPH_HAS_MONOCHROMATIC_TRIANGLE",
    vertices: [...vertices],
    edges
  });
}

describe("deterministic verifier contract hardening", () => {
  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0.01, 1.01])(
    "returns a schema-valid abstention for invalid confidence %s",
    async (invalidConfidence) => {
      const encoded = JSON.stringify(graph(K6_VERTICES, () => "ACQUAINTANCE"));
      const verifiers = [new TwoColourGraphVerifier(), new AbstainingVerifier()];

      for (const verifier of verifiers) {
        const result = await verifier.verify(encoded, invalidConfidence);
        expect(VerificationResultSchema.parse(result)).toEqual(result);
        expect(result).toMatchObject({
          status: "UNRESOLVED",
          interpretationConfidence: 0,
          reason: "Interpretation confidence must be a finite value between 0 and 1"
        });
      }
    }
  );

  it("abstains before parsing an oversized formal interpretation", async () => {
    const oversized = "[".padEnd(MAX_TWO_COLOUR_GRAPH_STATEMENT_CHARACTERS + 1, " ");
    const result = await new TwoColourGraphVerifier().verify(oversized, 1);

    expect(VerificationResultSchema.parse(result)).toEqual(result);
    expect(result).toMatchObject({
      status: "UNRESOLVED",
      reason: "Formal interpretation exceeds the deterministic verifier size limit"
    });
  });

  it("bounds graph cardinality and vertex identity at the persisted boundary", () => {
    const tooManyVertices = Array.from(
      { length: MAX_TWO_COLOUR_GRAPH_VERTICES + 1 },
      (_, index) => `v${String(index)}`
    );

    expect(TwoColourGraphInterpretationSchema.safeParse({
      protocol: TWO_COLOUR_GRAPH_PROTOCOL,
      protocolVersion: TWO_COLOUR_GRAPH_PROTOCOL_VERSION,
      problemId: "oxford-six-people",
      problemVersion: "1.0.0",
      claim: "ENCODED_GRAPH_HAS_MONOCHROMATIC_TRIANGLE",
      vertices: tooManyVertices,
      edges: []
    }).success).toBe(false);

    const valid = graph(K6_VERTICES, () => "ACQUAINTANCE");
    expect(TwoColourGraphInterpretationSchema.safeParse({
      ...valid,
      vertices: ["A", "ambiguous vertex", ...valid.vertices.slice(2)]
    }).success).toBe(false);
    expect(TwoColourGraphInterpretationSchema.safeParse({
      ...valid,
      vertices: ["A", "x".repeat(65), ...valid.vertices.slice(2)]
    }).success).toBe(false);
  });

  it("is invariant to edge order and endpoint orientation", async () => {
    const original = graph(K6_VERTICES, (left, right) =>
      left === "A" || right === "A" ? "STRANGER" : "ACQUAINTANCE"
    );
    const reordered = TwoColourGraphInterpretationSchema.parse({
      ...original,
      edges: [...original.edges]
        .reverse()
        .map((edge) => ({
          endpoints: [edge.endpoints[1], edge.endpoints[0]],
          relation: edge.relation
        }))
    });

    const originalTriangle = findMonochromaticTriangle(original);
    const reorderedTriangle = findMonochromaticTriangle(reordered);
    expect(reorderedTriangle).toEqual(originalTriangle);

    const verifier = new TwoColourGraphVerifier();
    const originalResult = await verifier.verify(JSON.stringify(original), 1);
    const reorderedResult = await verifier.verify(JSON.stringify(reordered), 1);
    expect(reorderedResult).toEqual(originalResult);
  });

  it("always emits a schema-valid result for malformed formal interpretations", async () => {
    const malformedStatements = [
      "",
      "null",
      "[]",
      "{}",
      "{not-json",
      JSON.stringify({ protocol: TWO_COLOUR_GRAPH_PROTOCOL })
    ];
    const verifier = new TwoColourGraphVerifier();

    for (const malformed of malformedStatements) {
      const result = await verifier.verify(malformed, 1);
      expect(VerificationResultSchema.parse(result)).toEqual(result);
      expect(result.status).toBe("UNRESOLVED");
    }
  });

  it("forbids generation-bound verification from declaring board-revision independence", () => {
    const parsed = VerificationWorkItemSchema.safeParse({
      protocolVersion: 1,
      verificationRequestId: "verification-request",
      verifier: "deterministic-verifier",
      basis: {
        contextEpoch: 0,
        committedInputSequence: 1,
        transcriptRevision: 0,
        boardRevision: 0,
        problemStateRevision: 0,
        policyRevision: 0,
        inputEpisodeId: "episode",
        turnId: "turn"
      },
      candidateFormalInterpretation: "{}",
      interpretationConfidence: 1,
      evidenceKey: {
        problemId: "problem",
        subject: { kind: "CLAIM", claimId: "claim" },
        dimension: "CORRECTNESS"
      },
      evidenceEventIds: ["event"],
      boardRevisionIndependent: true,
      sourceGenerationId: "generation"
    });

    expect(parsed.success).toBe(false);
  });

});
