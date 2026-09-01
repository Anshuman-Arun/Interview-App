import {
  evidenceKeyToString,
  generationBasesEqual,
  isEvidenceValueAllowed,
  type DeliveryAtom,
  type DisclosureAnalysis,
  type EvidenceKey,
  type EvidenceValue,
  type EventId,
  type FormalInterpretationProposal,
  type GenerationBasis,
  type GenerationId,
  type InterviewerProposal,
  type SessionId
} from "../../domain/src/index.js";
import {
  isGenerationBasisStillCompatible,
  initialSessionState,
  reduceSessionEvent,
  type EventSource,
  type EventType,
  type SessionEvent,
  type SessionState
} from "../../events/src/index.js";
import { MAX_REPLAY_IDENTIFIER_CHARS } from "./bounds.js";
import { replayEvidenceIdentity } from "./identity.js";
import { ReplayProjectionError } from "./provenance.js";

type GenerationPhase =
  | "ACTIVE"
  | "PROPOSAL_RECEIVED"
  | "VALIDATED"
  | "REJECTED"
  | "SUPERSEDED";

type GenerationProposalKind = "INTERVIEWER" | "FORMAL";

interface DeliveryAuthorizationUsage {
  textUsed: boolean;
  audioUsed: boolean;
  readonly boardActionIndexesUsed: Set<number>;
}

interface ExpectedEvidenceUpdate {
  readonly key: EvidenceKey;
  readonly value: EvidenceValue;
  readonly supersedesEventId?: EventId;
}

type PendingNext =
  | { readonly kind: "PROBLEM_PRESENTED" }
  | {
      readonly kind: "TRANSCRIPT_FINALIZED";
      readonly inputEpisodeId: string;
    }
  | {
      readonly kind: "SPEECH_INPUT_UPDATE";
      readonly inputEpisodeId: string;
      readonly text: string;
    }
  | {
      readonly kind: "TURN_COMMITTED";
      readonly inputEpisodeId: string;
    }
  | {
      readonly kind: "MODEL_PROPOSAL_OUTCOME";
      readonly generationId: GenerationId;
    }
  | {
      readonly kind: "FORMAL_PROPOSAL_OUTCOME";
      readonly generationId: GenerationId;
      readonly proposalRequestId: string;
    }
  | {
      readonly kind: "EVIDENCE_UPDATE";
      readonly expected: ExpectedEvidenceUpdate;
    }
  | {
      readonly kind: "FIRST_DELIVERY";
      readonly generationId: GenerationId;
    };

type RequiredFollowUp =
  | {
      readonly kind: "SUPERSEDE_GENERATION";
      readonly generationId: GenerationId;
    }
  | {
      readonly kind: "CANCEL_DELIVERY";
      readonly deliveryId: string;
    }
  | {
      readonly kind: "POSSIBLY_EXPOSE_DELIVERY";
      readonly deliveryId: string;
      readonly source: "APPLICATION";
    }
  | {
      readonly kind: "INVALIDATE_EVIDENCE";
      readonly keyIdentity: string;
      readonly evidenceEventId: EventId;
    };

const ALLOWED_SOURCES = {
  SESSION_STARTED: ["APPLICATION"],
  PROBLEM_PRESENTED: ["APPLICATION"],
  UTTERANCE_STARTED: ["USER"],
  UTTERANCE_DISCARDED: ["USER"],
  INPUT_EPISODE_STARTED: ["USER", "APPLICATION"],
  INPUT_EPISODE_UPDATED: ["USER", "APPLICATION"],
  INPUT_EPISODE_COMMITTED: ["APPLICATION"],
  TURN_COMMITTED: ["APPLICATION"],
  TRANSCRIPT_FINALIZED: ["WORKER"],
  TRANSCRIPT_CORRECTED: ["APPLICATION"],
  BOARD_PATCH_COMMITTED: ["USER"],
  VISION_REQUESTED: ["APPLICATION"],
  VISION_RESULT_ACCEPTED: ["WORKER"],
  VISION_RESULT_DISCARDED: ["APPLICATION"],
  LOCAL_COMPUTE_REQUESTED: ["APPLICATION"],
  LOCAL_COMPUTE_RESULT_ACCEPTED: ["APPLICATION"],
  LOCAL_COMPUTE_RESULT_DISCARDED: ["APPLICATION"],
  VERIFICATION_REQUESTED: ["APPLICATION"],
  VERIFICATION_RESULT_ACCEPTED: ["APPLICATION"],
  VERIFICATION_RESULT_DISCARDED: ["APPLICATION"],
  EVIDENCE_PROPOSED: ["PROVIDER"],
  STUDENT_EVIDENCE_UPDATED: ["APPLICATION"],
  STUDENT_EVIDENCE_INVALIDATED: ["APPLICATION"],
  PEDAGOGICAL_ACTION_SELECTED: ["APPLICATION"],
  MODEL_GENERATION_STARTED: ["APPLICATION"],
  GENERATION_CONTEXT_COMPILED: ["APPLICATION"],
  MODEL_PROPOSAL_RECEIVED: ["PROVIDER"],
  FORMAL_INTERPRETATION_PROPOSAL_RECEIVED: ["PROVIDER"],
  FORMAL_INTERPRETATION_PROPOSAL_REJECTED: ["APPLICATION"],
  MODEL_GENERATION_SUPERSEDED: ["APPLICATION"],
  PROPOSAL_VALIDATED: ["APPLICATION"],
  PROPOSAL_REJECTED: ["APPLICATION"],
  DELIVERY_QUEUED: ["APPLICATION"],
  DELIVERY_STARTED: ["APPLICATION"],
  DELIVERY_EXPOSED: ["RENDERER"],
  DELIVERY_COMPLETED: ["RENDERER"],
  DELIVERY_CANCELLED: ["APPLICATION"],
  DELIVERY_POSSIBLY_EXPOSED: ["APPLICATION", "RECOVERY"],
  POLICY_REVISION_CHANGED: ["APPLICATION"],
  PROBLEM_STATE_REVISION_CHANGED: ["APPLICATION"],
  SESSION_COMPLETED: ["APPLICATION"],
  SESSION_ARCHIVED: ["APPLICATION"],
  SESSION_RESUMED: ["APPLICATION"]
} as const satisfies Readonly<Record<EventType, readonly EventSource[]>>;

