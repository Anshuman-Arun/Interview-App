import { z } from "zod";
import {
  SessionEvaluationSchema,
  isDisclosedStatus,
  type DeliveryAtom,
  type EvidenceKey,
  type EventId,
  type GenerationId,
  type SessionEvaluation,
  type SessionId
} from "../../domain/src/index.js";
import type {
  SessionEvent,
  SessionState
} from "../../events/src/index.js";
import {
  MAX_REPLAY_EVALUATION_COLLECTION_ITEMS,
  previewText,
  resolveReplayBounds,
  takeBounded,
  type ReplayBounds
} from "./bounds.js";
import { compareReplayStrings } from "./identity.js";
import {
  normalizeReplayEvents,
  ReplayProjectionError,
  type NormalizedReplayEvent
} from "./provenance.js";
import { projectReplayTimelineFromNormalized } from "./timeline.js";
import { validateKnownReplayPrefix } from "./validation.js";
import type {
  ReplayCurrentEvidence,
  ReplayEvaluationSummary,
  ReplayEvidenceHistoryEntry,
  ReplayEvidenceValue,
  ReplayEventProvenance,
  ReplayGenerationHistoryEntry,
  ReplaySessionLifecycle,
  ReplayVerificationHistoryEntry,
  ReplayVerificationSummary,
  SessionHistoryProjection
} from "./types.js";

export interface SessionHistoryOptions {
  readonly bounds?: Partial<ReplayBounds>;
  readonly evaluation?: unknown;
}

function knownEvents(
  items: readonly NormalizedReplayEvent[]
): readonly SessionEvent[] {
  return items.flatMap((item) => item.event === undefined ? [] : [item.event]);
}

function lastObservedSequence(items: readonly NormalizedReplayEvent[]): number {
  return items.at(-1)?.metadata.sequence ?? 0;
}

function lifecycleFrom(
  items: readonly NormalizedReplayEvent[],
  state: SessionState | undefined,
  historyComplete: boolean
): ReplaySessionLifecycle {
  const started = items.find((item) => item.event?.type === "SESSION_STARTED");
  const completed = items.findLast((item) => item.event?.type === "SESSION_COMPLETED");
  const archived = items.findLast((item) => item.event?.type === "SESSION_ARCHIVED");
  const resumedCount = items.filter((item) => item.event?.type === "SESSION_RESUMED").length;
  const recoveryOriginPossiblyExposedCount = items.filter((item) =>
    item.event?.type === "DELIVERY_POSSIBLY_EXPOSED" && item.provenance.source === "RECOVERY"
  ).length;

  const startedAt = started?.event?.type === "SESSION_STARTED"
    ? started.event.payload.startedAt
    : undefined;
  const completedAt = completed?.event?.type === "SESSION_COMPLETED"
    ? completed.event.payload.completedAt
    : undefined;
  const archivedAt = archived?.event?.type === "SESSION_ARCHIVED"
    ? archived.event.payload.archivedAt
    : undefined;

  let activeElapsedDurationMs: number | undefined;
  const activeEnd = completed ?? archived;
  if (started !== undefined && activeEnd !== undefined) {
    const difference = activeEnd.metadata.elapsedMs - started.metadata.elapsedMs;
    if (difference >= 0 && Number.isSafeInteger(difference)) {
      activeElapsedDurationMs = difference;
    }
  }

  return {
    status: state?.status === "CREATED" ? "UNKNOWN" : state?.status ?? "UNKNOWN",
    historyComplete,
    started: started !== undefined ? true : historyComplete ? false : null,
    completed: completed !== undefined ? true : historyComplete ? false : null,
    archived: archived !== undefined ? true : historyComplete ? false : null,
    resumedCount,
    recoveryOriginPossiblyExposedCount,
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(completedAt === undefined ? {} : { completedAt }),
    ...(archivedAt === undefined ? {} : { archivedAt }),
    ...(activeElapsedDurationMs === undefined ? {} : { activeElapsedDurationMs })
  };
}

