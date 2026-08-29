import { z } from "zod";
import { DeliveryIdSchema, DisclosureIdSchema, GenerationIdSchema } from "./ids.js";
import { DisclosureLevelSchema } from "./pedagogy.js";
import { BoardActionSchema } from "./whiteboard.js";

export const DeliveryMediumSchema = z.enum(["TEXT", "AUDIO", "WHITEBOARD"]);
export type DeliveryMedium = z.infer<typeof DeliveryMediumSchema>;
export const DeliveryStatusSchema = z.enum([
  "VALIDATED", "QUEUED", "DELIVERING", "EXPOSED", "COMPLETED", "CANCELLED", "POSSIBLY_EXPOSED"
]);
export type DeliveryStatus = z.infer<typeof DeliveryStatusSchema>;

export const DeliveryContentSchema = z.discriminatedUnion("medium", [
  z.object({ medium: z.literal("TEXT"), text: z.string().min(1) }).strict(),
  z.object({ medium: z.literal("AUDIO"), text: z.string().min(1), audioRef: z.string().min(1) }).strict(),
  z.object({ medium: z.literal("WHITEBOARD"), action: BoardActionSchema }).strict()
]);

export const DeliveryAtomSchema = z.object({
  deliveryId: DeliveryIdSchema,
  generationId: GenerationIdSchema,
  content: DeliveryContentSchema,
  disclosureIds: z.array(DisclosureIdSchema),
  effectiveDisclosureLevel: DisclosureLevelSchema,
  status: DeliveryStatusSchema
}).strict();
export type DeliveryAtom = z.infer<typeof DeliveryAtomSchema>;

export const DeliveryCommandSchema = z.object({
  deliveryId: DeliveryIdSchema,
  content: DeliveryContentSchema
}).strict();
export type DeliveryCommand = z.infer<typeof DeliveryCommandSchema>;

export const isDisclosedStatus = (status: DeliveryStatus): boolean =>
  status === "EXPOSED" || status === "COMPLETED" || status === "POSSIBLY_EXPOSED";

