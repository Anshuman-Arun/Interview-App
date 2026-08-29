import {
  newRequestId,
  type CommandEnvelope,
  type GenerationId,
  type InputEpisodeId,
  type RequestId,
  type SessionId,
  type TurnId
} from "../../domain/src/index.js";

export function createCommandEnvelope(input: {
  readonly sessionId: SessionId;
  readonly producer: string;
  readonly requestId?: RequestId;
  readonly correlationId?: RequestId;
  readonly inputEpisodeId?: InputEpisodeId;
  readonly turnId?: TurnId;
  readonly generationId?: GenerationId;
  readonly contextEpoch?: CommandEnvelope["contextEpoch"];
  readonly sourceRevision?: number;
}): CommandEnvelope {
  const requestId = input.requestId ?? newRequestId();
  return {
    requestId,
    sessionId: input.sessionId,
    producer: input.producer,
    causationId: requestId,
    correlationId: input.correlationId ?? requestId,
    ...(input.inputEpisodeId === undefined ? {} : { inputEpisodeId: input.inputEpisodeId }),
    ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
    ...(input.generationId === undefined ? {} : { generationId: input.generationId }),
    ...(input.contextEpoch === undefined ? {} : { contextEpoch: input.contextEpoch }),
    ...(input.sourceRevision === undefined ? {} : { sourceRevision: input.sourceRevision })
  };
}
