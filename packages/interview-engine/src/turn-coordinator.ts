import {
  BoardRevisionSchema,
  BoardObservationSchema,
  CommandEnvelopeSchema,
  CommandIdentityValueSchema,
  ContextEpochSchema,
  DeliveryAtomSchema,
  GenerationBasisSchema,
  GenerationIdSchema,
  InputEpisodeIdSchema,
  InterviewerProposalSchema,
  EvidenceProposalSchema,
  EvidenceKeySchema,
  EvidenceValueSchema,
  RequestIdSchema,
  RealizationRequestSchema,
  TranscriptRevisionSchema,
  TurnIdSchema,
  UtteranceIdSchema,
  evidenceKeyToString,
  isEvidenceValueAllowed,
  newDeliveryId,
  newGenerationId,
  newInputEpisodeId,
  newRequestId,
  newTurnId,
  newUtteranceId,
  type BoardObservation,
  type BoardRevision,
  type CommandEnvelope,
  type CommandIdentityValue,
  type DeliveryAtom,
  type GenerationBasis,
  type GenerationId,
  type InputEpisodeId,
  type InterviewProblem,
  type InterviewerProposal,
  type EvidenceProposal,
  type RealizationRequest,
  type RequestId,
  type TranscriptRevision,
  type TurnId
  ,type UtteranceId
} from "../../domain/src/index.js";
import type { EventDraft } from "../../events/src/index.js";
import { z } from "zod";
import { createCommandEnvelope } from "./envelopes.js";
import { createProviderContextSpecFingerprint } from "./context-compiler.js";
import { isGenerationBasisStillCompatible } from "./compatibility.js";
import { assessVisionFreshness } from "./vision-freshness.js";
import { selectPedagogicalAction } from "./pedagogical-policy.js";
import type { DisclosureValidator } from "./disclosure-validator.js";
import type { SessionWriter } from "./session-writer.js";

const StartedResultSchema = z.object({ started: z.literal(true) }).strict();
const InputCommittedResultSchema = z.object({ inputEpisodeId: InputEpisodeIdSchema, turnId: TurnIdSchema }).strict();
const GenerationStartedResultSchema = z.object({ generationId: GenerationIdSchema, basis: GenerationBasisSchema }).strict();
const CommittedResultSchema = z.object({ committed: z.literal(true) }).strict();
const SupersededResultSchema = z.object({ superseded: z.literal(true) }).strict();
const CorrectedResultSchema = z.object({ corrected: z.literal(true) }).strict();
const UtteranceStartedResultSchema = z.object({ utteranceId: UtteranceIdSchema }).strict();
const UtteranceDiscardedResultSchema = z.object({ discarded: z.literal(true) }).strict();
const UtteranceFinalizedResultSchema = z.object({ inputEpisodeId: InputEpisodeIdSchema, transcriptRevision: TranscriptRevisionSchema }).strict();
const InputAppendedResultSchema = z.object({ appended: z.literal(true) }).strict();
const BoardInputAppendedResultSchema = z.object({ appended: z.literal(true), boardRevision: BoardRevisionSchema }).strict();
const VisionRequestedResultSchema = z.object({ visionRequestId: RequestIdSchema, sourceBoardRevision: BoardRevisionSchema }).strict();
const VisionProcessedResultSchema = z.object({ accepted: z.boolean(), reason: z.string().min(1).optional() }).strict();
const EvidenceProcessedResultSchema = z.object({ committed: z.boolean(), key: z.string().min(1), reason: z.string().min(1).optional() }).strict();
export const ProcessProposalResultSchema = z.object({
  accepted: z.boolean(),
  deliveryAtoms: z.array(DeliveryAtomSchema),
  reason: z.string().min(1).optional()
}).strict();
export type ProcessProposalResult = z.infer<typeof ProcessProposalResultSchema>;

function commandIdentityValue(value: unknown): CommandIdentityValue {
  return CommandIdentityValueSchema.parse(JSON.parse(JSON.stringify(value)));
}

