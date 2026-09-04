import { z } from "zod";
import { DisclosureIdSchema } from "./ids.js";
import { DisclosureLevelSchema, SocraticActionSchema } from "./pedagogy.js";
import { BoardActionSchema, MAX_INTERVIEWER_BOARD_ACTIONS } from "./whiteboard.js";

export const InterviewerProposalSchema = z.object({
  realizedAction: SocraticActionSchema,
  claimedDisclosureLevel: DisclosureLevelSchema,
  claimedDisclosureIds: z.array(DisclosureIdSchema),
  speechText: z.string().min(1).optional(),
  boardActions: z.array(BoardActionSchema).max(MAX_INTERVIEWER_BOARD_ACTIONS).optional()
}).strict().refine((value) => value.speechText !== undefined || (value.boardActions?.length ?? 0) > 0, {
  message: "A proposal must contain speech text or a board action"
});
export type InterviewerProposal = z.infer<typeof InterviewerProposalSchema>;

