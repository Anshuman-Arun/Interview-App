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

export type CommandIdentityValue =
  | null
  | boolean
  | number
  | string
  | readonly CommandIdentityValue[]
  | { readonly [key: string]: CommandIdentityValue };

export const CommandIdentityValueSchema: z.ZodType<CommandIdentityValue> = z.lazy(() => z.union([
  z.null(),
  z.boolean(),
  z.number(),
  z.string(),
  z.array(CommandIdentityValueSchema),
  z.record(z.string(), CommandIdentityValueSchema)
]));

export const CommandIdentitySchema = z.object({
  operation: z.string().regex(/^[A-Z][A-Z0-9_]*$/u).max(100),
  payload: z.record(z.string(), CommandIdentityValueSchema)
}).strict();
export type CommandIdentity = z.infer<typeof CommandIdentitySchema>;

export const CommandFingerprintSchema = z.string().regex(/^[0-9a-f]{64}$/u);
export type CommandFingerprint = z.infer<typeof CommandFingerprintSchema>;

export interface CommandResult<TValue> {
  readonly duplicate: boolean;
  readonly value: TValue;
  readonly appendedEventCount: number;
}
