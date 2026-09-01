import { z } from "zod";
import {
  CommandEnvelopeSchema,
  EvidenceKeySchema,
  EvidenceValueSchema,
  EventIdSchema,
  FormalInterpretationProposalSchema,
  GenerationBasisSchema,
  GenerationIdSchema,
  RequestIdSchema,
  VerificationResultSchema,
  evidenceKeyToString,
  newRequestId,
  type CommandEnvelope,
  type DeterministicVerifier,
  type EvidenceKey,
  type GenerationBasis,
  type InputEpisodeId,
  type VerificationResult,
  type TurnId
} from "../../domain/src/index.js";
import type { EventDraft } from "../../events/src/index.js";
import { createCommandEnvelope } from "./envelopes.js";
import { isGenerationBasisStillCompatible } from "./compatibility.js";
import { invalidateUndeliveredPolicyOutput } from "./policy-output-invalidation.js";
import type { SessionWriter } from "./session-writer.js";

const VerifierIdSchema = z.string().trim().min(1).max(128);

export const VerificationEvidenceScopeSchema = z.object({
  verifier: VerifierIdSchema,
  evidenceKey: EvidenceKeySchema
}).strict();
export type VerificationEvidenceScope = z.infer<typeof VerificationEvidenceScopeSchema>;

export const VerificationWorkItemSchema = z.object({
  protocolVersion: z.literal(1),
  verificationRequestId: RequestIdSchema,
  verifier: VerifierIdSchema,
  basis: GenerationBasisSchema,
  candidateFormalInterpretation: z.string().min(1).max(100_000),
  interpretationConfidence: z.number().min(0).max(1),
  evidenceKey: EvidenceKeySchema,
  evidenceEventIds: z.array(EventIdSchema).min(1),
  sourceGenerationId: GenerationIdSchema.optional(),
  sourceProposalRequestId: RequestIdSchema.optional()
}).strict();
export type VerificationWorkItem = z.infer<typeof VerificationWorkItemSchema>;

const FormalInterpretationDiscardReasonSchema = z.enum([
  "MISSING_GENERATION_ID",
  "UNKNOWN_GENERATION",
  "GENERATION_NOT_ACTIVE",
  "CALLBACK_BASIS_MISMATCH",
  "COMPATIBILITY_INCOMPATIBLE",
  "COMPATIBILITY_UNKNOWN",
  "PROBLEM_SCOPE_MISMATCH",
  "EVIDENCE_SCOPE_UNSUPPORTED",
  "VERIFIER_SCOPE_UNAUTHORIZED",
  "PROVENANCE_UNAVAILABLE"
]);
export type FormalInterpretationDiscardReason = z.infer<typeof FormalInterpretationDiscardReasonSchema>;

export const FormalInterpretationAdmissionResultSchema = z.discriminatedUnion("accepted", [
  z.object({ accepted: z.literal(true), workItem: VerificationWorkItemSchema }).strict(),
  z.object({
    accepted: z.literal(false),
    generationId: GenerationIdSchema.optional(),
    reason: FormalInterpretationDiscardReasonSchema
  }).strict()
]);
export type FormalInterpretationAdmissionResult = z.infer<typeof FormalInterpretationAdmissionResultSchema>;

const VerificationDiscardReasonSchema = z.enum([
  "UNKNOWN_REQUEST",
  "REQUEST_NOT_PENDING",
  "CALLBACK_BASIS_MISMATCH",
  "COMPATIBILITY_INCOMPATIBLE",
  "COMPATIBILITY_UNKNOWN",
  "VERIFIER_EXECUTION_FAILED",
  "VERIFIER_OUTPUT_INVALID",
  "VERIFIER_IDENTITY_MISMATCH",
  "VERIFIER_SCOPE_UNAUTHORIZED",
  "RECOMPUTATION_MISMATCH"
]);
export type VerificationDiscardReason = z.infer<typeof VerificationDiscardReasonSchema>;

export const VerificationAdmissionResultSchema = z.discriminatedUnion("accepted", [
  z.object({
    accepted: z.literal(true),
    verificationRequestId: RequestIdSchema,
    status: VerificationResultSchema.shape.status,
    evidenceCommitted: z.boolean()
  }).strict(),
  z.object({
    accepted: z.literal(false),
    verificationRequestId: RequestIdSchema,
    reason: VerificationDiscardReasonSchema
  }).strict()
]);
export type VerificationAdmissionResult = z.infer<typeof VerificationAdmissionResultSchema>;

type Recomputed =
  | { readonly ok: true; readonly result: VerificationResult }
  | { readonly ok: false; readonly reason: "VERIFIER_EXECUTION_FAILED" | "VERIFIER_OUTPUT_INVALID" };

