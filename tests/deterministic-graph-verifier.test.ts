import { describe, expect, it } from "vitest";
import {
  TWO_COLOUR_GRAPH_PROTOCOL,
  TWO_COLOUR_GRAPH_PROTOCOL_VERSION,
  TwoColourGraphInterpretationSchema,
  TwoColourGraphVerifier,
  findMonochromaticTriangle,
  type TwoColourGraphInterpretation,
  type TwoColourRelation
} from "../packages/verification/src/index.js";

const verticesK6 = ["A", "B", "C", "D", "E", "F"] as const;
const verticesK5 = ["A", "B", "C", "D", "E"] as const;

function unorderedPairs(vertices: readonly string[]): Array<readonly [string, string]> {
  const pairs: Array<readonly [string, string]> = [];
  for (let left = 0; left < vertices.length - 1; left += 1) {
    for (let right = left + 1; right < vertices.length; right += 1) {
      const leftVertex = vertices[left];
      const rightVertex = vertices[right];
      if (leftVertex !== undefined && rightVertex !== undefined) {
        pairs.push([leftVertex, rightVertex]);
      }
    }
  }
  return pairs;
}

function interpretation(
  vertices: readonly string[],
  relationForPair: (left: string, right: string) => TwoColourRelation
): TwoColourGraphInterpretation {
  return TwoColourGraphInterpretationSchema.parse({
    protocol: TWO_COLOUR_GRAPH_PROTOCOL,
    protocolVersion: TWO_COLOUR_GRAPH_PROTOCOL_VERSION,
    problemId: "oxford-six-people",
    problemVersion: "1.0.0",
    claim: "ENCODED_GRAPH_HAS_MONOCHROMATIC_TRIANGLE",
    vertices: [...vertices],
    edges: unorderedPairs(vertices).map(([left, right]) => ({
      endpoints: [left, right],
      relation: relationForPair(left, right)
    }))
  });
}

function statement(value: unknown): string {
  return JSON.stringify(value);
}

const verifier = new TwoColourGraphVerifier();

describe("deterministic Oxford two-colour graph verifier", () => {
  it("returns VERIFIED for a complete K6 colouring with a monochromatic triangle", async () => {
    const graph = interpretation(verticesK6, () => "ACQUAINTANCE");
    const result = await verifier.verify(statement(graph), 1);

    expect(result).toEqual({
      status: "VERIFIED",
      interpretationConfidence: 1,
      verifier: "oxford-two-colour-graph-verifier@1",
      reason: "Encoded complete two-colour graph contains a monochromatic triangle"
    });
  });

  it("returns CONTRADICTED for the standard five-cycle/complement K5 colouring", async () => {
    const cycleEdges = new Set(["A:B", "B:C", "C:D", "D:E", "A:E"]);
    const graph = interpretation(verticesK5, (left, right) =>
      cycleEdges.has(`${left}:${right}`) ? "ACQUAINTANCE" : "STRANGER"
    );

    expect(findMonochromaticTriangle(graph)).toBeUndefined();

    const result = await verifier.verify(statement(graph), 1);
    expect(result.status).toBe("CONTRADICTED");
    expect(result.interpretationConfidence).toBe(1);
  });

  it("returns UNRESOLVED for an incomplete graph", async () => {
    const graph = interpretation(verticesK6, () => "ACQUAINTANCE");
    const incomplete = { ...graph, edges: graph.edges.slice(0, -1) };

    const result = await verifier.verify(statement(incomplete), 1);
    expect(result.status).toBe("UNRESOLVED");
  });

  it("returns UNRESOLVED for a reversed duplicate unordered edge", async () => {
    const graph = interpretation(verticesK6, () => "ACQUAINTANCE");
    const firstEdge = graph.edges[0];
    expect(firstEdge).toBeDefined();
    if (firstEdge === undefined) return;

    const duplicate = {
      ...graph,
      edges: [
        ...graph.edges,
        {
          endpoints: [firstEdge.endpoints[1], firstEdge.endpoints[0]],
          relation: firstEdge.relation
        }
      ]
    };

    const result = await verifier.verify(statement(duplicate), 1);
    expect(result.status).toBe("UNRESOLVED");
  });

  it.each([
    {
      name: "unknown vertex",
      mutate: (graph: TwoColourGraphInterpretation) => ({
        ...graph,
        edges: [{ endpoints: ["A", "UNKNOWN"], relation: "ACQUAINTANCE" }, ...graph.edges.slice(1)]
      })
    },
    {
      name: "self-edge",
      mutate: (graph: TwoColourGraphInterpretation) => ({
        ...graph,
        edges: [{ endpoints: ["A", "A"], relation: "ACQUAINTANCE" }, ...graph.edges.slice(1)]
      })
    }
  ])("returns UNRESOLVED for an $name", async ({ mutate }) => {
    const graph = interpretation(verticesK6, () => "ACQUAINTANCE");
    const result = await verifier.verify(statement(mutate(graph)), 1);
    expect(result.status).toBe("UNRESOLVED");
  });

  it("returns UNRESOLVED when interpretation confidence is below one and preserves it", async () => {
    const graph = interpretation(verticesK6, () => "ACQUAINTANCE");
    const result = await verifier.verify(statement(graph), 0.999);

    expect(result.status).toBe("UNRESOLVED");
    expect(result.interpretationConfidence).toBe(0.999);
  });

  it("returns UNRESOLVED for malformed JSON", async () => {
    const result = await verifier.verify("{not-json", 1);
    expect(result.status).toBe("UNRESOLVED");
  });

  it("returns the same result on repeated verification", async () => {
    const graph = interpretation(verticesK6, (left, right) =>
      left === "A" || right === "A" ? "STRANGER" : "ACQUAINTANCE"
    );
    const encoded = statement(graph);

    const first = await verifier.verify(encoded, 1);
    const second = await verifier.verify(encoded, 1);

    expect(second).toEqual(first);
  });

  it("finds a monochromatic triangle in every two-colouring of K6", () => {
    const pairs = unorderedPairs(verticesK6);
    const colouringCount = 2 ** pairs.length;

    for (let mask = 0; mask < colouringCount; mask += 1) {
      const edges = pairs.map(([left, right], pairIndex) => ({
        endpoints: [left, right] as [string, string],
        relation: ((mask & (1 << pairIndex)) === 0 ? "ACQUAINTANCE" : "STRANGER") as TwoColourRelation
      }));

      const triangle = findMonochromaticTriangle({
        vertices: [...verticesK6],
        edges
      });

      expect(triangle, `missing triangle for colouring mask ${String(mask)}`).toBeDefined();
    }
  });

  it("strict schemas reject arbitrary extra fields", () => {
    const graph = interpretation(verticesK6, () => "ACQUAINTANCE");

    expect(TwoColourGraphInterpretationSchema.safeParse({
      ...graph,
      arbitrary: true
    }).success).toBe(false);

    const firstEdge = graph.edges[0];
    expect(firstEdge).toBeDefined();
    if (firstEdge === undefined) return;

    expect(TwoColourGraphInterpretationSchema.safeParse({
      ...graph,
      edges: [
        { ...firstEdge, arbitrary: true },
        ...graph.edges.slice(1)
      ]
    }).success).toBe(false);
  });
});