export class TurnCoordinator {
  public constructor(private readonly writer: SessionWriter) {}

  public async startSession(problem: InterviewProblem, commandEnvelope?: CommandEnvelope): Promise<void> {
    const providerContextSpecSha256 = await createProviderContextSpecFingerprint(problem);
    const envelope = CommandEnvelopeSchema.parse(commandEnvelope ?? createCommandEnvelope({ sessionId: this.writer.sessionId, producer: "application" }));
    await this.writer.execute(envelope, {
      operation: "START_SESSION",
      payload: { problemId: problem.id, problemVersion: problem.version, prompt: problem.public.prompt, providerContextSpecSha256 }
    }, StartedResultSchema, (state) => {
      if (state.started) throw new Error("Session already started");
      return {
        drafts: [
          { source: "APPLICATION", type: "SESSION_STARTED", payload: { startedAt: new Date().toISOString() } },
          {
            source: "APPLICATION",
            type: "PROBLEM_PRESENTED",
            payload: { problemId: problem.id, problemVersion: problem.version, prompt: problem.public.prompt, providerContextSpecSha256 }
          }
        ],
        result: { started: true }
      };
    });
  }

  public async commitInput(studentText: string, commandEnvelope?: CommandEnvelope): Promise<{ inputEpisodeId: InputEpisodeId; turnId: TurnId }> {
    const inputEpisodeId = newInputEpisodeId();
    const turnId = newTurnId();
    const envelope = CommandEnvelopeSchema.parse(commandEnvelope ?? createCommandEnvelope({ sessionId: this.writer.sessionId, producer: "synthetic-user", inputEpisodeId, turnId }));
    const result = await this.writer.execute(envelope, {
      operation: "COMMIT_SYNTHETIC_INPUT",
      payload: { studentText }
    }, InputCommittedResultSchema, () => ({
      drafts: [
        { source: "USER", type: "INPUT_EPISODE_STARTED", payload: { inputEpisodeId } },
        { source: "USER", type: "INPUT_EPISODE_UPDATED", payload: { inputEpisodeId, modality: "TYPING", semanticContent: studentText } },
        { source: "APPLICATION", type: "INPUT_EPISODE_COMMITTED", payload: { inputEpisodeId } },
        { source: "APPLICATION", type: "TURN_COMMITTED", payload: { turnId, inputEpisodeId, studentText } }
      ],
      result: { inputEpisodeId, turnId }
    }));
    return result.value;
  }

  public async beginUtterance(): Promise<UtteranceId> {
    const utteranceId = newUtteranceId();
    const envelope = createCommandEnvelope({ sessionId: this.writer.sessionId, producer: "vad", correlationId: newRequestId() });
    const result = await this.writer.execute(envelope, {
      operation: "BEGIN_UTTERANCE",
      payload: {}
    }, UtteranceStartedResultSchema, (state) => {
      const invalidations: EventDraft[] = [];
      for (const generation of Object.values(state.generations)) {
        if (generation.status === "ACTIVE") {
          invalidations.push({ source: "APPLICATION", type: "MODEL_GENERATION_SUPERSEDED", payload: { generationId: generation.generationId, reason: "Speech onset" } });
        }
      }
      for (const atom of Object.values(state.deliveries)) {
        if (atom.status === "QUEUED") {
          invalidations.push({ source: "APPLICATION", type: "DELIVERY_CANCELLED", payload: { deliveryId: atom.deliveryId, reason: "Speech onset before exposure" } });
        } else if (atom.status === "DELIVERING") {
          invalidations.push({ source: "APPLICATION", type: "DELIVERY_POSSIBLY_EXPOSED", payload: { deliveryId: atom.deliveryId, reason: "Speech onset while physical exposure was unacknowledged" } });
        }
      }
      return {
        drafts: [{ source: "USER", type: "UTTERANCE_STARTED", payload: { utteranceId } }, ...invalidations],
        result: { utteranceId }
      };
    });
    return result.value.utteranceId;
  }

