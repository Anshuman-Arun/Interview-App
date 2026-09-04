import { z } from "zod";
import { DeliveryIdSchema } from "./ids.js";
import { BoardRevisionSchema } from "./revisions.js";

export const WhiteboardLayerSchema = z.enum(["STUDENT", "AI_ANNOTATION", "SYSTEM_DECORATION"]);
export type WhiteboardLayer = z.infer<typeof WhiteboardLayerSchema>;

export const MAX_INTERVIEWER_BOARD_ACTIONS = 12;
export const MAX_BOARD_ACTION_POINTS = 8;
export const MAX_BOARD_ACTION_CONTENT_CHARACTERS = 2_000;
export const MAX_BOARD_ACTION_PURPOSE_CHARACTERS = 512;
export const MAX_BOARD_ACTION_SHAPE_ID_CHARACTERS = 160;
export const MAX_BOARD_ACTION_COORDINATE_MAGNITUDE = 1_000_000;
export const MAX_BOARD_ACTION_OFFSET_MAGNITUDE = 2_000;
export const MAX_BOARD_ACTION_GEOMETRY_DIMENSION = 100_000;

const PositiveSafeShapeRevisionSchema = z.number().refine(
  (value) => Number.isSafeInteger(value) && value >= 1,
  { message: "Shape revision must be a positive safe integer" }
);
const BoardActionShapeIdSchema = z.string()
  .min(1)
  .max(MAX_BOARD_ACTION_SHAPE_ID_CHARACTERS)
  .refine((value) => value.trim().length > 0, {
    message: "targetShapeId must be non-blank"
  })
  .refine((value) => value === value.trim(), {
    message: "Board action shape IDs must not contain surrounding whitespace"
  });
const BoardActionAnnotationIdSchema = DeliveryIdSchema.refine(
  (value) => value.length <= MAX_BOARD_ACTION_SHAPE_ID_CHARACTERS,
  { message: "AI annotation ID exceeds the bounded identifier size" }
);
const BoardActionCoordinateSchema = z.number()
  .refine(Number.isFinite, { message: "Board action coordinates must be finite" })
  .min(-MAX_BOARD_ACTION_COORDINATE_MAGNITUDE)
  .max(MAX_BOARD_ACTION_COORDINATE_MAGNITUDE);
const BoardActionOffsetSchema = z.number()
  .refine(Number.isFinite, { message: "Board action offsets must be finite" })
  .min(-MAX_BOARD_ACTION_OFFSET_MAGNITUDE)
  .max(MAX_BOARD_ACTION_OFFSET_MAGNITUDE);
const BoardActionDimensionSchema = z.number()
  .refine(Number.isFinite, { message: "Board action dimensions must be finite" })
  .positive()
  .max(MAX_BOARD_ACTION_GEOMETRY_DIMENSION);

export const BoardActionPointSchema = z.object({
  x: BoardActionCoordinateSchema,
  y: BoardActionCoordinateSchema
}).strict();
export type BoardActionPoint = z.infer<typeof BoardActionPointSchema>;

const BoardActionFractionSchema = z.number()
  .refine(Number.isFinite, { message: "Board action fractions must be finite" })
  .min(0)
  .max(1);

export const BoardActionTargetRegionSchema = z.object({
  shapeId: BoardActionShapeIdSchema,
  shapeRevision: PositiveSafeShapeRevisionSchema,
  xFraction: BoardActionFractionSchema,
  yFraction: BoardActionFractionSchema,
  widthFraction: BoardActionFractionSchema.refine((value) => value > 0, {
    message: "Target-region width must be positive"
  }).optional(),
  heightFraction: BoardActionFractionSchema.refine((value) => value > 0, {
    message: "Target-region height must be positive"
  }).optional()
}).strict().superRefine((region, context) => {
  const hasWidth = region.widthFraction !== undefined;
  const hasHeight = region.heightFraction !== undefined;
  if (hasWidth !== hasHeight) {
    context.addIssue({
      code: "custom",
      message: "Target-region width and height must be supplied together"
    });
  }
  if (
    region.widthFraction !== undefined
    && region.xFraction + region.widthFraction > 1
  ) {
    context.addIssue({
      code: "custom",
      path: ["widthFraction"],
      message: "Target region must remain within the referenced shape horizontally"
    });
  }
  if (
    region.heightFraction !== undefined
    && region.yFraction + region.heightFraction > 1
  ) {
    context.addIssue({
      code: "custom",
      path: ["heightFraction"],
      message: "Target region must remain within the referenced shape vertically"
    });
  }
});
export type BoardActionTargetRegion = z.infer<typeof BoardActionTargetRegionSchema>;

