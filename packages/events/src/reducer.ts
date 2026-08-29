import { evidenceKeyToString, isDisclosedStatus } from "../../domain/src/index.js";
import type { DeliveryAtom, DisclosureId } from "../../domain/src/index.js";
import type { SessionEvent } from "./schemas.js";
import { initialSessionState, type GenerationState, type SessionState } from "./state.js";

function assertSequence(state: SessionState, event: SessionEvent): void {
  if (event.sessionId !== state.sessionId) throw new Error("Event session does not match state session");
  if (event.sequence !== state.sequence + 1) {
    throw new Error(`Expected sequence ${String(state.sequence + 1)}, received ${String(event.sequence)}`);
  }
}

function withDeliveryStatus(state: SessionState, deliveryId: string, status: DeliveryAtom["status"]): SessionState {
  const current = state.deliveries[deliveryId];
  if (current === undefined) throw new Error(`Unknown delivery ${deliveryId}`);
  const allowed: Readonly<Record<DeliveryAtom["status"], readonly DeliveryAtom["status"][]>> = {
    VALIDATED: ["QUEUED"],
    QUEUED: ["DELIVERING", "CANCELLED"],
    DELIVERING: ["EXPOSED", "CANCELLED", "POSSIBLY_EXPOSED"],
    EXPOSED: ["COMPLETED"],
    COMPLETED: [],
    CANCELLED: [],
    POSSIBLY_EXPOSED: []
  };
  if (!allowed[current.status].includes(status)) {
    throw new Error(`Invalid delivery transition ${current.status} -> ${status}`);
  }
  const updated = { ...current, status };
  const ledger = isDisclosedStatus(status)
    ? Array.from(new Set<DisclosureId>([...state.disclosureLedger, ...current.disclosureIds]))
    : state.disclosureLedger;
  return { ...state, deliveries: { ...state.deliveries, [deliveryId]: updated }, disclosureLedger: ledger };
}

function updateGeneration(state: SessionState, generationId: string, patch: Partial<GenerationState>): SessionState {
  const current = state.generations[generationId];
  if (current === undefined) throw new Error(`Unknown generation ${generationId}`);
  return { ...state, generations: { ...state.generations, [generationId]: { ...current, ...patch } } };
}