function projectEvidenceValue(
  value: SessionState["studentEvidence"][string],
  bounds: ReplayBounds
): ReplayEvidenceValue {
  const evidenceIds = takeBounded(value.evidenceEventIds, bounds.maxProvenanceIds);
  return {
    value: value.value,
    inferenceConfidence: value.inferenceConfidence,
    evidenceEventIds: evidenceIds.values,
    evidenceEventIdsTruncation: evidenceIds.truncation,
    lastUpdatedSequence: value.lastUpdatedSequence
  };
}

function currentEvidenceFromState(
  state: SessionState,
  bounds: ReplayBounds
): {
  readonly values: readonly ReplayCurrentEvidence[];
  readonly truncation: ReturnType<typeof takeBounded<ReplayCurrentEvidence>>["truncation"];
} {
  const current: ReplayCurrentEvidence[] = [];
  const keys = Object.keys(state.evidenceHistory).sort(compareReplayStrings);
  for (const keyString of keys) {
    const records = state.evidenceHistory[keyString] ?? [];
    const active = records.find((record) => record.status === "ACTIVE");
    if (active === undefined) continue;
    current.push({
      keyString,
      key: active.key,
      value: projectEvidenceValue(active.value, bounds),
      evidenceEventId: active.evidenceEventId
    });
  }
  return takeBounded(current, bounds.maxEvidenceHistoryEntries);
}

function evidenceHistoryFrom(
  items: readonly NormalizedReplayEvent[],
  bounds: ReplayBounds,
  state: SessionState | undefined
): ReturnType<typeof takeBounded<ReplayEvidenceHistoryEntry>> {
  const finalStatusByEvidenceEventId = new Map<EventId, "ACTIVE" | "SUPERSEDED" | "STALE">();
  if (state !== undefined) {
    for (const evidenceRecords of Object.values(state.evidenceHistory)) {
      for (const record of evidenceRecords) {
        finalStatusByEvidenceEventId.set(record.evidenceEventId, record.status);
      }
    }
  }

  const records: ReplayEvidenceHistoryEntry[] = [];
  for (const item of items) {
    const event = item.event;
    if (event?.type === "STUDENT_EVIDENCE_UPDATED") {
      const finalStatus = finalStatusByEvidenceEventId.get(event.eventId);
      records.push({
        sequence: event.sequence,
        evidenceEventId: event.eventId,
        transition: "UPDATED",
        key: event.payload.key,
        ...(finalStatus === undefined ? {} : { finalStatus }),
        value: projectEvidenceValue(event.payload.value, bounds),
        ...(event.payload.supersedesEventId === undefined
          ? {}
          : { supersedesEventId: event.payload.supersedesEventId }),
        provenance: item.provenance
      });
    } else if (event?.type === "STUDENT_EVIDENCE_INVALIDATED") {
      records.push({
        sequence: event.sequence,
        evidenceEventId: event.eventId,
        transition: "INVALIDATED",
        key: event.payload.key,
        invalidatesEventId: event.payload.invalidatesEventId,
        reason: previewText(event.payload.reason, bounds.maxTextPreviewChars),
        provenance: item.provenance
      });
    }
  }
  return takeBounded(records, bounds.maxEvidenceHistoryEntries);
}

interface MutableVerificationHistory {
  verificationRequestId: string;
  verifier: string;
  basis: ReplayVerificationHistoryEntry["basis"];
  evidenceKey: EvidenceKey;
  evidenceEventIds: readonly EventId[];
  evidenceEventIdsTruncation: ReplayVerificationHistoryEntry["evidenceEventIdsTruncation"];
  candidateFormalInterpretationPersisted: boolean;
  interpretationConfidence: number;
  sourceGenerationId?: GenerationId;
  sourceProposalRequestId?: string;
  requestProvenance: ReplayEventProvenance;
  status: ReplayVerificationHistoryEntry["status"];
  result?: ReplayVerificationHistoryEntry["result"];
  discard?: ReplayVerificationHistoryEntry["discard"];
}

