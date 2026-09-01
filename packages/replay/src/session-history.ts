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
import {
  replaySession,
  type SessionEvent,
  type SessionState
} from "../../events/src/index.js";
import {
  previewText,
  resolveReplayBounds,
  takeBounded,
  type ReplayBounds
} from "./bounds.js";
import {
  normalizeReplayEvents,
  ReplayProjectionError,
  type NormalizedReplayEvent
} from "./provenance.js";
import { projectReplayTimeline } from "./timeline.js";
import type {
  ReplayCurrentEvidence,
  ReplayEvaluationSummary,
  ReplayEvidenceHistoryEntry,
  ReplayEventProvenance,
  ReplayGenerationHistoryEntry,
  ReplaySessionLifecycle,
  ReplayVerificationHistoryEntry,
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

function lastKnownSequence(items: readonly NormalizedReplayEvent[]): number {
  return items.at(-1)?.metadata.sequence ?? 0;
}

function safeReplay(
  sessionId: SessionId,
  events: readonly SessionEvent[]
): SessionState {
  try {
    return replaySession(sessionId, events);
  } catch {
    throw new ReplayProjectionError("INVALID_EVENT_SEMANTICS");
  }
}

function lifecycleFrom(
  items: readonly NormalizedReplayEvent[],
  state: SessionState | undefined
): ReplaySessionLifecycle {
  const started = items.find((item) => item.event?.type === "SESSION_STARTED");
  const completed = items.findLast((item) => item.event?.type === "SESSION_COMPLETED");
  const archived = items.findLast((item) => item.event?.type === "SESSION_ARCHIVED");
  const resumedCount = items.filter((item) => item.event?.type === "SESSION_RESUMED").length;
  const conservativeRecoveryCount = items.filter((item) =>
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
  if (started !== undefined && completed !== undefined) {
    const difference = completed.metadata.elapsedMs - started.metadata.elapsedMs;
    if (difference >= 0 && Number.isSafeInteger(difference)) {
      activeElapsedDurationMs = difference;
    }
  }

  return {
    status: state?.status ?? (items.length === 0 ? "CREATED" : "UNKNOWN"),
    started: started !== undefined,
    completed: completed !== undefined,
    archived: archived !== undefined,
    resumedCount,
    conservativeRecoveryCount,
    ...(items[0] === undefined ? {} : { createdAt: items[0].metadata.wallTime }),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(completedAt === undefined ? {} : { completedAt }),
    ...(archivedAt === undefined ? {} : { archivedAt }),
    ...(activeElapsedDurationMs === undefined ? {} : { activeElapsedDurationMs })
  };
}

function currentEvidenceFromState(
  state: SessionState,
  limit: number
): {
  readonly values: readonly ReplayCurrentEvidence[];
  readonly truncation: ReturnType<typeof takeBounded<ReplayCurrentEvidence>>["truncation"];
} {
  const current: ReplayCurrentEvidence[] = [];
  const keys = Object.keys(state.evidenceHistory).sort((left, right) => left.localeCompare(right));
  for (const keyString of keys) {
    const records = state.evidenceHistory[keyString] ?? [];
    const active = records.find((record) => record.status === "ACTIVE");
    if (active === undefined) continue;
    current.push({
      keyString,
      key: active.key,
      value: active.value,
      evidenceEventId: active.evidenceEventId
    });
  }
  return takeBounded(current, limit);
}

function evidenceHistoryFrom(
  items: readonly NormalizedReplayEvent[],
  bounds: ReplayBounds
): ReturnType<typeof takeBounded<ReplayEvidenceHistoryEntry>> {
  const records: ReplayEvidenceHistoryEntry[] = [];
  for (const item of items) {
    const event = item.event;
    if (event?.type === "STUDENT_EVIDENCE_UPDATED") {
      records.push({
        sequence: event.sequence,
        evidenceEventId: event.eventId,
        transition: "UPDATED",
        key: event.payload.key,
        value: event.payload.value,
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
  candidateFormalInterpretation: ReplayVerificationHistoryEntry["candidateFormalInterpretation"];
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
        evidenceEventIds: [...event.payload.evidenceEventIds],
        candidateFormalInterpretation: previewText(
          event.payload.candidateFormalInterpretation,
          bounds.maxTextPreviewChars
        ),
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
        reason: previewText(event.payload.result.reason, bounds.maxTextPreviewChars),
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
      candidateFormalInterpretation: entry.candidateFormalInterpretation,
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
  lateEventAfterSupersession: boolean;
  supersededSequence?: number;
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
        lateEventAfterSupersession: false
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
    if (
      current.supersededSequence !== undefined
      && event.sequence > current.supersededSequence
      && event.type !== "DELIVERY_QUEUED"
    ) {
      current.lateEventAfterSupersession = true;
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
      case "MODEL_PROPOSAL_RECEIVED": {
        const ids = [...event.payload.proposal.claimedDisclosureIds]
          .sort((left, right) => left.localeCompare(right));
        const boundedIds = takeBounded(ids, bounds.maxDisclosureIds);
        current.proposalMetadata = {
          realizedAction: event.payload.proposal.realizedAction,
          claimedDisclosureLevel: event.payload.proposal.claimedDisclosureLevel,
          claimedDisclosureIds: boundedIds.values,
          disclosureIdsTruncation: boundedIds.truncation,
          speechTextPersisted: event.payload.proposal.speechText !== undefined,
          boardActionCount: event.payload.proposal.boardActions?.length ?? 0,
          provenance: item.provenance
        };
        break;
      }
      case "FORMAL_INTERPRETATION_PROPOSAL_RECEIVED":
        current.formalInterpretation = {
          preview: previewText(
            event.payload.proposal.candidateFormalInterpretation,
            bounds.maxTextPreviewChars
          ),
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
        current.supersededSequence = event.sequence;
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
  } else {
    for (const current of byGeneration.values()) current.status = "UNKNOWN";
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
      deliveryIds: [...entry.deliveryIds].sort((left, right) => left.localeCompare(right)),
      lateEventAfterSupersession: entry.lateEventAfterSupersession
    }));
  return takeBounded(ordered, bounds.maxGenerationEntries);
}

function evaluationSummary(evaluation: SessionEvaluation): ReplayEvaluationSummary {
  return {
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

function validateEvaluation(
  input: unknown,
  sessionId: SessionId | null,
  problem: SessionHistoryProjection["problem"]
): ReplayEvaluationSummary | undefined {
  if (input === undefined) return undefined;
  const parsed = SessionEvaluationSchema.safeParse(input);
  if (!parsed.success) throw new ReplayProjectionError("EVALUATION_MISMATCH");
  if (
    sessionId === null
    || parsed.data.sessionId !== sessionId
    || problem === undefined
    || parsed.data.problemId !== problem.problemId
    || parsed.data.problemVersion !== problem.problemVersion
  ) {
    throw new ReplayProjectionError("EVALUATION_MISMATCH");
  }
  return evaluationSummary(parsed.data);
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
  const events = knownEvents(normalized.events);
  const state =
    normalized.sessionId === null
    || normalized.hasUnknownEvents
    || normalized.eventTruncation.truncated
      ? undefined
      : safeReplay(normalized.sessionId, events);

  const problemEvent = [...normalized.events].reverse()
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

  const timeline = projectReplayTimeline(rawEvents, { bounds });
  const evidence = evidenceHistoryFrom(normalized.events, bounds);
  const currentEvidence = state === undefined
    ? takeBounded<ReplayCurrentEvidence>([], bounds.maxEvidenceHistoryEntries)
    : currentEvidenceFromState(state, bounds.maxEvidenceHistoryEntries);
  const verification = verificationHistoryFrom(normalized.events, bounds);
  const generations = generationHistoryFrom(normalized.events, state, bounds);
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
  const verificationSummary = {
    pending: verification.values.filter((entry) => entry.status === "PENDING").length,
    verified: verification.values.filter((entry) => entry.result?.status === "VERIFIED").length,
    contradicted: verification.values.filter((entry) => entry.result?.status === "CONTRADICTED").length,
    unresolved: verification.values.filter((entry) => entry.result?.status === "UNRESOLVED").length,
    discarded: verification.values.filter((entry) => entry.status === "DISCARDED").length
  };
  const highestDisclosureUsed = state === undefined ? undefined : disclosedHighest(state);
  const evaluation = validateEvaluation(options.evaluation, normalized.sessionId, problem);

  const projection: SessionHistoryProjection = {
    sessionId: normalized.sessionId,
    ...(problem === undefined ? {} : { problem }),
    lifecycle: lifecycleFrom(normalized.events, state),
    counts: {
      ...eventCounts,
      exposedInterventions: directCounts.exposed,
      possiblyExposedInterventions: directCounts.possible,
      cancelledInterventions: directCounts.cancelled,
      ...(inFlightDeliveries === undefined ? {} : { inFlightDeliveries })
    },
    ...(highestDisclosureUsed === undefined ? {} : { highestDisclosureUsed }),
    currentStateAvailable: state !== undefined,
    knownThroughSequence: lastKnownSequence(normalized.events),
    totalEventCount: normalized.totalEventCount,
    timeline,
    evidenceHistory: evidence.values,
    evidenceHistoryTruncation: evidence.truncation,
    currentEvidence: currentEvidence.values,
    currentEvidenceTruncation: currentEvidence.truncation,
    evidenceSummary,
    verificationHistory: verification.values,
    verificationTruncation: verification.truncation,
    verificationSummary,
    generationHistory: generations.values,
    generationTruncation: generations.truncation,
    ...(evaluation === undefined ? {} : { evaluation })
  };

  return projection;
}