  public async discardUtterance(utteranceId: UtteranceId, reason: string): Promise<void> {
    const envelope = createCommandEnvelope({ sessionId: this.writer.sessionId, producer: "vad", correlationId: newRequestId() });
    await this.writer.execute(envelope, {
      operation: "DISCARD_UTTERANCE",
      payload: { utteranceId, reason }
    }, UtteranceDiscardedResultSchema, (state) => {
      const utterance = state.utterances[utteranceId];
      if (utterance === undefined || utterance.status !== "CAPTURING") throw new Error("Utterance is not being captured");
      return { drafts: [{ source: "USER", type: "UTTERANCE_DISCARDED", payload: { utteranceId, reason } }], result: { discarded: true } };
    });
  }

  public async finalizeUtterance(input: {
    readonly utteranceId: UtteranceId;
    readonly text: string;
    readonly inputEpisodeId?: InputEpisodeId;
  }): Promise<{ inputEpisodeId: InputEpisodeId; transcriptRevision: TranscriptRevision }> {
    const inputEpisodeId = input.inputEpisodeId ?? newInputEpisodeId();
    const startsEpisode = input.inputEpisodeId === undefined;
    const envelope = createCommandEnvelope({ sessionId: this.writer.sessionId, producer: "stt", inputEpisodeId });
    const result = await this.writer.execute(envelope, {
      operation: "FINALIZE_UTTERANCE",
      payload: { utteranceId: input.utteranceId, text: input.text, inputEpisodeId, startsEpisode }
    }, UtteranceFinalizedResultSchema, (state) => {
      const utterance = state.utterances[input.utteranceId];
      if (utterance === undefined || utterance.status !== "CAPTURING") throw new Error("Utterance is not being captured");
      if (!startsEpisode) {
        const episode = state.inputEpisodes[inputEpisodeId];
        if (episode === undefined || episode.status !== "ACTIVE") throw new Error("Input episode is not active");
      }
      const transcriptRevision = TranscriptRevisionSchema.parse(state.transcriptRevision + 1);
      const drafts: EventDraft[] = [
        ...(startsEpisode ? [{ source: "APPLICATION", type: "INPUT_EPISODE_STARTED", payload: { inputEpisodeId } } as const] : []),
        { source: "WORKER", type: "TRANSCRIPT_FINALIZED", payload: { utteranceId: input.utteranceId, inputEpisodeId, transcriptRevision, text: input.text } },
        { source: "APPLICATION", type: "INPUT_EPISODE_UPDATED", payload: { inputEpisodeId, modality: "SPEECH", semanticContent: input.text } }
      ];
      return { drafts, result: { inputEpisodeId, transcriptRevision } };
    });
    return result.value;
  }

  public async appendTypedInput(inputEpisodeId: InputEpisodeId, text: string): Promise<void> {
    const envelope = createCommandEnvelope({ sessionId: this.writer.sessionId, producer: "typed-input", inputEpisodeId });
    await this.writer.execute(envelope, {
      operation: "APPEND_TYPED_INPUT",
      payload: { inputEpisodeId, text }
    }, InputAppendedResultSchema, (state) => {
      const episode = state.inputEpisodes[inputEpisodeId];
      if (episode === undefined || episode.status !== "ACTIVE") throw new Error("Input episode is not active");
      return { drafts: [{ source: "USER", type: "INPUT_EPISODE_UPDATED", payload: { inputEpisodeId, modality: "TYPING", semanticContent: text } }], result: { appended: true } };
    });
  }

  public async appendBoardInput(inputEpisodeId: InputEpisodeId, summary: string): Promise<void> {
    const envelope = createCommandEnvelope({ sessionId: this.writer.sessionId, producer: "whiteboard", inputEpisodeId });
    await this.writer.execute(envelope, {
      operation: "APPEND_BOARD_INPUT",
      payload: { inputEpisodeId, summary }
    }, BoardInputAppendedResultSchema, (state) => {
      const episode = state.inputEpisodes[inputEpisodeId];
      if (episode === undefined || episode.status !== "ACTIVE") throw new Error("Input episode is not active");
      const boardRevision = BoardRevisionSchema.parse(state.boardRevision + 1);
      return {
        drafts: [
          { source: "USER", type: "BOARD_PATCH_COMMITTED", payload: { boardRevision, summary } },
          { source: "USER", type: "INPUT_EPISODE_UPDATED", payload: { inputEpisodeId, modality: "WHITEBOARD", semanticContent: summary } }
        ],
        result: { appended: true, boardRevision }
      };
    });
  }

