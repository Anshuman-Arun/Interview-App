import type {
  DeliveryAtom,
  DeliveryStatus
} from "../../domain/src/index.js";
import type { EventType } from "../../events/src/index.js";
import {
  previewText,
  resolveReplayBounds,
  takeBounded,
  truncationInfo,
  type ReplayBounds
} from "./bounds.js";
import {
  normalizeReplayEvents,
  ReplayProjectionError,
  type NormalizedReplayEvent,
  type NormalizedReplayHistory
} from "./provenance.js";
import {
  requiresSpecializedReplayValidation,
  validateKnownReplayPrefix
} from "./validation.js";
import type {
  ReplayDeliveryDetail,
  ReplayEvidenceDetail,
  ReplayGenerationDetail,
  ReplayProjectionIssue,
  ReplayRelationRefs,
  ReplayRevisionDetail,
  ReplayTimelineEntry,
  ReplayTimelineProjection,
  ReplayVerificationDetail
} from "./types.js";

export interface ReplayTimelineOptions {
  readonly bounds?: Partial<ReplayBounds>;
}

function assertNever(value: never): never {
  void value;
  throw new ReplayProjectionError("INVALID_EVENT_SEMANTICS");
}

function summaryFor(type: EventType): string {
  switch (type) {
    case "SESSION_STARTED": return "Session started";
    case "PROBLEM_PRESENTED": return "Problem presented";
    case "QUANT_RESEARCH_SCENARIO_INITIALIZED": return "Quant Research scenario initialized";
    case "QUANT_RESEARCH_ACTION_ACCEPTED": return "Quant Research action accepted";
    case "QUANT_RESEARCH_SCENARIO_COMPLETED": return "Quant Research scenario completed";
    case "UTTERANCE_STARTED": return "Speech utterance started";
    case "UTTERANCE_DISCARDED": return "Speech utterance discarded";
    case "INPUT_EPISODE_STARTED": return "Input episode started";
    case "INPUT_EPISODE_UPDATED": return "Input episode updated";
    case "INPUT_EPISODE_COMMITTED": return "Input episode committed";
    case "TURN_COMMITTED": return "Turn committed";
    case "TRANSCRIPT_FINALIZED": return "Transcript finalized";
    case "TRANSCRIPT_CORRECTED": return "Transcript corrected";
    case "BOARD_PATCH_COMMITTED": return "Whiteboard changed";
    case "VISION_REQUESTED": return "Vision verification requested";
    case "VISION_RESULT_ACCEPTED": return "Vision result accepted";
    case "VISION_EVIDENCE_BRIDGE_DECIDED": return "Vision evidence bridge decision recorded";
    case "VISION_EVIDENCE_BRIDGE_COMPLETED": return "Vision evidence bridge completed";
    case "VISION_RESULT_DISCARDED": return "Vision result discarded";
    case "LOCAL_COMPUTE_REQUESTED": return "Local compute requested";
    case "LOCAL_COMPUTE_RESULT_ACCEPTED": return "Local compute result accepted";
    case "LOCAL_COMPUTE_RESULT_DISCARDED": return "Local compute result discarded";
    case "VERIFICATION_REQUESTED": return "Verification requested";
    case "VERIFICATION_RESULT_ACCEPTED": return "Verification result accepted";
    case "VERIFICATION_RESULT_DISCARDED": return "Verification result discarded";
    case "EVIDENCE_PROPOSED": return "Evidence proposed";
    case "STUDENT_EVIDENCE_UPDATED": return "Evidence updated";
    case "STUDENT_EVIDENCE_INVALIDATED": return "Evidence marked stale";
    case "PEDAGOGICAL_ACTION_SELECTED": return "Pedagogical policy decision";
    case "MODEL_GENERATION_STARTED": return "Generation started";
    case "GENERATION_CONTEXT_COMPILED": return "Generation context compiled";
    case "MODEL_PROPOSAL_RECEIVED": return "Generated proposal persisted";
    case "FORMAL_INTERPRETATION_PROPOSAL_RECEIVED": return "Formal interpretation proposal persisted";
    case "FORMAL_INTERPRETATION_PROPOSAL_REJECTED": return "Formal interpretation proposal rejected";
    case "MODEL_GENERATION_SUPERSEDED": return "Generation superseded";
    case "PROPOSAL_VALIDATED": return "Generated proposal authorized";
    case "PROPOSAL_REJECTED": return "Generated proposal rejected";
    case "DELIVERY_QUEUED": return "Delivery authorized and queued";
    case "DELIVERY_STARTED": return "Delivery started";
    case "DELIVERY_EXPOSED": return "Delivery exposed";
    case "DELIVERY_COMPLETED": return "Delivery completed";
    case "DELIVERY_CANCELLED": return "Delivery cancelled before known exposure";
    case "DELIVERY_POSSIBLY_EXPOSED": return "Delivery possibly exposed";
    case "POLICY_REVISION_CHANGED": return "Policy revision changed";
    case "PROBLEM_STATE_REVISION_CHANGED": return "Problem-state revision changed";
    case "SESSION_COMPLETED": return "Session completed";
    case "SESSION_ARCHIVED": return "Session archived";
    case "SESSION_RESUMED": return "Session resumed";
  }
  return assertNever(type);
}