function fail(): never {
  throw new ReplayProjectionError("INVALID_EVENT_SEMANTICS");
}

function assertBoundedIdentifier(value: string | undefined): void {
  if (value !== undefined && value.length > MAX_REPLAY_IDENTIFIER_CHARS) fail();
}

function assertEvidenceKeyIdentifiers(key: EvidenceKey): void {
  assertBoundedIdentifier(key.problemId);
  switch (key.subject.kind) {
    case "CLAIM":
      assertBoundedIdentifier(key.subject.claimId);
      break;
    case "MILESTONE":
      assertBoundedIdentifier(key.subject.milestoneId);
      break;
    case "SKILL":
      assertBoundedIdentifier(key.subject.skillId);
      break;
    case "APPROACH":
      assertBoundedIdentifier(key.subject.approachId);
      break;
  }
}

function assertGenerationBasisIdentifiers(basis: GenerationBasis): void {
  assertBoundedIdentifier(basis.turnId);
  assertBoundedIdentifier(basis.inputEpisodeId);
}

function assertDeliveryIdentifiers(atom: DeliveryAtom): void {
  assertBoundedIdentifier(atom.deliveryId);
  assertBoundedIdentifier(atom.generationId);
  for (const disclosureId of atom.disclosureIds) {
    assertBoundedIdentifier(disclosureId);
  }
  if (atom.content.medium === "WHITEBOARD") {
    assertBoundedIdentifier(atom.content.action.targetShapeId);
  }
}

function sameCommandIdentity(left: SessionEvent, right: SessionEvent): boolean {
  return left.causationId === right.causationId
    && left.correlationId === right.correlationId;
}

function assertEventSource(event: SessionEvent): void {
  const allowed = ALLOWED_SOURCES[event.type] as readonly EventSource[];
  if (!allowed.includes(event.source)) fail();

  if (event.type === "INPUT_EPISODE_UPDATED") {
    const expectedSource = event.payload.modality === "SPEECH"
      ? "APPLICATION"
      : "USER";
    if (event.source !== expectedSource) fail();
  }
}

function registerEvidenceIdentity(
  aliases: Map<string, string>,
  key: EvidenceKey
): void {
  const serialized = evidenceKeyToString(key);
  const canonical = replayEvidenceIdentity(key);
  const prior = aliases.get(serialized);
  if (prior !== undefined && prior !== canonical) fail();
  aliases.set(serialized, canonical);
}

function generationPhase(
  phases: ReadonlyMap<GenerationId, GenerationPhase>,
  generationId: GenerationId
): GenerationPhase {
  const phase = phases.get(generationId);
  if (phase === undefined) fail();
  return phase;
}

function arraysEqual<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function boardActionsEqual(
  left: NonNullable<InterviewerProposal["boardActions"]>[number],
  right: NonNullable<InterviewerProposal["boardActions"]>[number]
): boolean {
  return left.operation === right.operation
    && left.content === right.content
    && left.targetShapeId === right.targetShapeId
    && left.expectedShapeRevision === right.expectedShapeRevision
    && left.annotationPurpose === right.annotationPurpose;
}

function consumeDeliveryAuthorization(
  proposal: InterviewerProposal,
  content: DeliveryAtom["content"],
  usage: DeliveryAuthorizationUsage
): boolean {
  if (content.medium === "TEXT") {
    if (
      usage.textUsed
      || proposal.speechText === undefined
      || content.text !== proposal.speechText
    ) return false;
    usage.textUsed = true;
    return true;
  }

  if (content.medium === "AUDIO") {
    if (
      usage.audioUsed
      || proposal.speechText === undefined
      || content.text !== proposal.speechText
    ) return false;
    usage.audioUsed = true;
    return true;
  }

  const actions = proposal.boardActions ?? [];
  const index = actions.findIndex((action, actionIndex) =>
    !usage.boardActionIndexesUsed.has(actionIndex)
    && boardActionsEqual(action, content.action)
  );
  if (index < 0) return false;
  usage.boardActionIndexesUsed.add(index);
  return true;
}

function committedSpeechText(
  state: Readonly<SessionState>,
  inputEpisodeId: string
): string | undefined {
  const episode = state.inputEpisodes[inputEpisodeId];
  if (episode === undefined || episode.status !== "COMMITTED") return undefined;
  const text = episode.inputs
    .filter((input) => input.modality === "SPEECH")
    .map((input) => input.semanticContent)
    .join(" ");
  return text.length === 0 ? undefined : text;
}

