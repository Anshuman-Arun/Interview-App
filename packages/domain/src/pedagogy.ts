import { z } from "zod";
import { DisclosureIdSchema } from "./ids.js";

export const SocraticActionSchema = z.enum([
  "WAIT",
  "CLARIFY",
  "PROBE_JUSTIFICATION",
  "CHECK_LOCAL_STEP",
  "ASK_FOR_EXAMPLE",
  "ASK_FOR_COUNTEREXAMPLE",
  "SIMPLIFY_CASE",
  "CHANGE_REPRESENTATION",
  "FOCUS_ATTENTION",
  "RECALL_RELEVANT_FACT",
  "CHALLENGE_ASSUMPTION",
  "DIRECTIONAL_NUDGE",
  "EXPLICIT_HINT",
  "VERIFY",
  "GENERALIZE",
  "ASK_ALTERNATE_SOLUTION"
]);
export type SocraticAction = z.infer<typeof SocraticActionSchema>;

export const DisclosureLevelSchema = z.union([
  z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)
]);
export type DisclosureLevel = z.infer<typeof DisclosureLevelSchema>;

export const RealizationRequestSchema = z.object({
  requiredAction: SocraticActionSchema,
  target: z.string().min(1).optional(),
  maximumDisclosure: DisclosureLevelSchema,
  allowedDisclosureIds: z.array(DisclosureIdSchema).max(256).optional()
}).strict();
export type RealizationRequest = z.infer<typeof RealizationRequestSchema>;