  public async commitInputEpisode(inputEpisodeId: InputEpisodeId): Promise<TurnId> {
    const turnId = newTurnId();
    const envelope = createCommandEnvelope({ sessionId: this.writer.sessionId, producer: "turn-coordinator", inputEpisodeId, turnId });
    const result = await this.writer.execute(envelope, {
      operation: "COMMIT_INPUT_EPISODE",
      payload: { inputEpisodeId }
    }, InputCommittedResultSchema, (state) => {
      const episode = state.inputEpisodes[inputEpisodeId];
      if (episode === undefined || episode.status !== "ACTIVE" || episode.inputs.length === 0) throw new Error("Input episode is not ready to commit");
      const studentText = episode.inputs.map((item) => item.semanticContent).join(" ");
      return {
        drafts: [
          { source: "APPLICATION", type: "INPUT_EPISODE_COMMITTED", payload: { inputEpisodeId } },
          { source: "APPLICATION", type: "TURN_COMMITTED", payload: { turnId, inputEpisodeId, studentText } }
        ],
        result: { inputEpisodeId, turnId }
      };
    });
    return result.value.turnId;
  }

  public async requestVision(regionId: string, relevantShapeIds: readonly string[]): Promise<{ visionRequestId: RequestId; sourceBoardRevision: BoardRevision }> {
    const visionRequestId = newRequestId();
    const envelope = createCommandEnvelope({ sessionId: this.writer.sessionId, producer: "vision-coordinator", correlationId: visionRequestId });
    const result = await this.writer.execute(envelope, {
      operation: "REQUEST_VISION",
      payload: { regionId, relevantShapeIds: [...relevantShapeIds] }
    }, VisionRequestedResultSchema, (state) => ({
      drafts: [{ source: "APPLICATION", type: "VISION_REQUESTED", payload: { visionRequestId, sourceBoardRevision: state.boardRevision, regionId, relevantShapeIds: [...relevantShapeIds] } }],
      result: { visionRequestId, sourceBoardRevision: state.boardRevision }
    }));
    return result.value;
  }

  public async processVisionResult(input: { readonly envelope: CommandEnvelope; readonly observation: BoardObservation }): Promise<z.infer<typeof VisionProcessedResultSchema>> {
    const envelope = CommandEnvelopeSchema.parse(input.envelope);
    const observation = BoardObservationSchema.parse(input.observation);
    const visionRequestId = envelope.correlationId;
    const result = await this.writer.execute(envelope, {
      operation: "PROCESS_VISION_RESULT",
      payload: { observation }
    }, VisionProcessedResultSchema, (state) => {
      const request = state.visionRequests[visionRequestId];
      if (request === undefined || request.status !== "PENDING") return { drafts: [], result: { accepted: false, reason: "Vision request is not pending" } };
      const sameDependencySet = request.regionId === observation.regionId
        && request.relevantShapeIds.length === observation.relevantShapeIds.length
        && request.relevantShapeIds.every((shapeId) => observation.relevantShapeIds.includes(shapeId));
      const freshness = assessVisionFreshness(observation, state);
      const sourceMatches = envelope.sourceRevision === request.sourceBoardRevision && observation.sourceBoardRevision === request.sourceBoardRevision;
      if (freshness !== "FRESH" || !sourceMatches || !sameDependencySet) {
        const reason = `Vision result rejected: freshness=${freshness}, sourceMatches=${String(sourceMatches)}, dependenciesMatch=${String(sameDependencySet)}`;
        return { drafts: [{ source: "APPLICATION", type: "VISION_RESULT_DISCARDED", payload: { visionRequestId, reason } }], result: { accepted: false, reason } };
      }
      return { drafts: [{ source: "WORKER", type: "VISION_RESULT_ACCEPTED", payload: { visionRequestId, observation } }], result: { accepted: true } };
    });
    return result.value;
  }

