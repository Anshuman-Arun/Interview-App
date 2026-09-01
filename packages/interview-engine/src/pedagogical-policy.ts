import { z } from "zod";
import {
  DisclosureIdSchema,
  DisclosureLevelSchema,
  EvidenceKeySchema,
  EvidenceValueSchema,
  GenerationBasisSchema,
  ProtectedDisclosureSchema,
  RealizationRequestSchema,
  ReasoningGraphSchema,
  VerificationResultSchema,
  evidenceKeyToString,
  isDisclosedStatus,
  isEvidenceValueAllowed,
  type DisclosureId,
  type DisclosureLevel,
  type EvidenceKey,
  type EvidenceValue,
  type InterviewProblem,
  type RealizationRequest,
  type SocraticAction
} from "../../domain/src/index.js";
import {
  isGenerationBasisStillCompatible,
  type SessionState
} from "../../events/src/index.js";
import { createProviderContextSpecFingerprintSync } from "./context-compiler.js";

const MAX_APPROACHES = 256;
const MAX_MILESTONES = 2_048;
const MAX_GRAPH_EDGES = 8_192;
const MAX_PROTECTED_DISCLOSURES = 1_024;
const MAX_EVIDENCE_KEYS = 4_096;
const MAX_EVIDENCE_RECORDS = 16_384;
const MAX_DELIVERIES = 4_096;
const MAX_VERIFICATION_REQUESTS = 2_048;
const MAX_EVENT_IDS = 100_000;
const MAX_POLICY_ID_CHARACTERS = 512;
const MAX_POLICY_TEXT_CHARACTERS = 100_000;
const MAX_APPROACH_REFS_PER_MILESTONE = 256;
const MAX_PREREQUISITES_PER_MILESTONE = 2_048;
const MAX_DISCLOSURE_REFS_PER_MILESTONE = 256;
const MAX_EQUIVALENT_FORMULATIONS_PER_DISCLOSURE = 256;
const MAX_COMMON_ERRORS = 2_048;
const MAX_EXTENSIONS = 2_048;
const MAX_EVIDENCE_PROVENANCE_IDS = 4_096;
const MIN_ACTIONABLE_EVIDENCE_CONFIDENCE = 0.7;

const PolicyDeliverySchema = z.object({
  deliveryId: z.string().min(1).max(MAX_POLICY_ID_CHARACTERS),
  generationId: z.string().min(1).max(MAX_POLICY_ID_CHARACTERS),
  disclosureIds: z.array(DisclosureIdSchema).max(MAX_DISCLOSURE_REFS_PER_MILESTONE),
  effectiveDisclosureLevel: DisclosureLevelSchema,
  status: z.enum([
    "VALIDATED", "QUEUED", "DELIVERING", "EXPOSED", "COMPLETED", "CANCELLED", "POSSIBLY_EXPOSED"
  ])
});

const PolicyProblemViewSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  interviewer: z.object({
    reasoningGraph: ReasoningGraphSchema,
    protectedDisclosures: z.array(ProtectedDisclosureSchema).max(MAX_PROTECTED_DISCLOSURES)
  })
});

type PolicyProblemView = z.infer<typeof PolicyProblemViewSchema>;
type EvidenceSubject = EvidenceKey["subject"];

export type ProgressClassification =
  | "PRODUCTIVE_PROGRESS"
  | "LOCAL_ERROR"
  | "STRUCTURAL_ERROR"
  | "UNSUPPORTED_CLAIM"
  | "AMBIGUOUS_STATEMENT"
  | "MISUNDERSTANDING"
  | "TRUE_STAGNATION"
  | "REPEATED_STAGNATION"
  | "UNEXPECTED_VALID_APPROACH"
  | "COMPLETED_PRIMARY_APPROACH"
  | "INSUFFICIENT_EVIDENCE";

export type InterventionStage =
  | "OBSERVE"
  | "PROBE"
  | "FOCUS"
  | "NUDGE"
  | "HINT"
  | "SATURATED";

export type PolicyReasonCode =
  | "PROGRESS_CONTINUES"
  | "ALTERNATE_APPROACH_PROGRESS"
  | "LOCAL_CORRECTION_NEEDED"
  | "STRUCTURAL_REFRAMING_NEEDED"
  | "JUSTIFICATION_MISSING"
  | "STATEMENT_AMBIGUOUS"
  | "PROBLEM_MISUNDERSTOOD"
  | "PROGRESS_STALLED"
  | "STAGNATION_PERSISTS_AFTER_ASSISTANCE"
  | "PRIMARY_APPROACH_COMPLETE"
  | "NO_CURRENT_EVIDENCE"
  | "VERIFICATION_UNRESOLVED"
  | "CONFLICTING_ACTIVE_SIGNALS"
  | "MALFORMED_POLICY_INPUT"
  | "INVALID_REASONING_TARGET"
  | "RESOURCE_LIMIT_EXCEEDED"
  | "PROBLEM_CONTEXT_MISMATCH"
  | "PROBLEM_PROVENANCE_UNKNOWN"
  | "PROBLEM_DEFINITION_MISMATCH"
  | "MISSING_PROBLEM_CONTEXT"
  | "ASSISTANCE_SATURATED";

export interface PolicyTarget {
  readonly kind: EvidenceSubject["kind"] | "TURN";
  readonly id: string;
}

export interface PolicyDecision {
  readonly classification: ProgressClassification;
  readonly interventionStage: InterventionStage;
  readonly reasonCode: PolicyReasonCode;
  readonly realizationRequest: RealizationRequest;
  readonly waitingPreferred: boolean;
  readonly escalationJustified: boolean;
  readonly target?: PolicyTarget;
}

interface ActiveEvidenceSignal {
  readonly key: EvidenceKey;
  readonly value: EvidenceValue;
  readonly target: PolicyTarget;
  readonly canonicalKey: string;
}

interface VerificationSignal {
  readonly target: PolicyTarget;
  readonly status: "VERIFIED" | "CONTRADICTED" | "UNRESOLVED";
  readonly sequence: number;
}

interface AssistanceRecord {
  readonly generationId: string;
  readonly action: SocraticAction;
  readonly target: string;
  readonly maximumDisclosure: DisclosureLevel;
  readonly effectiveDisclosureLevel: DisclosureLevel;
  readonly turnSequence: number;
}

interface AssistanceSnapshot {
  readonly records: readonly AssistanceRecord[];
  readonly disclosedIds: ReadonlySet<DisclosureId>;
}

interface GraphContext {
  readonly problem: PolicyProblemView;
  readonly approachIds: ReadonlySet<string>;
  readonly milestoneIds: ReadonlySet<string>;
  readonly disclosureIds: ReadonlySet<DisclosureId>;
  readonly predecessors: ReadonlyMap<string, readonly string[]>;
}

type CollectionResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reasonCode: PolicyReasonCode };

interface ClassificationResult {
  readonly classification: ProgressClassification;
  readonly reasonCode: PolicyReasonCode;
  readonly target: PolicyTarget;
  readonly verificationStatus?: VerificationSignal["status"];
  readonly completedApproachId?: string;
  readonly alternateApproachId?: string;
}

interface ActionPlan {
  readonly action: SocraticAction;
  readonly requestedDisclosure: DisclosureLevel;
  readonly stage: InterventionStage;
  readonly escalationJustified: boolean;
  readonly reasonCode?: PolicyReasonCode;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function targetFromSubject(subject: EvidenceSubject): PolicyTarget {
  switch (subject.kind) {
    case "CLAIM":
      return { kind: "CLAIM", id: subject.claimId };
    case "MILESTONE":
      return { kind: "MILESTONE", id: subject.milestoneId };
    case "SKILL":
      return { kind: "SKILL", id: subject.skillId };
    case "APPROACH":
      return { kind: "APPROACH", id: subject.approachId };
  }
}

function targetToString(target: PolicyTarget): string {
  return target.kind.toLowerCase() + ":" + target.id;
}

function sameTarget(left: PolicyTarget, right: PolicyTarget): boolean {
  return left.kind === right.kind && left.id === right.id;
}

function compareSignals(left: ActiveEvidenceSignal, right: ActiveEvidenceSignal): number {
  if (left.value.lastUpdatedSequence !== right.value.lastUpdatedSequence) {
    return right.value.lastUpdatedSequence - left.value.lastUpdatedSequence;
  }
  return left.canonicalKey.localeCompare(right.canonicalKey);
}

function compareVerification(left: VerificationSignal, right: VerificationSignal): number {
  if (left.sequence !== right.sequence) return right.sequence - left.sequence;
  return targetToString(left.target).localeCompare(targetToString(right.target));
}

function evidenceValuesEqual(left: EvidenceValue, right: EvidenceValue): boolean {
  return left.value === right.value
    && left.inferenceConfidence === right.inferenceConfidence
    && left.lastUpdatedSequence === right.lastUpdatedSequence
    && left.evidenceEventIds.length === right.evidenceEventIds.length
    && left.evidenceEventIds.every((eventId, index) => eventId === right.evidenceEventIds[index]);
}

function failClosedDecision(
  turnId: string,
  reasonCode: PolicyReasonCode,
  action: SocraticAction = "CLARIFY"
): PolicyDecision {
  const target: PolicyTarget = { kind: "TURN", id: turnId };
  return {
    classification: reasonCode === "NO_CURRENT_EVIDENCE" || reasonCode === "MISSING_PROBLEM_CONTEXT"
      ? "INSUFFICIENT_EVIDENCE"
      : "AMBIGUOUS_STATEMENT",
    interventionStage: "PROBE",
    reasonCode,
    realizationRequest: RealizationRequestSchema.parse({
      requiredAction: action,
      target: targetToString(target),
      maximumDisclosure: 0
    }),
    waitingPreferred: false,
    escalationJustified: false,
    target
  };
}

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string"
    && value.length <= maximum
    && value.trim().length > 0;
}