function verificationHistoryFrom(
  items: readonly NormalizedReplayEvent[],
  bounds: ReplayBounds
): ReturnType<typeof takeBounded<ReplayVerificationHistoryEntry>> {
  const byRequest = new Map<string, MutableVerificationHistory>();
  for (const item of items) {
    const event = item.event;
    if (event?.type === "VERIFICATION_REQUESTED") {
      byRequest.set(event.payload.verificationRequestId, {
        verificationRequestId: event.payload.verificationRequestId,
        verifier: event.payload.verifier,
        basis: event.payload.basis,
        evidenceKey: event.payload.evidenceKey,
        ...(() => {
          const evidenceEventIds = takeBounded(
            event.payload.evidenceEventIds,
            bounds.maxProvenanceIds
          );
          return {
            evidenceEventIds: evidenceEventIds.values,
            evidenceEventIdsTruncation: evidenceEventIds.truncation
          };
        })(),
        candidateFormalInterpretationPersisted: true,
        interpretationConfidence: event.payload.interpretationConfidence,
        ...(event.payload.sourceGenerationId === undefined
          ? {}
          : { sourceGenerationId: event.payload.sourceGenerationId }),
        ...(event.payload.sourceProposalRequestId === undefined
          ? {}
          : { sourceProposalRequestId: event.payload.sourceProposalRequestId }),
        requestProvenance: item.provenance,
        status: "PENDING"
      });
      continue;
    }

    if (
      event?.type !== "VERIFICATION_RESULT_ACCEPTED"
      && event?.type !== "VERIFICATION_RESULT_DISCARDED"
    ) {
      continue;
    }
    const current = byRequest.get(event.payload.verificationRequestId);
    if (current === undefined) {
      throw new ReplayProjectionError("INVALID_EVENT_SEMANTICS");
    }

    if (event.type === "VERIFICATION_RESULT_ACCEPTED") {
      current.status = "ACCEPTED";
      current.result = {
        status: event.payload.result.status,
        verifier: event.payload.result.verifier,
        interpretationConfidence: event.payload.result.interpretationConfidence,
        provenance: item.provenance
      };
    } else {
      current.status = "DISCARDED";
      current.discard = {
        reason: previewText(event.payload.reason, bounds.maxTextPreviewChars),
        provenance: item.provenance
      };
    }
  }

  const ordered = [...byRequest.values()]
    .sort((left, right) => left.requestProvenance.sequence - right.requestProvenance.sequence)
    .map((entry): ReplayVerificationHistoryEntry => ({
      verificationRequestId: entry.verificationRequestId,
      verifier: entry.verifier,
      basis: entry.basis,
      evidenceKey: entry.evidenceKey,
      evidenceEventIds: entry.evidenceEventIds,
      evidenceEventIdsTruncation: entry.evidenceEventIdsTruncation,
      candidateFormalInterpretationPersisted: entry.candidateFormalInterpretationPersisted,
      interpretationConfidence: entry.interpretationConfidence,
      ...(entry.sourceGenerationId === undefined ? {} : { sourceGenerationId: entry.sourceGenerationId }),
      ...(entry.sourceProposalRequestId === undefined ? {} : { sourceProposalRequestId: entry.sourceProposalRequestId }),
      requestProvenance: entry.requestProvenance,
      status: entry.status,
      ...(entry.result === undefined ? {} : { result: entry.result }),
      ...(entry.discard === undefined ? {} : { discard: entry.discard })
    }));
  return takeBounded(ordered, bounds.maxVerificationEntries);
}

interface MutableGenerationHistory {
  generationId: GenerationId;
  provider: string;
  basis: ReplayGenerationHistoryEntry["basis"];
  startProvenance: ReplayEventProvenance;
  status: ReplayGenerationHistoryEntry["status"];
  contextManifest?: ReplayGenerationHistoryEntry["contextManifest"];
  proposalMetadata?: ReplayGenerationHistoryEntry["proposalMetadata"];
  formalInterpretation?: ReplayGenerationHistoryEntry["formalInterpretation"];
  superseded?: ReplayGenerationHistoryEntry["superseded"];
  deliveryIds: string[];
}

