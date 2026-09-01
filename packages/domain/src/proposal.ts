import { z } from "zod";
import { DisclosureIdSchema } from "./ids.js";
import { DisclosureLevelSchema, SocraticActionSchema } from "./pedagogy.js";
import { BoardActionSchema } from "./whiteboard.js";

const MAX_PROPOSAL_TEXT_CHARACTERS = 100_000;
const MAX_PROPOSAL_DISCLOSURE_IDS = 256;
const MAX_PROPOSAL_BOARD_ACTIONS = 256;

export const InterviewerProposalSchema = z.object({
  realizedAction: SocraticActionSchema,
  claimedDisclosureLevel: DisclosureLevelSchema,
  claimedDisclosureIds: z.array(DisclosureIdSchema)
    .max(MAX_PROPOSAL_DISCLOSURE_IDS)
    .refine((ids) => new Set(ids).size === ids.length, "Claimed disclosure IDs must be unique"),
  speechText: z.string().min(1).max(MAX_PROPOSAL_TEXT_CHARACTERS).optional(),
  boardActions: z.array(BoardActionSchema).max(MAX_PROPOSAL_BOARD_ACTIONS).optional()
}).strict().refine((value) => value.speechText !== undefined || (value.boardActions?.length ?? 0) > 0, {
  message: "A proposal must contain speech text or a board action"
});
export type InterviewerProposal = z.infer<typeof InterviewerProposalSchema>;