function resultsEqual(left: VerificationResult, right: VerificationResult): boolean {
  return left.status === right.status
    && left.interpretationConfidence === right.interpretationConfidence
    && left.verifier === right.verifier
    && left.reason === right.reason;
}

export class VerificationCoordinator {
  private readonly authorizedScopes: ReadonlySet<string>;

  public constructor(
    private readonly writer: SessionWriter,
    scopes: readonly VerificationEvidenceScope[] = []
  ) {
    this.authorizedScopes = new Set(
      scopes.map((scope) => {
        const parsed = VerificationEvidenceScopeSchema.parse(scope);
        return verificationScopeKey(parsed.verifier, parsed.evidenceKey);
      })
    );
  }

  public async requestVerificationFromProposal(input: {
    readonly envelope: CommandEnvelope;
    readonly proposal: unknown;
    readonly verifier: string;
    readonly evidenceKey: EvidenceKey;
  }) {
    const envelope = CommandEnvelopeSchema.parse(input.envelope);
    const proposal = FormalInterpretationProposalSchema.parse(input.proposal);
    const verifier = VerifierIdSchema.parse(input.verifier);
    const evidenceKey = EvidenceKeySchema.parse(input.evidenceKey);
    const verificationRequestId = newRequestId();

    return this.writer.execute(envelope, {
      operation: "REQUEST_VERIFICATION_FROM_PROPOSAL",
      payload: { proposal, verifier, evidenceKey }
    }, FormalInterpretationAdmissionResultSchema, (state) => {
      const generationId = envelope.generationId;
      if (generationId === undefined) {
        return { drafts: [], result: { accepted: false as const, reason: "MISSING_GENERATION_ID" as const } };
      }

      const generation = state.generations[generationId];
      if (generation === undefined) {
        return {
          drafts: [],
          result: { accepted: false as const, generationId, reason: "UNKNOWN_GENERATION" as const }
        };
      }
      if (generation.status !== "ACTIVE") {
        return {
          drafts: [],
          result: { accepted: false as const, generationId, reason: "GENERATION_NOT_ACTIVE" as const }
        };
      }

      const received: EventDraft = {
        source: "PROVIDER",
        type: "FORMAL_INTERPRETATION_PROPOSAL_RECEIVED",
        payload: { generationId, proposalRequestId: envelope.requestId, proposal }
      };
      const reject = (reason: FormalInterpretationDiscardReason, supersede: boolean) => {
        const drafts: EventDraft[] = [received, {
          source: "APPLICATION",
          type: "FORMAL_INTERPRETATION_PROPOSAL_REJECTED",
          payload: { generationId, reason }
        }];
        if (supersede) {
          drafts.push({
            source: "APPLICATION",
            type: "MODEL_GENERATION_SUPERSEDED",
            payload: { generationId, reason }
          });
        }
        return {
          drafts,
          result: { accepted: false as const, generationId, reason }
        };
      };

      if (
        generation.basis.inputEpisodeId === undefined
        || envelope.inputEpisodeId !== generation.basis.inputEpisodeId
        || envelope.turnId !== generation.basis.turnId
        || envelope.contextEpoch !== generation.basis.contextEpoch
        || envelope.sourceRevision !== generation.basis.committedInputSequence
      ) return reject("CALLBACK_BASIS_MISMATCH", true);

      const compatibility = isGenerationBasisStillCompatible(generation.basis, state);
      if (compatibility === "INCOMPATIBLE") return reject("COMPATIBILITY_INCOMPATIBLE", true);
      if (compatibility === "UNKNOWN") return reject("COMPATIBILITY_UNKNOWN", true);

      if (state.problem?.id !== evidenceKey.problemId) {
        return reject("PROBLEM_SCOPE_MISMATCH", false);
      }
      if (evidenceKey.subject.kind !== "CLAIM" || evidenceKey.dimension !== "CORRECTNESS") {
        return reject("EVIDENCE_SCOPE_UNSUPPORTED", false);
      }
      if (!this.isScopeAuthorized(verifier, evidenceKey)) {
        return reject("VERIFIER_SCOPE_UNAUTHORIZED", false);
      }

      const turn = state.turns[generation.basis.turnId];
      const evidenceEventId = turn === undefined ? undefined : state.eventIds[turn.committedSequence - 1];
      if (evidenceEventId === undefined) return reject("PROVENANCE_UNAVAILABLE", false);

      const workItem = VerificationWorkItemSchema.parse({
        protocolVersion: 1,
        verificationRequestId,
        verifier,
        basis: generation.basis,
        candidateFormalInterpretation: proposal.candidateFormalInterpretation,
        interpretationConfidence: proposal.interpretationConfidence,
        evidenceKey,
        evidenceEventIds: [evidenceEventId],
        sourceGenerationId: generationId,
        sourceProposalRequestId: envelope.requestId
      });

      return {
        drafts: [received, {
          source: "APPLICATION",
          type: "VERIFICATION_REQUESTED",
          payload: {
            verificationRequestId: workItem.verificationRequestId,
            verifier: workItem.verifier,
            basis: workItem.basis,
            candidateFormalInterpretation: workItem.candidateFormalInterpretation,
            interpretationConfidence: workItem.interpretationConfidence,
            evidenceKey: workItem.evidenceKey,
            evidenceEventIds: workItem.evidenceEventIds,
            sourceGenerationId: generationId,
            sourceProposalRequestId: envelope.requestId
          }
        }],
        result: { accepted: true as const, workItem }
      };
    });
  }

