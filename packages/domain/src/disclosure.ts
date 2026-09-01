import { z } from "zod";
import { DisclosureIdSchema } from "./ids.js";
import { DisclosureLevelSchema } from "./pedagogy.js";

const MAX_DISCLOSURE_TEXT_CHARACTERS = 100_000;
const MAX_DISCLOSURE_FORMULATIONS = 256;
const MAX_DISCLOSURE_IDS = 256;

export const ProtectedDisclosureSchema = z.object({
  id: DisclosureIdSchema,
  fact: z.string().min(1).max(MAX_DISCLOSURE_TEXT_CHARACTERS),
  minimumDisclosureLevel: DisclosureLevelSchema,
  equivalentFormulations: z.array(
    z.string().min(1).max(MAX_DISCLOSURE_TEXT_CHARACTERS)
  ).min(1).max(MAX_DISCLOSURE_FORMULATIONS)
}).strict();
export type ProtectedDisclosure = z.infer<typeof ProtectedDisclosureSchema>;

export const DisclosureAnalysisSchema = z.object({
  status: z.enum(["SAFE", "UNSAFE", "UNKNOWN"]),
  effectiveDisclosureLevel: DisclosureLevelSchema,
  effectiveDisclosureIds: z.array(DisclosureIdSchema)
    .max(MAX_DISCLOSURE_IDS)
    .refine((ids) => new Set(ids).size === ids.length, "Effective disclosure IDs must be unique"),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1).max(MAX_DISCLOSURE_TEXT_CHARACTERS)
}).strict();
export type DisclosureAnalysis = z.infer<typeof DisclosureAnalysisSchema>;
