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



export const MAX_AUTHORITATIVE_BOARD_SHAPES = 2_048;
export const MAX_BOARD_MUTATION_SHAPES = 64;
export const MAX_BOARD_SHAPE_POINTS = 1_024;
export const MAX_BOARD_SHAPE_TEXT = 8_000;
export const MAX_BOARD_SHAPE_ID_LENGTH = 160;
export const MAX_BOARD_COORDINATE_MAGNITUDE = 1_000_000;

const BoardShapeIdSchema = z.string()
  .min(1)
  .max(MAX_BOARD_SHAPE_ID_LENGTH)
  .refine((value) => value === value.trim(), {
    message: "Board shape IDs must not contain surrounding whitespace"
  });
const PositiveSafeBoardShapeRevisionSchema = z.number().refine(
  (value) => Number.isSafeInteger(value) && value >= 1,
  { message: "Board shape revision must be a positive safe integer" }
);
const NonnegativeSafeTimestampSchema = z.number().refine(
  (value) => Number.isSafeInteger(value) && value >= 0,
  { message: "Board shape timestamp must be a non-negative safe integer" }
);
const BoardCoordinateSchema = z.number()
  .finite()
  .min(-MAX_BOARD_COORDINATE_MAGNITUDE)
  .max(MAX_BOARD_COORDINATE_MAGNITUDE);
const BoardDimensionSchema = z.number()
  .finite()
  .nonnegative()
  .max(MAX_BOARD_COORDINATE_MAGNITUDE);

export const AuthoritativeBoardShapeTypeSchema = z.enum([
  "stroke",
  "text",
  "rectangle",
  "ellipse",
  "arrow",
  "formula"
]);
export type AuthoritativeBoardShapeType = z.infer<typeof AuthoritativeBoardShapeTypeSchema>;

export const AuthoritativeBoardBoundsSchema = z.object({
  x: BoardCoordinateSchema,
  y: BoardCoordinateSchema,
  width: BoardDimensionSchema,
  height: BoardDimensionSchema
}).strict().superRefine((bounds, context) => {
  const right = bounds.x + bounds.width;
  const bottom = bounds.y + bounds.height;
  if (
    !Number.isFinite(right)
    || !Number.isFinite(bottom)
    || Math.abs(right) > MAX_BOARD_COORDINATE_MAGNITUDE * 2
    || Math.abs(bottom) > MAX_BOARD_COORDINATE_MAGNITUDE * 2
  ) {
    context.addIssue({ code: "custom", message: "Board shape bounds exceed the coordinate envelope" });
  }
});
export type AuthoritativeBoardBounds = z.infer<typeof AuthoritativeBoardBoundsSchema>;

export const AuthoritativeStudentShapeSchema = z.object({
  id: BoardShapeIdSchema,
  type: AuthoritativeBoardShapeTypeSchema,
  bounds: AuthoritativeBoardBoundsSchema,
  points: z.array(z.object({
    x: BoardCoordinateSchema,
    y: BoardCoordinateSchema
  }).strict()).max(MAX_BOARD_SHAPE_POINTS).optional(),
  text: z.string().max(MAX_BOARD_SHAPE_TEXT).optional(),
  revision: PositiveSafeBoardShapeRevisionSchema,
  createdAt: NonnegativeSafeTimestampSchema,
  lastModifiedAt: NonnegativeSafeTimestampSchema
}).strict().superRefine((shape, context) => {
  if (shape.lastModifiedAt < shape.createdAt) {
    context.addIssue({
      code: "custom",
      path: ["lastModifiedAt"],
      message: "Board shape modification time cannot precede creation time"
    });
  }
});
export type AuthoritativeStudentShape = z.infer<typeof AuthoritativeStudentShapeSchema>;

export const NormalizedBoardMutationSchema = z.object({
  baseBoardRevision: BoardRevisionSchema.refine(Number.isSafeInteger, {
    message: "Board mutation basis must be a safe integer"
  }),
  added: z.array(AuthoritativeStudentShapeSchema).max(MAX_BOARD_MUTATION_SHAPES),
  updated: z.array(z.object({
    beforeRevision: PositiveSafeBoardShapeRevisionSchema,
    shape: AuthoritativeStudentShapeSchema
  }).strict()).max(MAX_BOARD_MUTATION_SHAPES),
  deleted: z.array(z.object({
    shapeId: BoardShapeIdSchema,
    expectedRevision: PositiveSafeBoardShapeRevisionSchema
  }).strict()).max(MAX_BOARD_MUTATION_SHAPES)
}).strict().superRefine((mutation, context) => {
  const operationCount = mutation.added.length + mutation.updated.length + mutation.deleted.length;
  if (operationCount === 0) {
    context.addIssue({ code: "custom", message: "Board mutation must contain at least one shape change" });
  }
  if (operationCount > MAX_BOARD_MUTATION_SHAPES) {
    context.addIssue({
      code: "custom",
      message: "Board mutation exceeds the total shape-change limit"
    });
  }

  const ids = [
    ...mutation.added.map((shape) => shape.id),
    ...mutation.updated.map((entry) => entry.shape.id),
    ...mutation.deleted.map((entry) => entry.shapeId)
  ];
  if (new Set(ids).size !== ids.length) {
    context.addIssue({
      code: "custom",
      message: "A shape may appear only once in a normalized board mutation"
    });
  }
  for (const entry of mutation.updated) {
    if (entry.shape.revision !== entry.beforeRevision + 1) {
      context.addIssue({
        code: "custom",
        path: ["updated"],
        message: "Updated board shapes must advance their shape revision exactly once"
      });
    }
  }
});
export type NormalizedBoardMutation = z.infer<typeof NormalizedBoardMutationSchema>;
