import { z } from "zod";
import { DisclosureIdSchema } from "./ids.js";
import { DisclosureLevelSchema } from "./pedagogy.js";

export const ProtectedDisclosureSchema = z.object({
  id: DisclosureIdSchema,
  fact: z.string().min(1),
  minimumDisclosureLevel: DisclosureLevelSchema,
  equivalentFormulations: z.array(z.string().min(1)).min(1)
}).strict();
export type ProtectedDisclosure = z.infer<typeof ProtectedDisclosureSchema>;

export const DisclosureAnalysisSchema = z.object({
  status: z.enum(["SAFE", "UNSAFE", "UNKNOWN"]),
  effectiveDisclosureLevel: DisclosureLevelSchema,
  effectiveDisclosureIds: z.array(DisclosureIdSchema),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1)
}).strict();
export type DisclosureAnalysis = z.infer<typeof DisclosureAnalysisSchema>;