function generationHistoryFrom(
  items: readonly NormalizedReplayEvent[],
  state: SessionState | undefined,
  bounds: ReplayBounds
): ReturnType<typeof takeBounded<ReplayGenerationHistoryEntry>> {
  const byGeneration = new Map<GenerationId, MutableGenerationHistory>();

  for (const item of items) {
    const event = item.event;
    if (event?.type === "MODEL_GENERATION_STARTED") {
      byGeneration.set(event.payload.generationId, {
        generationId: event.payload.generationId,
        provider: event.payload.provider,
        basis: event.payload.basis,
        startProvenance: item.provenance,
        status: "ACTIVE",
        deliveryIds: [],
      });
      continue;
    }

    let generationId: GenerationId | undefined;
    if (
      event?.type === "GENERATION_CONTEXT_COMPILED"
      || event?.type === "MODEL_PROPOSAL_RECEIVED"
      || event?.type === "FORMAL_INTERPRETATION_PROPOSAL_RECEIVED"
      || event?.type === "FORMAL_INTERPRETATION_PROPOSAL_REJECTED"
      || event?.type === "MODEL_GENERATION_SUPERSEDED"
      || event?.type === "PROPOSAL_VALIDATED"
      || event?.type === "PROPOSAL_REJECTED"
    ) {
      generationId = event.payload.generationId;
    } else if (event?.type === "DELIVERY_QUEUED") {
      generationId = event.payload.atom.generationId;
    } else {
      continue;
    }

    const current = byGeneration.get(generationId);
    if (current === undefined) {
      throw new ReplayProjectionError("INVALID_EVENT_SEMANTICS");
    }
    switch (event.type) {
      case "GENERATION_CONTEXT_COMPILED":
        current.contextManifest = {
          compilerVersion: event.payload.manifest.compilerVersion,
          problemId: event.payload.manifest.problemId,
          problemVersion: event.payload.manifest.problemVersion,
          contextSha256: event.payload.manifest.contextSha256,
          reasoningGraphSha256: event.payload.manifest.reasoningGraphSha256
        };
        break;
      case "MODEL_PROPOSAL_RECEIVED":
        current.proposalMetadata = {
          realizedAction: event.payload.proposal.realizedAction,
          claimedDisclosureLevel: event.payload.proposal.claimedDisclosureLevel,
          claimedDisclosureIdCount: event.payload.proposal.claimedDisclosureIds.length,
          speechTextPersisted: event.payload.proposal.speechText !== undefined,
          boardActionCount: event.payload.proposal.boardActions?.length ?? 0,
          provenance: item.provenance
        };
        break;
      case "FORMAL_INTERPRETATION_PROPOSAL_RECEIVED":
        current.formalInterpretation = {
          proposalRequestId: event.payload.proposalRequestId,
          candidateFormalInterpretationPersisted: true,
          provenance: item.provenance
        };
        break;
      case "FORMAL_INTERPRETATION_PROPOSAL_REJECTED":
      case "PROPOSAL_REJECTED":
        current.status = "REJECTED";
        break;
      case "PROPOSAL_VALIDATED":
        current.status = "VALIDATED";
        break;
      case "MODEL_GENERATION_SUPERSEDED":
        current.status = "SUPERSEDED";
        current.superseded = {
          reason: previewText(event.payload.reason, bounds.maxTextPreviewChars),
          provenance: item.provenance
        };
        break;
      case "DELIVERY_QUEUED":
        current.deliveryIds.push(event.payload.atom.deliveryId);
        break;
      default:
        break;
    }
  }

  if (state !== undefined) {
    for (const current of byGeneration.values()) {
      const authoritative = state.generations[current.generationId];
      if (authoritative !== undefined) current.status = authoritative.status;
    }
  }

  const ordered = [...byGeneration.values()]
    .sort((left, right) => left.startProvenance.sequence - right.startProvenance.sequence)
    .map((entry): ReplayGenerationHistoryEntry => ({
      generationId: entry.generationId,
      provider: entry.provider,
      basis: entry.basis,
      startProvenance: entry.startProvenance,
      status: entry.status,
      ...(entry.contextManifest === undefined ? {} : { contextManifest: entry.contextManifest }),
      ...(entry.proposalMetadata === undefined ? {} : { proposalMetadata: entry.proposalMetadata }),
      ...(entry.formalInterpretation === undefined ? {} : { formalInterpretation: entry.formalInterpretation }),
      ...(entry.superseded === undefined ? {} : { superseded: entry.superseded }),
      ...(() => {
        const deliveryIds = takeBounded(
          entry.deliveryIds,
          bounds.maxProvenanceIds
        );
        return {
          deliveryIds: deliveryIds.values,
          deliveryIdsTruncation: deliveryIds.truncation
        };
      })(),
      statusIsCurrent: state !== undefined
    }));
  return takeBounded(ordered, bounds.maxGenerationEntries);
}