  public async processEvidenceProposal(input: { readonly envelope: CommandEnvelope; readonly proposal: EvidenceProposal }): Promise<z.infer<typeof EvidenceProcessedResultSchema>> {
    const envelope = CommandEnvelopeSchema.parse(input.envelope);
    const proposal = EvidenceProposalSchema.parse(input.proposal);
    const key = evidenceKeyToString(proposal.key);
    const result = await this.writer.execute(envelope, {
      operation: "PROCESS_EVIDENCE_PROPOSAL",
      payload: { proposal }
    }, EvidenceProcessedResultSchema, (state) => {
      const reasons: string[] = [];
      if (state.problem?.id !== proposal.key.problemId) reasons.push("Evidence is scoped to a different problem");
      if (!proposal.evidenceEventIds.every((eventId) => state.eventIds.includes(eventId))) reasons.push("Evidence provenance references unknown events");
      if (proposal.inferenceConfidence < 0.7) reasons.push("Inference confidence is below the Phase 0 commit threshold");
      if (!isEvidenceValueAllowed(proposal.key, proposal.proposedValue)) reasons.push("Evidence value is invalid for its dimension");
      const proposedDraft: EventDraft = { source: "PROVIDER", type: "EVIDENCE_PROPOSED", payload: { proposal } };
      if (reasons.length > 0) return { drafts: [proposedDraft], result: { committed: false, key, reason: reasons.join("; ") } };
      const value = EvidenceValueSchema.parse({
        value: proposal.proposedValue,
        inferenceConfidence: proposal.inferenceConfidence,
        evidenceEventIds: proposal.evidenceEventIds,
        lastUpdatedSequence: state.sequence + 2
      });
      const activeEvidence = state.evidenceHistory[key]?.find((record) => record.status === "ACTIVE");
      return {
        drafts: [proposedDraft, {
          source: "APPLICATION",
          type: "STUDENT_EVIDENCE_UPDATED",
          payload: {
            key: EvidenceKeySchema.parse(proposal.key),
            value,
            ...(activeEvidence === undefined ? {} : { supersedesEventId: activeEvidence.evidenceEventId })
          }
        }],
        result: { committed: true, key }
      };
    });
    return result.value;
  }

  public async selectAction(turnId: TurnId): Promise<RealizationRequest> {
    const envelope = createCommandEnvelope({ sessionId: this.writer.sessionId, producer: "pedagogical-policy", turnId });
    const result = await this.writer.execute(envelope, {
      operation: "SELECT_PEDAGOGICAL_ACTION",
      payload: { turnId }
    }, RealizationRequestSchema, (state) => {
      const request = selectPedagogicalAction(state, turnId);
      return { drafts: [{ source: "APPLICATION", type: "PEDAGOGICAL_ACTION_SELECTED", payload: { turnId, request } }], result: request };
    });
    return result.value;
  }

  public async startGeneration(inputEpisodeId: InputEpisodeId, turnId: TurnId, provider: string): Promise<{ generationId: GenerationId; basis: GenerationBasis }> {
    const generationId = newGenerationId();
    const envelope = createCommandEnvelope({ sessionId: this.writer.sessionId, producer: "turn-coordinator", inputEpisodeId, turnId, generationId });
    const result = await this.writer.execute(envelope, {
      operation: "START_GENERATION",
      payload: { inputEpisodeId, turnId, provider }
    }, GenerationStartedResultSchema, (state) => {
      if (state.lastCommittedInputSequence === undefined) throw new Error("No committed input exists");
      const basis: GenerationBasis = {
        contextEpoch: state.contextEpoch,
        committedInputSequence: state.lastCommittedInputSequence,
        transcriptRevision: state.transcriptRevision,
        boardRevision: state.boardRevision,
        problemStateRevision: state.problemStateRevision,
        policyRevision: state.policyRevision,
        inputEpisodeId,
        turnId
      };
      return { drafts: [{ source: "APPLICATION", type: "MODEL_GENERATION_STARTED", payload: { generationId, basis, provider } }], result: { generationId, basis } };
    });
    return result.value;
  }

