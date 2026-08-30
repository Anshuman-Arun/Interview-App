import { z } from "zod";
import { InputEpisodeIdSchema, TurnIdSchema } from "./ids.js";
import {
  BoardRevisionSchema,
  ContextEpochSchema,
  PolicyRevisionSchema,
  ProblemStateRevisionSchema,
  TranscriptRevisionSchema
} from "./revisions.js";

export const GenerationBasisSchema = z.object({
  contextEpoch: ContextEpochSchema,
  committedInputSequence: z.number().int().positive(),
  transcriptRevision: TranscriptRevisionSchema,
  boardRevision: BoardRevisionSchema,
  problemStateRevision: ProblemStateRevisionSchema,
  policyRevision: PolicyRevisionSchema,
  inputEpisodeId: InputEpisodeIdSchema.optional(),
  turnId: TurnIdSchema
}).strict();

export type GenerationBasis = z.infer<typeof GenerationBasisSchema>;
export const CompatibilitySchema = z.enum(["COMPATIBLE", "INCOMPATIBLE", "UNKNOWN"]);
export type Compatibility = z.infer<typeof CompatibilitySchema>;

export function generationBasesEqual(left: GenerationBasis, right: GenerationBasis): boolean {
  return left.contextEpoch === right.contextEpoch
    && left.committedInputSequence === right.committedInputSequence
    && left.transcriptRevision === right.transcriptRevision
    && left.boardRevision === right.boardRevision
    && left.problemStateRevision === right.problemStateRevision
    && left.policyRevision === right.policyRevision
    && left.inputEpisodeId === right.inputEpisodeId
    && left.turnId === right.turnId;
}