function evaluationSummary(evaluation: SessionEvaluation): ReplayEvaluationSummary {
  return {
    sessionId: evaluation.sessionId,
    problemId: evaluation.problemId,
    problemVersion: evaluation.problemVersion,
    evaluatedAt: evaluation.evaluatedAt,
    scores: { ...evaluation.scores },
    milestoneCount: evaluation.milestones.length,
    achievedMilestoneCount: evaluation.milestones.filter((milestone) => milestone.achieved).length,
    unassistedMilestoneCount: evaluation.unassistedMilestoneCount,
    assistedMilestoneCount: evaluation.assistedMilestoneCount,
    disclosedInterventionCount: evaluation.disclosedInterventions.length,
    totalTurns: evaluation.totalTurns
  };
}

function interventionIdentity(input: {
  readonly turnId: string;
  readonly disclosureLevel: number;
  readonly disclosureIds: readonly string[];
  readonly deliveryStatus: "EXPOSED" | "POSSIBLY_EXPOSED";
}): string {
  return JSON.stringify([
    input.turnId,
    input.disclosureLevel,
    [...input.disclosureIds].sort(compareReplayStrings),
    input.deliveryStatus
  ]);
}

function evaluationCollectionsWithinReplayBudget(input: unknown): boolean {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return true;
  }

  const record = input as Readonly<Record<string, unknown>>;
  let itemCount = 0;
  const addArrayLength = (value: unknown): boolean => {
    if (!Array.isArray(value)) return true;
    itemCount += value.length;
    return itemCount <= MAX_REPLAY_EVALUATION_COLLECTION_ITEMS;
  };

  if (
    !addArrayLength(record.milestones)
    || !addArrayLength(record.disclosedInterventions)
    || !addArrayLength(record.keyStrengths)
    || !addArrayLength(record.areasForImprovement)
  ) {
    return false;
  }

  if (Array.isArray(record.disclosedInterventions)) {
    for (const intervention of record.disclosedInterventions) {
      if (
        typeof intervention !== "object"
        || intervention === null
        || Array.isArray(intervention)
      ) {
        continue;
      }
      const disclosureIds = (intervention as Readonly<Record<string, unknown>>)
        .disclosureIds;
      if (!addArrayLength(disclosureIds)) return false;
    }
  }

  return true;
}