export const BoardActionPlacementSchema = z.object({
  anchorShapeId: BoardActionShapeIdSchema.optional(),
  anchorRevision: PositiveSafeShapeRevisionSchema.optional(),
  position: z.enum(["LEFT", "RIGHT", "ABOVE", "BELOW", "CENTER"]).optional(),
  x: BoardActionCoordinateSchema.optional(),
  y: BoardActionCoordinateSchema.optional(),
  offsetX: BoardActionOffsetSchema.optional(),
  offsetY: BoardActionOffsetSchema.optional()
}).strict().superRefine((placement, context) => {
  const anchored = placement.anchorShapeId !== undefined;
  const hasX = placement.x !== undefined;
  const hasY = placement.y !== undefined;
  if (hasX !== hasY) {
    context.addIssue({
      code: "custom",
      message: "Absolute board placement requires both x and y"
    });
  }
  if (anchored && (hasX || hasY)) {
    context.addIssue({
      code: "custom",
      message: "Board placement must be either shape-relative or absolute, not both"
    });
  }
  if (!anchored && !hasX) {
    context.addIssue({
      code: "custom",
      message: "Board placement requires an anchor shape or absolute coordinates"
    });
  }
  if (placement.anchorRevision !== undefined && !anchored) {
    context.addIssue({
      code: "custom",
      path: ["anchorRevision"],
      message: "anchorRevision requires anchorShapeId"
    });
  }
  if (placement.position !== undefined && !anchored) {
    context.addIssue({
      code: "custom",
      path: ["position"],
      message: "Relative position requires anchorShapeId"
    });
  }
  if (anchored && placement.anchorRevision === undefined) {
    context.addIssue({
      code: "custom",
      path: ["anchorRevision"],
      message: "Shape-relative placement requires the exact anchor revision"
    });
  }
  if (anchored && placement.position === undefined) {
    context.addIssue({
      code: "custom",
      path: ["position"],
      message: "Shape-relative placement requires an explicit relative position"
    });
  }
});
export type BoardActionPlacement = z.infer<typeof BoardActionPlacementSchema>;

const BoardActionBaseSchema = z.object({
  operation: z.enum([
    "write_text",
    "write_equation",
    "draw_arrow",
    "circle",
    "highlight",
    "point_at",
    "erase_ai_annotation",
    "draw_segment",
    "draw_arrow_between",
    "draw_polyline",
    "draw_rectangle",
    "draw_ellipse"
  ]),
  layer: z.literal("AI_ANNOTATION"),
  content: z.string().max(MAX_BOARD_ACTION_CONTENT_CHARACTERS).optional(),
  targetShapeId: BoardActionShapeIdSchema.optional(),
  expectedShapeRevision: PositiveSafeShapeRevisionSchema.optional(),
  targetAnnotationId: BoardActionAnnotationIdSchema.optional(),
  targetRegion: BoardActionTargetRegionSchema.optional(),
  placement: BoardActionPlacementSchema.optional(),
  points: z.array(BoardActionPointSchema).max(MAX_BOARD_ACTION_POINTS).optional(),
  fromShapeId: BoardActionShapeIdSchema.optional(),
  fromShapeRevision: PositiveSafeShapeRevisionSchema.optional(),
  toShapeId: BoardActionShapeIdSchema.optional(),
  toShapeRevision: PositiveSafeShapeRevisionSchema.optional(),
  width: BoardActionDimensionSchema.optional(),
  height: BoardActionDimensionSchema.optional(),
  annotationPurpose: z.string()
    .min(1)
    .max(MAX_BOARD_ACTION_PURPOSE_CHARACTERS)
    .refine((value) => value.trim().length > 0, {
      message: "annotationPurpose must be non-blank"
    })
}).strict();

