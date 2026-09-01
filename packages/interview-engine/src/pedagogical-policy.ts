import { z } from "zod";
import {
  DeliveryAtomSchema,
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

const MAX_APPROACHES = 256;
const MAX_MILESTONES = 2_048;
const MAX_GRAPH_EDGES = 8_192;
const MAX_PROTECTED_DISCLOSURES = 1_024;
const MAX_EVIDENCE_KEYS = 4_096;
const MAX_EVIDENCE_RECORDS = 16_384;
const MAX_DELIVERIES = 4_096;
const MAX_VERIFICATION_REQUESTS = 2_048;
const MAX_EVENT_IDS = 100_000;

const PolicyProblemViewSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  interviewer: z.object({
    reasoningGraph: ReasoningGraphSchema,
    protectedDisclosures: z.array(ProtectedDisclosureSchema).max(MAX_PROTECTED_DISCLOSURES)
  }).passthrough()
}).passthrough();

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
  readonly target?: string;
  readonly maximumDisclosure: DisclosureLevel;
  readonly effectiveDisclosureLevel: DisclosureLevel;
  readonly turnSequence: number;
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

function legacyNoProblemDecision(turnId: string): PolicyDecision {
  return {
    classification: "INSUFFICIENT_EVIDENCE",
    interventionStage: "PROBE",
    reasonCode: "MISSING_PROBLEM_CONTEXT",
    realizationRequest: RealizationRequestSchema.parse({
      requiredAction: "PROBE_JUSTIFICATION",
      target: "the student's most recent asserted step",
      maximumDisclosure: 0
    }),
    waitingPreferred: false,
    escalationJustified: false,
    target: { kind: "TURN", id: turnId }
  };
}

function validateGraphContext(problem: unknown): CollectionResult<GraphContext> {
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
  for (const milestoneId of milestoneIds) {
    predecessors.set(milestoneId, []);
    adjacency.set(milestoneId, []);
    indegree.set(milestoneId, 0);
  }

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
      predecessors.get(milestone.id)?.push(prerequisiteId);
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
    adjacency.get(edge.from)?.push(edge.to);
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
    const existing = predecessors.get(edge.to);
    if (existing !== undefined && !existing.includes(edge.from)) existing.push(edge.from);
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

  if (!Array.isArray(state.eventIds) || state.eventIds.length > MAX_EVENT_IDS) {
    return { ok: false, reasonCode: "RESOURCE_LIMIT_EXCEEDED" };
  }
  const knownEventIds = new Set<string>(state.eventIds);
  let recordCount = 0;
  const signals: ActiveEvidenceSignal[] = [];

  for (const [storedKey, rawHistory] of entries) {
    if (!Array.isArray(rawHistory)) {
      return { ok: false, reasonCode: "MALFORMED_POLICY_INPUT" };
    }
    recordCount += rawHistory.length;
    if (recordCount > MAX_EVIDENCE_RECORDS) {
      return { ok: false, reasonCode: "RESOURCE_LIMIT_EXCEEDED" };
    }

    const activeRecords = rawHistory.filter((rawRecord) => {
      if (!isRecord(rawRecord)) return false;
      return rawRecord["status"] === "ACTIVE";
    });
    const hasUnknownStatus = rawHistory.some((rawRecord) => {
      if (!isRecord(rawRecord)) return true;
      const status = rawRecord["status"];
      return status !== "ACTIVE" && status !== "SUPERSEDED" && status !== "STALE";
    });
    if (hasUnknownStatus || activeRecords.length > 1) {
      return { ok: false, reasonCode: "MALFORMED_POLICY_INPUT" };
    }
    const rawActive = activeRecords[0];
    if (rawActive === undefined || !isRecord(rawActive)) continue;

    const keyResult = EvidenceKeySchema.safeParse(rawActive["key"]);
    const valueResult = EvidenceValueSchema.safeParse(rawActive["value"]);
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
    if (evidenceKeyToString(key) !== storedKey) {
      return { ok: false, reasonCode: "MALFORMED_POLICY_INPUT" };
    }
    if (
      !Number.isSafeInteger(value.lastUpdatedSequence)
      || value.lastUpdatedSequence > state.sequence
      || !value.evidenceEventIds.every((eventId) => knownEventIds.has(eventId))
    ) {
      return { ok: false, reasonCode: "MALFORMED_POLICY_INPUT" };
    }
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
      target: targetFromSubject(key.subject),
      canonicalKey: storedKey
    });
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
  for (const rawRequest of entries.map((entry) => entry[1])) {
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
    if (
      !result.success
      || !key.success
      || !basis.success
      || typeof requestedEventId !== "string"
    ) {
      return { ok: false, reasonCode: "MALFORMED_POLICY_INPUT" };
    }

    const sequence = eventSequence.get(requestedEventId);
    if (sequence === undefined) {
      return { ok: false, reasonCode: "MALFORMED_POLICY_INPUT" };
    }
    if (key.data.problemId !== graph.problem.id) continue;
    if (
      key.data.subject.kind === "MILESTONE"
      && !graph.milestoneIds.has(key.data.subject.milestoneId)
    ) {
      return { ok: false, reasonCode: "INVALID_REASONING_TARGET" };
    }
    if (
      key.data.subject.kind === "APPROACH"
      && !graph.approachIds.has(key.data.subject.approachId)
    ) {
      return { ok: false, reasonCode: "INVALID_REASONING_TARGET" };
    }
    if (isGenerationBasisStillCompatible(basis.data, state) !== "COMPATIBLE") {
      continue;
    }

    signals.push({
      target: targetFromSubject(key.data.subject),
      status: result.data.status,
      sequence
    });
  }

  signals.sort(compareVerification);
  return { ok: true, value: signals };
}