function presentationState(status: DeliveryStatus): ReplayDeliveryDetail["presentationState"] {
  switch (status) {
    case "VALIDATED":
    case "QUEUED":
      return "AUTHORIZED";
    case "DELIVERING":
      return "DELIVERING";
    case "EXPOSED":
    case "COMPLETED":
      return "PRESENTED";
    case "POSSIBLY_EXPOSED":
      return "POSSIBLY_PRESENTED";
    case "CANCELLED":
      return "CANCELLED";
  }
  return assertNever(status);
}

function deliveryDetail(
  atom: DeliveryAtom,
  status: DeliveryStatus,
  bounds: ReplayBounds
): ReplayDeliveryDetail {
  const contentMayBeRendered = status === "EXPOSED";
  const boundedIds = contentMayBeRendered
    ? takeBounded(atom.disclosureIds, bounds.maxDisclosureIds)
    : undefined;
  const base = {
    deliveryId: atom.deliveryId,
    generationId: atom.generationId,
    medium: atom.content.medium,
    persistedAtomStatus: atom.status,
    status,
    presentationState: presentationState(status),
    disclosure: {
      effectiveDisclosureLevel: atom.effectiveDisclosureLevel,
      disclosureIdCount: atom.disclosureIds.length,
      ...(boundedIds === undefined
        ? {}
        : {
            disclosureIds: boundedIds.values,
            truncation: boundedIds.truncation
          })
    }
  } as const;

  if (!contentMayBeRendered) {
    return atom.content.medium === "AUDIO"
      ? { ...base, audioReferenceRecorded: true }
      : base;
  }

  if (atom.content.medium === "TEXT") {
    return {
      ...base,
      text: previewText(atom.content.text, bounds.maxTextPreviewChars)
    };
  }
  if (atom.content.medium === "AUDIO") {
    return {
      ...base,
      text: previewText(atom.content.text, bounds.maxTextPreviewChars),
      audioReferenceRecorded: true
    };
  }

  const action = atom.content.action;
  return {
    ...base,
    boardAction: {
      operation: action.operation,
      ...(action.content === undefined
        ? {}
        : { content: previewText(action.content, bounds.maxTextPreviewChars) }),
      ...(action.targetShapeId === undefined ? {} : { targetShapeId: action.targetShapeId }),
      ...(action.expectedShapeRevision === undefined
        ? {}
        : { expectedShapeRevision: action.expectedShapeRevision })
    }
  };
}

