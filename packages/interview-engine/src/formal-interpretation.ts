import { createHash } from "node:crypto";
import {
  CommandFingerprintSchema,
  FormalInterpretationRequestSchema,
  FormalInterpretationTargetSchema,
  FormalProtocolRefSchema,
  MAX_FORMAL_INTERPRETATION_PROTOCOLS,
  MAX_FORMAL_INTERPRETATION_SOURCE_CHARACTERS,
  newRequestId,
  type CommandFingerprint,
  type EvidenceKey,
  type FormalInterpretationRequest,
  type FormalProtocolRef,
  type GenerationId,
  type RequestId
} from "../../domain/src/index.js";
import { isGenerationBasisStillCompatible } from "./compatibility.js";
import type { SessionWriter } from "./session-writer.js";

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new TypeError("Interpretation request fingerprint cannot contain non-finite numbers");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (typeof value !== "object") throw new TypeError("Interpretation request fingerprint input is not JSON-compatible");
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

export function fingerprintFormalInterpretationRequest(input: unknown): CommandFingerprint {
  const request = FormalInterpretationRequestSchema.parse(input);
  return CommandFingerprintSchema.parse(
    createHash("sha256").update(canonicalJson(request)).digest("hex")
  );
}

export function createFormalInterpretationRequest(
  writer: SessionWriter,
  input: {
    readonly generationId: GenerationId;
    readonly target: EvidenceKey;
    readonly allowedProtocols: readonly FormalProtocolRef[];
    readonly requestId?: RequestId;
    readonly sourceSpan?: {
      readonly start: number;
      readonly end: number;
    };
  }
): FormalInterpretationRequest {
  if (writer.isClosed()) throw new Error("Cannot create a formal interpretation request from a closed session writer");
  const state = writer.getState();
  if (!state.started || state.status !== "ACTIVE") {
    throw new Error("Formal interpretation requires an active session");
  }
  if (state.problem === undefined) throw new Error("Formal interpretation requires an active problem");

  const generation = state.generations[input.generationId];
  if (generation === undefined || generation.status !== "ACTIVE") {
    throw new Error("Formal interpretation requires an active source generation");
  }
  if (isGenerationBasisStillCompatible(generation.basis, state) !== "COMPATIBLE") {
    throw new Error("Formal interpretation requires a current generation basis");
  }
  if (generation.basis.inputEpisodeId === undefined) {
    throw new Error("Formal interpretation requires an InputEpisode-bound generation");
  }

  const turn = state.turns[generation.basis.turnId];
  if (turn === undefined || turn.inputEpisodeId !== generation.basis.inputEpisodeId) {
    throw new Error("Formal interpretation source turn provenance is unavailable");
  }
  const sourceEventId = state.eventIds[turn.committedSequence - 1];
  if (sourceEventId === undefined) {
    throw new Error("Formal interpretation source event provenance is unavailable");
  }

  const target = FormalInterpretationTargetSchema.parse(input.target);
  if (
    input.allowedProtocols.length < 1
    || input.allowedProtocols.length > MAX_FORMAL_INTERPRETATION_PROTOCOLS
  ) {
    throw new Error("Formal interpretation protocol list exceeds the bounded size");
  }
  const allowedProtocols = input.allowedProtocols.map((protocol) => FormalProtocolRefSchema.parse(protocol));
  const start = input.sourceSpan?.start ?? 0;
  const end = input.sourceSpan?.end ?? turn.studentText.length;
  if (
    !Number.isSafeInteger(start)
    || !Number.isSafeInteger(end)
    || start < 0
    || end > turn.studentText.length
    || end <= start
    || end - start > MAX_FORMAL_INTERPRETATION_SOURCE_CHARACTERS
  ) {
    throw new Error("Formal interpretation source span is invalid or exceeds the bounded size");
  }

  return FormalInterpretationRequestSchema.parse({
    protocolVersion: 1,
    requestId: input.requestId ?? newRequestId(),
    sessionId: state.sessionId,
    generationId: generation.generationId,
    basis: generation.basis,
    source: {
      kind: "TURN_TEXT",
      inputEpisodeId: generation.basis.inputEpisodeId,
      turnId: generation.basis.turnId,
      sourceRevision: generation.basis.committedInputSequence,
      eventIds: [sourceEventId],
      span: {
        start,
        end,
        text: turn.studentText.slice(start, end)
      }
    },
    problem: {
      id: state.problem.id,
      version: state.problem.version
    },
    target,
    allowedProtocols
  });
}