function hasOnlyKeys(record: Readonly<Record<string, unknown>>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(record).every((key) => allowed.has(key));
}

function preflightPolicyProblem(problem: unknown): PolicyReasonCode | undefined {
  if (
    !isRecord(problem)
    || !hasOnlyKeys(problem, new Set(["id", "version", "public", "interviewer", "private"]))
    || !boundedString(problem["id"], MAX_POLICY_ID_CHARACTERS)
    || !boundedString(problem["version"], MAX_POLICY_ID_CHARACTERS)
  ) {
    return "MALFORMED_POLICY_INPUT";
  }

  const publicProblem = problem["public"];
  const interviewer = problem["interviewer"];
  if (!isRecord(publicProblem) || !isRecord(interviewer)) return "MALFORMED_POLICY_INPUT";
  if (
    !hasOnlyKeys(publicProblem, new Set(["prompt", "givenInformation"]))
    || !hasOnlyKeys(interviewer, new Set(["topics", "difficulty", "reasoningGraph", "protectedDisclosures"]))
  ) return "MALFORMED_POLICY_INPUT";

  const givenInformation = publicProblem["givenInformation"];
  const topics = interviewer["topics"];
  if (
    !boundedString(publicProblem["prompt"], MAX_POLICY_TEXT_CHARACTERS)
    || !Array.isArray(givenInformation)
    || givenInformation.length > MAX_MILESTONES
    || !(givenInformation as readonly unknown[]).every((item) => boundedString(item, MAX_POLICY_TEXT_CHARACTERS))
    || !Array.isArray(topics)
    || topics.length > MAX_MILESTONES
    || !(topics as readonly unknown[]).every((item) => boundedString(item, MAX_POLICY_ID_CHARACTERS))
    || !boundedString(interviewer["difficulty"], MAX_POLICY_ID_CHARACTERS)
  ) return "MALFORMED_POLICY_INPUT";

  const graph = interviewer["reasoningGraph"];
  const disclosures = interviewer["protectedDisclosures"];
  if (!isRecord(graph) || !Array.isArray(disclosures)) return "MALFORMED_POLICY_INPUT";
  if (
    !hasOnlyKeys(graph, new Set(["version", "approaches", "milestones", "edges", "commonErrors", "extensions"]))
    || !boundedString(graph["version"], MAX_POLICY_ID_CHARACTERS)
  ) return "MALFORMED_POLICY_INPUT";
  if (disclosures.length > MAX_PROTECTED_DISCLOSURES) return "RESOURCE_LIMIT_EXCEEDED";

  const approaches = graph["approaches"];
  const milestones = graph["milestones"];
  const edges = graph["edges"];
  const commonErrors = graph["commonErrors"];
  const extensions = graph["extensions"];
  if (
    !Array.isArray(approaches)
    || !Array.isArray(milestones)
    || !Array.isArray(edges)
    || !Array.isArray(commonErrors)
    || !Array.isArray(extensions)
  ) return "MALFORMED_POLICY_INPUT";
  if (
    approaches.length > MAX_APPROACHES
    || milestones.length > MAX_MILESTONES
    || edges.length > MAX_GRAPH_EDGES
    || commonErrors.length > MAX_COMMON_ERRORS
    || extensions.length > MAX_EXTENSIONS
  ) return "RESOURCE_LIMIT_EXCEEDED";

  for (const approach of approaches as readonly unknown[]) {
    if (
      !isRecord(approach)
      || !hasOnlyKeys(approach, new Set(["id", "label"]))
      || !boundedString(approach["id"], MAX_POLICY_ID_CHARACTERS)
      || !boundedString(approach["label"], MAX_POLICY_TEXT_CHARACTERS)
    ) return "MALFORMED_POLICY_INPUT";
  }

  for (const milestone of milestones as readonly unknown[]) {
    if (
      !isRecord(milestone)
      || !hasOnlyKeys(milestone, new Set([
        "id", "description", "approachIds", "optionalPrerequisiteIds", "protectedDisclosureIds"
      ]))
    ) return "MALFORMED_POLICY_INPUT";
    const approachIds = milestone["approachIds"];
    const prerequisiteIds = milestone["optionalPrerequisiteIds"];
    const disclosureIds = milestone["protectedDisclosureIds"];
    if (
      !boundedString(milestone["id"], MAX_POLICY_ID_CHARACTERS)
      || !boundedString(milestone["description"], MAX_POLICY_TEXT_CHARACTERS)
      || !Array.isArray(approachIds)
      || !Array.isArray(prerequisiteIds)
      || !Array.isArray(disclosureIds)
    ) return "MALFORMED_POLICY_INPUT";
    if (
      approachIds.length > MAX_APPROACH_REFS_PER_MILESTONE
      || prerequisiteIds.length > MAX_PREREQUISITES_PER_MILESTONE
      || disclosureIds.length > MAX_DISCLOSURE_REFS_PER_MILESTONE
    ) return "RESOURCE_LIMIT_EXCEEDED";
    if (
      !(approachIds as readonly unknown[]).every((id) => boundedString(id, MAX_POLICY_ID_CHARACTERS))
      || !(prerequisiteIds as readonly unknown[]).every((id) => boundedString(id, MAX_POLICY_ID_CHARACTERS))
      || !(disclosureIds as readonly unknown[]).every((id) => boundedString(id, MAX_POLICY_ID_CHARACTERS))
    ) return "MALFORMED_POLICY_INPUT";
  }

  for (const edge of edges as readonly unknown[]) {
    if (
      !isRecord(edge)
      || !hasOnlyKeys(edge, new Set(["from", "to"]))
      || !boundedString(edge["from"], MAX_POLICY_ID_CHARACTERS)
      || !boundedString(edge["to"], MAX_POLICY_ID_CHARACTERS)
    ) return "MALFORMED_POLICY_INPUT";
  }

  for (const commonError of commonErrors as readonly unknown[]) {
    if (
      !isRecord(commonError)
      || !hasOnlyKeys(commonError, new Set(["id", "description"]))
      || !boundedString(commonError["id"], MAX_POLICY_ID_CHARACTERS)
      || !boundedString(commonError["description"], MAX_POLICY_TEXT_CHARACTERS)
    ) return "MALFORMED_POLICY_INPUT";
  }

  for (const extension of extensions as readonly unknown[]) {
    if (
      !isRecord(extension)
      || !hasOnlyKeys(extension, new Set(["id", "prompt"]))
      || !boundedString(extension["id"], MAX_POLICY_ID_CHARACTERS)
      || !boundedString(extension["prompt"], MAX_POLICY_TEXT_CHARACTERS)
    ) return "MALFORMED_POLICY_INPUT";
  }

  for (const disclosure of disclosures as readonly unknown[]) {
    if (
      !isRecord(disclosure)
      || !hasOnlyKeys(disclosure, new Set([
        "id", "fact", "minimumDisclosureLevel", "equivalentFormulations"
      ]))
    ) return "MALFORMED_POLICY_INPUT";
    const formulations = disclosure["equivalentFormulations"];
    if (
      !boundedString(disclosure["id"], MAX_POLICY_ID_CHARACTERS)
      || !boundedString(disclosure["fact"], MAX_POLICY_TEXT_CHARACTERS)
      || !Array.isArray(formulations)
    ) return "MALFORMED_POLICY_INPUT";
    if (formulations.length > MAX_EQUIVALENT_FORMULATIONS_PER_DISCLOSURE) return "RESOURCE_LIMIT_EXCEEDED";
    if (!(formulations as readonly unknown[]).every((value) => boundedString(value, MAX_POLICY_TEXT_CHARACTERS))) {
      return "MALFORMED_POLICY_INPUT";
    }
  }

  return undefined;
}