function validateEvaluation(
  input: unknown,
  sessionId: SessionId | null,
  problem: SessionHistoryProjection["problem"],
  state: SessionState | undefined
): ReplayEvaluationSummary | undefined {
  if (input === undefined) return undefined;

  let parsed: ReturnType<typeof SessionEvaluationSchema.safeParse>;
  try {
    if (!evaluationCollectionsWithinReplayBudget(input)) {
      throw new ReplayProjectionError("EVALUATION_MISMATCH");
    }
    parsed = SessionEvaluationSchema.safeParse(input);
  } catch (error) {
    if (error instanceof ReplayProjectionError) throw error;
    throw new ReplayProjectionError("EVALUATION_MISMATCH");
  }
  if (!parsed.success) throw new ReplayProjectionError("EVALUATION_MISMATCH");

  const evaluatedAt = z.iso.datetime().safeParse(parsed.data.evaluatedAt);
  if (
    !evaluatedAt.success
    || sessionId === null
    || state === undefined
    || state.completedAt === undefined
    || (state.status !== "COMPLETED" && state.status !== "ARCHIVED")
    || parsed.data.sessionId !== sessionId
    || problem === undefined
    || parsed.data.problemId !== problem.problemId
    || parsed.data.problemVersion !== problem.problemVersion
    || parsed.data.totalTurns !== Object.keys(state.turns).length
  ) {
    throw new ReplayProjectionError("EVALUATION_MISMATCH");
  }

  const achieved = parsed.data.milestones.filter((milestone) => milestone.achieved);
  const unassisted = achieved.filter((milestone) => milestone.assistanceLevel === 0).length;
  const assisted = achieved.length - unassisted;
  const milestoneIds = new Set<string>();
  for (const milestone of parsed.data.milestones) {
    if (milestoneIds.has(milestone.milestoneId)) {
      throw new ReplayProjectionError("EVALUATION_MISMATCH");
    }
    milestoneIds.add(milestone.milestoneId);
    if (
      milestone.achievedAtTurnId !== undefined
      && state.turns[milestone.achievedAtTurnId] === undefined
    ) {
      throw new ReplayProjectionError("EVALUATION_MISMATCH");
    }
    if (!milestone.achieved && milestone.achievedAtTurnId !== undefined) {
      throw new ReplayProjectionError("EVALUATION_MISMATCH");
    }
  }

  const authoritativeInterventions = new Map<string, number>();
  for (const delivery of Object.values(state.deliveries)) {
    if (!isDisclosedStatus(delivery.status)) continue;
    const generation = state.generations[delivery.generationId];
    if (generation === undefined) {
      throw new ReplayProjectionError("EVALUATION_MISMATCH");
    }
    const identity = interventionIdentity({
      turnId: generation.basis.turnId,
      disclosureLevel: delivery.effectiveDisclosureLevel,
      disclosureIds: delivery.disclosureIds,
      deliveryStatus:
        delivery.status === "POSSIBLY_EXPOSED"
          ? "POSSIBLY_EXPOSED"
          : "EXPOSED"
    });
    authoritativeInterventions.set(
      identity,
      (authoritativeInterventions.get(identity) ?? 0) + 1
    );
  }

  for (const intervention of parsed.data.disclosedInterventions) {
    if (state.turns[intervention.turnId] === undefined) {
      throw new ReplayProjectionError("EVALUATION_MISMATCH");
    }
    const identity = interventionIdentity(intervention);
    const remaining = authoritativeInterventions.get(identity) ?? 0;
    if (remaining <= 0) throw new ReplayProjectionError("EVALUATION_MISMATCH");
    if (remaining === 1) {
      authoritativeInterventions.delete(identity);
    } else {
      authoritativeInterventions.set(identity, remaining - 1);
    }
  }

  if (
    parsed.data.unassistedMilestoneCount !== unassisted
    || parsed.data.assistedMilestoneCount !== assisted
    || authoritativeInterventions.size !== 0
  ) {
    throw new ReplayProjectionError("EVALUATION_MISMATCH");
  }

  return evaluationSummary(parsed.data);
}

