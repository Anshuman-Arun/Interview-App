import { z } from "zod";
import { BoardRevisionSchema } from "./revisions.js";

export const WhiteboardLayerSchema = z.enum(["STUDENT", "AI_ANNOTATION", "SYSTEM_DECORATION"]);
export type WhiteboardLayer = z.infer<typeof WhiteboardLayerSchema>;

export const BoardActionSchema = z.object({
  operation: z.enum([
    "write_text", "write_equation", "draw_arrow", "circle", "highlight", "point_at", "erase_ai_annotation"
  ]),
  layer: z.literal("AI_ANNOTATION"),
  content: z.string().optional(),
  targetShapeId: z.string().min(1).optional(),
  expectedShapeRevision: z.number().int().nonnegative().optional(),
  annotationPurpose: z.string().min(1)
}).strict();
export type BoardAction = z.infer<typeof BoardActionSchema>;

export const BoardObservationSchema = z.object({
  regionId: z.string().min(1),
  sourceBoardRevision: BoardRevisionSchema,
  relevantShapeIds: z.array(z.string().min(1)),
  bounds: z.object({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() }),
  interpretation: z.string(),
  confidence: z.number().min(0).max(1)
}).strict();
export type BoardObservation = z.infer<typeof BoardObservationSchema>;

export interface WhiteboardAdapter {
  readonly applyAiOverlayAction: (action: BoardAction) => Promise<void>;
  readonly clearAiOverlay: () => Promise<void>;
}