  public requestVerification(input: {
    readonly inputEpisodeId: InputEpisodeId;
    readonly turnId: TurnId;
    readonly verifier: string;
    readonly candidateFormalInterpretation: string;
    readonly interpretationConfidence: number;
    readonly evidenceKey: EvidenceKey;
    readonly envelope?: CommandEnvelope;
  }) {
    const verifier = VerifierIdSchema.parse(input.verifier);
    const evidenceKey = EvidenceKeySchema.parse(input.evidenceKey);
    const verificationRequestId = newRequestId();
    const envelope = CommandEnvelopeSchema.parse(input.envelope ?? createCommandEnvelope({
      sessionId: this.writer.sessionId,
      producer: "verification-coordinator",
      correlationId: verificationRequestId,
      inputEpisodeId: input.inputEpisodeId,
      turnId: input.turnId
    }));
    const effectiveRequestId = envelope.correlationId;

    return this.writer.execute(envelope, {
      operation: "REQUEST_VERIFICATION",
      payload: {
        inputEpisodeId: input.inputEpisodeId,
        turnId: input.turnId,
        verifier,
        candidateFormalInterpretation: input.candidateFormalInterpretation,
        interpretationConfidence: input.interpretationConfidence,
        evidenceKey
      }
    }, VerificationWorkItemSchema, (state) => {
      const episode = state.inputEpisodes[input.inputEpisodeId];
      const turn = state.turns[input.turnId];
      if (episode === undefined || episode.status !== "COMMITTED") throw new Error("Verification requires a committed InputEpisode");
      if (turn === undefined || turn.inputEpisodeId !== input.inputEpisodeId) throw new Error("Verification Turn does not match its InputEpisode");
      if (state.lastCommittedInputSequence === undefined) throw new Error("Verification requires a committed Turn");
      if (state.problem?.id !== evidenceKey.problemId) throw new Error("Verification evidence is scoped to a different problem");
      if (evidenceKey.subject.kind !== "CLAIM" || evidenceKey.dimension !== "CORRECTNESS") {
        throw new Error("Phase 0 deterministic verification may commit only claim correctness evidence");
      }
      if (!this.isScopeAuthorized(verifier, evidenceKey)) {
        throw new Error("Verifier is not authorized for the requested evidence scope");
      }

      const evidenceEventId = state.eventIds[turn.committedSequence - 1];
      if (evidenceEventId === undefined) throw new Error("Committed Turn provenance is unavailable");
      const basis: GenerationBasis = {
        contextEpoch: state.contextEpoch,
        committedInputSequence: state.lastCommittedInputSequence,
        transcriptRevision: state.transcriptRevision,
        boardRevision: state.boardRevision,
        problemStateRevision: state.problemStateRevision,
        policyRevision: state.policyRevision,
        inputEpisodeId: input.inputEpisodeId,
        turnId: input.turnId
      };
      const workItem = VerificationWorkItemSchema.parse({
        protocolVersion: 1,
        verificationRequestId: effectiveRequestId,
        verifier,
        basis,
        candidateFormalInterpretation: input.candidateFormalInterpretation,
        interpretationConfidence: input.interpretationConfidence,
        evidenceKey,
        evidenceEventIds: [evidenceEventId]
      });
      return {
        drafts: [{
          source: "APPLICATION",
          type: "VERIFICATION_REQUESTED",
          payload: {
            verificationRequestId: workItem.verificationRequestId,
            verifier: workItem.verifier,
            basis: workItem.basis,
            candidateFormalInterpretation: workItem.candidateFormalInterpretation,
            interpretationConfidence: workItem.interpretationConfidence,
            evidenceKey: workItem.evidenceKey,
            evidenceEventIds: workItem.evidenceEventIds
          }
        }],
        result: workItem
      };
    });
  }