function independentlyAnalyze(text: string): {
  readonly normalizedText: string;
  readonly tokenCount: number;
} {
  const normalizedText = text.trim().split(/\s+/u)
    .filter((token) => token.length > 0)
    .join(" ");
  return {
    normalizedText,
    tokenCount: normalizedText.length === 0
      ? 0
      : normalizedText.split(" ").length
  };
}

function evidenceUpdateMatches(
  event: SessionEvent,
  expected: ExpectedEvidenceUpdate
): boolean {
  if (event.type !== "STUDENT_EVIDENCE_UPDATED") return false;
  return replayEvidenceIdentity(event.payload.key) === replayEvidenceIdentity(expected.key)
    && event.payload.value.value === expected.value.value
    && event.payload.value.inferenceConfidence === expected.value.inferenceConfidence
    && arraysEqual(
      event.payload.value.evidenceEventIds,
      expected.value.evidenceEventIds
    )
    && event.payload.value.lastUpdatedSequence === expected.value.lastUpdatedSequence
    && event.payload.supersedesEventId === expected.supersedesEventId;
}

function consumePendingNext(
  pending: PendingNext,
  event: SessionEvent
): PendingNext["kind"] {
  switch (pending.kind) {
    case "PROBLEM_PRESENTED":
      if (event.type !== "PROBLEM_PRESENTED") fail();
      break;
    case "TRANSCRIPT_FINALIZED":
      if (
        event.type !== "TRANSCRIPT_FINALIZED"
        || event.payload.inputEpisodeId !== pending.inputEpisodeId
      ) fail();
      break;
    case "SPEECH_INPUT_UPDATE":
      if (
        event.type !== "INPUT_EPISODE_UPDATED"
        || event.payload.inputEpisodeId !== pending.inputEpisodeId
        || event.payload.modality !== "SPEECH"
        || event.payload.semanticContent !== pending.text
      ) fail();
      break;
    case "TURN_COMMITTED":
      if (
        event.type !== "TURN_COMMITTED"
        || event.payload.inputEpisodeId !== pending.inputEpisodeId
      ) fail();
      break;
    case "MODEL_PROPOSAL_OUTCOME":
      if (
        (event.type !== "PROPOSAL_VALIDATED" && event.type !== "PROPOSAL_REJECTED")
        || event.payload.generationId !== pending.generationId
      ) fail();
      break;
    case "FORMAL_PROPOSAL_OUTCOME":
      if (event.type === "FORMAL_INTERPRETATION_PROPOSAL_REJECTED") {
        if (event.payload.generationId !== pending.generationId) fail();
      } else if (event.type === "VERIFICATION_REQUESTED") {
        if (
          event.payload.sourceGenerationId !== pending.generationId
          || event.payload.sourceProposalRequestId !== pending.proposalRequestId
        ) fail();
      } else {
        fail();
      }
      break;
    case "EVIDENCE_UPDATE":
      if (!evidenceUpdateMatches(event, pending.expected)) fail();
      break;
    case "FIRST_DELIVERY":
      if (
        event.type !== "DELIVERY_QUEUED"
        || event.payload.atom.generationId !== pending.generationId
      ) fail();
      break;
  }

  return pending.kind;
}

function requiredFollowUpMatches(
  required: RequiredFollowUp,
  event: SessionEvent
): boolean {
  switch (required.kind) {
    case "SUPERSEDE_GENERATION":
      return event.type === "MODEL_GENERATION_SUPERSEDED"
        && event.payload.generationId === required.generationId;
    case "CANCEL_DELIVERY":
      return event.type === "DELIVERY_CANCELLED"
        && event.payload.deliveryId === required.deliveryId;
    case "POSSIBLY_EXPOSE_DELIVERY":
      return event.type === "DELIVERY_POSSIBLY_EXPOSED"
        && event.source === required.source
        && event.payload.deliveryId === required.deliveryId;
    case "INVALIDATE_EVIDENCE":
      return event.type === "STUDENT_EVIDENCE_INVALIDATED"
        && event.payload.invalidatesEventId === required.evidenceEventId
        && replayEvidenceIdentity(event.payload.key) === required.keyIdentity;
  }
}

function expectedEvidenceFromProposal(
  state: Readonly<SessionState>,
  event: Extract<SessionEvent, { readonly type: "EVIDENCE_PROPOSED" }>
): ExpectedEvidenceUpdate | undefined {
  const proposal = event.payload.proposal;
  if (
    state.problem?.id !== proposal.key.problemId
    || proposal.inferenceConfidence < 0.7
    || !isEvidenceValueAllowed(proposal.key, proposal.proposedValue)
    || !proposal.evidenceEventIds.every((eventId) => state.eventIds.includes(eventId))
  ) {
    return undefined;
  }

  const keyString = evidenceKeyToString(proposal.key);
  const active = state.evidenceHistory[keyString]?.find((record) =>
    record.status === "ACTIVE"
  );
  return {
    key: proposal.key,
    value: {
      value: proposal.proposedValue,
      inferenceConfidence: proposal.inferenceConfidence,
      evidenceEventIds: proposal.evidenceEventIds,
      lastUpdatedSequence: event.sequence + 1
    },
    ...(active === undefined
      ? {}
      : { supersedesEventId: active.evidenceEventId })
  };
}