export const BoardActionSchema = BoardActionBaseSchema.superRefine((action, context) => {
  const issue = (path: string[], message: string): void => {
    context.addIssue({ code: "custom", path, message });
  };

  if (action.expectedShapeRevision !== undefined && action.targetShapeId === undefined) {
    issue(["expectedShapeRevision"], "expectedShapeRevision requires targetShapeId");
  }
  if (action.fromShapeRevision !== undefined && action.fromShapeId === undefined) {
    issue(["fromShapeRevision"], "fromShapeRevision requires fromShapeId");
  }
  if (action.toShapeRevision !== undefined && action.toShapeId === undefined) {
    issue(["toShapeRevision"], "toShapeRevision requires toShapeId");
  }
  if (
    action.targetRegion !== undefined
    && (action.targetShapeId !== undefined || action.expectedShapeRevision !== undefined)
  ) {
    issue(["targetRegion"], "targetRegion cannot be combined with whole-shape target fields");
  }

  const forbid = (field: keyof typeof action, allowed: boolean): void => {
    if (!allowed && action[field] !== undefined) {
      issue([field], `${field} is not valid for ${action.operation}`);
    }
  };

  const isWrite = action.operation === "write_text" || action.operation === "write_equation";
  const isTargetOverlay =
    action.operation === "draw_arrow"
    || action.operation === "circle"
    || action.operation === "highlight"
    || action.operation === "point_at";
  const isErase = action.operation === "erase_ai_annotation";
  const isPointGeometry = action.operation === "draw_segment" || action.operation === "draw_polyline";
  const isBoxGeometry = action.operation === "draw_rectangle" || action.operation === "draw_ellipse";
  const isArrowBetween = action.operation === "draw_arrow_between";

  forbid("placement", isWrite || isBoxGeometry);
  forbid("points", isPointGeometry);
  forbid("fromShapeId", isArrowBetween);
  forbid("fromShapeRevision", isArrowBetween);
  forbid("toShapeId", isArrowBetween);
  forbid("toShapeRevision", isArrowBetween);
  forbid("width", isBoxGeometry);
  forbid("height", isBoxGeometry);
  forbid("targetShapeId", isWrite || isTargetOverlay);
  forbid("expectedShapeRevision", isWrite || isTargetOverlay);
  forbid("targetAnnotationId", isErase);
  forbid("targetRegion", isTargetOverlay);

  if (isPointGeometry) {
    const length = action.points?.length ?? 0;
    if (action.operation === "draw_segment" && length !== 2) {
      issue(["points"], "draw_segment requires exactly two bounded points");
    }
    if (action.operation === "draw_polyline" && (length < 2 || length > MAX_BOARD_ACTION_POINTS)) {
      issue(["points"], "draw_polyline requires between two and eight bounded points");
    }
  }
  if (isBoxGeometry) {
    if (action.placement === undefined) issue(["placement"], `${action.operation} requires placement`);
    if (action.width === undefined) issue(["width"], `${action.operation} requires width`);
    if (action.height === undefined) issue(["height"], `${action.operation} requires height`);
  }
  if (isArrowBetween) {
    if (action.fromShapeId === undefined) issue(["fromShapeId"], "draw_arrow_between requires fromShapeId");
    if (action.fromShapeRevision === undefined) issue(["fromShapeRevision"], "draw_arrow_between requires fromShapeRevision");
    if (action.toShapeId === undefined) issue(["toShapeId"], "draw_arrow_between requires toShapeId");
    if (action.toShapeRevision === undefined) issue(["toShapeRevision"], "draw_arrow_between requires toShapeRevision");
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

export const BoardShapeIdSchema = z.string()
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
  .min(-MAX_BOARD_COORDINATE_MAGNITUDE)
  .max(MAX_BOARD_COORDINATE_MAGNITUDE);
const BoardDimensionSchema = z.number()
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

export function authoritativeBoardShapeCanonicalJson(
  input: AuthoritativeStudentShape
): string {
  const shape = AuthoritativeStudentShapeSchema.parse(input);
  return JSON.stringify({
    id: shape.id,
    type: shape.type,
    bounds: {
      x: shape.bounds.x,
      y: shape.bounds.y,
      width: shape.bounds.width,
      height: shape.bounds.height
    },
    points: shape.points === undefined
      ? null
      : shape.points.map((point) => ({ x: point.x, y: point.y })),
    text: shape.text ?? null,
    revision: shape.revision,
    createdAt: shape.createdAt,
    lastModifiedAt: shape.lastModifiedAt
  });
}

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

export const MAX_BOARD_SCENE_SHAPES = 24;
export const MAX_BOARD_SCENE_AI_ANNOTATIONS = 6;
export const MAX_BOARD_SCENE_SEMANTIC_RELATIONS = 8;
export const MAX_BOARD_SCENE_RELATION_SHAPES = 8;
export const MAX_BOARD_SCENE_TEXT_CHARACTERS = 384;
export const MAX_BOARD_SCENE_OBSERVATION_CHARACTERS = 384;
export const MAX_BOARD_SCENE_ANNOTATION_PURPOSE_CHARACTERS = 160;
export const MAX_BOARD_SCENE_BYTES = 12 * 1024;
export const MIN_BOARD_SCENE_SEMANTIC_CONFIDENCE = 0.6;

const BoardSceneTextSchema = z.string().max(MAX_BOARD_SCENE_TEXT_CHARACTERS);
const BoardSceneObservationTextSchema = z.string()
  .min(1)
  .max(MAX_BOARD_SCENE_OBSERVATION_CHARACTERS);

export const BoardSceneSemanticObservationSchema = z.object({
  kind: z.enum([
    "TEXT",
    "EQUATION",
    "DIAGRAM_RELATION",
    "ARROW",
    "LABEL",
    "GENERAL_BOARD_DESCRIPTION"
  ]),
  interpretation: BoardSceneObservationTextSchema,
  confidence: z.number().min(0).max(1),
  sourceBoardRevision: BoardRevisionSchema
}).strict();
export type BoardSceneSemanticObservation = z.infer<typeof BoardSceneSemanticObservationSchema>;

export const BoardSceneShapeSchema = z.object({
  shapeId: BoardShapeIdSchema,
  shapeRevision: PositiveSafeBoardShapeRevisionSchema,
  type: AuthoritativeBoardShapeTypeSchema,
  bounds: AuthoritativeBoardBoundsSchema,
  text: BoardSceneTextSchema.optional(),
  semanticObservation: BoardSceneSemanticObservationSchema.optional()
}).strict();
export type BoardSceneShape = z.infer<typeof BoardSceneShapeSchema>;

export const BoardSceneSemanticRelationSchema = z.object({
  observationId: z.string().min(1).max(MAX_BOARD_ACTION_SHAPE_ID_CHARACTERS),
  kind: BoardSceneSemanticObservationSchema.shape.kind,
  relevantShapeIds: z.array(BoardShapeIdSchema)
    .min(2)
    .max(MAX_BOARD_SCENE_RELATION_SHAPES),
  bounds: AuthoritativeBoardBoundsSchema,
  interpretation: BoardSceneObservationTextSchema,
  confidence: z.number().min(0).max(1),
  sourceBoardRevision: BoardRevisionSchema
}).strict();
export type BoardSceneSemanticRelation = z.infer<typeof BoardSceneSemanticRelationSchema>;

export const BoardSceneAiAnnotationSchema = z.object({
  annotationId: BoardActionAnnotationIdSchema,
  operation: z.string().min(1).max(64),
  purpose: z.string().min(1).max(MAX_BOARD_SCENE_ANNOTATION_PURPOSE_CHARACTERS),
  content: BoardSceneTextSchema.optional(),
  targetShapeId: BoardShapeIdSchema.optional(),
  targetShapeRevision: PositiveSafeBoardShapeRevisionSchema.optional(),
  targetRegion: BoardActionTargetRegionSchema.optional(),
  placement: BoardActionPlacementSchema.optional(),
  points: z.array(BoardActionPointSchema).max(MAX_BOARD_ACTION_POINTS).optional(),
  fromShapeId: BoardShapeIdSchema.optional(),
  fromShapeRevision: PositiveSafeBoardShapeRevisionSchema.optional(),
  toShapeId: BoardShapeIdSchema.optional(),
  toShapeRevision: PositiveSafeBoardShapeRevisionSchema.optional(),
  width: BoardActionDimensionSchema.optional(),
  height: BoardActionDimensionSchema.optional()
}).strict().superRefine((annotation, context) => {
  if (annotation.targetShapeRevision !== undefined && annotation.targetShapeId === undefined) {
    context.addIssue({
      code: "custom",
      path: ["targetShapeRevision"],
      message: "AI annotation target revision requires targetShapeId"
    });
  }
});
export type BoardSceneAiAnnotation = z.infer<typeof BoardSceneAiAnnotationSchema>;

const NonnegativeSceneCountSchema = z.number().refine(
  (value) => Number.isSafeInteger(value) && value >= 0,
  { message: "Board scene counts must be non-negative safe integers" }
);

export const BoardSceneContextSchema = z.object({
  boardRevision: BoardRevisionSchema,
  studentShapeCount: NonnegativeSceneCountSchema.default(0),
  includedStudentShapeCount: NonnegativeSceneCountSchema.default(0),
  omittedStudentShapeCount: NonnegativeSceneCountSchema.default(0),
  studentShapesTruncated: z.boolean().default(false),
  aiAnnotationCount: NonnegativeSceneCountSchema.default(0),
  includedAiAnnotationCount: NonnegativeSceneCountSchema.default(0),
  aiAnnotationsTruncated: z.boolean().default(false),
  contentBounds: AuthoritativeBoardBoundsSchema.optional(),
  shapes: z.array(BoardSceneShapeSchema).max(MAX_BOARD_SCENE_SHAPES),
  semanticRelations: z.array(BoardSceneSemanticRelationSchema)
    .max(MAX_BOARD_SCENE_SEMANTIC_RELATIONS)
    .default([]),
  aiAnnotations: z.array(BoardSceneAiAnnotationSchema).max(MAX_BOARD_SCENE_AI_ANNOTATIONS)
}).strict();
export type BoardSceneContext = z.infer<typeof BoardSceneContextSchema>;

