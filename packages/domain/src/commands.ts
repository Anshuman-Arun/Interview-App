import { z } from "zod";
import {
  GenerationIdSchema,
  InputEpisodeIdSchema,
  RequestIdSchema,
  SessionIdSchema,
  TurnIdSchema
} from "./ids.js";
import { ContextEpochSchema } from "./revisions.js";

export const CommandEnvelopeSchema = z.object({
  requestId: RequestIdSchema,
  sessionId: SessionIdSchema,
  producer: z.string().min(1),
  causationId: RequestIdSchema,
  correlationId: RequestIdSchema,
  inputEpisodeId: InputEpisodeIdSchema.optional(),
  turnId: TurnIdSchema.optional(),
  generationId: GenerationIdSchema.optional(),
  contextEpoch: ContextEpochSchema.optional(),
  sourceRevision: z.number().int().nonnegative().optional()
}).strict();

export type CommandEnvelope = z.infer<typeof CommandEnvelopeSchema>;
export type AsyncResultEnvelope = CommandEnvelope;

export interface CommandResult<TValue> {
  readonly duplicate: boolean;
  readonly value: TValue;
  readonly appendedEventCount: number;
}