function expectedEvidenceFromVerification(
  state: Readonly<SessionState>,
  event: Extract<SessionEvent, { readonly type: "VERIFICATION_RESULT_ACCEPTED" }>
): ExpectedEvidenceUpdate | undefined {
  if (event.payload.result.status !== "VERIFIED") return undefined;
  const request = state.verificationRequests[event.payload.verificationRequestId];
  if (request === undefined) fail();

  const keyString = evidenceKeyToString(request.evidenceKey);
  const active = state.evidenceHistory[keyString]?.find((record) =>
    record.status === "ACTIVE"
  );
  return {
    key: request.evidenceKey,
    value: {
      value: "CORRECT",
      inferenceConfidence: event.payload.result.interpretationConfidence,
      evidenceEventIds: Array.from(new Set([
        ...request.evidenceEventIds,
        request.requestedEventId
      ])),
      lastUpdatedSequence: event.sequence + 1
    },
    ...(active === undefined
      ? {}
      : { supersedesEventId: active.evidenceEventId })
  };
}

function terminalStateIsSettled(state: Readonly<SessionState>): boolean {
  const generationsSettled = Object.values(state.generations).every((generation) =>
    generation.status !== "ACTIVE" && generation.status !== "PROPOSAL_RECEIVED"
  );
  const deliveriesSettled = Object.values(state.deliveries).every((delivery) =>
    delivery.status !== "QUEUED" && delivery.status !== "DELIVERING"
  );
  return generationsSettled && deliveriesSettled;
}

export interface ValidatedReplayPrefix {
  readonly state: SessionState;
  readonly validatedThroughSequence: number;
}