function entryForKnownEvent(
  item: NormalizedReplayEvent,
  queuedAtoms: Map<string, DeliveryAtom>,
  bounds: ReplayBounds,
  stateValidation: ReplayTimelineEntry["stateValidation"] = "VALIDATED"
): ReplayTimelineEntry {
  const event = item.event;
  if (event === undefined) throw new ReplayProjectionError("INVALID_EVENT_SEMANTICS");

  let relations: ReplayRelationRefs = {};
  let text: ReturnType<typeof previewText> | undefined;
  let delivery: ReplayDeliveryDetail | undefined;
  let generation: ReplayGenerationDetail | undefined;
  let evidence: ReplayEvidenceDetail | undefined;
  let verification: ReplayVerificationDetail | undefined;
  let policy: ReplayTimelineEntry["policy"];
  let revisions: ReplayRevisionDetail | undefined;
  let quantResearch: ReplayTimelineEntry["quantResearch"];

  switch (event.type) {
    case "SESSION_STARTED":
      break;
    case "PROBLEM_PRESENTED":
      break;
    case "QUANT_RESEARCH_SCENARIO_INITIALIZED":
      quantResearch = {
        phase: "INITIALIZED",
        family: event.payload.definition.family,
        version: event.payload.definition.version,
        generatorVersion: event.payload.definition.generatorVersion,
        rngVersion: event.payload.definition.rngVersion,
        authoritativeSnapshotPersisted: true,
        specializedValidationRequired: true
      };
      break;
    case "QUANT_RESEARCH_ACTION_ACCEPTED":
      quantResearch = {
        phase: "ACTION_ACCEPTED",
        actionId: event.payload.action.actionId,
        actionKind: event.payload.action.kind,
        specializedValidationRequired: true
      };
      break;
    case "QUANT_RESEARCH_SCENARIO_COMPLETED":
      quantResearch = {
        phase: "COMPLETED",
        family: event.payload.result.family,
        version: event.payload.result.version,
        generatorVersion: event.payload.result.generatorVersion,
        rngVersion: event.payload.result.rngVersion,
        acceptedActionCount: event.payload.result.acceptedActionCount,
        resultStatus: "COMPLETE",
        specializedValidationRequired: true
      };
      break;
    case "UTTERANCE_STARTED":
      relations = { utteranceId: event.payload.utteranceId };
      break;
    case "UTTERANCE_DISCARDED":
      relations = { utteranceId: event.payload.utteranceId };
      text = previewText(event.payload.reason, bounds.maxTextPreviewChars);
      break;
    case "INPUT_EPISODE_STARTED":
      relations = { inputEpisodeId: event.payload.inputEpisodeId };
      break;
    case "INPUT_EPISODE_UPDATED":
      relations = { inputEpisodeId: event.payload.inputEpisodeId };
      text = previewText(event.payload.semanticContent, bounds.maxTextPreviewChars);
      break;
    case "INPUT_EPISODE_COMMITTED":
      relations = { inputEpisodeId: event.payload.inputEpisodeId };
      break;
    case "TURN_COMMITTED":
      relations = {
        inputEpisodeId: event.payload.inputEpisodeId,
        turnId: event.payload.turnId
      };
      text = previewText(event.payload.studentText, bounds.maxTextPreviewChars);
      break;
    case "TRANSCRIPT_FINALIZED":
      relations = {
        utteranceId: event.payload.utteranceId,
        inputEpisodeId: event.payload.inputEpisodeId
      };
      text = previewText(event.payload.text, bounds.maxTextPreviewChars);
      revisions = { transcriptRevision: event.payload.transcriptRevision };
      break;
    case "TRANSCRIPT_CORRECTED":
      text = previewText(event.payload.correctedText, bounds.maxTextPreviewChars);
      revisions = {
        transcriptRevision: event.payload.transcriptRevision,
        contextEpoch: event.payload.contextEpoch
      };
      break;
    case "BOARD_PATCH_COMMITTED":
      text = previewText(event.payload.summary, bounds.maxTextPreviewChars);
      revisions = { boardRevision: event.payload.boardRevision };
      break;
    case "VISION_REQUESTED":
      relations = { requestId: event.payload.visionRequestId };
      revisions = { boardRevision: event.payload.sourceBoardRevision };
      break;
    case "VISION_RESULT_ACCEPTED":
      relations = { requestId: event.payload.visionRequestId };
      revisions = { boardRevision: event.payload.observation.sourceBoardRevision };
      break;
    case "VISION_EVIDENCE_BRIDGE_DECIDED":
      relations = { requestId: event.payload.visionRequestId };
      break;
    case "VISION_EVIDENCE_BRIDGE_COMPLETED":
      relations = { requestId: event.payload.visionRequestId };
      break;
    case "VISION_RESULT_DISCARDED":
      relations = { requestId: event.payload.visionRequestId };
      text = previewText(event.payload.reason, bounds.maxTextPreviewChars);
      break;
    case "LOCAL_COMPUTE_REQUESTED":
      relations = {
        requestId: event.payload.computeRequestId,
        inputEpisodeId: event.payload.inputEpisodeId
      };
      revisions = { transcriptRevision: event.payload.sourceTranscriptRevision };
      break;
    case "LOCAL_COMPUTE_RESULT_ACCEPTED":
      relations = { requestId: event.payload.computeRequestId };
      text = previewText(event.payload.normalizedText, bounds.maxTextPreviewChars);
      revisions = { transcriptRevision: event.payload.sourceTranscriptRevision };
      break;
    case "LOCAL_COMPUTE_RESULT_DISCARDED":
      relations = { requestId: event.payload.computeRequestId };
      text = previewText(event.payload.reason, bounds.maxTextPreviewChars);
      break;
    case "VERIFICATION_REQUESTED":
      relations = {
        requestId: event.payload.verificationRequestId,
        ...(event.payload.sourceGenerationId === undefined
          ? {}
          : { generationId: event.payload.sourceGenerationId })
      };
      verification = {
        phase: "REQUESTED",
        verificationRequestId: event.payload.verificationRequestId,
        verifier: event.payload.verifier,
        evidenceKey: event.payload.evidenceKey,
        basis: event.payload.basis,
        candidateFormalInterpretationPersisted: true,
        interpretationConfidence: event.payload.interpretationConfidence,
        ...(event.payload.sourceGenerationId === undefined
          ? {}
          : { sourceGenerationId: event.payload.sourceGenerationId }),
        ...(event.payload.sourceProposalRequestId === undefined
          ? {}
          : { sourceProposalRequestId: event.payload.sourceProposalRequestId })
      };
      break;
    case "VERIFICATION_RESULT_ACCEPTED":
      relations = { requestId: event.payload.verificationRequestId };
      verification = {
        phase: "ACCEPTED",
        verificationRequestId: event.payload.verificationRequestId,
        verifier: event.payload.result.verifier,
        interpretationConfidence: event.payload.result.interpretationConfidence,
        resultStatus: event.payload.result.status
      };
      break;
    case "VERIFICATION_RESULT_DISCARDED":
      relations = { requestId: event.payload.verificationRequestId };
      verification = {
        phase: "DISCARDED",
        verificationRequestId: event.payload.verificationRequestId,
        reason: previewText(event.payload.reason, bounds.maxTextPreviewChars)
      };
      break;
    case "EVIDENCE_PROPOSED":
      // Provider-proposed evidence is not authoritative student evidence. Keep only
      // event provenance in replay; a committed STUDENT_EVIDENCE_UPDATED event
      // carries the inspectable evidence state if admission succeeded.
      break;
    case "STUDENT_EVIDENCE_UPDATED": {
      const supporting = takeBounded(
        event.payload.value.evidenceEventIds,
        bounds.maxProvenanceIds
      );
      evidence = {
        transition: "UPDATED",
        key: event.payload.key,
        value: event.payload.value.value,
        inferenceConfidence: event.payload.value.inferenceConfidence,
        supportingEventIds: supporting.values,
        supportingEventIdsTruncation: supporting.truncation,
        ...(event.payload.supersedesEventId === undefined
          ? {}
          : { supersedesEventId: event.payload.supersedesEventId })
      };
      break;
    }
    case "STUDENT_EVIDENCE_INVALIDATED":
      evidence = {
        transition: "INVALIDATED",
        key: event.payload.key,
        invalidatesEventId: event.payload.invalidatesEventId,
        reason: previewText(event.payload.reason, bounds.maxTextPreviewChars)
      };
      break;
    case "PEDAGOGICAL_ACTION_SELECTED":
      relations = { turnId: event.payload.turnId };
      policy = {
        requiredAction: event.payload.request.requiredAction,
        maximumDisclosure: event.payload.request.maximumDisclosure,
        targetPersisted: event.payload.request.target !== undefined
      };
      break;
    case "MODEL_GENERATION_STARTED":
      relations = {
        generationId: event.payload.generationId,
        turnId: event.payload.basis.turnId,
        ...(event.payload.basis.inputEpisodeId === undefined
          ? {}
          : { inputEpisodeId: event.payload.basis.inputEpisodeId })
      };
      generation = {
        generationId: event.payload.generationId,
        phase: "STARTED",
        provider: event.payload.provider,
        basis: event.payload.basis
      };
      break;
    case "GENERATION_CONTEXT_COMPILED":
      relations = {
        generationId: event.payload.generationId,
        turnId: event.payload.manifest.generationBasis.turnId
      };
      generation = {
        generationId: event.payload.generationId,
        phase: "CONTEXT_COMPILED",
        basis: event.payload.manifest.generationBasis,
        contextManifest: {
          compilerVersion: event.payload.manifest.compilerVersion,
          problemId: event.payload.manifest.problemId,
          problemVersion: event.payload.manifest.problemVersion,
          contextSha256: event.payload.manifest.contextSha256,
          reasoningGraphSha256: event.payload.manifest.reasoningGraphSha256
        }
      };
      break;
    case "MODEL_PROPOSAL_RECEIVED":
      relations = { generationId: event.payload.generationId };
      generation = {
        generationId: event.payload.generationId,
        phase: "PROPOSAL_RECEIVED",
        realizedAction: event.payload.proposal.realizedAction,
        claimedDisclosureLevel: event.payload.proposal.claimedDisclosureLevel,
        claimedDisclosureIdCount: event.payload.proposal.claimedDisclosureIds.length,
        proposalTextPersisted: event.payload.proposal.speechText !== undefined,
        proposalBoardActionCount: event.payload.proposal.boardActions?.length ?? 0
      };
      break;
    case "FORMAL_INTERPRETATION_PROPOSAL_RECEIVED":
      relations = {
        generationId: event.payload.generationId,
        requestId: event.payload.proposalRequestId
      };
      generation = {
        generationId: event.payload.generationId,
        phase: "FORMAL_INTERPRETATION_RECEIVED",
        formalInterpretationPersisted: true
      };
      break;
    case "FORMAL_INTERPRETATION_PROPOSAL_REJECTED":
      relations = { generationId: event.payload.generationId };
      generation = {
        generationId: event.payload.generationId,
        phase: "FORMAL_INTERPRETATION_REJECTED",
        reason: previewText(event.payload.reason, bounds.maxTextPreviewChars)
      };
      break;
    case "MODEL_GENERATION_SUPERSEDED":
      relations = { generationId: event.payload.generationId };
      generation = {
        generationId: event.payload.generationId,
        phase: "SUPERSEDED",
        reason: previewText(event.payload.reason, bounds.maxTextPreviewChars)
      };
      break;
    case "PROPOSAL_VALIDATED":
      relations = { generationId: event.payload.generationId };
      generation = { generationId: event.payload.generationId, phase: "VALIDATED" };
      break;
    case "PROPOSAL_REJECTED":
      relations = { generationId: event.payload.generationId };
      generation = {
        generationId: event.payload.generationId,
        phase: "REJECTED",
        reason: previewText(event.payload.reason, bounds.maxTextPreviewChars)
      };
      break;
    case "DELIVERY_QUEUED":
      queuedAtoms.set(event.payload.atom.deliveryId, event.payload.atom);
      relations = {
        deliveryId: event.payload.atom.deliveryId,
        generationId: event.payload.atom.generationId
      };
      delivery = deliveryDetail(event.payload.atom, "QUEUED", bounds);
      break;
    case "DELIVERY_STARTED":
    case "DELIVERY_EXPOSED":
    case "DELIVERY_COMPLETED":
    case "DELIVERY_CANCELLED":
    case "DELIVERY_POSSIBLY_EXPOSED": {
      const atom = queuedAtoms.get(event.payload.deliveryId);
      relations = { deliveryId: event.payload.deliveryId };
      if (atom !== undefined) {
        relations = {
          deliveryId: event.payload.deliveryId,
          generationId: atom.generationId
        };
        const status: DeliveryStatus = event.type === "DELIVERY_STARTED"
          ? "DELIVERING"
          : event.type === "DELIVERY_EXPOSED"
            ? "EXPOSED"
            : event.type === "DELIVERY_COMPLETED"
              ? "COMPLETED"
              : event.type === "DELIVERY_CANCELLED"
                ? "CANCELLED"
                : "POSSIBLY_EXPOSED";
        delivery = deliveryDetail(atom, status, bounds);
      }
      // Cancellation/uncertainty reasons are application-internal free text and
      // may accidentally contain protected realization content. Their existence is
      // represented by the authoritative event itself; do not render the reason.
      break;
    }
    case "POLICY_REVISION_CHANGED":
      text = previewText(event.payload.reason, bounds.maxTextPreviewChars);
      revisions = {
        policyRevision: event.payload.policyRevision,
        contextEpoch: event.payload.contextEpoch
      };
      break;
    case "PROBLEM_STATE_REVISION_CHANGED":
      text = previewText(event.payload.reason, bounds.maxTextPreviewChars);
      revisions = {
        problemStateRevision: event.payload.problemStateRevision,
        contextEpoch: event.payload.contextEpoch
      };
      break;
    case "SESSION_COMPLETED":
      if (event.payload.summary !== undefined) {
        text = previewText(event.payload.summary, bounds.maxTextPreviewChars);
      }
      break;
    case "SESSION_ARCHIVED":
      if (event.payload.reason !== undefined) {
        text = previewText(event.payload.reason, bounds.maxTextPreviewChars);
      }
      break;
    case "SESSION_RESUMED":
      break;
    default:
      assertNever(event);
  }

  return {
    kind: event.type,
    summary: summaryFor(event.type),
    stateValidation,
    provenance: item.provenance,
    relations,
    ...(text === undefined ? {} : { text }),
    ...(delivery === undefined ? {} : { delivery }),
    ...(generation === undefined ? {} : { generation }),
    ...(evidence === undefined ? {} : { evidence }),
    ...(verification === undefined ? {} : { verification }),
    ...(policy === undefined ? {} : { policy }),
    ...(revisions === undefined ? {} : { revisions }),
    ...(quantResearch === undefined ? {} : { quantResearch })
  };
}