function validateGraphContext(problem: unknown): CollectionResult<GraphContext> {
  const preflightFailure = preflightPolicyProblem(problem);
  if (preflightFailure !== undefined) return { ok: false, reasonCode: preflightFailure };

  const parsed = PolicyProblemViewSchema.safeParse(problem);
  if (!parsed.success) {
    return { ok: false, reasonCode: "MALFORMED_POLICY_INPUT" };
  }

  const graph = parsed.data.interviewer.reasoningGraph;
  if (
    graph.approaches.length > MAX_APPROACHES
    || graph.milestones.length > MAX_MILESTONES
    || graph.edges.length > MAX_GRAPH_EDGES
  ) {
    return { ok: false, reasonCode: "RESOURCE_LIMIT_EXCEEDED" };
  }

  const approachIds = new Set<string>();
  for (const approach of graph.approaches) {
    if (approachIds.has(approach.id)) {
      return { ok: false, reasonCode: "MALFORMED_POLICY_INPUT" };
    }
    approachIds.add(approach.id);
  }

  const milestoneIds = new Set<string>();
  for (const milestone of graph.milestones) {
    if (milestoneIds.has(milestone.id)) {
      return { ok: false, reasonCode: "MALFORMED_POLICY_INPUT" };
    }
    milestoneIds.add(milestone.id);
  }

  const disclosureIds = new Set<DisclosureId>();
  for (const disclosure of parsed.data.interviewer.protectedDisclosures) {
    if (disclosureIds.has(disclosure.id)) {
      return { ok: false, reasonCode: "MALFORMED_POLICY_INPUT" };
    }
    disclosureIds.add(disclosure.id);
  }

  const predecessors = new Map<string, string[]>();
  const adjacency = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  const dependencyKeys = new Set<string>();
  for (const milestoneId of milestoneIds) {
    predecessors.set(milestoneId, []);
    adjacency.set(milestoneId, []);
    indegree.set(milestoneId, 0);
  }

  const addDependency = (from: string, to: string): void => {
    const dependencyKey = from + "->" + to;
    if (dependencyKeys.has(dependencyKey)) return;
    dependencyKeys.add(dependencyKey);
    adjacency.get(from)?.push(to);
    indegree.set(to, (indegree.get(to) ?? 0) + 1);
    predecessors.get(to)?.push(from);
  };

  for (const milestone of graph.milestones) {
    const seenApproaches = new Set<string>();
    for (const approachId of milestone.approachIds) {
      if (!approachIds.has(approachId) || seenApproaches.has(approachId)) {
        return { ok: false, reasonCode: "INVALID_REASONING_TARGET" };
      }
      seenApproaches.add(approachId);
    }

    const seenPrerequisites = new Set<string>();
    for (const prerequisiteId of milestone.optionalPrerequisiteIds) {
      if (
        prerequisiteId === milestone.id
        || !milestoneIds.has(prerequisiteId)
        || seenPrerequisites.has(prerequisiteId)
      ) {
        return { ok: false, reasonCode: "INVALID_REASONING_TARGET" };
      }
      seenPrerequisites.add(prerequisiteId);
      addDependency(prerequisiteId, milestone.id);
    }

    const seenDisclosures = new Set<DisclosureId>();
    for (const disclosureId of milestone.protectedDisclosureIds) {
      if (!disclosureIds.has(disclosureId) || seenDisclosures.has(disclosureId)) {
        return { ok: false, reasonCode: "INVALID_REASONING_TARGET" };
      }
      seenDisclosures.add(disclosureId);
    }
  }

  const edgeKeys = new Set<string>();
  for (const edge of graph.edges) {
    if (
      edge.from === edge.to
      || !milestoneIds.has(edge.from)
      || !milestoneIds.has(edge.to)
    ) {
      return { ok: false, reasonCode: "INVALID_REASONING_TARGET" };
    }
    const edgeKey = edge.from + "->" + edge.to;
    if (edgeKeys.has(edgeKey)) {
      return { ok: false, reasonCode: "MALFORMED_POLICY_INPUT" };
    }
    edgeKeys.add(edgeKey);
    addDependency(edge.from, edge.to);
  }

  const queue = [...milestoneIds].filter((id) => indegree.get(id) === 0).sort();
  let cursor = 0;
  let visited = 0;
  while (cursor < queue.length) {
    const current = queue[cursor];
    cursor += 1;
    if (current === undefined) continue;
    visited += 1;
    const nextIds = [...(adjacency.get(current) ?? [])].sort();
    for (const next of nextIds) {
      const remaining = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }
  if (visited !== graph.milestones.length) {
    return { ok: false, reasonCode: "INVALID_REASONING_TARGET" };
  }

  const frozenPredecessors = new Map<string, readonly string[]>();
  for (const [key, values] of predecessors.entries()) {
    frozenPredecessors.set(key, [...new Set(values)].sort());
  }

  return {
    ok: true,
    value: {
      problem: parsed.data,
      approachIds,
      milestoneIds,
      disclosureIds,
      predecessors: frozenPredecessors
    }
  };
}

function collectActiveEvidence(
  state: Readonly<SessionState>,
  graph: GraphContext
): CollectionResult<readonly ActiveEvidenceSignal[]> {
  const rawHistories: unknown = state.evidenceHistory;
  if (!isRecord(rawHistories)) {
    return { ok: false, reasonCode: "MALFORMED_POLICY_INPUT" };
  }
  const entries = Object.entries(rawHistories);
  if (entries.length > MAX_EVIDENCE_KEYS) {
    return { ok: false, reasonCode: "RESOURCE_LIMIT_EXCEEDED" };
  }

  const rawProjection: unknown = state.studentEvidence;
  if (!isRecord(rawProjection)) {
    return { ok: false, reasonCode: "MALFORMED_POLICY_INPUT" };
  }
  const projectionEntries = Object.entries(rawProjection);
  if (projectionEntries.length > MAX_EVIDENCE_KEYS) {
    return { ok: false, reasonCode: "RESOURCE_LIMIT_EXCEEDED" };
  }

  if (!Array.isArray(state.eventIds)) {
    return { ok: false, reasonCode: "MALFORMED_POLICY_INPUT" };
  }
  if (state.eventIds.length > MAX_EVENT_IDS) {
    return { ok: false, reasonCode: "RESOURCE_LIMIT_EXCEEDED" };
  }
  if (
    !Number.isSafeInteger(state.sequence)
    || state.sequence < 0
    || state.sequence !== state.eventIds.length
    || !state.eventIds.every((eventId) => boundedString(eventId, MAX_POLICY_ID_CHARACTERS))
  ) {
    return { ok: false, reasonCode: "MALFORMED_POLICY_INPUT" };
  }
  const knownEventIds = new Set<string>(state.eventIds);
  if (knownEventIds.size !== state.eventIds.length) {
    return { ok: false, reasonCode: "MALFORMED_POLICY_INPUT" };
  }
  const eventSequence = new Map<string, number>();
  state.eventIds.forEach((eventId, index) => {
    eventSequence.set(eventId, index + 1);
  });
  let recordCount = 0;
  const activeKeys = new Set<string>();
  const signals: ActiveEvidenceSignal[] = [];

  for (const [storedKey, rawHistory] of entries) {
    if (!boundedString(storedKey, MAX_POLICY_TEXT_CHARACTERS) || !Array.isArray(rawHistory)) {
      return { ok: false, reasonCode: "MALFORMED_POLICY_INPUT" };
    }
    recordCount += rawHistory.length;
    if (recordCount > MAX_EVIDENCE_RECORDS) {
      return { ok: false, reasonCode: "RESOURCE_LIMIT_EXCEEDED" };
    }

    const historyItems: readonly unknown[] = rawHistory;
    const activeRecords = historyItems.filter((rawRecord) => {
      if (!isRecord(rawRecord)) return false;
      return rawRecord["status"] === "ACTIVE";
    });
    const hasUnknownStatus = historyItems.some((rawRecord) => {
      if (!isRecord(rawRecord)) return true;
      const status = rawRecord["status"];
      return status !== "ACTIVE" && status !== "SUPERSEDED" && status !== "STALE";
    });
    if (hasUnknownStatus || activeRecords.length > 1) {
      return { ok: false, reasonCode: "MALFORMED_POLICY_INPUT" };
    }
    const rawActive = activeRecords[0];
    if (rawActive === undefined) {
      if (rawProjection[storedKey] !== undefined) {
        return { ok: false, reasonCode: "MALFORMED_POLICY_INPUT" };
      }
      continue;
    }
    if (!isRecord(rawActive)) {
      return { ok: false, reasonCode: "MALFORMED_POLICY_INPUT" };
    }

    const rawValue = rawActive["value"];
    const rawEvidenceEventIds = isRecord(rawValue) ? rawValue["evidenceEventIds"] : undefined;
    if (!isRecord(rawValue) || !Array.isArray(rawEvidenceEventIds) || rawEvidenceEventIds.length === 0) {
      return { ok: false, reasonCode: "MALFORMED_POLICY_INPUT" };
    }
    if (rawEvidenceEventIds.length > MAX_EVIDENCE_PROVENANCE_IDS) {
      return { ok: false, reasonCode: "RESOURCE_LIMIT_EXCEEDED" };
    }

    const keyResult = EvidenceKeySchema.safeParse(rawActive["key"]);
    const valueResult = EvidenceValueSchema.safeParse(rawValue);
    const evidenceRecordId = rawActive["evidenceEventId"];
    if (
      !keyResult.success
      || !valueResult.success
      || typeof evidenceRecordId !== "string"
      || !knownEventIds.has(evidenceRecordId)
    ) {
      return { ok: false, reasonCode: "MALFORMED_POLICY_INPUT" };
    }

    const key = keyResult.data;
    const value = valueResult.data;
    const target = targetFromSubject(key.subject);
    if (
      !boundedString(key.problemId, MAX_POLICY_ID_CHARACTERS)
      || !boundedString(target.id, MAX_POLICY_ID_CHARACTERS)
      || evidenceKeyToString(key) !== storedKey
      || !isEvidenceValueAllowed(key, value.value)
    ) {
      return { ok: false, reasonCode: "MALFORMED_POLICY_INPUT" };
    }
    const recordSequence = eventSequence.get(evidenceRecordId);
    if (
      !Number.isSafeInteger(value.lastUpdatedSequence)
      || value.lastUpdatedSequence > state.sequence
      || recordSequence !== value.lastUpdatedSequence
      || value.evidenceEventIds.length > MAX_EVIDENCE_PROVENANCE_IDS
      || !value.evidenceEventIds.every((eventId) => {
        const provenanceSequence = eventSequence.get(eventId);
        return provenanceSequence !== undefined && provenanceSequence < value.lastUpdatedSequence;
      })
    ) {
      return { ok: false, reasonCode: "MALFORMED_POLICY_INPUT" };
    }

    const projectedValue = EvidenceValueSchema.safeParse(rawProjection[storedKey]);
    if (!projectedValue.success || !evidenceValuesEqual(projectedValue.data, value)) {
      return { ok: false, reasonCode: "MALFORMED_POLICY_INPUT" };
    }
    activeKeys.add(storedKey);

    if (key.problemId !== graph.problem.id) continue;

    if (
      key.subject.kind === "MILESTONE"
      && !graph.milestoneIds.has(key.subject.milestoneId)
    ) {
      return { ok: false, reasonCode: "INVALID_REASONING_TARGET" };
    }
    if (
      key.subject.kind === "APPROACH"
      && !graph.approachIds.has(key.subject.approachId)
    ) {
      return { ok: false, reasonCode: "INVALID_REASONING_TARGET" };
    }

    signals.push({
      key,
      value,
      target,
      canonicalKey: storedKey
    });
  }

  for (const [projectionKey, rawProjectedValue] of projectionEntries) {
    if (!activeKeys.has(projectionKey)) {
      return { ok: false, reasonCode: "MALFORMED_POLICY_INPUT" };
    }
    const projectionEventIds = isRecord(rawProjectedValue) ? rawProjectedValue["evidenceEventIds"] : undefined;
    if (
      !Array.isArray(projectionEventIds)
      || projectionEventIds.length === 0
      || projectionEventIds.length > MAX_EVIDENCE_PROVENANCE_IDS
      || !EvidenceValueSchema.safeParse(rawProjectedValue).success
    ) {
      return { ok: false, reasonCode: "MALFORMED_POLICY_INPUT" };
    }
  }

  signals.sort(compareSignals);
  return { ok: true, value: signals };
}

function collectVerificationSignals(
  state: Readonly<SessionState>,
  graph: GraphContext
): CollectionResult<readonly VerificationSignal[]> {
  const rawRequests: unknown = state.verificationRequests;
  if (!isRecord(rawRequests)) {
    return { ok: false, reasonCode: "MALFORMED_POLICY_INPUT" };
  }
  const entries = Object.entries(rawRequests);
  if (entries.length > MAX_VERIFICATION_REQUESTS) {
    return { ok: false, reasonCode: "RESOURCE_LIMIT_EXCEEDED" };
  }
  if (state.eventIds.length > MAX_EVENT_IDS) {
    return { ok: false, reasonCode: "RESOURCE_LIMIT_EXCEEDED" };
  }

  const eventSequence = new Map<string, number>();
  state.eventIds.forEach((eventId, index) => {
    eventSequence.set(eventId, index + 1);
  });

  const signals: VerificationSignal[] = [];
  for (const [requestKey, rawRequest] of entries) {
    if (!isRecord(rawRequest)) {
      return { ok: false, reasonCode: "MALFORMED_POLICY_INPUT" };
    }
    const status = rawRequest["status"];
    if (status !== "PENDING" && status !== "ACCEPTED" && status !== "DISCARDED") {
      return { ok: false, reasonCode: "MALFORMED_POLICY_INPUT" };
    }
    if (status !== "ACCEPTED") continue;

    const result = VerificationResultSchema.safeParse(rawRequest["result"]);
    const key = EvidenceKeySchema.safeParse(rawRequest["evidenceKey"]);
    const basis = GenerationBasisSchema.safeParse(rawRequest["basis"]);
    const requestedEventId = rawRequest["requestedEventId"];
    const verificationRequestId = rawRequest["verificationRequestId"];
    const verifier = rawRequest["verifier"];
    const interpretationConfidence = rawRequest["interpretationConfidence"];
    const evidenceEventIds = rawRequest["evidenceEventIds"];
    if (
      !result.success
      || !key.success
      || !basis.success
      || typeof requestedEventId !== "string"
      || verificationRequestId !== requestKey
      || typeof verifier !== "string"
      || verifier.length === 0
      || verifier.length > 128
      || typeof interpretationConfidence !== "number"
      || interpretationConfidence !== result.data.interpretationConfidence
      || verifier !== result.data.verifier
      || !Array.isArray(evidenceEventIds)
      || evidenceEventIds.length === 0
      || evidenceEventIds.length > MAX_EVIDENCE_PROVENANCE_IDS
    ) {
      return { ok: false, reasonCode: "MALFORMED_POLICY_INPUT" };
    }

    const sequence = eventSequence.get(requestedEventId);
    if (
      sequence === undefined
      || !(evidenceEventIds as readonly unknown[]).every((eventId) =>
        typeof eventId === "string"
        && eventSequence.has(eventId)
        && (eventSequence.get(eventId) ?? Number.POSITIVE_INFINITY) < sequence
      )
    ) {
      return { ok: false, reasonCode: "MALFORMED_POLICY_INPUT" };
    }
    if (key.data.subject.kind !== "CLAIM" || key.data.dimension !== "CORRECTNESS") {
      return { ok: false, reasonCode: "MALFORMED_POLICY_INPUT" };
    }
    if (key.data.problemId !== graph.problem.id) continue;
    if (isGenerationBasisStillCompatible(basis.data, state) !== "COMPATIBLE") {
      continue;
    }

    signals.push({
      target: targetFromSubject(key.data.subject),
      status: result.data.interpretationConfidence < 1
        ? "UNRESOLVED"
        : result.data.status,
      sequence
    });
  }

  signals.sort(compareVerification);
  return { ok: true, value: signals };
}

function collectExposedAssistance(
  state: Readonly<SessionState>,
  graph: GraphContext
): CollectionResult<AssistanceSnapshot> {
  const rawDeliveries: unknown = state.deliveries;
  const rawGenerations: unknown = state.generations;
  const rawActions: unknown = state.pedagogicalActions;
  const rawTurns: unknown = state.turns;
  const rawEpisodes: unknown = state.inputEpisodes;
  if (
    !isRecord(rawDeliveries)
    || !isRecord(rawGenerations)
    || !isRecord(rawActions)
    || !isRecord(rawTurns)
    || !isRecord(rawEpisodes)
  ) {
    return { ok: false, reasonCode: "MALFORMED_POLICY_INPUT" };
  }
  const deliveryEntries = Object.entries(rawDeliveries);
  if (deliveryEntries.length > MAX_DELIVERIES) {
    return { ok: false, reasonCode: "RESOURCE_LIMIT_EXCEEDED" };
  }

  const byGeneration = new Map<string, AssistanceRecord>();
  const disclosedIds = new Set<DisclosureId>();
  const disclosuresById = disclosureMap(graph);
  for (const [deliveryKey, rawDelivery] of deliveryEntries.sort((left, right) => left[0].localeCompare(right[0]))) {
    const delivery = PolicyDeliverySchema.safeParse(rawDelivery);
    if (!delivery.success || delivery.data.deliveryId !== deliveryKey) {
      return { ok: false, reasonCode: "MALFORMED_POLICY_INPUT" };
    }
    if (!isDisclosedStatus(delivery.data.status)) continue;

    const rawGeneration = rawGenerations[delivery.data.generationId];
    if (!isRecord(rawGeneration) || rawGeneration["generationId"] !== delivery.data.generationId) {
      return { ok: false, reasonCode: "MALFORMED_POLICY_INPUT" };
    }
    const basis = GenerationBasisSchema.safeParse(rawGeneration["basis"]);
    if (!basis.success || basis.data.inputEpisodeId === undefined) {
      return { ok: false, reasonCode: "MALFORMED_POLICY_INPUT" };
    }

    const rawRequest = rawActions[basis.data.turnId];
    const parsedRequest = RealizationRequestSchema.safeParse(rawRequest);
    const rawTurn = rawTurns[basis.data.turnId];
    const rawEpisode = rawEpisodes[basis.data.inputEpisodeId];
    if (
      !parsedRequest.success
      || parsedRequest.data.target === undefined
      || !isRecord(rawTurn)
      || rawTurn["turnId"] !== basis.data.turnId
      || rawTurn["inputEpisodeId"] !== basis.data.inputEpisodeId
      || !Number.isSafeInteger(rawTurn["committedSequence"])
      || (rawTurn["committedSequence"] as number) <= 0
      || basis.data.committedInputSequence !== rawTurn["committedSequence"]
      || !isRecord(rawEpisode)
      || rawEpisode["inputEpisodeId"] !== basis.data.inputEpisodeId
      || rawEpisode["status"] !== "COMMITTED"
      || delivery.data.effectiveDisclosureLevel > parsedRequest.data.maximumDisclosure
      || new Set(delivery.data.disclosureIds).size !== delivery.data.disclosureIds.length
    ) {
      return { ok: false, reasonCode: "MALFORMED_POLICY_INPUT" };
    }

    const allowedIds = new Set(parsedRequest.data.allowedDisclosureIds ?? []);
    for (const disclosureId of delivery.data.disclosureIds) {
      const disclosure = disclosuresById.get(disclosureId);
      if (
        disclosure === undefined
        || !allowedIds.has(disclosureId)
        || disclosure.minimumDisclosureLevel > delivery.data.effectiveDisclosureLevel
      ) {
        return { ok: false, reasonCode: "MALFORMED_POLICY_INPUT" };
      }
      disclosedIds.add(disclosureId);
    }

    const turnSequence = rawTurn["committedSequence"];
    const current = byGeneration.get(delivery.data.generationId);
    const record: AssistanceRecord = {
      generationId: delivery.data.generationId,
      action: parsedRequest.data.requiredAction,
      target: parsedRequest.data.target,
      maximumDisclosure: parsedRequest.data.maximumDisclosure,
      effectiveDisclosureLevel: delivery.data.effectiveDisclosureLevel,
      turnSequence
    };
    if (
      current === undefined
      || record.effectiveDisclosureLevel > current.effectiveDisclosureLevel
    ) {
      byGeneration.set(delivery.data.generationId, record);
    }
  }

  return {
    ok: true,
    value: {
      records: [...byGeneration.values()].sort((left, right) => {
        if (left.turnSequence !== right.turnSequence) return left.turnSequence - right.turnSequence;
        return left.generationId.localeCompare(right.generationId);
      }),
      disclosedIds
    }
  };
}

function findSignal(
  signals: readonly ActiveEvidenceSignal[],
  dimension: EvidenceKey["dimension"],
  values: ReadonlySet<EvidenceValue["value"]>
): ActiveEvidenceSignal | undefined {
  return signals.find(
    (signal) => signal.key.dimension === dimension && values.has(signal.value.value)
  );
}

function verificationStatusesForTarget(
  signals: readonly VerificationSignal[],
  target: PolicyTarget
): ReadonlySet<VerificationSignal["status"]> {
  return new Set(
    signals
      .filter((signal) => sameTarget(signal.target, target))
      .map((signal) => signal.status)
  );
}

function findConflictTarget(
  evidence: readonly ActiveEvidenceSignal[],
  verification: readonly VerificationSignal[]
): PolicyTarget | undefined {
  const targets = new Map<string, PolicyTarget>();
  for (const signal of evidence) targets.set(targetToString(signal.target), signal.target);
  for (const signal of verification) targets.set(targetToString(signal.target), signal.target);

  for (const [, target] of [...targets.entries()].sort((left, right) => left[0].localeCompare(right[0]))) {
    const subjectSignals = evidence.filter((signal) => sameTarget(signal.target, target));
    const values = new Set(subjectSignals.map((signal) => signal.value.value));
    const verificationStatuses = verificationStatusesForTarget(verification, target);

    const hasError = values.has("LOCAL_ERROR") || values.has("STRUCTURAL_ERROR");
    const complete = values.has("COMPLETE");
    const misunderstood = values.has("MISUNDERSTOOD_PROBLEM");
    if ((complete && (hasError || misunderstood))) return target;
    if (values.has("CORRECT") && verificationStatuses.has("CONTRADICTED")) return target;
    if (hasError && verificationStatuses.has("VERIFIED")) return target;
    if (verificationStatuses.has("VERIFIED") && verificationStatuses.has("CONTRADICTED")) return target;
  }
  return undefined;
}

function completedMilestoneIds(evidence: readonly ActiveEvidenceSignal[]): ReadonlySet<string> {
  return new Set(
    evidence
      .filter(
        (signal) =>
          signal.key.subject.kind === "MILESTONE"
          && signal.key.dimension === "PROGRESS"
          && signal.value.value === "COMPLETE"
      )
      .map((signal) => signal.key.subject.kind === "MILESTONE" ? signal.key.subject.milestoneId : "")
      .filter((id) => id.length > 0)
  );
}

function milestoneReady(
  milestoneId: string,
  graph: GraphContext,
  completeMilestones: ReadonlySet<string>
): boolean {
  const predecessors = graph.predecessors.get(milestoneId) ?? [];
  return predecessors.length === 0 || predecessors.some((id) => completeMilestones.has(id));
}

function inferActiveApproachId(
  evidence: readonly ActiveEvidenceSignal[],
  graph: GraphContext
): string | undefined {
  for (const signal of evidence) {
    if (signal.key.subject.kind === "APPROACH") {
      return signal.key.subject.approachId;
    }
    if (signal.key.subject.kind !== "MILESTONE") continue;

    const milestoneId = signal.key.subject.milestoneId;
    const milestone = graph.problem.interviewer.reasoningGraph.milestones.find(
      (item) => item.id === milestoneId
    );
    if (milestone === undefined) continue;
    if (milestone.approachIds.length === 1) return milestone.approachIds[0];
  }
  return undefined;
}

function evidenceForActiveApproach(
  evidence: readonly ActiveEvidenceSignal[],
  graph: GraphContext
): readonly ActiveEvidenceSignal[] {
  const activeApproachId = inferActiveApproachId(evidence, graph);
  if (activeApproachId === undefined) return evidence;

  return evidence.filter((signal) => {
    if (signal.key.subject.kind === "APPROACH") {
      return signal.key.subject.approachId === activeApproachId;
    }
    if (signal.key.subject.kind !== "MILESTONE") return true;
    const milestoneId = signal.key.subject.milestoneId;
    const milestone = graph.problem.interviewer.reasoningGraph.milestones.find(
      (item) => item.id === milestoneId
    );
    return milestone?.approachIds.includes(activeApproachId) ?? false;
  });
}

function selectNextMilestoneTarget(
  evidence: readonly ActiveEvidenceSignal[],
  graph: GraphContext
): PolicyTarget | undefined {
  const completed = completedMilestoneIds(evidence);
  const activeApproachId = inferActiveApproachId(evidence, graph);

  const candidates = graph.problem.interviewer.reasoningGraph.milestones
    .filter((milestone) => !completed.has(milestone.id))
    .filter((milestone) => activeApproachId === undefined || milestone.approachIds.includes(activeApproachId))
    .filter((milestone) => milestoneReady(milestone.id, graph, completed))
    .map((milestone) => milestone.id)
    .sort();

  const selected = candidates[0];
  return selected === undefined ? undefined : { kind: "MILESTONE", id: selected };
}

function findCompletedApproaches(
  evidence: readonly ActiveEvidenceSignal[],
  graph: GraphContext
): readonly string[] {
  const completedMilestones = completedMilestoneIds(evidence);
  const directlyCompletedApproaches = new Set(
    evidence
      .filter(
        (signal) =>
          signal.key.subject.kind === "APPROACH"
          && signal.key.dimension === "PROGRESS"
          && signal.value.value === "COMPLETE"
      )
      .map((signal) => signal.key.subject.kind === "APPROACH" ? signal.key.subject.approachId : "")
      .filter((id) => id.length > 0)
  );

  return graph.problem.interviewer.reasoningGraph.approaches
    .map((approach) => approach.id)
    .filter((approachId) => {
      if (directlyCompletedApproaches.has(approachId)) return true;
      const requiredMilestones = graph.problem.interviewer.reasoningGraph.milestones
        .filter((milestone) => milestone.approachIds.includes(approachId))
        .map((milestone) => milestone.id);
      return requiredMilestones.length > 0
        && requiredMilestones.every((id) => completedMilestones.has(id));
    });
}

function isUnexpectedApproachTarget(target: PolicyTarget, graph: GraphContext): boolean {
  const primaryApproachId = graph.problem.interviewer.reasoningGraph.approaches[0]?.id;
  if (primaryApproachId === undefined) return false;
  if (target.kind === "APPROACH") return target.id !== primaryApproachId;
  if (target.kind !== "MILESTONE") return false;
  const milestone = graph.problem.interviewer.reasoningGraph.milestones.find((item) => item.id === target.id);
  return milestone !== undefined
    && milestone.approachIds.length === 1
    && milestone.approachIds[0] !== primaryApproachId;
}

function classifyProgress(
  evidence: readonly ActiveEvidenceSignal[],
  verification: readonly VerificationSignal[],
  graph: GraphContext,
  turnId: string
): ClassificationResult {
  const actionable = evidence.filter(
    (signal) => signal.value.inferenceConfidence >= MIN_ACTIONABLE_EVIDENCE_CONFIDENCE
  );
  const latestActionableSequence = actionable[0]?.value.lastUpdatedSequence ?? 0;
  const latestVerificationSequence = verification[0]?.sequence ?? 0;
  const latestLowConfidence = evidence.find(
    (signal) => signal.value.inferenceConfidence < MIN_ACTIONABLE_EVIDENCE_CONFIDENCE
  );
  if (
    latestLowConfidence !== undefined
    && latestLowConfidence.value.lastUpdatedSequence > Math.max(
      latestActionableSequence,
      latestVerificationSequence
    )
  ) {
    return {
      classification: "AMBIGUOUS_STATEMENT",
      reasonCode: "STATEMENT_AMBIGUOUS",
      target: latestLowConfidence.target
    };
  }

  const scopedEvidence = evidenceForActiveApproach(actionable, graph);
  const conflictTarget = findConflictTarget(scopedEvidence, verification);
  if (conflictTarget !== undefined) {
    return {
      classification: "AMBIGUOUS_STATEMENT",
      reasonCode: "CONFLICTING_ACTIVE_SIGNALS",
      target: conflictTarget
    };
  }

  const structural = findSignal(scopedEvidence, "CORRECTNESS", new Set(["STRUCTURAL_ERROR"]));
  if (structural !== undefined) {
    return {
      classification: "STRUCTURAL_ERROR",
      reasonCode: "STRUCTURAL_REFRAMING_NEEDED",
      target: structural.target
    };
  }

  const misunderstood = findSignal(scopedEvidence, "UNDERSTANDING", new Set(["MISUNDERSTOOD_PROBLEM"]));
  if (misunderstood !== undefined) {
    return {
      classification: "MISUNDERSTANDING",
      reasonCode: "PROBLEM_MISUNDERSTOOD",
      target: misunderstood.target
    };
  }

  const local = findSignal(scopedEvidence, "CORRECTNESS", new Set(["LOCAL_ERROR"]));
  if (local !== undefined) {
    return {
      classification: "LOCAL_ERROR",
      reasonCode: "LOCAL_CORRECTION_NEEDED",
      target: local.target
    };
  }

  const contradicted = verification.find((signal) => signal.status === "CONTRADICTED");
  if (contradicted !== undefined) {
    return {
      classification: "LOCAL_ERROR",
      reasonCode: "LOCAL_CORRECTION_NEEDED",
      target: contradicted.target,
      verificationStatus: contradicted.status
    };
  }

  const unsupported = findSignal(scopedEvidence, "JUSTIFICATION", new Set(["UNJUSTIFIED", "INCOMPLETE"]));
  if (unsupported !== undefined) {
    const relatedVerification = verification.find((signal) => sameTarget(signal.target, unsupported.target));
    return {
      classification: "UNSUPPORTED_CLAIM",
      reasonCode: relatedVerification?.status === "UNRESOLVED"
        ? "VERIFICATION_UNRESOLVED"
        : "JUSTIFICATION_MISSING",
      target: unsupported.target,
      ...(relatedVerification === undefined ? {} : { verificationStatus: relatedVerification.status })
    };
  }

  const stalled = findSignal(scopedEvidence, "PROGRESS", new Set(["STALLED", "REGRESSING"]));
  if (stalled !== undefined) {
    return {
      classification: "TRUE_STAGNATION",
      reasonCode: "PROGRESS_STALLED",
      target: stalled.target
    };
  }

  const progressing = findSignal(scopedEvidence, "PROGRESS", new Set(["PROGRESSING"]));
  if (progressing !== undefined) {
    const nextTarget = selectNextMilestoneTarget(scopedEvidence, graph);
    const selectedTarget = nextTarget ?? progressing.target;
    if (isUnexpectedApproachTarget(progressing.target, graph)) {
      return {
        classification: "UNEXPECTED_VALID_APPROACH",
        reasonCode: "ALTERNATE_APPROACH_PROGRESS",
        target: selectedTarget
      };
    }
    return {
      classification: "PRODUCTIVE_PROGRESS",
      reasonCode: "PROGRESS_CONTINUES",
      target: selectedTarget
    };
  }

  const completedApproaches = findCompletedApproaches(actionable, graph);
  if (completedApproaches.length > 0) {
    const completedApproachId = completedApproaches[0];
    const alternateApproachId = graph.problem.interviewer.reasoningGraph.approaches
      .map((approach) => approach.id)
      .filter((approachId) => !completedApproaches.includes(approachId))
      .sort()[0];
    return {
      classification: "COMPLETED_PRIMARY_APPROACH",
      reasonCode: "PRIMARY_APPROACH_COMPLETE",
      target: alternateApproachId === undefined
        ? {
            kind: "APPROACH",
            id: completedApproachId
              ?? graph.problem.interviewer.reasoningGraph.approaches[0]?.id
              ?? "completed"
          }
        : { kind: "APPROACH", id: alternateApproachId },
      ...(completedApproachId === undefined ? {} : { completedApproachId }),
      ...(alternateApproachId === undefined ? {} : { alternateApproachId })
    };
  }

  const completedMilestone = findSignal(scopedEvidence, "PROGRESS", new Set(["COMPLETE"]));
  if (completedMilestone !== undefined) {
    const nextTarget = selectNextMilestoneTarget(scopedEvidence, graph);
    return {
      classification: isUnexpectedApproachTarget(completedMilestone.target, graph)
        ? "UNEXPECTED_VALID_APPROACH"
        : "PRODUCTIVE_PROGRESS",
      reasonCode: isUnexpectedApproachTarget(completedMilestone.target, graph)
        ? "ALTERNATE_APPROACH_PROGRESS"
        : "PROGRESS_CONTINUES",
      target: nextTarget ?? completedMilestone.target
    };
  }

  const verified = verification.find((signal) => signal.status === "VERIFIED");
  if (verified !== undefined) {
    return {
      classification: "PRODUCTIVE_PROGRESS",
      reasonCode: "PROGRESS_CONTINUES",
      target: verified.target,
      verificationStatus: verified.status
    };
  }

  const unresolved = verification.find((signal) => signal.status === "UNRESOLVED");
  if (unresolved !== undefined) {
    return {
      classification: "AMBIGUOUS_STATEMENT",
      reasonCode: "VERIFICATION_UNRESOLVED",
      target: unresolved.target,
      verificationStatus: unresolved.status
    };
  }

  const positive = scopedEvidence.find((signal) =>
    (signal.key.dimension === "CORRECTNESS" && signal.value.value === "CORRECT")
    || (signal.key.dimension === "UNDERSTANDING" && signal.value.value === "UNDERSTANDS")
    || (signal.key.dimension === "JUSTIFICATION" && signal.value.value === "JUSTIFIED")
  );
  if (positive !== undefined) {
    return {
      classification: "PRODUCTIVE_PROGRESS",
      reasonCode: "PROGRESS_CONTINUES",
      target: positive.target
    };
  }

  const ambiguous = scopedEvidence.find(
    (signal) =>
      signal.value.value === "UNKNOWN"
      || (signal.key.dimension === "STUDENT_CONFIDENCE" && signal.value.value === "UNCERTAIN")
  );
  if (ambiguous !== undefined) {
    return {
      classification: "AMBIGUOUS_STATEMENT",
      reasonCode: "STATEMENT_AMBIGUOUS",
      target: ambiguous.target
    };
  }

  if (actionable.length === 0) {
    const latest = evidence[0];
    if (latest !== undefined) {
      return {
        classification: "AMBIGUOUS_STATEMENT",
        reasonCode: "STATEMENT_AMBIGUOUS",
        target: latest.target
      };
    }
    return {
      classification: "INSUFFICIENT_EVIDENCE",
      reasonCode: "NO_CURRENT_EVIDENCE",
      target: { kind: "TURN", id: turnId }
    };
  }

  const latest = scopedEvidence[0] ?? actionable[0];
  return {
    classification: "AMBIGUOUS_STATEMENT",
    reasonCode: "STATEMENT_AMBIGUOUS",
    target: latest?.target ?? { kind: "TURN", id: turnId }
  };
}

function assistanceForTarget(
  assistance: readonly AssistanceRecord[],
  target: PolicyTarget
): readonly AssistanceRecord[] {
  const targetString = targetToString(target);
  return assistance.filter((record) => record.target === targetString);
}

function requestedLevel(value: number): DisclosureLevel {
  return DisclosureLevelSchema.parse(value);
}

function disclosureMap(graph: GraphContext): ReadonlyMap<DisclosureId, PolicyProblemView["interviewer"]["protectedDisclosures"][number]> {
  return new Map(
    graph.problem.interviewer.protectedDisclosures.map((disclosure) => [disclosure.id, disclosure])
  );
}

function validateDisclosureLedger(
  state: Readonly<SessionState>,
  graph: GraphContext,
  exposedDisclosureIds: ReadonlySet<DisclosureId>
): CollectionResult<ReadonlySet<DisclosureId>> {
  const rawLedger: unknown = state.disclosureLedger;
  if (!Array.isArray(rawLedger)) {
    return { ok: false, reasonCode: "MALFORMED_POLICY_INPUT" };
  }
  if (rawLedger.length > MAX_PROTECTED_DISCLOSURES) {
    return { ok: false, reasonCode: "RESOURCE_LIMIT_EXCEEDED" };
  }

  const ledgerItems: readonly unknown[] = rawLedger;
  const delivered = new Set<DisclosureId>();
  for (const rawDisclosureId of ledgerItems) {
    const parsed = DisclosureIdSchema.safeParse(rawDisclosureId);
    if (
      !parsed.success
      || !graph.disclosureIds.has(parsed.data)
      || delivered.has(parsed.data)
    ) {
      return { ok: false, reasonCode: "MALFORMED_POLICY_INPUT" };
    }
    delivered.add(parsed.data);
  }
  if (
    delivered.size !== exposedDisclosureIds.size
    || [...delivered].some((disclosureId) => !exposedDisclosureIds.has(disclosureId))
  ) {
    return { ok: false, reasonCode: "MALFORMED_POLICY_INPUT" };
  }
  return { ok: true, value: delivered };
}

function targetDisclosureAuthorization(
  target: PolicyTarget,
  level: DisclosureLevel,
  graph: GraphContext,
  completed: ReadonlySet<string>,
  activeApproachId: string | undefined
): CollectionResult<readonly DisclosureId[]> {
  if (level === 0 || target.kind !== "MILESTONE") return { ok: true, value: [] };

  const milestone = graph.problem.interviewer.reasoningGraph.milestones.find((item) => item.id === target.id);
  if (milestone === undefined || !milestoneReady(milestone.id, graph, completed)) {
    return { ok: true, value: [] };
  }

  const relevantMilestoneIds = new Set<string>([milestone.id]);
  if (activeApproachId !== undefined) {
    const queue = [milestone.id];
    let cursor = 0;
    while (cursor < queue.length) {
      const current = queue[cursor];
      cursor += 1;
      if (current === undefined) continue;
      for (const predecessorId of graph.predecessors.get(current) ?? []) {
        if (relevantMilestoneIds.has(predecessorId)) continue;
        const predecessor = graph.problem.interviewer.reasoningGraph.milestones.find(
          (item) => item.id === predecessorId
        );
        if (predecessor === undefined || !predecessor.approachIds.includes(activeApproachId)) continue;
        relevantMilestoneIds.add(predecessorId);
        queue.push(predecessorId);
      }
    }
  }

  const allowed = new Set<DisclosureId>();
  const byId = disclosureMap(graph);
  for (const relevantMilestoneId of relevantMilestoneIds) {
    const relevantMilestone = graph.problem.interviewer.reasoningGraph.milestones.find(
      (item) => item.id === relevantMilestoneId
    );
    if (relevantMilestone === undefined) continue;
    for (const disclosureId of relevantMilestone.protectedDisclosureIds) {
      const disclosure = byId.get(disclosureId);
      if (disclosure !== undefined && disclosure.minimumDisclosureLevel <= level) {
        allowed.add(disclosureId);
        if (allowed.size > MAX_DISCLOSURE_REFS_PER_MILESTONE) {
          return { ok: false, reasonCode: "RESOURCE_LIMIT_EXCEEDED" };
        }
      }
    }
  }
  return { ok: true, value: [...allowed].sort() };
}

function explicitHintLevel(
  target: PolicyTarget,
  graph: GraphContext,
  completed: ReadonlySet<string>,
  alreadyDisclosed: ReadonlySet<DisclosureId>
): DisclosureLevel | undefined {
  if (target.kind !== "MILESTONE" || !milestoneReady(target.id, graph, completed)) return undefined;
  const milestone = graph.problem.interviewer.reasoningGraph.milestones.find((item) => item.id === target.id);
  if (milestone === undefined) return undefined;

  const byId = disclosureMap(graph);
  const candidates = milestone.protectedDisclosureIds
    .map((id) => byId.get(id))
    .filter((item) => item !== undefined)
    .filter((item) => !alreadyDisclosed.has(item.id))
    .map((item) => item.minimumDisclosureLevel)
    .filter((level) => level >= 3 && level <= 4)
    .sort((left, right) => left - right);

  const level = candidates[0];
  return level === undefined ? undefined : requestedLevel(level);
}

function chooseActionPlan(
  classification: ClassificationResult,
  targetAssistance: readonly AssistanceRecord[],
  hintLevel: DisclosureLevel | undefined
): ActionPlan {
  if (
    classification.classification === "PRODUCTIVE_PROGRESS"
    || classification.classification === "UNEXPECTED_VALID_APPROACH"
  ) {
    return {
      action: "WAIT",
      requestedDisclosure: 0,
      stage: "OBSERVE",
      escalationJustified: false
    };
  }
  if (classification.classification === "COMPLETED_PRIMARY_APPROACH") {
    return {
      action: classification.alternateApproachId === undefined ? "GENERALIZE" : "ASK_ALTERNATE_SOLUTION",
      requestedDisclosure: 0,
      stage: "OBSERVE",
      escalationJustified: false
    };
  }

  const assistanceCount = targetAssistance.length;
  const assistanceSaturated = targetAssistance.some(
    (record) => record.action === "EXPLICIT_HINT" || record.effectiveDisclosureLevel >= 4
  );
  if (assistanceSaturated) {
    return {
      action: "CLARIFY",
      requestedDisclosure: 0,
      stage: "SATURATED",
      escalationJustified: false,
      reasonCode: "ASSISTANCE_SATURATED"
    };
  }

  switch (classification.classification) {
    case "INSUFFICIENT_EVIDENCE":
      return {
        action: "PROBE_JUSTIFICATION",
        requestedDisclosure: 0,
        stage: "PROBE",
        escalationJustified: false
      };
    case "AMBIGUOUS_STATEMENT":
      return {
        action: classification.verificationStatus === "UNRESOLVED" ? "VERIFY" : "CLARIFY",
        requestedDisclosure: 0,
        stage: "PROBE",
        escalationJustified: false
      };
    case "UNSUPPORTED_CLAIM":
      return {
        action: classification.verificationStatus === "UNRESOLVED" ? "VERIFY" : "PROBE_JUSTIFICATION",
        requestedDisclosure: 0,
        stage: "PROBE",
        escalationJustified: false
      };
    case "LOCAL_ERROR":
      if (assistanceCount === 0) {
        return {
          action: "CHECK_LOCAL_STEP",
          requestedDisclosure: 0,
          stage: "PROBE",
          escalationJustified: false
        };
      }
      if (assistanceCount === 1) {
        return {
          action: "FOCUS_ATTENTION",
          requestedDisclosure: 1,
          stage: "FOCUS",
          escalationJustified: true
        };
      }
      if (assistanceCount === 2) {
        return {
          action: "DIRECTIONAL_NUDGE",
          requestedDisclosure: 2,
          stage: "NUDGE",
          escalationJustified: true
        };
      }
      if (hintLevel !== undefined) {
        return {
          action: "EXPLICIT_HINT",
          requestedDisclosure: hintLevel,
          stage: "HINT",
          escalationJustified: true
        };
      }
      return {
        action: "FOCUS_ATTENTION",
        requestedDisclosure: 1,
        stage: "FOCUS",
        escalationJustified: false
      };
    case "STRUCTURAL_ERROR":
      if (assistanceCount === 0) {
        return {
          action: "CHANGE_REPRESENTATION",
          requestedDisclosure: 1,
          stage: "FOCUS",
          escalationJustified: false
        };
      }
      if (assistanceCount === 1) {
        return {
          action: "SIMPLIFY_CASE",
          requestedDisclosure: 1,
          stage: "FOCUS",
          escalationJustified: true
        };
      }
      if (assistanceCount === 2) {
        return {
          action: "DIRECTIONAL_NUDGE",
          requestedDisclosure: 2,
          stage: "NUDGE",
          escalationJustified: true
        };
      }
      if (hintLevel !== undefined) {
        return {
          action: "EXPLICIT_HINT",
          requestedDisclosure: hintLevel,
          stage: "HINT",
          escalationJustified: true
        };
      }
      return {
        action: "CHANGE_REPRESENTATION",
        requestedDisclosure: 1,
        stage: "FOCUS",
        escalationJustified: false
      };
    case "MISUNDERSTANDING":
      if (assistanceCount === 0) {
        return {
          action: "SIMPLIFY_CASE",
          requestedDisclosure: 1,
          stage: "FOCUS",
          escalationJustified: false
        };
      }
      if (assistanceCount === 1) {
        return {
          action: "CHANGE_REPRESENTATION",
          requestedDisclosure: 1,
          stage: "FOCUS",
          escalationJustified: true
        };
      }
      if (assistanceCount === 2) {
        return {
          action: "DIRECTIONAL_NUDGE",
          requestedDisclosure: 2,
          stage: "NUDGE",
          escalationJustified: true
        };
      }
      if (hintLevel !== undefined) {
        return {
          action: "EXPLICIT_HINT",
          requestedDisclosure: hintLevel,
          stage: "HINT",
          escalationJustified: true
        };
      }
      return {
        action: "SIMPLIFY_CASE",
        requestedDisclosure: 1,
        stage: "FOCUS",
        escalationJustified: false
      };
    case "TRUE_STAGNATION":
    case "REPEATED_STAGNATION":
      if (assistanceCount === 0) {
        return {
          action: "ASK_FOR_EXAMPLE",
          requestedDisclosure: 0,
          stage: "PROBE",
          escalationJustified: false
        };
      }
      if (assistanceCount === 1) {
        return {
          action: "FOCUS_ATTENTION",
          requestedDisclosure: 1,
          stage: "FOCUS",
          escalationJustified: true
        };
      }
      if (assistanceCount === 2) {
        return {
          action: "DIRECTIONAL_NUDGE",
          requestedDisclosure: 2,
          stage: "NUDGE",
          escalationJustified: true
        };
      }
      if (hintLevel !== undefined) {
        return {
          action: "EXPLICIT_HINT",
          requestedDisclosure: hintLevel,
          stage: "HINT",
          escalationJustified: true
        };
      }
      return {
        action: "CHANGE_REPRESENTATION",
        requestedDisclosure: 1,
        stage: "FOCUS",
        escalationJustified: false
      };
  }
}

export function decidePedagogicalPolicy(
  state: Readonly<SessionState>,
  turnId: string,
  problem: InterviewProblem
): PolicyDecision {
  const rawTurns: unknown = state.turns;
  const rawEpisodes: unknown = state.inputEpisodes;
  if (!isRecord(rawTurns) || !isRecord(rawEpisodes)) {
    return failClosedDecision(turnId, "MALFORMED_POLICY_INPUT");
  }

  const rawTurn = rawTurns[turnId];
  if (rawTurn === undefined) throw new Error("Unknown turn " + turnId);
  if (
    !isRecord(rawTurn)
    || rawTurn["turnId"] !== turnId
    || typeof rawTurn["inputEpisodeId"] !== "string"
    || rawTurn["inputEpisodeId"].length === 0
    || !Number.isSafeInteger(rawTurn["committedSequence"])
    || (rawTurn["committedSequence"] as number) <= 0
  ) {
    return failClosedDecision(turnId, "MALFORMED_POLICY_INPUT");
  }
  const rawEpisode = rawEpisodes[rawTurn["inputEpisodeId"]];
  if (
    !isRecord(rawEpisode)
    || rawEpisode["inputEpisodeId"] !== rawTurn["inputEpisodeId"]
    || rawEpisode["status"] !== "COMMITTED"
  ) {
    return failClosedDecision(turnId, "MALFORMED_POLICY_INPUT");
  }

  const graphResult = validateGraphContext(problem);
  if (!graphResult.ok) return failClosedDecision(turnId, graphResult.reasonCode);
  const graph = graphResult.value;

  if (
    state.problem === undefined
    || state.problem.id !== graph.problem.id
    || state.problem.version !== graph.problem.version
  ) {
    return failClosedDecision(turnId, "PROBLEM_CONTEXT_MISMATCH");
  }
  if (state.problem.providerContextSpecSha256 === undefined) {
    return failClosedDecision(turnId, "PROBLEM_PROVENANCE_UNKNOWN");
  }
  if (state.problem.prompt !== problem.public.prompt) {
    return failClosedDecision(turnId, "PROBLEM_DEFINITION_MISMATCH");
  }
  let policyProblemFingerprint: string;
  try {
    policyProblemFingerprint = createProviderContextSpecFingerprintSync(problem);
  } catch {
    return failClosedDecision(turnId, "MALFORMED_POLICY_INPUT");
  }
  if (state.problem.providerContextSpecSha256 !== policyProblemFingerprint) {
    return failClosedDecision(turnId, "PROBLEM_DEFINITION_MISMATCH");
  }

  const evidenceResult = collectActiveEvidence(state, graph);
  if (!evidenceResult.ok) return failClosedDecision(turnId, evidenceResult.reasonCode);
  const verificationResult = collectVerificationSignals(state, graph);
  if (!verificationResult.ok) return failClosedDecision(turnId, verificationResult.reasonCode);
  const assistanceResult = collectExposedAssistance(state, graph);
  if (!assistanceResult.ok) return failClosedDecision(turnId, assistanceResult.reasonCode);
  const ledgerResult = validateDisclosureLedger(state, graph, assistanceResult.value.disclosedIds);
  if (!ledgerResult.ok) return failClosedDecision(turnId, ledgerResult.reasonCode);

  let classification = classifyProgress(
    evidenceResult.value,
    verificationResult.value,
    graph,
    turnId
  );
  const targetAssistance = assistanceForTarget(assistanceResult.value.records, classification.target);
  if (
    classification.classification === "TRUE_STAGNATION"
    && targetAssistance.length >= 2
  ) {
    classification = {
      ...classification,
      classification: "REPEATED_STAGNATION",
      reasonCode: "STAGNATION_PERSISTS_AFTER_ASSISTANCE"
    };
  }

  const actionableEvidence = evidenceResult.value.filter(
    (signal) => signal.value.inferenceConfidence >= MIN_ACTIONABLE_EVIDENCE_CONFIDENCE
  );
  const completeMilestones = completedMilestoneIds(actionableEvidence);
  const hintLevel = explicitHintLevel(
    classification.target,
    graph,
    completeMilestones,
    ledgerResult.value
  );
  const plan = chooseActionPlan(classification, targetAssistance, hintLevel);
  const activeApproachId = inferActiveApproachId(actionableEvidence, graph);
  const authorization = targetDisclosureAuthorization(
    classification.target,
    plan.requestedDisclosure,
    graph,
    completeMilestones,
    activeApproachId
  );
  if (!authorization.ok) return failClosedDecision(turnId, authorization.reasonCode);

  const request = RealizationRequestSchema.parse({
    requiredAction: plan.action,
    target: targetToString(classification.target),
    maximumDisclosure: plan.requestedDisclosure,
    ...(plan.requestedDisclosure === 0 ? {} : { allowedDisclosureIds: authorization.value })
  });

  return {
    classification: classification.classification,
    interventionStage: plan.stage,
    reasonCode: plan.reasonCode ?? classification.reasonCode,
    realizationRequest: request,
    waitingPreferred: plan.action === "WAIT",
    escalationJustified: plan.escalationJustified,
    target: classification.target
  };
}

export function selectPedagogicalAction(
  state: Readonly<SessionState>,
  turnId: string,
  problem: InterviewProblem
): RealizationRequest {
  return decidePedagogicalPolicy(state, turnId, problem).realizationRequest;
}
