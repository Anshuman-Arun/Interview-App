import {
  evidenceKeyToString,
  isEvidenceValueAllowed,
  type EvidenceKey,
  type GenerationId,
  type SessionId
} from "../../domain/src/index.js";
import {
  isGenerationBasisStillCompatible,
  initialSessionState,
  reduceSessionEvent,
  type SessionEvent,
  type SessionState
} from "../../events/src/index.js";
import { replayEvidenceIdentity } from "./identity.js";
import { ReplayProjectionError } from "./provenance.js";

type GenerationPhase =
  | "ACTIVE"
  | "PROPOSAL_RECEIVED"
  | "VALIDATED"
  | "REJECTED"
  | "SUPERSEDED";

function fail(): never {
  throw new ReplayProjectionError("INVALID_EVENT_SEMANTICS");
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

function assertPriorEventIds(
  state: Readonly<SessionState>,
  eventIds: readonly string[]
): void {
  const known = new Set(state.eventIds);
  if (!eventIds.every((eventId) => known.has(eventId))) fail();
}

function generationPhase(
  phases: ReadonlyMap<GenerationId, GenerationPhase>,
  generationId: GenerationId
): GenerationPhase {
  const phase = phases.get(generationId);
  if (phase === undefined) fail();
  return phase;
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
  const usedTurnEpisodes = new Set<string>();
  const evidenceAliases = new Map<string, string>();
  let problemPresented = false;

  try {
    for (const event of events) {
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
          break;

        case "PROBLEM_PRESENTED":
          if (problemPresented) fail();
          problemPresented = true;
          break;

        case "UTTERANCE_STARTED":
          if (state.utterances[event.payload.utteranceId] !== undefined) fail();
          break;

        case "INPUT_EPISODE_STARTED":
          if (state.inputEpisodes[event.payload.inputEpisodeId] !== undefined) fail();
          break;

        case "INPUT_EPISODE_COMMITTED": {
          const episode = state.inputEpisodes[event.payload.inputEpisodeId];
          if (episode === undefined || episode.status !== "ACTIVE" || episode.inputs.length === 0) fail();
          break;
        }

        case "TURN_COMMITTED": {
          if (state.turns[event.payload.turnId] !== undefined) fail();
          const episode = state.inputEpisodes[event.payload.inputEpisodeId];
          if (episode === undefined || episode.status !== "COMMITTED") fail();
          if (usedTurnEpisodes.has(event.payload.inputEpisodeId)) fail();
          usedTurnEpisodes.add(event.payload.inputEpisodeId);
          break;
        }

        case "TRANSCRIPT_FINALIZED": {
          if (event.payload.transcriptRevision !== state.transcriptRevision + 1) fail();
          const episode = state.inputEpisodes[event.payload.inputEpisodeId];
          if (episode === undefined || episode.status !== "ACTIVE") fail();
          break;
        }

        case "TRANSCRIPT_CORRECTED":
          if (
            event.payload.transcriptRevision !== state.transcriptRevision + 1
            || event.payload.contextEpoch !== state.contextEpoch + 1
          ) fail();
          break;

        case "BOARD_PATCH_COMMITTED":
          if (event.payload.boardRevision !== state.boardRevision + 1) fail();
          break;

        case "EVIDENCE_PROPOSED":
          if (
            state.problem?.id !== event.payload.proposal.key.problemId
            || !isEvidenceValueAllowed(
              event.payload.proposal.key,
              event.payload.proposal.proposedValue
            )
          ) fail();
          assertPriorEventIds(state, event.payload.proposal.evidenceEventIds);
          break;

        case "STUDENT_EVIDENCE_UPDATED":
          if (
            state.problem?.id !== event.payload.key.problemId
            || !isEvidenceValueAllowed(event.payload.key, event.payload.value.value)
          ) fail();
          registerEvidenceIdentity(evidenceAliases, event.payload.key);
          assertPriorEventIds(state, event.payload.value.evidenceEventIds);
          break;

        case "STUDENT_EVIDENCE_INVALIDATED":
          if (state.problem?.id !== event.payload.key.problemId) fail();
          registerEvidenceIdentity(evidenceAliases, event.payload.key);
          break;

        case "VERIFICATION_REQUESTED":
          if (
            state.problem?.id !== event.payload.evidenceKey.problemId
            || event.payload.evidenceKey.subject.kind !== "CLAIM"
            || event.payload.evidenceKey.dimension !== "CORRECTNESS"
          ) fail();
          assertPriorEventIds(state, event.payload.evidenceEventIds);
          if (isGenerationBasisStillCompatible(event.payload.basis, state) !== "COMPATIBLE") fail();
          break;

        case "PEDAGOGICAL_ACTION_SELECTED":
          if (state.turns[event.payload.turnId] === undefined) fail();
          break;

        case "MODEL_GENERATION_STARTED": {
          if (state.generations[event.payload.generationId] !== undefined) fail();
          if (isGenerationBasisStillCompatible(event.payload.basis, state) !== "COMPATIBLE") fail();
          generationPhases.set(event.payload.generationId, "ACTIVE");
          break;
        }

        case "GENERATION_CONTEXT_COMPILED":
          if (generationPhase(generationPhases, event.payload.generationId) !== "ACTIVE") fail();
          break;

        case "MODEL_PROPOSAL_RECEIVED":
        case "FORMAL_INTERPRETATION_PROPOSAL_RECEIVED":
          if (generationPhase(generationPhases, event.payload.generationId) !== "ACTIVE") fail();
          generationPhases.set(event.payload.generationId, "PROPOSAL_RECEIVED");
          break;

        case "FORMAL_INTERPRETATION_PROPOSAL_REJECTED":
        case "PROPOSAL_REJECTED":
          if (generationPhase(generationPhases, event.payload.generationId) !== "PROPOSAL_RECEIVED") fail();
          generationPhases.set(event.payload.generationId, "REJECTED");
          break;

        case "PROPOSAL_VALIDATED":
          if (generationPhase(generationPhases, event.payload.generationId) !== "PROPOSAL_RECEIVED") fail();
          generationPhases.set(event.payload.generationId, "VALIDATED");
          break;

        case "MODEL_GENERATION_SUPERSEDED": {
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

        case "DELIVERY_QUEUED":
          if (state.deliveries[event.payload.atom.deliveryId] !== undefined) fail();
          if (generationPhase(generationPhases, event.payload.atom.generationId) !== "VALIDATED") fail();
          break;

        case "DELIVERY_CANCELLED": {
          const delivery = state.deliveries[event.payload.deliveryId];
          if (delivery === undefined || delivery.status !== "QUEUED") fail();
          break;
        }

        case "DELIVERY_STARTED": {
          const delivery = state.deliveries[event.payload.deliveryId];
          if (delivery === undefined) fail();
          if (generationPhase(generationPhases, delivery.generationId) !== "VALIDATED") fail();
          const generation = state.generations[delivery.generationId];
          if (
            generation === undefined
            || isGenerationBasisStillCompatible(generation.basis, state) !== "COMPATIBLE"
          ) fail();
          break;
        }

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
          if (state.status !== "ACTIVE") fail();
          break;

        case "SESSION_ARCHIVED":
          if (state.status !== "ACTIVE" && state.status !== "COMPLETED") fail();
          break;

        case "SESSION_RESUMED":
          if (state.status !== "ACTIVE") fail();
          break;

        default:
          break;
      }

      state = reduceSessionEvent(state, event);
    }
  } catch (error) {
    if (error instanceof ReplayProjectionError) throw error;
    fail();
  }

  if (options.completeHistory === true) {
    if (state.started && state.problem === undefined) fail();

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
      && Object.values(state.deliveries).some((delivery) =>
        delivery.status === "QUEUED" || delivery.status === "DELIVERING"
      )
    ) fail();
  }

  return {
    state,
    validatedThroughSequence: events.at(-1)?.sequence ?? 0
  };
}