function collectExposedAssistance(
  state: Readonly<SessionState>
): CollectionResult<readonly AssistanceRecord[]> {
  const rawDeliveries: unknown = state.deliveries;
  if (!isRecord(rawDeliveries)) {
    return { ok: false, reasonCode: "MALFORMED_POLICY_INPUT" };
  }
  const deliveryEntries = Object.entries(rawDeliveries);
  if (deliveryEntries.length > MAX_DELIVERIES) {
    return { ok: false, reasonCode: "RESOURCE_LIMIT_EXCEEDED" };
  }

  const byGeneration = new Map<string, AssistanceRecord>();
  for (const [deliveryKey, rawDelivery] of deliveryEntries.sort((left, right) => left[0].localeCompare(right[0]))) {
    const delivery = DeliveryAtomSchema.safeParse(rawDelivery);
    if (!delivery.success) {
      return { ok: false, reasonCode: "MALFORMED_POLICY_INPUT" };
    }
    if (delivery.data.deliveryId !== deliveryKey) {
      return { ok: false, reasonCode: "MALFORMED_POLICY_INPUT" };
    }
    if (!isDisclosedStatus(delivery.data.status)) continue;

    const generation = state.generations[delivery.data.generationId];
    if (generation === undefined) {
      return { ok: false, reasonCode: "MALFORMED_POLICY_INPUT" };
    }
    const basis = GenerationBasisSchema.safeParse(generation.basis);
    if (!basis.success) {
      return { ok: false, reasonCode: "MALFORMED_POLICY_INPUT" };
    }
    const request = state.pedagogicalActions[basis.data.turnId];
    if (request === undefined) {
      return { ok: false, reasonCode: "MALFORMED_POLICY_INPUT" };
    }
    const parsedRequest = RealizationRequestSchema.safeParse(request);
    const turn = state.turns[basis.data.turnId];
    if (
      !parsedRequest.success
      || turn === undefined
      || !Number.isSafeInteger(turn.committedSequence)
      || turn.committedSequence <= 0
    ) {
      return { ok: false, reasonCode: "MALFORMED_POLICY_INPUT" };
    }

    const current = byGeneration.get(delivery.data.generationId);
    const record: AssistanceRecord = {
      generationId: delivery.data.generationId,
      action: parsedRequest.data.requiredAction,
      ...(parsedRequest.data.target === undefined ? {} : { target: parsedRequest.data.target }),
      maximumDisclosure: parsedRequest.data.maximumDisclosure,
      effectiveDisclosureLevel: delivery.data.effectiveDisclosureLevel,
      turnSequence: turn.committedSequence
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
    value: [...byGeneration.values()].sort((left, right) => {
      if (left.turnSequence !== right.turnSequence) return left.turnSequence - right.turnSequence;
      return left.generationId.localeCompare(right.generationId);
    })
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

  for (const [targetKey, target] of [...targets.entries()].sort((left, right) => left[0].localeCompare(right[0]))) {
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
  const direct = evidence.find(
    (signal) =>
      signal.key.subject.kind === "APPROACH"
      && signal.key.dimension === "PROGRESS"
      && (signal.value.value === "PROGRESSING" || signal.value.value === "COMPLETE")
  );
  if (direct?.key.subject.kind === "APPROACH") return direct.key.subject.approachId;

  const milestoneSignal = evidence.find(
    (signal) =>
      signal.key.subject.kind === "MILESTONE"
      && signal.key.dimension === "PROGRESS"
      && (signal.value.value === "PROGRESSING" || signal.value.value === "COMPLETE")
  );
  if (milestoneSignal?.key.subject.kind !== "MILESTONE") return undefined;
  const milestone = graph.problem.interviewer.reasoningGraph.milestones.find(
    (item) => item.id === milestoneSignal.key.subject.milestoneId
  );
  if (milestone === undefined || milestone.approachIds.length !== 1) return undefined;
  return milestone.approachIds[0];
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
  const completed = completedMilestoneIds(evidence);
  return graph.problem.interviewer.reasoningGraph.approaches
    .map((approach) => approach.id)
    .filter((approachId) => {
      const requiredMilestones = graph.problem.interviewer.reasoningGraph.milestones
        .filter((milestone) => milestone.approachIds.includes(approachId))
        .map((milestone) => milestone.id);
      return requiredMilestones.length > 0 && requiredMilestones.every((id) => completed.has(id));
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
  const conflictTarget = findConflictTarget(evidence, verification);
  if (conflictTarget !== undefined) {
    return {
      classification: "AMBIGUOUS_STATEMENT",
      reasonCode: "CONFLICTING_ACTIVE_SIGNALS",
      target: conflictTarget
    };
  }

  const completedApproaches = findCompletedApproaches(evidence, graph);
  const completionSequence = evidence
    .filter((signal) => signal.value.value === "COMPLETE")
    .reduce((maximum, signal) => Math.max(maximum, signal.value.lastUpdatedSequence), 0);
  const laterProgress = evidence.find(
    (signal) =>
      signal.key.dimension === "PROGRESS"
      && signal.value.value === "PROGRESSING"
      && signal.value.lastUpdatedSequence > completionSequence
  );
  if (completedApproaches.length > 0 && laterProgress === undefined) {
    const completedApproachId = completedApproaches[0];
    const alternateApproachId = graph.problem.interviewer.reasoningGraph.approaches
      .map((approach) => approach.id)
      .filter((approachId) => !completedApproaches.includes(approachId))
      .sort()[0];
    return {
      classification: "COMPLETED_PRIMARY_APPROACH",
      reasonCode: "PRIMARY_APPROACH_COMPLETE",
      target: alternateApproachId === undefined
        ? { kind: "APPROACH", id: completedApproachId ?? graph.problem.interviewer.reasoningGraph.approaches[0]?.id ?? "completed" }
        : { kind: "APPROACH", id: alternateApproachId },
      ...(completedApproachId === undefined ? {} : { completedApproachId }),
      ...(alternateApproachId === undefined ? {} : { alternateApproachId })
    };
  }

  const structural = findSignal(evidence, "CORRECTNESS", new Set(["STRUCTURAL_ERROR"]));
  if (structural !== undefined) {
    return {
      classification: "STRUCTURAL_ERROR",
      reasonCode: "STRUCTURAL_REFRAMING_NEEDED",
      target: structural.target
    };
  }

  const misunderstood = findSignal(evidence, "UNDERSTANDING", new Set(["MISUNDERSTOOD_PROBLEM"]));
  if (misunderstood !== undefined) {
    return {
      classification: "MISUNDERSTANDING",
      reasonCode: "PROBLEM_MISUNDERSTOOD",
      target: misunderstood.target
    };
  }

  const local = findSignal(evidence, "CORRECTNESS", new Set(["LOCAL_ERROR"]));
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

  const unsupported = findSignal(evidence, "JUSTIFICATION", new Set(["UNJUSTIFIED", "INCOMPLETE"]));
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

  const stalled = findSignal(evidence, "PROGRESS", new Set(["STALLED", "REGRESSING"]));
  if (stalled !== undefined) {
    return {
      classification: "TRUE_STAGNATION",
      reasonCode: "PROGRESS_STALLED",
      target: stalled.target
    };
  }

  const progressing = findSignal(evidence, "PROGRESS", new Set(["PROGRESSING"]));
  if (progressing !== undefined) {
    const nextTarget = selectNextMilestoneTarget(evidence, graph);
    const target = nextTarget ?? progressing.target;
    if (isUnexpectedApproachTarget(progressing.target, graph)) {
      return {
        classification: "UNEXPECTED_VALID_APPROACH",
        reasonCode: "ALTERNATE_APPROACH_PROGRESS",
        target
      };
    }
    return {
      classification: "PRODUCTIVE_PROGRESS",
      reasonCode: "PROGRESS_CONTINUES",
      target
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

  const ambiguous = evidence.find(
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

  if (evidence.length === 0) {
    return {
      classification: "INSUFFICIENT_EVIDENCE",
      reasonCode: "NO_CURRENT_EVIDENCE",
      target: { kind: "TURN", id: turnId }
    };
  }

  const latest = evidence[0];
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
  return assistance.filter(
    (record) =>
      record.target === undefined
      || record.target === targetString
      || record.target === "the student's most recent asserted step"
  );
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
  graph: GraphContext
): CollectionResult<ReadonlySet<DisclosureId>> {
  if (!Array.isArray(state.disclosureLedger) || state.disclosureLedger.length > MAX_PROTECTED_DISCLOSURES) {
    return { ok: false, reasonCode: "RESOURCE_LIMIT_EXCEEDED" };
  }
  const delivered = new Set<DisclosureId>();
  for (const disclosureId of state.disclosureLedger) {
    if (!graph.disclosureIds.has(disclosureId)) {
      return { ok: false, reasonCode: "MALFORMED_POLICY_INPUT" };
    }
    delivered.add(disclosureId);
  }
  return { ok: true, value: delivered };
}

function targetDisclosureAuthorization(
  target: PolicyTarget,
  level: DisclosureLevel,
  graph: GraphContext,
  completed: ReadonlySet<string>,
  alreadyDisclosed: ReadonlySet<DisclosureId>
): readonly DisclosureId[] {
  const allowed = new Set<DisclosureId>(alreadyDisclosed);
  if (level === 0 || target.kind !== "MILESTONE") return [...allowed].sort();

  const milestone = graph.problem.interviewer.reasoningGraph.milestones.find((item) => item.id === target.id);
  if (milestone === undefined || !milestoneReady(milestone.id, graph, completed)) {
    return [...allowed].sort();
  }

  const byId = disclosureMap(graph);
  for (const disclosureId of milestone.protectedDisclosureIds) {
    const disclosure = byId.get(disclosureId);
    if (disclosure !== undefined && disclosure.minimumDisclosureLevel <= level) {
      allowed.add(disclosureId);
    }
  }
  return [...allowed].sort();
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
    case "PRODUCTIVE_PROGRESS":
    case "UNEXPECTED_VALID_APPROACH":
      return {
        action: "WAIT",
        requestedDisclosure: 0,
        stage: "OBSERVE",
        escalationJustified: false
      };
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
      return {
        action: "DIRECTIONAL_NUDGE",
        requestedDisclosure: 2,
        stage: "NUDGE",
        escalationJustified: true
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
    case "COMPLETED_PRIMARY_APPROACH":
      return {
        action: classification.alternateApproachId === undefined ? "GENERALIZE" : "ASK_ALTERNATE_SOLUTION",
        requestedDisclosure: 0,
        stage: "OBSERVE",
        escalationJustified: false
      };
  }
}

export function decidePedagogicalPolicy(
  state: Readonly<SessionState>,
  turnId: string,
  problem: InterviewProblem
): PolicyDecision {
  const turn = state.turns[turnId];
  if (turn === undefined) throw new Error("Unknown turn " + turnId);

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

  const evidenceResult = collectActiveEvidence(state, graph);
  if (!evidenceResult.ok) return failClosedDecision(turnId, evidenceResult.reasonCode);
  const verificationResult = collectVerificationSignals(state, graph);
  if (!verificationResult.ok) return failClosedDecision(turnId, verificationResult.reasonCode);
  const assistanceResult = collectExposedAssistance(state);
  if (!assistanceResult.ok) return failClosedDecision(turnId, assistanceResult.reasonCode);
  const ledgerResult = validateDisclosureLedger(state, graph);
  if (!ledgerResult.ok) return failClosedDecision(turnId, ledgerResult.reasonCode);

  let classification = classifyProgress(
    evidenceResult.value,
    verificationResult.value,
    graph,
    turnId
  );
  const targetAssistance = assistanceForTarget(assistanceResult.value, classification.target);
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

  const completeMilestones = completedMilestoneIds(evidenceResult.value);
  const hintLevel = explicitHintLevel(
    classification.target,
    graph,
    completeMilestones,
    ledgerResult.value
  );
  const plan = chooseActionPlan(classification, targetAssistance, hintLevel);
  const allowedDisclosureIds = targetDisclosureAuthorization(
    classification.target,
    plan.requestedDisclosure,
    graph,
    completeMilestones,
    ledgerResult.value
  );

  const request = RealizationRequestSchema.parse({
    requiredAction: plan.action,
    target: targetToString(classification.target),
    maximumDisclosure: plan.requestedDisclosure,
    ...(plan.requestedDisclosure === 0 ? {} : { allowedDisclosureIds })
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
  problem?: InterviewProblem
): RealizationRequest {
  const turn = state.turns[turnId];
  if (turn === undefined) throw new Error("Unknown turn " + turnId);
  if (problem === undefined) return legacyNoProblemDecision(turnId).realizationRequest;
  return decidePedagogicalPolicy(state, turnId, problem).realizationRequest;
}
