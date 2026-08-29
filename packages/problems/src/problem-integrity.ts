import type {
  InterviewProblem,
  ProtectedDisclosure,
  ReasoningGraph
} from "../../domain/src/index.js";

export function assertInterviewProblemIntegrity(problem: InterviewProblem): void {
  assertNonBlank(problem.id, "Problem id");
  assertNonBlank(problem.version, "Problem version");
  assertNonBlank(problem.public.prompt, "Public prompt");
  assertNonBlank(problem.private.canonicalSolution, "Canonical solution");
  assertNonBlank(problem.private.verificationNotes, "Verification notes");

  assertReasoningGraphFixtureIntegrity(problem.interviewer.reasoningGraph);
  assertProtectedDisclosureIntegrity(problem);
}

export function assertReasoningGraphFixtureIntegrity(graph: ReasoningGraph): void {
  assertNonBlank(graph.version, "Reasoning graph version");

  const approachIds = assertUniqueIds(
    graph.approaches.map((approach) => approach.id),
    "approach"
  );
  const milestoneIds = assertUniqueIds(
    graph.milestones.map((milestone) => milestone.id),
    "milestone"
  );
  assertUniqueIds(
    graph.commonErrors.map((commonError) => commonError.id),
    "common-error"
  );
  assertUniqueIds(
    graph.extensions.map((extension) => extension.id),
    "extension"
  );

  for (const milestone of graph.milestones) {
    assertUniqueReferences(
      milestone.approachIds,
      `Milestone "${milestone.id}" has duplicate approach reference`
    );
    for (const approachId of milestone.approachIds) {
      if (!approachIds.has(approachId)) {
        throw new Error(
          `Milestone "${milestone.id}" references unknown approach "${approachId}"`
        );
      }
    }

    assertUniqueReferences(
      milestone.optionalPrerequisiteIds,
      `Milestone "${milestone.id}" has duplicate prerequisite`
    );
    for (const prerequisiteId of milestone.optionalPrerequisiteIds) {
      if (prerequisiteId === milestone.id) {
        throw new Error(
          `Milestone "${milestone.id}" cannot require itself as a prerequisite`
        );
      }
      if (!milestoneIds.has(prerequisiteId)) {
        throw new Error(
          `Milestone "${milestone.id}" references unknown prerequisite "${prerequisiteId}"`
        );
      }
    }

    assertUniqueReferences(
      milestone.protectedDisclosureIds,
      `Milestone "${milestone.id}" has duplicate protected-disclosure reference`
    );
  }

  assertReasoningEdgesFormDag(graph, milestoneIds);
}

export function normalizeDisclosureFormulation(formulation: string): string {
  return formulation
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ")
    .toLowerCase();
}

function assertProtectedDisclosureIntegrity(problem: InterviewProblem): void {
  const disclosureIds = new Set<string>();

  for (const disclosure of problem.interviewer.protectedDisclosures) {
    if (disclosureIds.has(disclosure.id)) {
      throw new Error(`Duplicate protected disclosure ID "${disclosure.id}"`);
    }
    disclosureIds.add(disclosure.id);
    assertDisclosureContent(disclosure);
  }

  for (const milestone of problem.interviewer.reasoningGraph.milestones) {
    for (const disclosureId of milestone.protectedDisclosureIds) {
      if (!disclosureIds.has(disclosureId)) {
        throw new Error(
          `Milestone "${milestone.id}" references unknown protected disclosure "${disclosureId}"`
        );
      }
    }
  }
}

function assertDisclosureContent(disclosure: ProtectedDisclosure): void {
  assertNonBlank(
    disclosure.fact,
    `Protected disclosure "${disclosure.id}" fact`
  );

  if (disclosure.equivalentFormulations.length === 0) {
    throw new Error(
      `Protected disclosure "${disclosure.id}" must define at least one equivalent formulation`
    );
  }

  const normalized = new Set<string>();
  for (const formulation of disclosure.equivalentFormulations) {
    assertNonBlank(
      formulation,
      `Protected disclosure "${disclosure.id}" equivalent formulation`
    );
    const normalizedFormulation = normalizeDisclosureFormulation(formulation);
    if (normalized.has(normalizedFormulation)) {
      throw new Error(
        `Protected disclosure "${disclosure.id}" has duplicate equivalent formulation after normalization: "${normalizedFormulation}"`
      );
    }
    normalized.add(normalizedFormulation);
  }
}

function assertReasoningEdgesFormDag(
  graph: ReasoningGraph,
  milestoneIds: ReadonlySet<string>
): void {
  const edgeKeys = new Set<string>();
  const adjacency = new Map<string, string[]>();
  const indegree = new Map<string, number>();

  for (const milestoneId of milestoneIds) {
    adjacency.set(milestoneId, []);
    indegree.set(milestoneId, 0);
  }

  for (const edge of graph.edges) {
    if (!milestoneIds.has(edge.from)) {
      throw new Error(`Reasoning edge references unknown source milestone "${edge.from}"`);
    }
    if (!milestoneIds.has(edge.to)) {
      throw new Error(`Reasoning edge references unknown target milestone "${edge.to}"`);
    }
    if (edge.from === edge.to) {
      throw new Error(`Reasoning graph cannot contain self-edge "${edge.from}" -> "${edge.to}"`);
    }

    const edgeKey = JSON.stringify([edge.from, edge.to]);
    if (edgeKeys.has(edgeKey)) {
      throw new Error(`Duplicate reasoning edge "${edge.from}" -> "${edge.to}"`);
    }
    edgeKeys.add(edgeKey);

    adjacency.get(edge.from)?.push(edge.to);
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }

  const roots = graph.milestones
    .map((milestone) => milestone.id)
    .filter((milestoneId) => indegree.get(milestoneId) === 0);
  const queue = [...roots];
  let cursor = 0;
  let visitedCount = 0;

  while (cursor < queue.length) {
    const milestoneId = queue[cursor];
    cursor += 1;
    if (milestoneId === undefined) continue;

    visitedCount += 1;
    for (const next of adjacency.get(milestoneId) ?? []) {
      const remaining = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }

  if (visitedCount !== graph.milestones.length) {
    throw new Error("Reasoning graph must be acyclic");
  }

  const reachable = new Set<string>();
  const reachabilityQueue = [...roots];
  let reachabilityCursor = 0;

  while (reachabilityCursor < reachabilityQueue.length) {
    const milestoneId = reachabilityQueue[reachabilityCursor];
    reachabilityCursor += 1;
    if (milestoneId === undefined || reachable.has(milestoneId)) continue;

    reachable.add(milestoneId);
    for (const next of adjacency.get(milestoneId) ?? []) {
      if (!reachable.has(next)) reachabilityQueue.push(next);
    }
  }

  const unreachable = graph.milestones
    .map((milestone) => milestone.id)
    .filter((milestoneId) => !reachable.has(milestoneId));
  if (unreachable.length > 0) {
    throw new Error(
      `Reasoning graph contains milestone(s) unreachable from every graph root: ${unreachable.join(", ")}`
    );
  }
}

function assertUniqueIds(values: readonly string[], label: string): ReadonlySet<string> {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new Error(`Duplicate ${label} ID "${value}"`);
    }
    seen.add(value);
  }
  return seen;
}

function assertUniqueReferences(
  values: readonly string[],
  messagePrefix: string
): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new Error(`${messagePrefix} "${value}"`);
    }
    seen.add(value);
  }
}

function assertNonBlank(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${label} must be non-empty after trimming`);
  }
}
