import { evidenceKeyToString, generationBasesEqual, isDisclosedStatus } from "../../domain/src/index.js";
import type { DeliveryAtom, DisclosureId } from "../../domain/src/index.js";
import type { SessionEvent } from "./schemas.js";
import {
  initialSessionState,
  type GenerationState,
  type SessionState,
  type VisionRequestState
} from "./state.js";

function assertSequence(state: SessionState, event: SessionEvent): void {
  if (event.sessionId !== state.sessionId) throw new Error("Event session does not match state session");
  if (event.sequence !== state.sequence + 1) {
    throw new Error(`Expected sequence ${String(state.sequence + 1)}, received ${String(event.sequence)}`);
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}

function withDeliveryStatus(state: SessionState, deliveryId: string, status: DeliveryAtom["status"]): SessionState {
  const current = state.deliveries[deliveryId];
  if (current === undefined) throw new Error(`Unknown delivery ${deliveryId}`);
  const allowed: Readonly<Record<DeliveryAtom["status"], readonly DeliveryAtom["status"][]>> = {
    VALIDATED: ["QUEUED"],
    QUEUED: ["DELIVERING", "CANCELLED"],
    DELIVERING: ["EXPOSED", "POSSIBLY_EXPOSED"],
    EXPOSED: ["COMPLETED"],
    COMPLETED: [],
    CANCELLED: [],
    POSSIBLY_EXPOSED: ["EXPOSED"]
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
      if (state.started) throw new Error("Session is already started");
      next = {
        ...state,
        started: true,
        status: "ACTIVE",
        ...(event.payload.configuration === undefined
          ? {}
          : { configuration: deepFreeze(structuredClone(event.payload.configuration)) })
      };
      break;
    case "PROBLEM_PRESENTED": {
      if (state.problem !== undefined) {
        throw new Error("Authoritative problem identity is already bound");
      }
      if (state.configuration !== undefined) {
        if (state.configuration.mode === "QUANT_TRADING") {
          throw new Error("Quant Trading sessions cannot bind PROBLEM_PRESENTED state");
        }
        const configuredTarget = state.configuration.mode === "OXFORD_MATHEMATICS"
          ? state.configuration.problem
          : state.configuration.scenario;
        if (
          configuredTarget.id !== event.payload.problemId
          || configuredTarget.version !== event.payload.problemVersion
        ) {
          throw new Error("Presented problem identity does not match session configuration");
        }
      }
      next = {
        ...state,
        problem: {
          id: event.payload.problemId,
          version: event.payload.problemVersion,
          prompt: event.payload.prompt,
          ...(event.payload.providerContextSpecSha256 === undefined
            ? {}
            : { providerContextSpecSha256: event.payload.providerContextSpecSha256 })
        }
      };
      break;
    }
    case "QUANT_RESEARCH_SCENARIO_INITIALIZED": {
      if (state.quantResearch !== undefined) throw new Error("Quant Research scenario is already initialized");
      if (
        event.payload.definition.family !== event.payload.authoritativeSnapshot.family ||
        state.problem?.id !== event.payload.definition.family ||
        state.problem.version !== event.payload.definition.version
      ) {
        throw new Error("Quant Research initialization does not match the presented problem");
      }
      next = {
        ...state,
        quantResearch: {
          definition: event.payload.definition,
          authoritativeSnapshot: event.payload.authoritativeSnapshot,
          actions: []
        }
      };
      break;
    }
    case "QUANT_RESEARCH_ACTION_ACCEPTED": {
      const quantResearch = state.quantResearch;
      if (quantResearch === undefined) throw new Error("Quant Research scenario is not initialized");
      if (quantResearch.result !== undefined) throw new Error("Quant Research scenario is already complete");
      if (quantResearch.actions.length >= 64) throw new Error("Quant Research action history exceeds the maximum size");
      if (quantResearch.actions.some((action) => action.actionId === event.payload.action.actionId)) {
        throw new Error("Quant Research action ID is already present in authoritative history");
      }
      next = {
        ...state,
        quantResearch: {
          ...quantResearch,
          actions: [...quantResearch.actions, event.payload.action]
        }
      };
      break;
    }
    case "QUANT_RESEARCH_SCENARIO_COMPLETED": {
      const quantResearch = state.quantResearch;
      if (quantResearch === undefined) throw new Error("Quant Research scenario is not initialized");
      if (quantResearch.result !== undefined) throw new Error("Quant Research scenario is already complete");
      const result = event.payload.result;
      if (
        result.status !== "COMPLETE" ||
        result.family !== quantResearch.definition.family ||
        result.version !== quantResearch.definition.version ||
        result.generatorVersion !== quantResearch.definition.generatorVersion ||
        result.rngVersion !== quantResearch.definition.rngVersion ||
        result.acceptedActionCount !== quantResearch.actions.length
      ) {
        throw new Error("Quant Research completion result does not match authoritative history");
      }
      next = {
        ...state,
        quantResearch: {
          ...quantResearch,
          result
        }
      };
      break;
    }
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
    case "BOARD_PATCH_COMMITTED": {
      if (event.payload.boardRevision !== state.boardRevision + 1) {
        throw new Error("Board revision must advance exactly once per committed patch");
      }
      const mutation = event.payload.mutation;
      if (mutation === undefined) {
        next = {
          ...state,
          boardRevision: event.payload.boardRevision,
          boardShapeAuthorityKnown: false
        };
        break;
      }
      if (!state.boardShapeAuthorityKnown) {
        throw new Error("Normalized board mutation cannot apply while shape authority is unknown");
      }
      if (mutation.baseBoardRevision !== state.boardRevision) {
        throw new Error("Normalized board mutation basis does not match authoritative board revision");
      }
      const boardShapes = { ...state.boardShapes };
      for (const shape of mutation.added) {
        if (boardShapes[shape.id] !== undefined) {
          throw new Error("Normalized board add targets an existing shape");
        }
        boardShapes[shape.id] = shape;
      }
      for (const entry of mutation.updated) {
        const existing = boardShapes[entry.shape.id];
        if (existing === undefined || existing.revision !== entry.beforeRevision) {
          throw new Error("Normalized board update has a stale shape basis");
        }
        boardShapes[entry.shape.id] = entry.shape;
      }
      for (const entry of mutation.deleted) {
        const existing = boardShapes[entry.shapeId];
        if (existing === undefined || existing.revision !== entry.expectedRevision) {
          throw new Error("Normalized board delete has a stale shape basis");
        }
        if (!Reflect.deleteProperty(boardShapes, entry.shapeId)) {
          throw new Error("Normalized board delete could not remove the authoritative shape");
        }
      }
      next = {
        ...state,
        boardRevision: event.payload.boardRevision,
        boardShapeAuthorityKnown: true,
        boardShapes
      };
      break;
    }
    case "VISION_REQUESTED": {
      if (state.visionRequests[event.payload.visionRequestId] !== undefined) {
        throw new Error("Vision request already exists");
      }
      const request: VisionRequestState = {
        visionRequestId: event.payload.visionRequestId,
        sourceBoardRevision: event.payload.sourceBoardRevision,
        regionId: event.payload.regionId,
        relevantShapeIds: [...event.payload.relevantShapeIds],
        ...(event.payload.snapshotBasis === undefined
          ? {}
          : { snapshotBasis: event.payload.snapshotBasis }),
        ...(event.payload.relevantShapeRevisions === undefined
          ? {}
          : { relevantShapeRevisions: [...event.payload.relevantShapeRevisions] }),
        ...(event.payload.regionBounds === undefined
          ? {}
          : { regionBounds: event.payload.regionBounds }),
        ...(event.payload.requestedObservationKind === undefined
          ? {}
          : { requestedObservationKind: event.payload.requestedObservationKind }),
        status: "PENDING"
      };
      next = {
        ...state,
        visionRequests: {
          ...state.visionRequests,
          [event.payload.visionRequestId]: request
        }
      };
      break;
    }
    case "VISION_RESULT_ACCEPTED": {
      const request = state.visionRequests[event.payload.visionRequestId];
      if (request === undefined || request.status !== "PENDING") {
        throw new Error("Vision request is not pending");
      }
      const observation = event.payload.observation;
      if (
        observation.sourceBoardRevision !== request.sourceBoardRevision
        || observation.regionId !== request.regionId
      ) {
        throw new Error("Accepted vision observation does not match its persisted request basis");
      }

      const admission = event.payload.admission;
      const dependencyShapeIds = admission === undefined
        ? observation.relevantShapeIds
        : admission.sourceRelevantShapeIds;
      if (!sameStringSet(dependencyShapeIds, request.relevantShapeIds)) {
        throw new Error("Accepted vision dependencies do not match the persisted request");
      }

      if (admission !== undefined) {
        if (
          request.snapshotBasis === undefined
          || request.relevantShapeRevisions === undefined
          || request.regionBounds === undefined
          || request.requestedObservationKind === undefined
        ) {
          throw new Error("Accepted vision admission requires complete persisted request provenance");
        }
        if (
          admission.requestId !== event.payload.visionRequestId
          || admission.sessionId !== state.sessionId
          || admission.admittedAtBoardRevision !== state.boardRevision
          || !jsonDataEqual(admission.observation, observation)
        ) {
          throw new Error("Accepted vision admission identity does not match replay authority");
        }
        if (
          request.snapshotBasis !== undefined
          && !jsonDataEqual(admission.snapshotBasis, request.snapshotBasis)
        ) {
          throw new Error("Accepted vision snapshot basis does not match the persisted request");
        }
        if (
          request.relevantShapeRevisions !== undefined
          && !sameShapeRevisionBindings(
            admission.shapeRevisionBindings,
            request.relevantShapeRevisions
          )
        ) {
          throw new Error("Accepted vision shape revisions do not match the persisted request");
        }
        if (
          request.regionBounds !== undefined
          && !jsonDataEqual(admission.observation.bounds, request.regionBounds)
        ) {
          throw new Error("Accepted vision region bounds do not match the persisted request");
        }
        if (
          request.requestedObservationKind !== undefined
          && request.requestedObservationKind !== "ANY"
          && admission.observationKind !== request.requestedObservationKind
        ) {
          throw new Error("Accepted vision observation kind does not match the persisted request");
        }
      }

      next = {
        ...state,
        visionRequests: {
          ...state.visionRequests,
          [event.payload.visionRequestId]: {
            ...request,
            status: "ACCEPTED",
            observation,
            ...(admission === undefined ? {} : { acceptedObservation: admission }),
            resultEventId: event.eventId
          }
        }
      };
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
    case "VERIFICATION_REQUESTED":
      if (state.verificationRequests[event.payload.verificationRequestId] !== undefined) throw new Error("Verification request already exists");
      next = {
        ...state,
        verificationRequests: {
          ...state.verificationRequests,
          [event.payload.verificationRequestId]: {
            ...event.payload,
            requestedEventId: event.eventId,
            status: "PENDING"
          }
        }
      };
      break;
    case "VERIFICATION_RESULT_ACCEPTED": {
      const request = state.verificationRequests[event.payload.verificationRequestId];
      if (request === undefined || request.status !== "PENDING") throw new Error("Verification request is not pending");
      if (request.verifier !== event.payload.result.verifier || request.interpretationConfidence !== event.payload.result.interpretationConfidence) {
        throw new Error("Verification result does not match its request");
      }
      next = {
        ...state,
        verificationRequests: {
          ...state.verificationRequests,
          [event.payload.verificationRequestId]: {
            ...request,
            status: "ACCEPTED",
            result: event.payload.result,
            resultEventId: event.eventId,
            resultSequence: event.sequence
          }
        }
      };
      break;
    }
    case "VERIFICATION_RESULT_DISCARDED": {
      const request = state.verificationRequests[event.payload.verificationRequestId];
      if (request === undefined || request.status !== "PENDING") throw new Error("Verification request is not pending");
      next = {
        ...state,
        verificationRequests: {
          ...state.verificationRequests,
          [event.payload.verificationRequestId]: { ...request, status: "DISCARDED", discardReason: event.payload.reason }
        }
      };
      break;
    }
    case "EVIDENCE_PROPOSED":
      next = { ...state, evidenceProposals: [...state.evidenceProposals, event.payload.proposal] };
      break;
    case "STUDENT_EVIDENCE_UPDATED": {
      if (event.payload.value.lastUpdatedSequence !== event.sequence) throw new Error("Evidence lastUpdatedSequence must equal its authoritative event sequence");
      const key = evidenceKeyToString(event.payload.key);
      const history = state.evidenceHistory[key] ?? [];
      const activeRecords = history.filter((record) => record.status === "ACTIVE");
      if (activeRecords.length > 1) throw new Error("Evidence history contains multiple active records");
      const active = activeRecords[0];
      if (active === undefined && event.payload.supersedesEventId !== undefined) throw new Error("Evidence update cannot supersede a missing active record");
      if (active !== undefined && event.payload.supersedesEventId !== active.evidenceEventId) throw new Error("Evidence update must explicitly supersede the active record");
      const superseded = history.map((record) => record.status === "ACTIVE"
        ? { ...record, status: "SUPERSEDED" as const, supersededByEventId: event.eventId }
        : record);
      next = {
        ...state,
        studentEvidence: { ...state.studentEvidence, [key]: event.payload.value },
        evidenceHistory: {
          ...state.evidenceHistory,
          [key]: [...superseded, {
            evidenceEventId: event.eventId,
            key: event.payload.key,
            value: event.payload.value,
            status: "ACTIVE"
          }]
        }
      };
      break;
    }
    case "STUDENT_EVIDENCE_INVALIDATED": {
      const key = evidenceKeyToString(event.payload.key);
      const history = state.evidenceHistory[key] ?? [];
      const activeRecords = history.filter((record) => record.status === "ACTIVE");
      if (activeRecords.length > 1) throw new Error("Evidence history contains multiple active records");
      const active = activeRecords[0];
      if (active === undefined || active.evidenceEventId !== event.payload.invalidatesEventId) {
        throw new Error("Evidence invalidation must identify the active record");
      }
      const remainingEvidence = Object.fromEntries(
        Object.entries(state.studentEvidence).filter(([candidateKey]) => candidateKey !== key)
      );
      next = {
        ...state,
        studentEvidence: remainingEvidence,
        evidenceHistory: {
          ...state.evidenceHistory,
          [key]: history.map((record) => record.evidenceEventId === event.payload.invalidatesEventId
            ? { ...record, status: "STALE", invalidationReason: event.payload.reason }
            : record)
        }
      };
      break;
    }
    case "PEDAGOGICAL_ACTION_SELECTED":
      next = { ...state, pedagogicalActions: { ...state.pedagogicalActions, [event.payload.turnId]: event.payload.request } };
      break;
    case "MODEL_GENERATION_STARTED": {
      const pedagogicalAction = state.pedagogicalActions[event.payload.basis.turnId];
      next = {
        ...state,
        generations: {
          ...state.generations,
          [event.payload.generationId]: {
            generationId: event.payload.generationId,
            basis: event.payload.basis,
            provider: event.payload.provider,
            ...(pedagogicalAction === undefined ? {} : { pedagogicalAction }),
            status: "ACTIVE"
          }
        }
      };
      break;
    }
    case "GENERATION_CONTEXT_COMPILED": {
      const generation = state.generations[event.payload.generationId];
      if (generation === undefined || generation.status !== "ACTIVE") throw new Error("Context compilation requires an active generation");
      if (generation.contextManifest !== undefined) throw new Error("Generation context is already compiled");
      if (
        event.payload.manifest.generationId !== event.payload.generationId
        || !generationBasesEqual(event.payload.manifest.generationBasis, generation.basis)
      ) throw new Error("Context manifest does not match its generation basis");
      next = updateGeneration(state, event.payload.generationId, { contextManifest: event.payload.manifest });
      break;
    }
    case "MODEL_PROPOSAL_RECEIVED":
      next = updateGeneration(state, event.payload.generationId, { status: "PROPOSAL_RECEIVED", proposal: event.payload.proposal });
      break;
    case "FORMAL_INTERPRETATION_PROPOSAL_RECEIVED":
      next = updateGeneration(state, event.payload.generationId, {
        status: "PROPOSAL_RECEIVED",
        formalInterpretationProposal: event.payload.proposal
      });
      break;
    case "FORMAL_INTERPRETATION_PROPOSAL_REJECTED":
      next = updateGeneration(state, event.payload.generationId, { status: "REJECTED" });
      break;
    case "MODEL_GENERATION_SUPERSEDED":
      next = updateGeneration(state, event.payload.generationId, { status: "SUPERSEDED" });
      break;
    case "PROPOSAL_VALIDATED": {
      const generation = state.generations[event.payload.generationId];
      if (generation === undefined) throw new Error("Unknown generation");
      next = updateGeneration(state, event.payload.generationId, {
        status: "VALIDATED",
        interviewerProposalValidated: true,
        ...(generation.proposal === undefined
          ? {}
          : { validatedInterviewerProposal: generation.proposal })
      });
      break;
    }
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
    case "SESSION_COMPLETED":
      next = {
        ...state,
        status: "COMPLETED",
        completedAt: event.payload.completedAt,
        ...(event.payload.summary ? { completionSummary: event.payload.summary } : {})
      };
      break;
    case "SESSION_ARCHIVED":
      next = {
        ...state,
        status: "ARCHIVED",
        archivedAt: event.payload.archivedAt,
        ...(event.payload.reason ? { archivalReason: event.payload.reason } : {})
      };
      break;
    case "SESSION_RESUMED":
      next = state;
      break;
  }
  return { ...next, sequence: event.sequence, eventIds: [...next.eventIds, event.eventId] };
}

export function replaySession(sessionId: SessionState["sessionId"], events: readonly SessionEvent[]): SessionState {
  return events.reduce(reduceSessionEvent, initialSessionState(sessionId));
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}

function sameShapeRevisionBindings(
  left: readonly { readonly shapeId: string; readonly expectedRevision: number }[],
  right: readonly { readonly shapeId: string; readonly expectedRevision: number }[]
): boolean {
  if (left.length !== right.length) return false;
  const rightById = new Map(right.map((binding) => [
    binding.shapeId,
    binding.expectedRevision
  ] as const));
  return left.every((binding) =>
    rightById.get(binding.shapeId) === binding.expectedRevision
  );
}

function jsonDataEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