export function validateKnownReplayPrefix(
  sessionId: SessionId,
  events: readonly SessionEvent[],
  options: { readonly completeHistory?: boolean } = {}
): ValidatedReplayPrefix {
  let state = initialSessionState(sessionId);
  const generationPhases = new Map<GenerationId, GenerationPhase>();
  const generationProposalKinds = new Map<GenerationId, GenerationProposalKind>();
  const validatedAnalyses = new Map<GenerationId, DisclosureAnalysis>();
  const deliveryAuthorizationUsage = new Map<GenerationId, DeliveryAuthorizationUsage>();
  const formalProposals = new Map<string, {
    readonly generationId: GenerationId;
    readonly proposal: FormalInterpretationProposal;
  }>();
  const usedTurnEpisodes = new Set<string>();
  const evidenceAliases = new Map<string, string>();
  let pendingNext: PendingNext | undefined;
  let requiredFollowUps: RequiredFollowUp[] = [];
  let problemPresented = false;
  let previousEvent: SessionEvent | undefined;

  try {
    for (const event of events) {
      assertEventSource(event);

      let consumedPendingKind: PendingNext["kind"] | undefined;
      if (pendingNext !== undefined) {
        consumedPendingKind = consumePendingNext(pendingNext, event);
        pendingNext = undefined;
      }

      let consumedRequiredKind: RequiredFollowUp["kind"] | undefined;
      if (requiredFollowUps.length > 0) {
        const index = requiredFollowUps.findIndex((required) =>
          requiredFollowUpMatches(required, event)
        );
        if (index < 0) fail();
        consumedRequiredKind = requiredFollowUps[index]?.kind;
        requiredFollowUps = requiredFollowUps.filter((_, candidateIndex) =>
          candidateIndex !== index
        );
      }

      if (!state.started && event.type !== "SESSION_STARTED") fail();
      if (state.started && event.type === "SESSION_STARTED") fail();
      if (
        state.started
        && state.problem === undefined
        && event.type !== "SESSION_STARTED"
        && event.type !== "PROBLEM_PRESENTED"
      ) fail();

      switch (event.type) {
        case "SESSION_STARTED":
          pendingNext = { kind: "PROBLEM_PRESENTED" };
          break;

        case "PROBLEM_PRESENTED":
          assertBoundedIdentifier(event.payload.problemId);
          assertBoundedIdentifier(event.payload.problemVersion);
          if (problemPresented) fail();
          problemPresented = true;
          break;

        case "UTTERANCE_STARTED": {
          assertBoundedIdentifier(event.payload.utteranceId);
          if (state.utterances[event.payload.utteranceId] !== undefined) fail();
          requiredFollowUps = [
            ...Object.values(state.generations)
              .filter((generation) => generation.status === "ACTIVE")
              .map((generation): RequiredFollowUp => ({
                kind: "SUPERSEDE_GENERATION",
                generationId: generation.generationId
              })),
            ...Object.values(state.deliveries).flatMap((delivery): RequiredFollowUp[] =>
              delivery.status === "QUEUED"
                ? [{
                    kind: "CANCEL_DELIVERY",
                    deliveryId: delivery.deliveryId
                  }]
                : delivery.status === "DELIVERING"
                  ? [{
                      kind: "POSSIBLY_EXPOSE_DELIVERY",
                      deliveryId: delivery.deliveryId,
                      source: "APPLICATION"
                    }]
                  : []
            )
          ];
          break;
        }

        case "UTTERANCE_DISCARDED":
          assertBoundedIdentifier(event.payload.utteranceId);
          break;

        case "INPUT_EPISODE_STARTED":
          assertBoundedIdentifier(event.payload.inputEpisodeId);
          if (state.inputEpisodes[event.payload.inputEpisodeId] !== undefined) fail();
          if (event.source === "APPLICATION") {
            pendingNext = {
              kind: "TRANSCRIPT_FINALIZED",
              inputEpisodeId: event.payload.inputEpisodeId
            };
          }
          break;

        case "INPUT_EPISODE_UPDATED":
          assertBoundedIdentifier(event.payload.inputEpisodeId);
          if (event.payload.modality === "WHITEBOARD") {
            if (
              previousEvent?.type !== "BOARD_PATCH_COMMITTED"
              || previousEvent.payload.summary !== event.payload.semanticContent
              || previousEvent.payload.boardRevision !== state.boardRevision
              || !sameCommandIdentity(previousEvent, event)
            ) fail();
          }
          break;

        case "INPUT_EPISODE_COMMITTED": {
          assertBoundedIdentifier(event.payload.inputEpisodeId);
          const episode = state.inputEpisodes[event.payload.inputEpisodeId];
          if (
            episode === undefined
            || episode.status !== "ACTIVE"
            || episode.inputs.length === 0
          ) fail();
          pendingNext = {
            kind: "TURN_COMMITTED",
            inputEpisodeId: event.payload.inputEpisodeId
          };
          break;
        }

        case "TURN_COMMITTED": {
          assertBoundedIdentifier(event.payload.turnId);
          assertBoundedIdentifier(event.payload.inputEpisodeId);
          if (state.turns[event.payload.turnId] !== undefined) fail();
          const episode = state.inputEpisodes[event.payload.inputEpisodeId];
          if (episode === undefined || episode.status !== "COMMITTED") fail();
          if (usedTurnEpisodes.has(event.payload.inputEpisodeId)) fail();
          const expectedStudentText = episode.inputs
            .map((input) => input.semanticContent)
            .join(" ");
          if (event.payload.studentText !== expectedStudentText) fail();
          usedTurnEpisodes.add(event.payload.inputEpisodeId);
          break;
        }

        case "TRANSCRIPT_FINALIZED": {
          assertBoundedIdentifier(event.payload.utteranceId);
          assertBoundedIdentifier(event.payload.inputEpisodeId);
          if (event.payload.transcriptRevision !== state.transcriptRevision + 1) fail();
          const episode = state.inputEpisodes[event.payload.inputEpisodeId];
          const utterance = state.utterances[event.payload.utteranceId];
          if (
            episode === undefined
            || episode.status !== "ACTIVE"
            || utterance === undefined
            || utterance.status !== "CAPTURING"
          ) fail();
          pendingNext = {
            kind: "SPEECH_INPUT_UPDATE",
            inputEpisodeId: event.payload.inputEpisodeId,
            text: event.payload.text
          };
          break;
        }

        case "TRANSCRIPT_CORRECTED": {
          if (
            event.payload.transcriptRevision !== state.transcriptRevision + 1
            || event.payload.contextEpoch !== state.contextEpoch + 1
          ) fail();
          requiredFollowUps = Object.values(state.evidenceHistory)
            .flatMap((records) => records)
            .filter((record) => record.status === "ACTIVE")
            .map((record): RequiredFollowUp => ({
              kind: "INVALIDATE_EVIDENCE",
              keyIdentity: replayEvidenceIdentity(record.key),
              evidenceEventId: record.evidenceEventId
            }));
          break;
        }

        case "BOARD_PATCH_COMMITTED":
          if (event.payload.boardRevision !== state.boardRevision + 1) fail();
          break;

        case "VISION_REQUESTED":
          assertBoundedIdentifier(event.payload.visionRequestId);
          if (
            state.visionRequests[event.payload.visionRequestId] !== undefined
            || event.payload.sourceBoardRevision !== state.boardRevision
          ) fail();
          break;

        case "VISION_RESULT_ACCEPTED": {
          assertBoundedIdentifier(event.payload.visionRequestId);
          const request = state.visionRequests[event.payload.visionRequestId];
          const observation = event.payload.observation;
          if (
            request === undefined
            || request.status !== "PENDING"
            || request.sourceBoardRevision !== state.boardRevision
            || observation.sourceBoardRevision !== request.sourceBoardRevision
            || observation.regionId !== request.regionId
            || observation.relevantShapeIds.length !== request.relevantShapeIds.length
            || !request.relevantShapeIds.every((shapeId) =>
              observation.relevantShapeIds.includes(shapeId)
            )
          ) fail();
          break;
        }

        case "VISION_RESULT_DISCARDED":
          assertBoundedIdentifier(event.payload.visionRequestId);
          break;

        case "LOCAL_COMPUTE_REQUESTED":
          assertBoundedIdentifier(event.payload.computeRequestId);
          assertBoundedIdentifier(event.payload.inputEpisodeId);
          if (
            state.localComputeRequests[event.payload.computeRequestId] !== undefined
            || event.payload.sourceTranscriptRevision !== state.transcriptRevision
            || committedSpeechText(state, event.payload.inputEpisodeId) === undefined
          ) fail();
          break;

        case "LOCAL_COMPUTE_RESULT_ACCEPTED": {
          assertBoundedIdentifier(event.payload.computeRequestId);
          const request = state.localComputeRequests[event.payload.computeRequestId];
          if (
            request === undefined
            || request.status !== "PENDING"
            || request.sourceTranscriptRevision !== event.payload.sourceTranscriptRevision
            || state.transcriptRevision !== request.sourceTranscriptRevision
          ) fail();
          const text = committedSpeechText(state, request.inputEpisodeId);
          if (text === undefined) fail();
          const expected = independentlyAnalyze(text);
          if (
            event.payload.normalizedText !== expected.normalizedText
            || event.payload.tokenCount !== expected.tokenCount
          ) fail();
          break;
        }

        case "LOCAL_COMPUTE_RESULT_DISCARDED":
          assertBoundedIdentifier(event.payload.computeRequestId);
          break;

        case "VERIFICATION_REQUESTED": {
          assertBoundedIdentifier(event.payload.verificationRequestId);
          assertBoundedIdentifier(event.payload.verifier);
          assertGenerationBasisIdentifiers(event.payload.basis);
          assertEvidenceKeyIdentifiers(event.payload.evidenceKey);
          for (const evidenceEventId of event.payload.evidenceEventIds) {
            assertBoundedIdentifier(evidenceEventId);
          }
          assertBoundedIdentifier(event.payload.sourceGenerationId);
          assertBoundedIdentifier(event.payload.sourceProposalRequestId);
          if (
            state.problem?.id !== event.payload.evidenceKey.problemId
            || event.payload.evidenceKey.subject.kind !== "CLAIM"
            || event.payload.evidenceKey.dimension !== "CORRECTNESS"
          ) fail();
          if (
            !event.payload.evidenceEventIds.every((eventId) =>
              state.eventIds.includes(eventId)
            )
            || isGenerationBasisStillCompatible(event.payload.basis, state)
              !== "COMPATIBLE"
          ) fail();

          const hasSourceGeneration = event.payload.sourceGenerationId !== undefined;
          const hasSourceProposal = event.payload.sourceProposalRequestId !== undefined;
          if (hasSourceGeneration !== hasSourceProposal) fail();

          if (
            event.payload.sourceGenerationId !== undefined
            && event.payload.sourceProposalRequestId !== undefined
          ) {
            if (consumedPendingKind !== "FORMAL_PROPOSAL_OUTCOME") fail();
            if (
              generationPhase(generationPhases, event.payload.sourceGenerationId)
                !== "PROPOSAL_RECEIVED"
              || generationProposalKinds.get(event.payload.sourceGenerationId)
                !== "FORMAL"
            ) fail();
            const source = formalProposals.get(event.payload.sourceProposalRequestId);
            const generation = state.generations[event.payload.sourceGenerationId];
            if (
              source === undefined
              || source.generationId !== event.payload.sourceGenerationId
              || generation === undefined
              || source.proposal.candidateFormalInterpretation
                !== event.payload.candidateFormalInterpretation
              || source.proposal.interpretationConfidence
                !== event.payload.interpretationConfidence
              || !generationBasesEqual(event.payload.basis, generation.basis)
            ) fail();
          }
          break;
        }

        case "VERIFICATION_RESULT_ACCEPTED": {
          assertBoundedIdentifier(event.payload.verificationRequestId);
          assertBoundedIdentifier(event.payload.result.verifier);
          const request = state.verificationRequests[event.payload.verificationRequestId];
          if (
            request === undefined
            || request.status !== "PENDING"
            || request.verifier !== event.payload.result.verifier
            || request.interpretationConfidence
              !== event.payload.result.interpretationConfidence
            || isGenerationBasisStillCompatible(request.basis, state)
              !== "COMPATIBLE"
          ) fail();
          const expected = expectedEvidenceFromVerification(state, event);
          if (expected !== undefined) {
            pendingNext = {
              kind: "EVIDENCE_UPDATE",
              expected
            };
          }
          break;
        }

        case "VERIFICATION_RESULT_DISCARDED":
          assertBoundedIdentifier(event.payload.verificationRequestId);
          break;

        case "EVIDENCE_PROPOSED": {
          assertEvidenceKeyIdentifiers(event.payload.proposal.key);
          for (const evidenceEventId of event.payload.proposal.evidenceEventIds) {
            assertBoundedIdentifier(evidenceEventId);
          }
          const expected = expectedEvidenceFromProposal(state, event);
          if (expected !== undefined) {
            pendingNext = {
              kind: "EVIDENCE_UPDATE",
              expected
            };
          }
          break;
        }

        case "STUDENT_EVIDENCE_UPDATED":
          assertEvidenceKeyIdentifiers(event.payload.key);
          for (const evidenceEventId of event.payload.value.evidenceEventIds) {
            assertBoundedIdentifier(evidenceEventId);
          }
          assertBoundedIdentifier(event.payload.supersedesEventId);
          if (consumedPendingKind !== "EVIDENCE_UPDATE") fail();
          if (
            state.problem?.id !== event.payload.key.problemId
            || !isEvidenceValueAllowed(event.payload.key, event.payload.value.value)
            || !event.payload.value.evidenceEventIds.every((eventId) =>
              state.eventIds.includes(eventId)
            )
          ) fail();
          registerEvidenceIdentity(evidenceAliases, event.payload.key);
          break;

        case "STUDENT_EVIDENCE_INVALIDATED":
          assertEvidenceKeyIdentifiers(event.payload.key);
          assertBoundedIdentifier(event.payload.invalidatesEventId);
          if (consumedRequiredKind !== "INVALIDATE_EVIDENCE") fail();
          if (state.problem?.id !== event.payload.key.problemId) fail();
          registerEvidenceIdentity(evidenceAliases, event.payload.key);
          break;

        case "PEDAGOGICAL_ACTION_SELECTED":
          assertBoundedIdentifier(event.payload.turnId);
          if (state.turns[event.payload.turnId] === undefined) fail();
          break;

        case "MODEL_GENERATION_STARTED":
          assertBoundedIdentifier(event.payload.generationId);
          assertBoundedIdentifier(event.payload.provider);
          assertGenerationBasisIdentifiers(event.payload.basis);
          if (
            state.generations[event.payload.generationId] !== undefined
            || isGenerationBasisStillCompatible(event.payload.basis, state)
              !== "COMPATIBLE"
          ) fail();
          generationPhases.set(event.payload.generationId, "ACTIVE");
          break;

        case "GENERATION_CONTEXT_COMPILED": {
          assertBoundedIdentifier(event.payload.generationId);
          assertBoundedIdentifier(event.payload.manifest.compilerVersion);
          assertBoundedIdentifier(event.payload.manifest.problemId);
          assertBoundedIdentifier(event.payload.manifest.problemVersion);
          assertGenerationBasisIdentifiers(event.payload.manifest.generationBasis);
          if (generationPhase(generationPhases, event.payload.generationId) !== "ACTIVE") fail();
          if (
            state.problem === undefined
            || event.payload.manifest.problemId !== state.problem.id
            || event.payload.manifest.problemVersion !== state.problem.version
          ) fail();
          break;
        }

        case "MODEL_PROPOSAL_RECEIVED":
          assertBoundedIdentifier(event.payload.generationId);
          if (generationPhase(generationPhases, event.payload.generationId) !== "ACTIVE") fail();
          generationProposalKinds.set(event.payload.generationId, "INTERVIEWER");
          generationPhases.set(event.payload.generationId, "PROPOSAL_RECEIVED");
          pendingNext = {
            kind: "MODEL_PROPOSAL_OUTCOME",
            generationId: event.payload.generationId
          };
          break;

        case "FORMAL_INTERPRETATION_PROPOSAL_RECEIVED":
          assertBoundedIdentifier(event.payload.generationId);
          assertBoundedIdentifier(event.payload.proposalRequestId);
          if (generationPhase(generationPhases, event.payload.generationId) !== "ACTIVE") fail();
          if (formalProposals.has(event.payload.proposalRequestId)) fail();
          formalProposals.set(event.payload.proposalRequestId, {
            generationId: event.payload.generationId,
            proposal: event.payload.proposal
          });
          generationProposalKinds.set(event.payload.generationId, "FORMAL");
          generationPhases.set(event.payload.generationId, "PROPOSAL_RECEIVED");
          pendingNext = {
            kind: "FORMAL_PROPOSAL_OUTCOME",
            generationId: event.payload.generationId,
            proposalRequestId: event.payload.proposalRequestId
          };
          break;

        case "FORMAL_INTERPRETATION_PROPOSAL_REJECTED":
          assertBoundedIdentifier(event.payload.generationId);
          if (
            consumedPendingKind !== "FORMAL_PROPOSAL_OUTCOME"
            || generationPhase(generationPhases, event.payload.generationId)
              !== "PROPOSAL_RECEIVED"
            || generationProposalKinds.get(event.payload.generationId) !== "FORMAL"
          ) fail();
          generationPhases.set(event.payload.generationId, "REJECTED");
          break;

        case "MODEL_GENERATION_SUPERSEDED": {
          assertBoundedIdentifier(event.payload.generationId);
          const phase = generationPhase(generationPhases, event.payload.generationId);
          if (
            phase !== "ACTIVE"
            && phase !== "PROPOSAL_RECEIVED"
            && phase !== "VALIDATED"
            && phase !== "REJECTED"
          ) fail();
          generationPhases.set(event.payload.generationId, "SUPERSEDED");
          break;
        }

        case "PROPOSAL_VALIDATED": {
          assertBoundedIdentifier(event.payload.generationId);
          if (
            consumedPendingKind !== "MODEL_PROPOSAL_OUTCOME"
            || generationPhase(generationPhases, event.payload.generationId)
              !== "PROPOSAL_RECEIVED"
            || generationProposalKinds.get(event.payload.generationId)
              !== "INTERVIEWER"
          ) fail();
          const generation = state.generations[event.payload.generationId];
          const proposal = generation?.proposal;
          const request = generation === undefined
            ? undefined
            : state.pedagogicalActions[generation.basis.turnId];
          if (
            generation === undefined
            || proposal === undefined
            || request === undefined
            || isGenerationBasisStillCompatible(generation.basis, state)
              !== "COMPATIBLE"
            || proposal.realizedAction !== request.requiredAction
            || event.payload.analysis.status !== "SAFE"
            || event.payload.analysis.confidence !== 1
            || event.payload.analysis.effectiveDisclosureLevel
              > request.maximumDisclosure
            || proposal.claimedDisclosureLevel
              < event.payload.analysis.effectiveDisclosureLevel
          ) fail();
          validatedAnalyses.set(event.payload.generationId, event.payload.analysis);
          deliveryAuthorizationUsage.set(event.payload.generationId, {
            textUsed: false,
            audioUsed: false,
            boardActionIndexesUsed: new Set<number>()
          });
          generationPhases.set(event.payload.generationId, "VALIDATED");
          pendingNext = {
            kind: "FIRST_DELIVERY",
            generationId: event.payload.generationId
          };
          break;
        }

        case "PROPOSAL_REJECTED":
          assertBoundedIdentifier(event.payload.generationId);
          if (
            consumedPendingKind !== "MODEL_PROPOSAL_OUTCOME"
            || generationPhase(generationPhases, event.payload.generationId)
              !== "PROPOSAL_RECEIVED"
            || generationProposalKinds.get(event.payload.generationId)
              !== "INTERVIEWER"
          ) fail();
          generationPhases.set(event.payload.generationId, "REJECTED");
          break;

        case "DELIVERY_QUEUED": {
          assertDeliveryIdentifiers(event.payload.atom);
          if (state.deliveries[event.payload.atom.deliveryId] !== undefined) fail();
          if (
            generationPhase(generationPhases, event.payload.atom.generationId)
              !== "VALIDATED"
          ) fail();
          const generation = state.generations[event.payload.atom.generationId];
          const analysis = validatedAnalyses.get(event.payload.atom.generationId);
          const authorizationUsage = deliveryAuthorizationUsage.get(
            event.payload.atom.generationId
          );
          if (
            generation?.proposal === undefined
            || analysis === undefined
            || authorizationUsage === undefined
            || event.payload.atom.effectiveDisclosureLevel
              !== analysis.effectiveDisclosureLevel
            || !arraysEqual(
              event.payload.atom.disclosureIds,
              analysis.effectiveDisclosureIds
            )
            || !consumeDeliveryAuthorization(
              generation.proposal,
              event.payload.atom.content,
              authorizationUsage
            )
          ) fail();
          break;
        }

        case "DELIVERY_CANCELLED": {
          assertBoundedIdentifier(event.payload.deliveryId);
          const delivery = state.deliveries[event.payload.deliveryId];
          if (delivery === undefined || delivery.status !== "QUEUED") fail();
          break;
        }

        case "DELIVERY_STARTED": {
          assertBoundedIdentifier(event.payload.deliveryId);
          const delivery = state.deliveries[event.payload.deliveryId];
          if (delivery === undefined) fail();
          if (generationPhase(generationPhases, delivery.generationId) !== "VALIDATED") fail();
          const generation = state.generations[delivery.generationId];
          if (
            generation === undefined
            || isGenerationBasisStillCompatible(generation.basis, state)
              !== "COMPATIBLE"
          ) fail();
          break;
        }

        case "DELIVERY_EXPOSED":
        case "DELIVERY_COMPLETED":
          assertBoundedIdentifier(event.payload.deliveryId);
          break;

        case "DELIVERY_POSSIBLY_EXPOSED":
          assertBoundedIdentifier(event.payload.deliveryId);
          if (
            event.source === "APPLICATION"
            && consumedRequiredKind !== "POSSIBLY_EXPOSE_DELIVERY"
          ) fail();
          break;

        case "POLICY_REVISION_CHANGED":
          if (
            event.payload.policyRevision !== state.policyRevision + 1
            || event.payload.contextEpoch !== state.contextEpoch + 1
          ) fail();
          break;

        case "PROBLEM_STATE_REVISION_CHANGED":
          if (
            event.payload.problemStateRevision !== state.problemStateRevision + 1
            || event.payload.contextEpoch !== state.contextEpoch + 1
          ) fail();
          break;

        case "SESSION_COMPLETED":
          if (state.status !== "ACTIVE" || !terminalStateIsSettled(state)) fail();
          break;

        case "SESSION_ARCHIVED":
          if (
            (state.status !== "ACTIVE" && state.status !== "COMPLETED")
            || !terminalStateIsSettled(state)
          ) fail();
          break;

        case "SESSION_RESUMED":
          if (state.status !== "ACTIVE") fail();
          break;
      }

      state = reduceSessionEvent(state, event);
      previousEvent = event;
    }
  } catch (error) {
    if (error instanceof ReplayProjectionError) throw error;
    fail();
  }

  if (options.completeHistory === true) {
    if (
      state.started && state.problem === undefined
      || pendingNext !== undefined
      || requiredFollowUps.length > 0
    ) fail();

    const turnCountsByEpisode = new Map<string, number>();
    for (const turn of Object.values(state.turns)) {
      turnCountsByEpisode.set(
        turn.inputEpisodeId,
        (turnCountsByEpisode.get(turn.inputEpisodeId) ?? 0) + 1
      );
    }
    for (const episode of Object.values(state.inputEpisodes)) {
      if (
        episode.status === "COMMITTED"
        && turnCountsByEpisode.get(episode.inputEpisodeId) !== 1
      ) fail();
    }

    if (
      (state.status === "COMPLETED" || state.status === "ARCHIVED")
      && !terminalStateIsSettled(state)
    ) fail();
  }

  return {
    state,
    validatedThroughSequence: events.at(-1)?.sequence ?? 0
  };
}
