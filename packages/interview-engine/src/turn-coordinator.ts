import {
  BoardRevisionSchema,
  ContextEpochSchema,
  DeliveryAtomSchema,
  InterviewerProposalSchema,
  TranscriptRevisionSchema,
  newDeliveryId,
  newGenerationId,
  newInputEpisodeId,
  newTurnId,
  type CommandEnvelope,
  type DeliveryAtom,
  type GenerationBasis,
  type GenerationId,
  type InputEpisodeId,
  type InterviewProblem,
  type InterviewerProposal,
  type RealizationRequest,
  type TurnId
} from "../../domain/src/index.js";
import type { EventDraft } from "../../events/src/index.js";
import { createCommandEnvelope } from "./envelopes.js";
import { isGenerationBasisStillCompatible } from "./compatibility.js";
import { selectPedagogicalAction } from "./pedagogical-policy.js";
import type { DisclosureValidator } from "./disclosure-validator.js";
import type { SessionWriter } from "./session-writer.js";

export interface ProcessProposalResult {
  readonly accepted: boolean;
  readonly deliveryAtoms: readonly DeliveryAtom[];
  readonly reason?: string;
}

export class TurnCoordinator {
  public constructor(private readonly writer: SessionWriter) {}

  public async startSession(problem: InterviewProblem): Promise<void> {
    const envelope = createCommandEnvelope({ sessionId: this.writer.sessionId, producer: "application" });
    await this.writer.execute(envelope, (state) => {
      if (state.started) throw new Error("Session already started");
      return {
        drafts: [
          { source: "APPLICATION", type: "SESSION_STARTED", payload: { startedAt: new Date().toISOString() } },
          { source: "APPLICATION", type: "PROBLEM_PRESENTED", payload: { problemId: problem.id, problemVersion: problem.version, prompt: problem.public.prompt } }
        ],
        result: { started: true }
      };
    });
  }

  public async commitInput(studentText: string): Promise<{ inputEpisodeId: InputEpisodeId; turnId: TurnId }> {
    const inputEpisodeId = newInputEpisodeId();
    const turnId = newTurnId();
    const envelope = createCommandEnvelope({ sessionId: this.writer.sessionId, producer: "synthetic-user", inputEpisodeId, turnId });
    const result = await this.writer.execute(envelope, () => ({
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

  public async selectAction(turnId: TurnId): Promise<RealizationRequest> {
    const envelope = createCommandEnvelope({ sessionId: this.writer.sessionId, producer: "pedagogical-policy", turnId });
    const result = await this.writer.execute(envelope, (state) => {
      const request = selectPedagogicalAction(state, turnId);
      return { drafts: [{ source: "APPLICATION", type: "PEDAGOGICAL_ACTION_SELECTED", payload: { turnId, request } }], result: request };
    });
    return result.value;
  }

  public async startGeneration(inputEpisodeId: InputEpisodeId, turnId: TurnId, provider: string): Promise<{ generationId: GenerationId; basis: GenerationBasis }> {
    const generationId = newGenerationId();
    const envelope = createCommandEnvelope({ sessionId: this.writer.sessionId, producer: "turn-coordinator", inputEpisodeId, turnId, generationId });
    const result = await this.writer.execute(envelope, (state) => {
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
    const proposal = InterviewerProposalSchema.parse(input.proposal);
    const generationId = input.envelope.generationId;
    if (generationId === undefined) throw new Error("Provider result envelope is missing generationId");
    const outcome = await this.writer.execute<ProcessProposalResult>(input.envelope, (state) => {
      const generation = state.generations[generationId];
      if (generation === undefined) return { drafts: [], result: { accepted: false, deliveryAtoms: [], reason: "Unknown generation" } };
      if (generation.status !== "ACTIVE") return { drafts: [], result: { accepted: false, deliveryAtoms: [], reason: "Generation is not active" } };
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
    await this.writer.execute(envelope, (state) => ({
      drafts: [{ source: "USER", type: "BOARD_PATCH_COMMITTED", payload: { boardRevision: BoardRevisionSchema.parse(state.boardRevision + 1), summary } }],
      result: { committed: true }
    }));
  }

  public async supersedeGeneration(generationId: GenerationId, reason: string): Promise<void> {
    const envelope = createCommandEnvelope({ sessionId: this.writer.sessionId, producer: "turn-coordinator", generationId });
    await this.writer.execute(envelope, (state) => {
      const generation = state.generations[generationId];
      if (generation === undefined) throw new Error("Unknown generation");
      if (generation.status === "SUPERSEDED") return { drafts: [], result: { superseded: true } };
      if (generation.status !== "ACTIVE") throw new Error(`Cannot supersede generation in ${generation.status}`);
      return {
        drafts: [{ source: "APPLICATION", type: "MODEL_GENERATION_SUPERSEDED", payload: { generationId, reason } }],
        result: { superseded: true }
      };
    });
  }

  public async correctTranscript(correctedText: string): Promise<void> {
    const envelope = createCommandEnvelope({ sessionId: this.writer.sessionId, producer: "transcript-correction" });
    await this.writer.execute(envelope, (state) => ({
      drafts: [{ source: "APPLICATION", type: "TRANSCRIPT_CORRECTED", payload: {
        transcriptRevision: TranscriptRevisionSchema.parse(state.transcriptRevision + 1),
        contextEpoch: ContextEpochSchema.parse(state.contextEpoch + 1),
        correctedText
      } }],
      result: { corrected: true }
    }));
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

export const currentState = (coordinator: TurnCoordinator): never => {
  void coordinator;
  throw new Error("Use the owning SessionWriter to inspect authoritative state");
};
