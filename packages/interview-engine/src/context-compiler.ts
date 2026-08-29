import { z } from "zod";
import {
  DisclosureIdSchema,
  RealizationRequestSchema,
  type InterviewProblem,
  type RealizationRequest,
  type TurnId
} from "../../domain/src/index.js";
import type { SessionState } from "../../events/src/index.js";

export const CompiledContextSchema = z.object({
  problemPrompt: z.string().min(1),
  recentStudentWork: z.string().min(1),
  realizationRequest: RealizationRequestSchema,
  deliveredFacts: z.array(DisclosureIdSchema),
  forbiddenDisclosureIds: z.array(DisclosureIdSchema)
}).strict();
export type CompiledContext = z.infer<typeof CompiledContextSchema>;

export function compileContext(input: {
  readonly state: Readonly<SessionState>;
  readonly problem: InterviewProblem;
  readonly turnId: TurnId;
  readonly realizationRequest: RealizationRequest;
}): CompiledContext {
  const turn = input.state.turns[input.turnId];
  if (turn === undefined) throw new Error(`Unknown turn ${input.turnId}`);
  const delivered = new Set(input.state.disclosureLedger);
  return CompiledContextSchema.parse({
    problemPrompt: input.problem.public.prompt,
    recentStudentWork: turn.studentText,
    realizationRequest: input.realizationRequest,
    deliveredFacts: [...delivered],
    forbiddenDisclosureIds: input.problem.interviewer.protectedDisclosures
      .map((item) => item.id)
      .filter((id) => !delivered.has(id))
  });
}