  public async processProposal(input: {
    readonly envelope: CommandEnvelope;
    readonly problem: InterviewProblem;
    readonly proposal: InterviewerProposal;
    readonly validator: DisclosureValidator;
  }): Promise<ProcessProposalResult> {
    const envelope = CommandEnvelopeSchema.parse(input.envelope);
    const proposal = InterviewerProposalSchema.parse(input.proposal);
    const generationId = envelope.generationId;
    if (generationId === undefined) throw new Error("Provider result envelope is missing generationId");
    const providerContextSpecSha256 = await createProviderContextSpecFingerprint(input.problem);
    const outcome = await this.writer.execute(envelope, {
      operation: "PROCESS_INTERVIEWER_PROPOSAL",
      payload: {
        problemId: input.problem.id,
        problemVersion: input.problem.version,
        providerContextSpecSha256,
        protectedDisclosures: input.problem.interviewer.protectedDisclosures,
        proposal: commandIdentityValue(proposal)
      }
    }, ProcessProposalResultSchema, (state) => {
      const generation = state.generations[generationId];
      if (generation === undefined) return { drafts: [], result: { accepted: false, deliveryAtoms: [], reason: "Unknown generation" } };
      if (generation.status !== "ACTIVE") return { drafts: [], result: { accepted: false, deliveryAtoms: [], reason: "Generation is not active" } };
      if (state.problem?.providerContextSpecSha256 === undefined) {
        return rejectDrafts(generationId, proposal, "Problem definition provenance is unavailable");
      }
      if (state.problem.providerContextSpecSha256 !== providerContextSpecSha256) {
        return rejectDrafts(generationId, proposal, "Problem definition does not match the session-bound provider context contract");
      }
      const compatibility = isGenerationBasisStillCompatible(generation.basis, state);
      if (compatibility !== "COMPATIBLE") {
        return {
          drafts: [
            { source: "PROVIDER", type: "MODEL_PROPOSAL_RECEIVED", payload: { generationId, proposal } },
            { source: "APPLICATION", type: "PROPOSAL_REJECTED", payload: { generationId, reason: `Generation compatibility is ${compatibility}` } },
            { source: "APPLICATION", type: "MODEL_GENERATION_SUPERSEDED", payload: { generationId, reason: `Generation compatibility is ${compatibility}` } }
          ],
          result: { accepted: false, deliveryAtoms: [], reason: `Generation compatibility is ${compatibility}` }
        };
      }
      const request = state.pedagogicalActions[generation.basis.turnId];
      if (request === undefined) return rejectDrafts(generationId, proposal, "No application-selected pedagogical action");
      const validation = input.validator.validate({ proposal, request, protectedDisclosures: input.problem.interviewer.protectedDisclosures });
      if (!validation.accepted) return rejectDrafts(generationId, proposal, validation.reason);
      const atoms: DeliveryAtom[] = [];
      if (proposal.speechText !== undefined) {
        atoms.push(DeliveryAtomSchema.parse({
          deliveryId: newDeliveryId(), generationId,
          content: { medium: "TEXT", text: proposal.speechText },
          disclosureIds: validation.analysis.effectiveDisclosureIds,
          effectiveDisclosureLevel: validation.analysis.effectiveDisclosureLevel,
          status: "VALIDATED"
        }));
      }
      for (const action of proposal.boardActions ?? []) {
        atoms.push(DeliveryAtomSchema.parse({
          deliveryId: newDeliveryId(), generationId,
          content: { medium: "WHITEBOARD", action },
          disclosureIds: validation.analysis.effectiveDisclosureIds,
          effectiveDisclosureLevel: validation.analysis.effectiveDisclosureLevel,
          status: "VALIDATED"
        }));
      }
      const drafts: EventDraft[] = [
        { source: "PROVIDER", type: "MODEL_PROPOSAL_RECEIVED", payload: { generationId, proposal } },
        { source: "APPLICATION", type: "PROPOSAL_VALIDATED", payload: { generationId, analysis: validation.analysis } },
        ...atoms.map((atom): EventDraft => ({ source: "APPLICATION", type: "DELIVERY_QUEUED", payload: { atom } }))
      ];
      return { drafts, result: { accepted: true, deliveryAtoms: atoms } };
    });
    return outcome.value;
  }

