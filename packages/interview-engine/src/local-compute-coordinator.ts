import { z } from "zod";
import {
  CommandEnvelopeSchema,
  newRequestId,
  RequestIdSchema,
  type CommandEnvelope,
  type InputEpisodeId
} from "../../domain/src/index.js";
import type { EventDraft, SessionState } from "../../events/src/index.js";
import {
  LocalComputeResponseSchema,
  WorkerTranscriptAnalysisRequestSchema,
  type LocalComputeRequest
} from "../../local-compute/src/index.js";
import { createCommandEnvelope } from "./envelopes.js";
import type { SessionWriter } from "./session-writer.js";

const LocalComputeDiscardReasonSchema = z.enum([
  "UNKNOWN_REQUEST",
  "REQUEST_NOT_PENDING",
  "WORKER_ERROR",
  "UNEXPECTED_RESPONSE_TYPE",
  "CALLBACK_BASIS_MISSING",
  "CALLBACK_BASIS_MISMATCH",
  "STALE_SOURCE_REVISION",
  "EPISODE_NOT_COMMITTED",
  "DETERMINISTIC_VALIDATION_FAILED"
]);
export type LocalComputeDiscardReason = z.infer<typeof LocalComputeDiscardReasonSchema>;

export const LocalComputeAdmissionResultSchema = z.discriminatedUnion("accepted", [
  z.object({ accepted: z.literal(true), computeRequestId: RequestIdSchema }).strict(),
  z.object({ accepted: z.literal(false), computeRequestId: RequestIdSchema, reason: LocalComputeDiscardReasonSchema }).strict()
]);
export type LocalComputeAdmissionResult = z.infer<typeof LocalComputeAdmissionResultSchema>;

function transcriptText(state: Readonly<SessionState>, inputEpisodeId: InputEpisodeId): string | undefined {
  const episode = state.inputEpisodes[inputEpisodeId];
  if (episode === undefined || episode.status !== "COMMITTED") return undefined;
  const text = episode.inputs
    .filter((input) => input.modality === "SPEECH")
    .map((input) => input.semanticContent)
    .join(" ");
  return text.length === 0 ? undefined : text;
}

function independentlyAnalyze(text: string): { readonly normalizedText: string; readonly tokenCount: number } {
  const normalizedText = text.trim().split(/\s+/u).filter((token) => token.length > 0).join(" ");
  return {
    normalizedText,
    tokenCount: normalizedText.length === 0 ? 0 : normalizedText.split(" ").length
  };
}

function discardedDraft(computeRequestId: CommandEnvelope["correlationId"], reason: LocalComputeDiscardReason): EventDraft {
  return {
    source: "APPLICATION",
    type: "LOCAL_COMPUTE_RESULT_DISCARDED",
    payload: { computeRequestId, operation: "ANALYZE_TRANSCRIPT", reason }
  };
}

export class LocalComputeCoordinator {
  public constructor(private readonly writer: SessionWriter) {}

  public requestTranscriptAnalysis(inputEpisodeId: InputEpisodeId, commandEnvelope?: CommandEnvelope) {
    const computeRequestId = newRequestId();
    const envelope = CommandEnvelopeSchema.parse(commandEnvelope ?? createCommandEnvelope({
      sessionId: this.writer.sessionId,
      producer: "local-compute-coordinator",
      correlationId: computeRequestId,
      inputEpisodeId
    }));
    const effectiveComputeRequestId = envelope.correlationId;

    return this.writer.execute(envelope, {
      operation: "REQUEST_TRANSCRIPT_ANALYSIS",
      payload: { inputEpisodeId }
    }, WorkerTranscriptAnalysisRequestSchema, (state) => {
      const text = transcriptText(state, inputEpisodeId);
      if (text === undefined) throw new Error("Transcript analysis requires committed speech input");
      const request = WorkerTranscriptAnalysisRequestSchema.parse({
        protocolVersion: 1,
        requestId: effectiveComputeRequestId,
        type: "ANALYZE_TRANSCRIPT",
        sourceRevision: state.transcriptRevision,
        text
      });
      return {
        drafts: [{
          source: "APPLICATION",
          type: "LOCAL_COMPUTE_REQUESTED",
          payload: {
            computeRequestId: effectiveComputeRequestId,
            operation: "ANALYZE_TRANSCRIPT",
            inputEpisodeId,
            sourceTranscriptRevision: state.transcriptRevision
          }
        }],
        result: request
      };
    });
  }

  public processResult(input: { readonly envelope: CommandEnvelope; readonly response: unknown }) {
    const envelope = CommandEnvelopeSchema.parse(input.envelope);
    const response = LocalComputeResponseSchema.parse(input.response);
    if (envelope.correlationId !== response.requestId) {
      throw new Error("Worker response RequestId does not match callback correlationId");
    }

    return this.writer.execute(envelope, {
      operation: "PROCESS_LOCAL_COMPUTE_RESULT",
      payload: { response }
    }, LocalComputeAdmissionResultSchema, (state) => {
      const request = state.localComputeRequests[response.requestId];
      if (request === undefined) return this.noEvent(response.requestId, "UNKNOWN_REQUEST");
      if (request.status !== "PENDING") return this.noEvent(response.requestId, "REQUEST_NOT_PENDING");

      const discard = (reason: LocalComputeDiscardReason) => ({
        drafts: [discardedDraft(response.requestId, reason)],
        result: { accepted: false as const, computeRequestId: response.requestId, reason }
      });

      if (response.type === "WORKER_ERROR") return discard("WORKER_ERROR");
      if (response.type !== "TRANSCRIPT_ANALYSIS_RESULT") return discard("UNEXPECTED_RESPONSE_TYPE");
      if (envelope.sourceRevision === undefined) return discard("CALLBACK_BASIS_MISSING");
      if (envelope.sourceRevision !== request.sourceTranscriptRevision) return discard("CALLBACK_BASIS_MISMATCH");
      if (response.sourceRevision !== request.sourceTranscriptRevision || state.transcriptRevision !== request.sourceTranscriptRevision) {
        return discard("STALE_SOURCE_REVISION");
      }

      const text = transcriptText(state, request.inputEpisodeId);
      if (text === undefined) return discard("EPISODE_NOT_COMMITTED");
      const expected = independentlyAnalyze(text);
      if (response.normalizedText !== expected.normalizedText || response.tokenCount !== expected.tokenCount) {
        return discard("DETERMINISTIC_VALIDATION_FAILED");
      }

      return {
        drafts: [{
          source: "APPLICATION",
          type: "LOCAL_COMPUTE_RESULT_ACCEPTED",
          payload: {
            computeRequestId: response.requestId,
            operation: "ANALYZE_TRANSCRIPT",
            sourceTranscriptRevision: request.sourceTranscriptRevision,
            normalizedText: response.normalizedText,
            tokenCount: response.tokenCount
          }
        }],
        result: { accepted: true as const, computeRequestId: response.requestId }
      };
    });
  }

  private noEvent(computeRequestId: LocalComputeRequest["requestId"], reason: LocalComputeDiscardReason) {
    return {
      drafts: [],
      result: { accepted: false as const, computeRequestId, reason }
    };
  }
}