export function projectReplayTimeline(
  rawEvents: readonly unknown[],
  options: ReplayTimelineOptions = {}
): ReplayTimelineProjection {
  let bounds: ReplayBounds;
  try {
    bounds = resolveReplayBounds(options.bounds);
  } catch {
    throw new RangeError("Invalid replay bounds");
  }
  const normalized = normalizeReplayEvents(rawEvents, bounds);
  return projectReplayTimelineFromNormalized(normalized, bounds);
}

export function projectReplayTimelineFromNormalized(
  normalized: NormalizedReplayHistory,
  bounds: ReplayBounds,
  knownPrefixAlreadyValidated = false
): ReplayTimelineProjection {
  const firstSpecialized = normalized.events.find((item) =>
    item.event !== undefined
    && requiresSpecializedReplayValidation(item.event.type)
    && (
      normalized.firstUnknownSequence === undefined
      || item.metadata.sequence < normalized.firstUnknownSequence
    )
  );
  const specializedBoundarySequence = firstSpecialized?.metadata.sequence;
  const semanticBoundarySequence = normalized.firstUnknownSequence;
  const validatedItems = normalized.events.filter((item) =>
    semanticBoundarySequence === undefined
      ? item.event !== undefined
      : item.metadata.sequence < semanticBoundarySequence && item.event !== undefined
  );
  const validatedEvents = validatedItems.map((item) => {
    if (item.event === undefined) {
      throw new ReplayProjectionError("INVALID_EVENT_SEMANTICS");
    }
    return item.event;
  });

  if (
    !knownPrefixAlreadyValidated
    && normalized.sessionId !== null
    && validatedEvents.length > 0
  ) {
    validateKnownReplayPrefix(normalized.sessionId, validatedEvents, {
      completeHistory:
        !normalized.eventTruncation.truncated
        && !normalized.hasUnknownEvents
    });
  }

  const timelineSelected = normalized.events.slice(0, bounds.maxTimelineEntries);
  const queuedAtoms = new Map<string, DeliveryAtom>();
  const issues: ReplayProjectionIssue[] = [];
  const entries: ReplayTimelineEntry[] = [];

  if (normalized.eventTruncation.truncated) {
    issues.push({ code: "EVENT_LIMIT_REACHED" });
  }
  if (normalized.events.length > bounds.maxTimelineEntries) {
    issues.push({ code: "TIMELINE_LIMIT_REACHED" });
  }
  if (
    normalized.sessionId === null
    || normalized.eventTruncation.truncated
    || normalized.hasUnknownEvents
    || specializedBoundarySequence !== undefined
  ) {
    issues.push({ code: "CURRENT_STATE_UNAVAILABLE" });
  }

  const firstUnknown = normalized.events.find((item) => item.event === undefined);
  if (firstUnknown !== undefined) {
    issues.push({
      code: "UNKNOWN_EVENT_SEMANTICS",
      sequence: firstUnknown.metadata.sequence,
      eventType: firstUnknown.metadata.type
    });
  }

  if (firstSpecialized?.event !== undefined) {
    issues.push({
      code: "SPECIALIZED_DOMAIN_VALIDATION_REQUIRED",
      sequence: firstSpecialized.metadata.sequence,
      eventType: firstSpecialized.event.type
    });
  }

  for (const item of timelineSelected) {
    if (item.event === undefined) {
      entries.push({
        kind: "UNKNOWN_EVENT",
        summary: "Unknown authoritative event; payload intentionally withheld",
        stateValidation: "UNKNOWN_EVENT",
        provenance: item.provenance,
        relations: {},
        unknown: {
          eventType: item.metadata.type,
          schemaVersion: item.metadata.schemaVersion
        }
      });
      continue;
    }

    if (
      semanticBoundarySequence !== undefined
      && item.metadata.sequence > semanticBoundarySequence
    ) {
      entries.push({
        kind: item.event.type,
        summary: "Known event after unknown semantic boundary; payload intentionally withheld",
        stateValidation: "UNAVAILABLE_AFTER_UNKNOWN",
        provenance: item.provenance,
        relations: {}
      });
      continue;
    }

    const stateValidation =
      specializedBoundarySequence !== undefined
      && item.metadata.sequence >= specializedBoundarySequence
        ? "SPECIALIZED_DOMAIN_UNVERIFIED"
        : "VALIDATED";
    entries.push(entryForKnownEvent(item, queuedAtoms, bounds, stateValidation));
  }

  const timelineTruncation = truncationInfo(normalized.events.length, bounds.maxTimelineEntries);
  return {
    sessionId: normalized.sessionId,
    totalEventCount: normalized.totalEventCount,
    entries,
    eventTruncation: normalized.eventTruncation,
    timelineTruncation,
    complete:
      normalized.sessionId !== null
      && !normalized.eventTruncation.truncated
      && !timelineTruncation.truncated
      && !normalized.hasUnknownEvents
      && specializedBoundarySequence === undefined,
    issues,
    bounds
  };
}
