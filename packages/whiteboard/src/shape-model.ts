import { z } from "zod";
import { BoardActionSchema } from "../../domain/src/index.js";

export const BoundingBoxSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().nonnegative(),
  height: z.number().nonnegative()
}).strict();
export type BoundingBox = z.infer<typeof BoundingBoxSchema>;

export const StudentShapeTypeSchema = z.enum(["stroke", "text", "rectangle", "ellipse", "arrow", "formula"]);
export type StudentShapeType = z.infer<typeof StudentShapeTypeSchema>;

export const StudentShapeSchema = z.object({
  id: z.string().min(1),
  type: StudentShapeTypeSchema,
  bounds: BoundingBoxSchema,
  points: z.array(z.object({ x: z.number(), y: z.number() })).optional(),
  text: z.string().optional(),
  revision: z.number().int().nonnegative(),
  createdAt: z.number().nonnegative(),
  lastModifiedAt: z.number().nonnegative()
}).strict();
export type StudentShape = z.infer<typeof StudentShapeSchema>;

export const AiAnnotationSchema = z.object({
  id: z.string().min(1),
  action: BoardActionSchema,
  appliedAtBoardRevision: z.number().int().nonnegative(),
  createdAt: z.number().nonnegative()
}).strict();
export type AiAnnotation = z.infer<typeof AiAnnotationSchema>;

export const WhiteboardSnapshotSchema = z.object({
  boardRevision: z.number().int().nonnegative(),
  studentShapes: z.array(StudentShapeSchema),
  aiAnnotations: z.array(AiAnnotationSchema),
  timestamp: z.number().nonnegative()
}).strict();
export type WhiteboardSnapshot = z.infer<typeof WhiteboardSnapshotSchema>;
