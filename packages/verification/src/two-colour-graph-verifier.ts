import { z } from "zod";
import type { DeterministicVerifier, VerificationResult } from "../../domain/src/index.js";

export const TWO_COLOUR_GRAPH_PROTOCOL = "INTERVIEW_APP_TWO_COLOUR_GRAPH_CLAIM" as const;
export const TWO_COLOUR_GRAPH_PROTOCOL_VERSION = 1 as const;
export const TWO_COLOUR_GRAPH_VERIFIER_NAME = "oxford-two-colour-graph-verifier@1" as const;

export const TwoColourRelationSchema = z.enum(["ACQUAINTANCE", "STRANGER"]);
export type TwoColourRelation = z.infer<typeof TwoColourRelationSchema>;

const VertexIdSchema = z.string().min(1);

export const TwoColourGraphEdgeSchema = z.object({
  endpoints: z.tuple([VertexIdSchema, VertexIdSchema]),
  relation: TwoColourRelationSchema
}).strict();

export const TwoColourGraphInterpretationSchema = z.object({
  protocol: z.literal(TWO_COLOUR_GRAPH_PROTOCOL),
  protocolVersion: z.literal(TWO_COLOUR_GRAPH_PROTOCOL_VERSION),
  problemId: z.literal("oxford-six-people"),
  problemVersion: z.literal("1.0.0"),
  claim: z.literal("ENCODED_GRAPH_HAS_MONOCHROMATIC_TRIANGLE"),
  vertices: z.array(VertexIdSchema).min(1),
  edges: z.array(TwoColourGraphEdgeSchema)
}).strict().superRefine((interpretation, context) => {
  const vertexIndex = new Map<string, number>();

  interpretation.vertices.forEach((vertex, index) => {
    if (vertexIndex.has(vertex)) {
      context.addIssue({
        code: "custom",
        path: ["vertices", index],
        message: "Vertices must be unique"
      });
      return;
    }
    vertexIndex.set(vertex, index);
  });

  const unorderedPairs = new Set<string>();

  interpretation.edges.forEach((edge, edgeIndex) => {
    const [left, right] = edge.endpoints;
    const leftIndex = vertexIndex.get(left);
    const rightIndex = vertexIndex.get(right);

    if (left === right) {
      context.addIssue({
        code: "custom",
        path: ["edges", edgeIndex, "endpoints"],
        message: "Self-edges are not allowed"
      });
      return;
    }

    if (leftIndex === undefined || rightIndex === undefined) {
      context.addIssue({
        code: "custom",
        path: ["edges", edgeIndex, "endpoints"],
        message: "Every edge endpoint must name a known vertex"
      });
      return;
    }

    const lowerIndex = Math.min(leftIndex, rightIndex);
    const upperIndex = Math.max(leftIndex, rightIndex);
    const pairKey = `${String(lowerIndex)}:${String(upperIndex)}`;

    if (unorderedPairs.has(pairKey)) {
      context.addIssue({
        code: "custom",
        path: ["edges", edgeIndex, "endpoints"],
        message: "Duplicate unordered vertex pairs are not allowed"
      });
      return;
    }

    unorderedPairs.add(pairKey);
  });

  const expectedPairCount = interpretation.vertices.length * (interpretation.vertices.length - 1) / 2;
  if (unorderedPairs.size !== expectedPairCount) {
    context.addIssue({
      code: "custom",
      path: ["edges"],
      message: "Edges must contain exactly one relation for every unordered vertex pair"
    });
  }
});

export type TwoColourGraphInterpretation = z.infer<typeof TwoColourGraphInterpretationSchema>;

export interface MonochromaticTriangle {
  readonly vertices: readonly [string, string, string];
  readonly relation: TwoColourRelation;
}

function setRelation(
  adjacency: Map<string, Map<string, TwoColourRelation>>,
  from: string,
  to: string,
  relation: TwoColourRelation
): void {
  const existing = adjacency.get(from);
  if (existing !== undefined) {
    existing.set(to, relation);
    return;
  }

  adjacency.set(from, new Map([[to, relation]]));
}

export function findMonochromaticTriangle(
  graph: Pick<TwoColourGraphInterpretation, "vertices" | "edges">
): MonochromaticTriangle | undefined {
  const adjacency = new Map<string, Map<string, TwoColourRelation>>();

  for (const edge of graph.edges) {
    const [left, right] = edge.endpoints;
    setRelation(adjacency, left, right, edge.relation);
    setRelation(adjacency, right, left, edge.relation);
  }

  for (let first = 0; first < graph.vertices.length - 2; first += 1) {
    for (let second = first + 1; second < graph.vertices.length - 1; second += 1) {
      for (let third = second + 1; third < graph.vertices.length; third += 1) {
        const firstVertex = graph.vertices[first];
        const secondVertex = graph.vertices[second];
        const thirdVertex = graph.vertices[third];

        if (firstVertex === undefined || secondVertex === undefined || thirdVertex === undefined) {
          continue;
        }

        const firstSecond = adjacency.get(firstVertex)?.get(secondVertex);
        const firstThird = adjacency.get(firstVertex)?.get(thirdVertex);
        const secondThird = adjacency.get(secondVertex)?.get(thirdVertex);

        if (
          firstSecond !== undefined
          && firstSecond === firstThird
          && firstSecond === secondThird
        ) {
          return {
            vertices: [firstVertex, secondVertex, thirdVertex],
            relation: firstSecond
          };
        }
      }
    }
  }

  return undefined;
}

function unresolved(interpretationConfidence: number, reason: string): VerificationResult {
  return {
    status: "UNRESOLVED",
    interpretationConfidence,
    verifier: TWO_COLOUR_GRAPH_VERIFIER_NAME,
    reason
  };
}

export class TwoColourGraphVerifier implements DeterministicVerifier {
  public async verify(statement: string, interpretationConfidence: number): Promise<VerificationResult> {
    if (!Number.isFinite(interpretationConfidence) || interpretationConfidence < 0 || interpretationConfidence > 1) {
      return unresolved(interpretationConfidence, "Interpretation confidence must be a finite value between 0 and 1");
    }

    if (interpretationConfidence < 1) {
      return unresolved(interpretationConfidence, "Formal interpretation confidence is insufficient");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(statement) as unknown;
    } catch {
      return unresolved(interpretationConfidence, "Formal interpretation is not valid JSON");
    }

    const interpretation = TwoColourGraphInterpretationSchema.safeParse(parsed);
    if (!interpretation.success) {
      return unresolved(interpretationConfidence, "Formal interpretation is malformed, incomplete, or ambiguous");
    }

    const triangle = findMonochromaticTriangle(interpretation.data);
    if (triangle !== undefined) {
      return {
        status: "VERIFIED",
        interpretationConfidence,
        verifier: TWO_COLOUR_GRAPH_VERIFIER_NAME,
        reason: "Encoded complete two-colour graph contains a monochromatic triangle"
      };
    }

    return {
      status: "CONTRADICTED",
      interpretationConfidence,
      verifier: TWO_COLOUR_GRAPH_VERIFIER_NAME,
      reason: "Encoded complete two-colour graph contains no monochromatic triangle"
    };
  }
}