function verificationSummaryFrom(
  items: readonly NormalizedReplayEvent[]
): ReplayVerificationSummary {
  const byRequest = new Map<string, {
    status: "PENDING" | "ACCEPTED" | "DISCARDED";
    resultStatus?: "VERIFIED" | "CONTRADICTED" | "UNRESOLVED";
  }>();

  for (const item of items) {
    const event = item.event;
    if (event?.type === "VERIFICATION_REQUESTED") {
      byRequest.set(event.payload.verificationRequestId, { status: "PENDING" });
    } else if (event?.type === "VERIFICATION_RESULT_ACCEPTED") {
      const request = byRequest.get(event.payload.verificationRequestId);
      if (request === undefined) {
        throw new ReplayProjectionError("INVALID_EVENT_SEMANTICS");
      }
      request.status = "ACCEPTED";
      request.resultStatus = event.payload.result.status;
    } else if (event?.type === "VERIFICATION_RESULT_DISCARDED") {
      const request = byRequest.get(event.payload.verificationRequestId);
      if (request === undefined) {
        throw new ReplayProjectionError("INVALID_EVENT_SEMANTICS");
      }
      request.status = "DISCARDED";
    }
  }

  const values = [...byRequest.values()];
  return {
    pending: values.filter((entry) => entry.status === "PENDING").length,
    verified: values.filter((entry) => entry.resultStatus === "VERIFIED").length,
    contradicted: values.filter((entry) => entry.resultStatus === "CONTRADICTED").length,
    unresolved: values.filter((entry) => entry.resultStatus === "UNRESOLVED").length,
    discarded: values.filter((entry) => entry.status === "DISCARDED").length
  };
}

function directDeliveryCounts(events: readonly SessionEvent[]): {
  readonly exposed: number;
  readonly possible: number;
  readonly cancelled: number;
} {
  return {
    exposed: new Set(events.filter((event) => event.type === "DELIVERY_EXPOSED")
      .map((event) => event.payload.deliveryId)).size,
    possible: new Set(events.filter((event) => event.type === "DELIVERY_POSSIBLY_EXPOSED")
      .map((event) => event.payload.deliveryId)).size,
    cancelled: new Set(events.filter((event) => event.type === "DELIVERY_CANCELLED")
      .map((event) => event.payload.deliveryId)).size
  };
}

function disclosedHighest(state: SessionState): 0 | 1 | 2 | 3 | 4 | 5 | undefined {
  let highest: 0 | 1 | 2 | 3 | 4 | 5 | undefined;
  for (const delivery of Object.values(state.deliveries)) {
    if (!isDisclosedStatus(delivery.status)) continue;
    if (highest === undefined || delivery.effectiveDisclosureLevel > highest) {
      highest = delivery.effectiveDisclosureLevel;
    }
  }
  return highest;
}

