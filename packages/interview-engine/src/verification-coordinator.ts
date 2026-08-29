import { z } from "zod";
import {
  CommandEnvelopeSchema,
  EvidenceKeySchema,
  EvidenceValueSchema,
  EventIdSchema,
  GenerationBasisSchema,
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
import type { SessionWriter } from "./session-writer.js";

export const VerificationWorkItemSchema = z.object({
  protocolVersion: z.literal(1),
  verificationRequestId: RequestIdSchema,
  verifier: z.string().min(1),
  basis: GenerationBasisSchema,
  candidateFormalInterpretation: z.string().min(1).max(100_000),
  interpretationConfidence: z.number().min(0).max(1),
  evidenceKey: EvidenceKeySchema,
  evidenceEventIds: z.array(EventIdSchema).min(1)
}).strict();
export type VerificationWorkItem = z.infer<typeof VerificationWorkItemSchema>;

const VerificationDiscardReasonSchema = z.enum([
  "UNKNOWN_REQUEST",
  "REQUEST_NOT_PENDING",
  "CALLBACK_BASIS_MISMATCH",
  "COMPATIBILITY_INCOMPATIBLE",
  "COMPATIBILITY_UNKNOWN",
  "VERIFIER_EXECUTION_FAILED",
  "VERIFIER_OUTPUT_INVALID",
  "VERIFIER_IDENTITY_MISMATCH",
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
  public constructor(private readonly writer: SessionWriter) {}

  public requestVerification(input: {
    readonly inputEpisodeId: InputEpisodeId;
    readonly turnId: TurnId;
    readonly verifier: string;
    readonly candidateFormalInterpretation: string;
    readonly interpretationConfidence: number;
    readonly evidenceKey: EvidenceKey;
    readonly envelope?: CommandEnvelope;
  }) {
    const verificationRequestId = newRequestId();
    const envelope = CommandEnvelopeSchema.parse(input.envelope ?? createCommandEnvelope({
      sessionId: this.writer.sessionId,
      producer: "verification-coordinator",
      correlationId: verificationRequestId,
      inputEpisodeId: input.inputEpisodeId,
      turnId: input.turnId
    }));
    const effectiveRequestId = envelope.correlationId;

    return this.writer.execute(envelope, VerificationWorkItemSchema, (state) => {
      const episode = state.inputEpisodes[input.inputEpisodeId];
      const turn = state.turns[input.turnId];
      if (episode === undefined || episode.status !== "COMMITTED") throw new Error("Verification requires a committed InputEpisode");
      if (turn === undefined || turn.inputEpisodeId !== input.inputEpisodeId) throw new Error("Verification Turn does not match its InputEpisode");
      if (state.lastCommittedInputSequence === undefined) throw new Error("Verification requires a committed Turn");
      if (state.problem?.id !== input.evidenceKey.problemId) throw new Error("Verification evidence is scoped to a different problem");
      if (input.evidenceKey.subject.kind !== "CLAIM" || input.evidenceKey.dimension !== "CORRECTNESS") {
        throw new Error("Phase 0 deterministic verification may commit only claim correctness evidence");
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
        verifier: input.verifier,
        basis,
        candidateFormalInterpretation: input.candidateFormalInterpretation,
        interpretationConfidence: input.interpretationConfidence,
        evidenceKey: input.evidenceKey,
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
    const recomputed = snapshotRequest === undefined || snapshotRequest.status !== "PENDING"
      ? undefined
      : await this.recompute(input.verifier, snapshotRequest.candidateFormalInterpretation, snapshotRequest.interpretationConfidence);

    return this.writer.execute(envelope, VerificationAdmissionResultSchema, (state) => {
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
}