export function reduceSessionEvent(state: SessionState, event: SessionEvent): SessionState {
  assertSequence(state, event);
  let next: SessionState;
  switch (event.type) {
    case "SESSION_STARTED":
      next = { ...state, started: true };
      break;
    case "PROBLEM_PRESENTED":
      next = { ...state, problem: { id: event.payload.problemId, version: event.payload.problemVersion, prompt: event.payload.prompt } };
      break;
    case "UTTERANCE_STARTED":
      next = { ...state, utterances: { ...state.utterances, [event.payload.utteranceId]: { utteranceId: event.payload.utteranceId, status: "CAPTURING" } } };
      break;
    case "UTTERANCE_DISCARDED": {
      const utterance = state.utterances[event.payload.utteranceId];
      if (utterance === undefined || utterance.status !== "CAPTURING") throw new Error("Utterance is not being captured");
      next = { ...state, utterances: { ...state.utterances, [event.payload.utteranceId]: { ...utterance, status: "DISCARDED" } } };
      break;
    }
    case "INPUT_EPISODE_STARTED":
      next = { ...state, inputEpisodes: { ...state.inputEpisodes, [event.payload.inputEpisodeId]: { inputEpisodeId: event.payload.inputEpisodeId, status: "ACTIVE", inputs: [] } } };
      break;
    case "INPUT_EPISODE_UPDATED": {
      const episode = state.inputEpisodes[event.payload.inputEpisodeId];
      if (episode === undefined || episode.status !== "ACTIVE") throw new Error("Input episode is not active");
      next = { ...state, inputEpisodes: { ...state.inputEpisodes, [event.payload.inputEpisodeId]: { ...episode, inputs: [...episode.inputs, { modality: event.payload.modality, semanticContent: event.payload.semanticContent }] } } };
      break;
    }
    case "INPUT_EPISODE_COMMITTED": {
      const episode = state.inputEpisodes[event.payload.inputEpisodeId];
      if (episode === undefined || episode.status !== "ACTIVE") throw new Error("Input episode is not active");
      next = { ...state, inputEpisodes: { ...state.inputEpisodes, [event.payload.inputEpisodeId]: { ...episode, status: "COMMITTED" } } };
      break;
    }
    case "TURN_COMMITTED":
      next = {
        ...state,
        lastCommittedInputSequence: event.sequence,
        turns: { ...state.turns, [event.payload.turnId]: { ...event.payload, committedSequence: event.sequence } }
      };
      break;
    case "TRANSCRIPT_FINALIZED": {
      const utterance = state.utterances[event.payload.utteranceId];
      if (utterance === undefined || utterance.status !== "CAPTURING") throw new Error("Utterance is not being captured");
      next = {
        ...state,
        transcriptRevision: event.payload.transcriptRevision,
        utterances: { ...state.utterances, [event.payload.utteranceId]: { ...utterance, status: "FINALIZED", inputEpisodeId: event.payload.inputEpisodeId, text: event.payload.text } }
      };
      break;
    }
    case "TRANSCRIPT_CORRECTED":
      next = { ...state, transcriptRevision: event.payload.transcriptRevision, contextEpoch: event.payload.contextEpoch };
      break;
    case "BOARD_PATCH_COMMITTED":
      next = { ...state, boardRevision: event.payload.boardRevision };
      break;
    case "VISION_REQUESTED":
      next = { ...state, visionRequests: { ...state.visionRequests, [event.payload.visionRequestId]: { ...event.payload, status: "PENDING" } } };
      break;
    case "VISION_RESULT_ACCEPTED": {
      const request = state.visionRequests[event.payload.visionRequestId];
      if (request === undefined || request.status !== "PENDING") throw new Error("Vision request is not pending");
      next = { ...state, visionRequests: { ...state.visionRequests, [event.payload.visionRequestId]: { ...request, status: "ACCEPTED", observation: event.payload.observation } } };
      break;
    }
    case "VISION_RESULT_DISCARDED": {
      const request = state.visionRequests[event.payload.visionRequestId];
      if (request === undefined || request.status !== "PENDING") throw new Error("Vision request is not pending");
      next = { ...state, visionRequests: { ...state.visionRequests, [event.payload.visionRequestId]: { ...request, status: "DISCARDED", discardReason: event.payload.reason } } };
      break;
    }
    case "LOCAL_COMPUTE_REQUESTED":
      if (state.localComputeRequests[event.payload.computeRequestId] !== undefined) throw new Error("Local compute request already exists");
      next = {
        ...state,
        localComputeRequests: {
          ...state.localComputeRequests,
          [event.payload.computeRequestId]: { ...event.payload, status: "PENDING" }
        }
      };
      break;
    case "LOCAL_COMPUTE_RESULT_ACCEPTED": {
      const request = state.localComputeRequests[event.payload.computeRequestId];
      if (request === undefined || request.status !== "PENDING") throw new Error("Local compute request is not pending");
      if (request.sourceTranscriptRevision !== event.payload.sourceTranscriptRevision) {
        throw new Error("Local compute result basis does not match its request");
      }
      next = {
        ...state,
        localComputeRequests: {
          ...state.localComputeRequests,
          [event.payload.computeRequestId]: {
            ...request,
            status: "ACCEPTED",
            result: { normalizedText: event.payload.normalizedText, tokenCount: event.payload.tokenCount }
          }
        }
      };
      break;
    }
    case "LOCAL_COMPUTE_RESULT_DISCARDED": {
      const request = state.localComputeRequests[event.payload.computeRequestId];
      if (request === undefined || request.status !== "PENDING") throw new Error("Local compute request is not pending");
      next = {
        ...state,
        localComputeRequests: {
          ...state.localComputeRequests,
          [event.payload.computeRequestId]: { ...request, status: "DISCARDED", discardReason: event.payload.reason }
        }
      };
      break;
    }
    case "EVIDENCE_PROPOSED":
      next = { ...state, evidenceProposals: [...state.evidenceProposals, event.payload.proposal] };
      break;
    case "STUDENT_EVIDENCE_UPDATED":
      if (event.payload.value.lastUpdatedSequence !== event.sequence) throw new Error("Evidence lastUpdatedSequence must equal its authoritative event sequence");
      next = { ...state, studentEvidence: { ...state.studentEvidence, [evidenceKeyToString(event.payload.key)]: event.payload.value } };
      break;
    case "PEDAGOGICAL_ACTION_SELECTED":
      next = { ...state, pedagogicalActions: { ...state.pedagogicalActions, [event.payload.turnId]: event.payload.request } };
      break;
    case "MODEL_GENERATION_STARTED":
      next = { ...state, generations: { ...state.generations, [event.payload.generationId]: { generationId: event.payload.generationId, basis: event.payload.basis, provider: event.payload.provider, status: "ACTIVE" } } };
      break;
    case "MODEL_PROPOSAL_RECEIVED":
      next = updateGeneration(state, event.payload.generationId, { status: "PROPOSAL_RECEIVED", proposal: event.payload.proposal });
      break;
    case "MODEL_GENERATION_SUPERSEDED":
      next = updateGeneration(state, event.payload.generationId, { status: "SUPERSEDED" });
      break;
    case "PROPOSAL_VALIDATED":
      next = updateGeneration(state, event.payload.generationId, { status: "VALIDATED" });
      break;
    case "PROPOSAL_REJECTED":
      next = updateGeneration(state, event.payload.generationId, { status: "REJECTED" });
      break;
    case "DELIVERY_QUEUED":
      if (event.payload.atom.status !== "VALIDATED") throw new Error("Only validated atoms may be queued");
      next = { ...state, deliveries: { ...state.deliveries, [event.payload.atom.deliveryId]: { ...event.payload.atom, status: "QUEUED" } } };
      break;
    case "DELIVERY_STARTED":
      next = withDeliveryStatus(state, event.payload.deliveryId, "DELIVERING");
      break;
    case "DELIVERY_EXPOSED":
      next = withDeliveryStatus(state, event.payload.deliveryId, "EXPOSED");
      break;
    case "DELIVERY_COMPLETED":
      next = withDeliveryStatus(state, event.payload.deliveryId, "COMPLETED");
      break;
    case "DELIVERY_CANCELLED":
      next = withDeliveryStatus(state, event.payload.deliveryId, "CANCELLED");
      break;
    case "DELIVERY_POSSIBLY_EXPOSED":
      next = withDeliveryStatus(state, event.payload.deliveryId, "POSSIBLY_EXPOSED");
      break;
    case "POLICY_REVISION_CHANGED":
      next = { ...state, policyRevision: event.payload.policyRevision, contextEpoch: event.payload.contextEpoch };
      break;
    case "PROBLEM_STATE_REVISION_CHANGED":
      next = { ...state, problemStateRevision: event.payload.problemStateRevision, contextEpoch: event.payload.contextEpoch };
      break;
  }
  return { ...next, sequence: event.sequence, eventIds: [...next.eventIds, event.eventId] };
}

export function replaySession(sessionId: SessionState["sessionId"], events: readonly SessionEvent[]): SessionState {
  return events.reduce(reduceSessionEvent, initialSessionState(sessionId));
}