export function projectSessionHistory(
  rawEvents: readonly unknown[],
  options: SessionHistoryOptions = {}
): SessionHistoryProjection {
  const bounds = resolveReplayBounds(options.bounds);
  const normalized = normalizeReplayEvents(rawEvents, bounds);
  const semanticItems = normalized.events.filter((item) =>
    normalized.firstUnknownSequence === undefined
      ? item.event !== undefined
      : item.metadata.sequence < normalized.firstUnknownSequence && item.event !== undefined
  );
  const events = knownEvents(semanticItems);
  const validated = normalized.sessionId === null || events.length === 0
    ? undefined
    : validateKnownReplayPrefix(normalized.sessionId, events, {
        completeHistory:
          !normalized.eventTruncation.truncated
          && !normalized.hasUnknownEvents
      });
  const historyComplete =
    normalized.sessionId !== null
    && !normalized.hasUnknownEvents
    && !normalized.eventTruncation.truncated;
  const state = historyComplete ? validated?.state : undefined;

  const problemEvent = [...semanticItems].reverse()
    .find((item) => item.event?.type === "PROBLEM_PRESENTED");
  const problem = state?.problem === undefined
    ? problemEvent?.event?.type === "PROBLEM_PRESENTED"
      ? {
          problemId: problemEvent.event.payload.problemId,
          problemVersion: problemEvent.event.payload.problemVersion
        }
      : undefined
    : {
        problemId: state.problem.id,
        problemVersion: state.problem.version
      };

  const timeline = projectReplayTimelineFromNormalized(
    normalized,
    bounds,
    true
  );
  const evidence = evidenceHistoryFrom(semanticItems, bounds, state);
  const currentEvidence = state === undefined
    ? takeBounded<ReplayCurrentEvidence>([], bounds.maxEvidenceHistoryEntries)
    : currentEvidenceFromState(state, bounds);
  const verification = verificationHistoryFrom(semanticItems, bounds);
  const generations = generationHistoryFrom(semanticItems, state, bounds);
  const directCounts = directDeliveryCounts(events);
  const eventCounts = {
    turns: events.filter((event) => event.type === "TURN_COMMITTED").length,
    inputEpisodes: events.filter((event) => event.type === "INPUT_EPISODE_STARTED").length,
    utterances: events.filter((event) => event.type === "UTTERANCE_STARTED").length,
    generations: events.filter((event) => event.type === "MODEL_GENERATION_STARTED").length,
    deliveries: events.filter((event) => event.type === "DELIVERY_QUEUED").length
  };

  const inFlightDeliveries = state === undefined
    ? undefined
    : Object.values(state.deliveries).filter((delivery: DeliveryAtom) =>
        delivery.status === "VALIDATED"
        || delivery.status === "QUEUED"
        || delivery.status === "DELIVERING"
      ).length;

  const evidenceStateRecords = state === undefined
    ? undefined
    : Object.values(state.evidenceHistory).flatMap((records) => [...records]);
  const evidenceSummary = {
    recordedUpdates: events.filter((event) => event.type === "STUDENT_EVIDENCE_UPDATED").length,
    recordedInvalidations: events.filter((event) => event.type === "STUDENT_EVIDENCE_INVALIDATED").length,
    ...(evidenceStateRecords === undefined
      ? {}
      : {
          currentActive: evidenceStateRecords.filter((record) => record.status === "ACTIVE").length,
          superseded: evidenceStateRecords.filter((record) => record.status === "SUPERSEDED").length,
          stale: evidenceStateRecords.filter((record) => record.status === "STALE").length
        })
  };
  const verificationSummary = verificationSummaryFrom(semanticItems);
  const highestDisclosureUsed = state === undefined ? undefined : disclosedHighest(state);
  const evaluation = validateEvaluation(options.evaluation, normalized.sessionId, problem, state);

  return {
    sessionId: normalized.sessionId,
    ...(problem === undefined ? {} : { problem }),
    lifecycle: lifecycleFrom(semanticItems, state, historyComplete),
    counts: {
      ...eventCounts,
      exposedInterventions: directCounts.exposed,
      possiblyExposedInterventions: directCounts.possible,
      cancelledInterventions: directCounts.cancelled,
      ...(inFlightDeliveries === undefined ? {} : { inFlightDeliveries })
    },
    ...(highestDisclosureUsed === undefined ? {} : { highestDisclosureUsed }),
    currentStateAvailable: state !== undefined,
    validatedThroughSequence: validated?.validatedThroughSequence ?? 0,
    observedThroughSequence: lastObservedSequence(normalized.events),
    countsComplete: historyComplete,
    totalEventCount: normalized.totalEventCount,
    timeline,
    evidenceHistory: evidence.values,
    evidenceHistoryTruncation: evidence.truncation,
    evidenceHistoryComplete: historyComplete && !evidence.truncation.truncated,
    currentEvidence: currentEvidence.values,
    currentEvidenceTruncation: currentEvidence.truncation,
    evidenceSummary,
    verificationHistory: verification.values,
    verificationTruncation: verification.truncation,
    verificationHistoryComplete: historyComplete && !verification.truncation.truncated,
    verificationSummary,
    generationHistory: generations.values,
    generationTruncation: generations.truncation,
    generationHistoryComplete: historyComplete && !generations.truncation.truncated,
    ...(evaluation === undefined ? {} : { evaluation })
  };
}
