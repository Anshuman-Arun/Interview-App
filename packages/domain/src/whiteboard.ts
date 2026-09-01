import { z } from "zod";
import { BoardRevisionSchema } from "./revisions.js";

export const WhiteboardLayerSchema = z.enum(["STUDENT", "AI_ANNOTATION", "SYSTEM_DECORATION"]);
export type WhiteboardLayer = z.infer<typeof WhiteboardLayerSchema>;

const PositiveSafeShapeRevisionSchema = z.number().refine(
  (value) => Number.isSafeInteger(value) && value >= 1,
  { message: "expectedShapeRevision must be a positive safe integer" }
);

export const BoardActionSchema = z.object({
  operation: z.enum([
    "write_text", "write_equation", "draw_arrow", "circle", "highlight", "point_at", "erase_ai_annotation"
  ]),
  layer: z.literal("AI_ANNOTATION"),
  content: z.string().optional(),
  targetShapeId: z.string().refine(
    (value) => value.trim().length > 0,
    { message: "targetShapeId must be non-blank" }
  ).optional(),
  expectedShapeRevision: PositiveSafeShapeRevisionSchema.optional(),
  annotationPurpose: z.string().refine(
    (value) => value.trim().length > 0,
    { message: "annotationPurpose must be non-blank" }
  )
}).strict().superRefine((action, context) => {
  if (action.expectedShapeRevision !== undefined && action.targetShapeId === undefined) {
    context.addIssue({
      code: "custom",
      path: ["expectedShapeRevision"],
      message: "expectedShapeRevision requires targetShapeId"
    });
  }
});
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

