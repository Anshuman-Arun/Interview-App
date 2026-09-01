import {
  ProtectedDisclosureSchema,
  ReasoningGraphSchema,
  type InterviewProblem,
  type ProtectedDisclosure,
  type ReasoningGraph
} from "../../domain/src/index.js";

const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/u;

export function assertInterviewProblemIntegrity(problem: InterviewProblem): void {
  assertNonBlank(problem.id, "Problem id");
  assertSemanticVersion(problem.version, "Problem version");
  assertNonBlank(problem.public.prompt, "Public prompt");
  assertNonBlank(problem.private.canonicalSolution, "Canonical solution");
  assertNonBlank(problem.private.verificationNotes, "Verification notes");
  assertNonBlank(problem.interviewer.difficulty, "Problem difficulty");

  assertStringList(problem.public.givenInformation, "Given information", false);
  assertStringList(problem.interviewer.topics, "Problem topic", true);
  const reasoningGraph = ReasoningGraphSchema.parse(problem.interviewer.reasoningGraph);
  assertReasoningGraphFixtureIntegrity(reasoningGraph);
  assertProtectedDisclosureIntegrity(problem, reasoningGraph);
}

export function assertReasoningGraphFixtureIntegrity(graph: ReasoningGraph): void {
  const parsedGraph = ReasoningGraphSchema.parse(graph);
  assertSemanticVersion(parsedGraph.version, "Reasoning graph version");
  if (parsedGraph.approaches.length === 0) throw new Error("Reasoning graph must define at least one approach");
  if (parsedGraph.milestones.length === 0) throw new Error("Reasoning graph must define at least one milestone");

  const approachIds = assertUniqueIds(
    parsedGraph.approaches.map((approach) => approach.id),
    "approach"
  );
  for (const approach of parsedGraph.approaches) {
    assertNonBlank(approach.label, `Approach "${approach.id}" label`);
  }

  const milestoneIds = assertUniqueIds(
    parsedGraph.milestones.map((milestone) => milestone.id),
    "milestone"
  );
  assertUniqueIds(
    parsedGraph.commonErrors.map((commonError) => commonError.id),
    "common-error"
  );
  assertUniqueIds(
    parsedGraph.extensions.map((extension) => extension.id),
    "extension"
  );

  for (const commonError of parsedGraph.commonErrors) {
    assertNonBlank(commonError.description, `Common error "${commonError.id}" description`);
  }
  for (const extension of parsedGraph.extensions) {
    assertNonBlank(extension.prompt, `Extension "${extension.id}" prompt`);
  }

  const referencedApproaches = new Set<string>();
  for (const milestone of parsedGraph.milestones) {
    assertNonBlank(milestone.description, `Milestone "${milestone.id}" description`);
    if (milestone.approachIds.length === 0) {
      throw new Error(`Milestone "${milestone.id}" must reference at least one approach`);
    }
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
      referencedApproaches.add(approachId);
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

  const unusedApproaches = [...approachIds].filter((id) => !referencedApproaches.has(id));
  if (unusedApproaches.length > 0) {
    throw new Error(`Reasoning graph contains unused approach(es): ${unusedApproaches.join(", ")}`);
  }

  assertReasoningEdgesFormDag(parsedGraph, milestoneIds);
  assertPrerequisiteAndEdgeConsistency(parsedGraph, milestoneIds);
  assertApproachPathsCoherent(parsedGraph);
}

export function normalizeDisclosureFormulation(formulation: string): string {
  return formulation
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ")
    .toLowerCase();
}

function assertProtectedDisclosureIntegrity(
  problem: InterviewProblem,
  reasoningGraph: ReasoningGraph
): void {
  const disclosureIds = new Set<string>();
  const referencedDisclosureIds = new Set<string>();
  const phraseOwners = new Map<string, string>();

  for (const disclosure of problem.interviewer.protectedDisclosures) {
    if (disclosureIds.has(disclosure.id)) {
      throw new Error(`Duplicate protected disclosure ID "${disclosure.id}"`);
    }
    disclosureIds.add(disclosure.id);
    assertDisclosureContent(disclosure);

    for (const phrase of [disclosure.fact, ...disclosure.equivalentFormulations]) {
      const normalized = normalizeDisclosureFormulation(phrase);
      const existingOwner = phraseOwners.get(normalized);
      if (existingOwner !== undefined && existingOwner !== disclosure.id) {
        throw new Error(
          `Protected disclosure phrase "${normalized}" is shared by "${existingOwner}" and "${disclosure.id}"`
        );
      }
      phraseOwners.set(normalized, disclosure.id);
    }
  }

  for (const milestone of reasoningGraph.milestones) {
    for (const disclosureId of milestone.protectedDisclosureIds) {
      if (!disclosureIds.has(disclosureId)) {
        throw new Error(
          `Milestone "${milestone.id}" references unknown protected disclosure "${disclosureId}"`
        );
      }
      referencedDisclosureIds.add(disclosureId);
    }
  }

  const unusedDisclosures = [...disclosureIds].filter((id) => !referencedDisclosureIds.has(id));
  if (unusedDisclosures.length > 0) {
    throw new Error(`Problem contains unreferenced protected disclosure(s): ${unusedDisclosures.join(", ")}`);
  }
}

function assertDisclosureContent(disclosure: ProtectedDisclosure): void {
  ProtectedDisclosureSchema.parse(disclosure);
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

function assertPrerequisiteAndEdgeConsistency(
  graph: ReasoningGraph,
  milestoneIds: ReadonlySet<string>
): void {
  const incomingSourcesByMilestone = new Map<string, Set<string>>();
  for (const milestoneId of milestoneIds) {
    incomingSourcesByMilestone.set(milestoneId, new Set());
  }
  for (const edge of graph.edges) {
    incomingSourcesByMilestone.get(edge.to)?.add(edge.from);
  }

  for (const milestone of graph.milestones) {
    const incomingSources = incomingSourcesByMilestone.get(milestone.id) ?? new Set();
    const declaredPrerequisites = new Set(milestone.optionalPrerequisiteIds);

    for (const prereq of declaredPrerequisites) {
      if (!incomingSources.has(prereq)) {
        throw new Error(
          `Milestone "${milestone.id}" declares prerequisite "${prereq}" without a corresponding incoming graph edge`
        );
      }
    }

    for (const incoming of incomingSources) {
      if (!declaredPrerequisites.has(incoming)) {
        throw new Error(
          `Milestone "${milestone.id}" has incoming graph edge from "${incoming}" but does not declare it as a prerequisite`
        );
      }
    }
  }
}

function assertApproachPathsCoherent(graph: ReasoningGraph): void {
  for (const approach of graph.approaches) {
    const approachMilestones = graph.milestones.filter((m) =>
      m.approachIds.includes(approach.id)
    );
    if (approachMilestones.length === 0) {
      throw new Error(`Approach "${approach.id}" has no associated milestones`);
    }

    const approachMilestoneIds = new Set(approachMilestones.map((m) => m.id));
    const approachAdjacency = new Map<string, string[]>();
    const approachIndegree = new Map<string, number>();

    for (const m of approachMilestones) {
      approachAdjacency.set(m.id, []);
      approachIndegree.set(m.id, 0);
    }

    for (const edge of graph.edges) {
      if (approachMilestoneIds.has(edge.from) && approachMilestoneIds.has(edge.to)) {
        approachAdjacency.get(edge.from)?.push(edge.to);
        approachIndegree.set(edge.to, (approachIndegree.get(edge.to) ?? 0) + 1);
      }
    }

    const approachRoots = approachMilestones
      .filter(
        (m) =>
          (approachIndegree.get(m.id) ?? 0) === 0 &&
          m.optionalPrerequisiteIds.length === 0
      )
      .map((m) => m.id);

    if (approachRoots.length === 0) {
      throw new Error(`Approach "${approach.id}" has no entry milestone`);
    }

    const reachableInApproach = new Set<string>();
    const approachQueue = [...approachRoots];
    let cursor = 0;

    while (cursor < approachQueue.length) {
      const current = approachQueue[cursor];
      cursor += 1;
      if (current === undefined || reachableInApproach.has(current)) continue;

      reachableInApproach.add(current);
      for (const next of approachAdjacency.get(current) ?? []) {
        if (!reachableInApproach.has(next)) approachQueue.push(next);
      }
    }

    const disconnected = approachMilestones
      .map((m) => m.id)
      .filter((id) => !reachableInApproach.has(id));

    if (disconnected.length > 0) {
      throw new Error(
        `Approach "${approach.id}" contains disconnected milestone(s): ${disconnected.join(", ")}`
      );
    }
  }
}

function assertUniqueIds(values: readonly string[], label: string): ReadonlySet<string> {
  const seen = new Set<string>();
  for (const value of values) {
    assertNonBlank(value, `${capitalize(label)} id`);
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

function assertStringList(values: readonly string[], label: string, requireOne: boolean): void {
  if (requireOne && values.length === 0) throw new Error(`${label} list must not be empty`);
  const seen = new Set<string>();
  for (const value of values) {
    assertNonBlank(value, label);
    const normalized = value.normalize("NFKC").trim().toLowerCase();
    if (seen.has(normalized)) throw new Error(`Duplicate ${label.toLowerCase()} "${value.trim()}"`);
    seen.add(normalized);
  }
}

function assertSemanticVersion(value: string, label: string): void {
  assertNonBlank(value, label);
  if (!SEMVER_PATTERN.test(value.trim())) {
    throw new Error(`${label} must use MAJOR.MINOR.PATCH numeric format`);
  }
}

function assertNonBlank(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${label} must be non-empty after trimming`);
  }
}

function capitalize(value: string): string {
  return value.length === 0 ? value : value.charAt(0).toUpperCase() + value.slice(1);
}
