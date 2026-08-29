import { z } from "zod";

type Revision<TName extends string> = number & { readonly __revision: TName };

export type ContextEpoch = Revision<"ContextEpoch">;
export type BoardRevision = Revision<"BoardRevision">;
export type TranscriptRevision = Revision<"TranscriptRevision">;
export type ProblemStateRevision = Revision<"ProblemStateRevision">;
export type PolicyRevision = Revision<"PolicyRevision">;

const revisionSchema = <TName extends string>() =>
  z.number().int().nonnegative() as unknown as z.ZodType<Revision<TName>>;

export const ContextEpochSchema = revisionSchema<"ContextEpoch">();
export const BoardRevisionSchema = revisionSchema<"BoardRevision">();
export const TranscriptRevisionSchema = revisionSchema<"TranscriptRevision">();
export const ProblemStateRevisionSchema = revisionSchema<"ProblemStateRevision">();
export const PolicyRevisionSchema = revisionSchema<"PolicyRevision">();

export const zeroContextEpoch = ContextEpochSchema.parse(0);
export const zeroBoardRevision = BoardRevisionSchema.parse(0);
export const zeroTranscriptRevision = TranscriptRevisionSchema.parse(0);
export const zeroProblemStateRevision = ProblemStateRevisionSchema.parse(0);
export const zeroPolicyRevision = PolicyRevisionSchema.parse(0);

export const incrementContextEpoch = (value: ContextEpoch): ContextEpoch =>
  ContextEpochSchema.parse(value + 1);
export const incrementBoardRevision = (value: BoardRevision): BoardRevision =>
  BoardRevisionSchema.parse(value + 1);
export const incrementTranscriptRevision = (value: TranscriptRevision): TranscriptRevision =>
  TranscriptRevisionSchema.parse(value + 1);