  public async commitBoardPatch(summary: string): Promise<void> {
    const envelope = createCommandEnvelope({ sessionId: this.writer.sessionId, producer: "whiteboard" });
    await this.writer.execute(envelope, {
      operation: "COMMIT_BOARD_PATCH",
      payload: { summary }
    }, CommittedResultSchema, (state) => ({
      drafts: [{ source: "USER", type: "BOARD_PATCH_COMMITTED", payload: { boardRevision: BoardRevisionSchema.parse(state.boardRevision + 1), summary } }],
      result: { committed: true }
    }));
  }

  public async supersedeGeneration(generationId: GenerationId, reason: string): Promise<void> {
    const envelope = createCommandEnvelope({ sessionId: this.writer.sessionId, producer: "turn-coordinator", generationId });
    await this.writer.execute(envelope, {
      operation: "SUPERSEDE_GENERATION",
      payload: { generationId, reason }
    }, SupersededResultSchema, (state) => {
      const generation = state.generations[generationId];
      if (generation === undefined) throw new Error("Unknown generation");
      if (generation.status === "SUPERSEDED") return { drafts: [], result: { superseded: true } };
      if (generation.status !== "ACTIVE" && generation.status !== "PROPOSAL_RECEIVED" && generation.status !== "VALIDATED") {
        throw new Error(`Cannot supersede generation in ${generation.status}`);
      }
      return {
        drafts: [{ source: "APPLICATION", type: "MODEL_GENERATION_SUPERSEDED", payload: { generationId, reason } }],
        result: { superseded: true }
      };
    });
  }

  public async correctTranscript(correctedText: string): Promise<void> {
    const envelope = createCommandEnvelope({ sessionId: this.writer.sessionId, producer: "transcript-correction" });
    await this.writer.execute(envelope, {
      operation: "CORRECT_TRANSCRIPT",
      payload: { correctedText }
    }, CorrectedResultSchema, (state) => {
      const invalidations: EventDraft[] = Object.values(state.evidenceHistory)
        .flatMap((records) => records.filter((record) => record.status === "ACTIVE"))
        .map((record): EventDraft => ({
          source: "APPLICATION",
          type: "STUDENT_EVIDENCE_INVALIDATED",
          payload: {
            key: record.key,
            invalidatesEventId: record.evidenceEventId,
            reason: "Transcript correction made the supporting interpretation stale"
          }
        }));
      return {
        drafts: [{ source: "APPLICATION", type: "TRANSCRIPT_CORRECTED", payload: {
          transcriptRevision: TranscriptRevisionSchema.parse(state.transcriptRevision + 1),
          contextEpoch: ContextEpochSchema.parse(state.contextEpoch + 1),
          correctedText
        } }, ...invalidations],
        result: { corrected: true }
      };
    });
  }
}

function rejectDrafts(generationId: GenerationId, proposal: InterviewerProposal, reason: string): { readonly drafts: readonly EventDraft[]; readonly result: ProcessProposalResult } {
  return {
    drafts: [
      { source: "PROVIDER", type: "MODEL_PROPOSAL_RECEIVED", payload: { generationId, proposal } },
      { source: "APPLICATION", type: "PROPOSAL_REJECTED", payload: { generationId, reason } }
    ],
    result: { accepted: false, deliveryAtoms: [], reason }
  };
}