  public async processResult(input: {
    readonly envelope: CommandEnvelope;
    readonly result: unknown;
    readonly verifier: DeterministicVerifier;
  }) {
    const envelope = CommandEnvelopeSchema.parse(input.envelope);
    const supplied = VerificationResultSchema.parse(input.result);

    const snapshotRequest = this.writer.getState().verificationRequests[envelope.correlationId];
    const recomputed = snapshotRequest === undefined
      || snapshotRequest.status !== "PENDING"
      || !this.isScopeAuthorized(snapshotRequest.verifier, snapshotRequest.evidenceKey)
      ? undefined
      : await this.recompute(input.verifier, snapshotRequest.candidateFormalInterpretation, snapshotRequest.interpretationConfidence);

    return this.writer.execute(envelope, {
      operation: "PROCESS_VERIFICATION_RESULT",
      payload: { result: supplied }
    }, VerificationAdmissionResultSchema, (state) => {
      const verificationRequestId = envelope.correlationId;
      const request = state.verificationRequests[verificationRequestId];
      if (request === undefined) return this.noEvent(verificationRequestId, "UNKNOWN_REQUEST");
      if (request.status !== "PENDING") return this.noEvent(verificationRequestId, "REQUEST_NOT_PENDING");

      const discard = (reason: VerificationDiscardReason) => ({
        drafts: [{
          source: "APPLICATION" as const,
          type: "VERIFICATION_RESULT_DISCARDED" as const,
          payload: { verificationRequestId, reason }
        }],
        result: { accepted: false as const, verificationRequestId, reason }
      });

      if (
        envelope.inputEpisodeId !== request.basis.inputEpisodeId
        || envelope.turnId !== request.basis.turnId
        || envelope.contextEpoch !== request.basis.contextEpoch
        || envelope.sourceRevision !== request.basis.committedInputSequence
      ) return discard("CALLBACK_BASIS_MISMATCH");

      const compatibility = isGenerationBasisStillCompatible(request.basis, state);
      if (compatibility === "INCOMPATIBLE") return discard("COMPATIBILITY_INCOMPATIBLE");
      if (compatibility === "UNKNOWN") return discard("COMPATIBILITY_UNKNOWN");
      if (!this.isScopeAuthorized(request.verifier, request.evidenceKey)) {
        return discard("VERIFIER_SCOPE_UNAUTHORIZED");
      }
      if (recomputed === undefined) return discard("REQUEST_NOT_PENDING");
      if (!recomputed.ok) return discard(recomputed.reason);
      if (recomputed.result.verifier !== request.verifier) return discard("VERIFIER_IDENTITY_MISMATCH");
      if (!resultsEqual(supplied, recomputed.result)) return discard("RECOMPUTATION_MISMATCH");

      const drafts: EventDraft[] = [{
        source: "APPLICATION",
        type: "VERIFICATION_RESULT_ACCEPTED",
        payload: { verificationRequestId, result: recomputed.result }
      }];
      const evidenceCommitted = recomputed.result.status === "VERIFIED";
      if (evidenceCommitted) {
        const evidenceEventIds = Array.from(new Set([...request.evidenceEventIds, request.requestedEventId]));
        const evidenceKey = evidenceKeyToString(request.evidenceKey);
        const activeEvidence = state.evidenceHistory[evidenceKey]?.find((record) => record.status === "ACTIVE");
        drafts.push({
          source: "APPLICATION",
          type: "STUDENT_EVIDENCE_UPDATED",
          payload: {
            key: request.evidenceKey,
            value: EvidenceValueSchema.parse({
              value: "CORRECT",
              inferenceConfidence: recomputed.result.interpretationConfidence,
              evidenceEventIds,
              lastUpdatedSequence: state.sequence + 2
            }),
            ...(activeEvidence === undefined ? {} : { supersedesEventId: activeEvidence.evidenceEventId })
          }
        });
      }
      drafts.push(...invalidateUndeliveredPolicyOutput(
        state,
        "Authoritative verification changed before delivery"
      ));
      return {
        drafts,
        result: {
          accepted: true as const,
          verificationRequestId,
          status: recomputed.result.status,
          evidenceCommitted
        }
      };
    });
  }

  private async recompute(verifier: DeterministicVerifier, statement: string, confidence: number): Promise<Recomputed> {
    try {
      const result = await verifier.verify(statement, confidence);
      const parsed = VerificationResultSchema.safeParse(result);
      return parsed.success
        ? { ok: true, result: parsed.data }
        : { ok: false, reason: "VERIFIER_OUTPUT_INVALID" };
    } catch {
      return { ok: false, reason: "VERIFIER_EXECUTION_FAILED" };
    }
  }

  private noEvent(verificationRequestId: CommandEnvelope["correlationId"], reason: VerificationDiscardReason) {
    return {
      drafts: [],
      result: { accepted: false as const, verificationRequestId, reason }
    };
  }

  private isScopeAuthorized(verifier: string, evidenceKey: EvidenceKey): boolean {
    return this.authorizedScopes.has(verificationScopeKey(verifier, evidenceKey));
  }
}

function verificationScopeKey(verifier: string, evidenceKey: EvidenceKey): string {
  return `${verifier}\u0000${evidenceKeyToString(evidenceKey)}`;
}
