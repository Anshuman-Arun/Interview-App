import { z } from "zod";
import { RequestIdSchema, SessionIdSchema } from "./ids.js";
import { BoardRevisionSchema } from "./revisions.js";

export const VISION_PROTOCOL_VERSION = 1 as const;
export const MAX_VISION_ID_LENGTH = 160;
export const MAX_VISION_REGION_SHAPES = 64;
export const MAX_VISION_OBSERVATIONS = 16;
export const MAX_VISION_INTERPRETATION_LENGTH = 4_000;
export const MAX_VISION_METADATA_LENGTH = 160;
export const MAX_VISION_COORDINATE_MAGNITUDE = 1_000_000;
export const MAX_VISION_REGION_DIMENSION = 100_000;

const DIAGNOSTIC_SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/_-]*$/u;
const boundedIdentifier = (maximum = MAX_VISION_ID_LENGTH) =>
  z.string().min(1).max(maximum).regex(DIAGNOSTIC_SAFE_ID_PATTERN);

export const VisionRequestIdSchema = RequestIdSchema.refine(
  (value) => value.length <= MAX_VISION_ID_LENGTH && DIAGNOSTIC_SAFE_ID_PATTERN.test(value),
  { message: "Vision request ID must be bounded and diagnostic-safe" }
);
export const VisionSessionIdSchema = SessionIdSchema.refine(
  (value) => value.length <= MAX_VISION_ID_LENGTH && DIAGNOSTIC_SAFE_ID_PATTERN.test(value),
  { message: "Vision session ID must be bounded and diagnostic-safe" }
);
export const VisionBoardRevisionSchema = BoardRevisionSchema.refine(
  (value) => Number.isSafeInteger(value),
  { message: "Vision board revision must be a safe integer" }
);
function hasOnlyDiagnosticSafeMetadataCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f || code === 0x2028 || code === 0x2029) return false;
  }
  return true;
}

const boundedMetadata = z.string()
  .min(1)
  .max(MAX_VISION_METADATA_LENGTH)
  .refine((value) => value === value.trim(), {
    message: "Vision metadata must not contain surrounding whitespace"
  })
  .refine(hasOnlyDiagnosticSafeMetadataCharacters, {
    message: "Vision metadata contains diagnostic-unsafe control characters"
  });
const boundedInterpretation = z.string()
  .min(1)
  .max(MAX_VISION_INTERPRETATION_LENGTH)
  .refine((value) => value.trim().length > 0, {
    message: "Vision interpretation must contain non-whitespace content"
  });
const uniqueStrings = (values: readonly string[]): boolean => new Set(values).size === values.length;

export const VisionBoundsSchema = z.object({
  x: z.number().min(-MAX_VISION_COORDINATE_MAGNITUDE).max(MAX_VISION_COORDINATE_MAGNITUDE),
  y: z.number().min(-MAX_VISION_COORDINATE_MAGNITUDE).max(MAX_VISION_COORDINATE_MAGNITUDE),
  width: z.number().positive().max(MAX_VISION_REGION_DIMENSION),
  height: z.number().positive().max(MAX_VISION_REGION_DIMENSION)
}).strict().superRefine((value, context) => {
  if (value.x + value.width > MAX_VISION_COORDINATE_MAGNITUDE) {
    context.addIssue({ code: "custom", path: ["width"], message: "Vision bounds exceed the coordinate limit" });
  }
  if (value.y + value.height > MAX_VISION_COORDINATE_MAGNITUDE) {
    context.addIssue({ code: "custom", path: ["height"], message: "Vision bounds exceed the coordinate limit" });
  }
});
export type VisionBounds = z.infer<typeof VisionBoundsSchema>;

export const VisionSnapshotBasisSchema = z.object({
  snapshotId: boundedIdentifier(),
  snapshotHash: z.string().regex(/^[0-9a-f]{64}$/u),
  preprocessingVersion: boundedMetadata,
  sourceBoardRevision: VisionBoardRevisionSchema
}).strict();
export type VisionSnapshotBasis = z.infer<typeof VisionSnapshotBasisSchema>;

export const VisionRegionSchema = z.object({
  regionId: boundedIdentifier(128),
  bounds: VisionBoundsSchema,
  relevantShapeIds: z.array(boundedIdentifier()).max(MAX_VISION_REGION_SHAPES)
}).strict().superRefine((value, context) => {
  if (!uniqueStrings(value.relevantShapeIds)) {
    context.addIssue({ code: "custom", path: ["relevantShapeIds"], message: "Relevant shape IDs must be unique" });
  }
});
export type VisionRegion = z.infer<typeof VisionRegionSchema>;

export const VisionShapeRevisionBindingSchema = z.object({
  shapeId: boundedIdentifier(),
  expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
}).strict();
export type VisionShapeRevisionBinding = z.infer<typeof VisionShapeRevisionBindingSchema>;

export const VisionObservationKindSchema = z.enum([
  "TEXT",
  "EQUATION",
  "DIAGRAM_RELATION",
  "ARROW",
  "LABEL",
  "GENERAL_BOARD_DESCRIPTION"
]);
export type VisionObservationKind = z.infer<typeof VisionObservationKindSchema>;

export const VisionRequestedObservationKindSchema = z.union([
  VisionObservationKindSchema,
  z.literal("ANY")
]);
export type VisionRequestedObservationKind = z.infer<typeof VisionRequestedObservationKindSchema>;

export const VisionInferenceRequestSchema = z.object({
  protocolVersion: z.literal(VISION_PROTOCOL_VERSION),
  requestId: VisionRequestIdSchema,
  sessionId: VisionSessionIdSchema,
  sourceBoardRevision: VisionBoardRevisionSchema,
  snapshotBasis: VisionSnapshotBasisSchema,
  region: VisionRegionSchema,
  relevantShapeRevisions: z.array(VisionShapeRevisionBindingSchema).max(MAX_VISION_REGION_SHAPES),
  requestedObservationKind: VisionRequestedObservationKindSchema
}).strict().superRefine((value, context) => {
  if (value.snapshotBasis.sourceBoardRevision !== value.sourceBoardRevision) {
    context.addIssue({
      code: "custom",
      path: ["snapshotBasis", "sourceBoardRevision"],
      message: "Snapshot basis must use the request source board revision"
    });
  }

  const regionIds = new Set(value.region.relevantShapeIds);
  const bindingIds = value.relevantShapeRevisions.map((binding) => binding.shapeId);
  if (!uniqueStrings(bindingIds)) {
    context.addIssue({
      code: "custom",
      path: ["relevantShapeRevisions"],
      message: "Shape revision bindings must be unique"
    });
  }
  for (const binding of value.relevantShapeRevisions) {
    if (!regionIds.has(binding.shapeId)) {
      context.addIssue({
        code: "custom",
        path: ["relevantShapeRevisions"],
        message: "Shape revision binding must refer to a relevant region shape"
      });
    }
  }
  if (
    value.relevantShapeRevisions.length > 0
    && value.relevantShapeRevisions.length !== value.region.relevantShapeIds.length
  ) {
    context.addIssue({
      code: "custom",
      path: ["relevantShapeRevisions"],
      message: "Shape revision bindings must cover every relevant region shape when provided"
    });
  }
});
export type VisionInferenceRequest = z.infer<typeof VisionInferenceRequestSchema>;

export const VisionBackendProvenanceSchema = z.object({
  backendId: boundedIdentifier(128),
  backendVersion: boundedMetadata,
  providerId: boundedMetadata,
  modelId: boundedMetadata,
  modelVersion: boundedMetadata,
  visionCapabilityVersion: boundedMetadata
}).strict();
export type VisionBackendProvenance = z.infer<typeof VisionBackendProvenanceSchema>;

export const VisionObservationProposalSchema = z.object({
  proposalId: boundedIdentifier(),
  requestId: VisionRequestIdSchema,
  sessionId: VisionSessionIdSchema,
  sourceBoardRevision: VisionBoardRevisionSchema,
  snapshotBasis: VisionSnapshotBasisSchema,
  regionId: boundedIdentifier(128),
  relevantShapeIds: z.array(boundedIdentifier()).max(MAX_VISION_REGION_SHAPES),
  observationKind: VisionObservationKindSchema,
  interpretation: boundedInterpretation,
  confidence: z.number().min(0).max(1)
}).strict().superRefine((value, context) => {
  if (!uniqueStrings(value.relevantShapeIds)) {
    context.addIssue({ code: "custom", path: ["relevantShapeIds"], message: "Proposal shape IDs must be unique" });
  }
});
export type VisionObservationProposal = z.infer<typeof VisionObservationProposalSchema>;

export const VisionBackendResultSchema = z.object({
  protocolVersion: z.literal(VISION_PROTOCOL_VERSION),
  requestId: VisionRequestIdSchema,
  sessionId: VisionSessionIdSchema,
  sourceBoardRevision: VisionBoardRevisionSchema,
  snapshotBasis: VisionSnapshotBasisSchema,
  regionId: boundedIdentifier(128),
  backend: VisionBackendProvenanceSchema,
  proposals: z.array(VisionObservationProposalSchema).max(MAX_VISION_OBSERVATIONS)
}).strict();
export type VisionBackendResult = z.infer<typeof VisionBackendResultSchema>;

export const VisionAdmissionFreshnessProofSchema = z.enum([
  "EXACT_BOARD_REVISION",
  "SHAPE_AND_REGION_COMPATIBLE"
]);
export type VisionAdmissionFreshnessProof = z.infer<typeof VisionAdmissionFreshnessProofSchema>;

export const VisionAdmissionReasonSchema = z.enum([
  "STALE_BOARD",
  "STALE_SHAPE",
  "SNAPSHOT_MISMATCH",
  "UNKNOWN_REQUEST",
  "REQUEST_CANCELLED",
  "INVALID_OUTPUT",
  "REGION_MISMATCH",
  "SOURCE_MISMATCH",
  "FRESHNESS_UNKNOWN",
  "BACKEND_ERROR",
  "CONFLICTING_REQUEST_ID",
  "RESOURCE_LIMIT",
  "MANAGER_SHUTDOWN"
]);
export type VisionAdmissionReason = z.infer<typeof VisionAdmissionReasonSchema>;

export const BoundedBoardObservationSchema = z.object({
  regionId: boundedIdentifier(128),
  sourceBoardRevision: VisionBoardRevisionSchema,
  relevantShapeIds: z.array(boundedIdentifier()).max(MAX_VISION_REGION_SHAPES),
  bounds: VisionBoundsSchema,
  interpretation: boundedInterpretation,
  confidence: z.number().min(0).max(1)
}).strict().superRefine((value, context) => {
  if (!uniqueStrings(value.relevantShapeIds)) {
    context.addIssue({ code: "custom", path: ["relevantShapeIds"], message: "Observation shape IDs must be unique" });
  }
});
export type BoundedBoardObservation = z.infer<typeof BoundedBoardObservationSchema>;

export const AcceptedBoardObservationSchema = z.object({
  requestId: VisionRequestIdSchema,
  sessionId: VisionSessionIdSchema,
  proposalId: boundedIdentifier(),
  observationKind: VisionObservationKindSchema,
  observation: BoundedBoardObservationSchema,
  snapshotBasis: VisionSnapshotBasisSchema,
  sourceRelevantShapeIds: z.array(boundedIdentifier()).max(MAX_VISION_REGION_SHAPES),
  shapeRevisionBindings: z.array(VisionShapeRevisionBindingSchema).max(MAX_VISION_REGION_SHAPES),
  backend: VisionBackendProvenanceSchema,
  admittedAtBoardRevision: VisionBoardRevisionSchema,
  freshnessProof: VisionAdmissionFreshnessProofSchema
}).strict().superRefine((value, context) => {
  if (value.observation.sourceBoardRevision !== value.snapshotBasis.sourceBoardRevision) {
    context.addIssue({
      code: "custom",
      path: ["observation", "sourceBoardRevision"],
      message: "Accepted observation and snapshot must share the same source board revision"
    });
  }
  if (value.admittedAtBoardRevision < value.observation.sourceBoardRevision) {
    context.addIssue({
      code: "custom",
      path: ["admittedAtBoardRevision"],
      message: "Accepted observation cannot be admitted before its source board revision"
    });
  }
  if (
    value.freshnessProof === "EXACT_BOARD_REVISION"
    && value.admittedAtBoardRevision !== value.observation.sourceBoardRevision
  ) {
    context.addIssue({
      code: "custom",
      path: ["freshnessProof"],
      message: "Exact-revision freshness requires matching source and admission board revisions"
    });
  }
  if (
    value.freshnessProof === "SHAPE_AND_REGION_COMPATIBLE"
    && (
      value.admittedAtBoardRevision <= value.observation.sourceBoardRevision
      || value.shapeRevisionBindings.length === 0
    )
  ) {
    context.addIssue({
      code: "custom",
      path: ["freshnessProof"],
      message: "Narrow freshness requires an advanced board revision and shape revision provenance"
    });
  }

  if (!uniqueStrings(value.sourceRelevantShapeIds)) {
    context.addIssue({
      code: "custom",
      path: ["sourceRelevantShapeIds"],
      message: "Accepted observation source shape IDs must be unique"
    });
  }
  const sourceShapes = new Set(value.sourceRelevantShapeIds);
  for (const shapeId of value.observation.relevantShapeIds) {
    if (!sourceShapes.has(shapeId)) {
      context.addIssue({
        code: "custom",
        path: ["observation", "relevantShapeIds"],
        message: "Observed shape must belong to the accepted request source shape set"
      });
    }
  }

  const bindingIds = value.shapeRevisionBindings.map((binding) => binding.shapeId);
  if (!uniqueStrings(bindingIds)) {
    context.addIssue({
      code: "custom",
      path: ["shapeRevisionBindings"],
      message: "Accepted observation shape revision bindings must be unique"
    });
  }
  if (
    bindingIds.length > 0
    && (
      bindingIds.length !== value.sourceRelevantShapeIds.length
      || bindingIds.some((shapeId) => !sourceShapes.has(shapeId))
    )
  ) {
    context.addIssue({
      code: "custom",
      path: ["shapeRevisionBindings"],
      message: "Accepted shape revision provenance must cover the complete request source shape set"
    });
  }
});
export type AcceptedBoardObservation = z.infer<typeof AcceptedBoardObservationSchema>;

export const VisionAdmissionResultSchema = z.discriminatedUnion("accepted", [
  z.object({
    accepted: z.literal(true),
    requestId: VisionRequestIdSchema,
    observations: z.array(AcceptedBoardObservationSchema).max(MAX_VISION_OBSERVATIONS),
    backend: VisionBackendProvenanceSchema
  }).strict(),
  z.object({
    accepted: z.literal(false),
    requestId: VisionRequestIdSchema,
    reason: VisionAdmissionReasonSchema
  }).strict()
]);
export type VisionAdmissionResult = z.infer<typeof VisionAdmissionResultSchema>;

const VisionDiagnosticBaseSchema = z.object({
  requestId: VisionRequestIdSchema,
  regionId: boundedIdentifier(128),
  sourceBoardRevision: VisionBoardRevisionSchema,
  observationCount: z.number().int().nonnegative().max(MAX_VISION_OBSERVATIONS),
  backendId: boundedIdentifier(128).optional(),
  backendVersion: boundedMetadata.optional()
}).strict();

export const VisionDiagnosticSchema = z.discriminatedUnion("outcome", [
  VisionDiagnosticBaseSchema.extend({
    outcome: z.literal("ACCEPTED")
  }).strict(),
  VisionDiagnosticBaseSchema.extend({
    outcome: z.literal("REJECTED"),
    observationCount: z.literal(0),
    reason: VisionAdmissionReasonSchema
  }).strict()
]);
export type VisionDiagnostic = z.infer<typeof VisionDiagnosticSchema>;


export const MAX_WHITEBOARD_VISION_PNG_BYTES = 2 * 1024 * 1024;
export const MAX_WHITEBOARD_VISION_BASE64_LENGTH =
  Math.ceil(MAX_WHITEBOARD_VISION_PNG_BYTES / 3) * 4;

export const WhiteboardVisionSnapshotUploadSchema = z.object({
  protocolVersion: z.literal(VISION_PROTOCOL_VERSION),
  requestId: VisionRequestIdSchema,
  sessionId: VisionSessionIdSchema,
  sourceBoardRevision: VisionBoardRevisionSchema,
  snapshotId: boundedIdentifier(128),
  capturedAtMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  declaredWidth: z.number().int().positive().max(8192),
  declaredHeight: z.number().int().positive().max(8192),
  region: VisionRegionSchema,
  relevantShapeRevisions: z.array(VisionShapeRevisionBindingSchema)
    .min(1)
    .max(MAX_VISION_REGION_SHAPES),
  requestedObservationKind: VisionObservationKindSchema,
  pngBase64: z.string()
    .min(4)
    .max(MAX_WHITEBOARD_VISION_BASE64_LENGTH)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/u)
}).strict().superRefine((upload, context) => {
  if (upload.region.relevantShapeIds.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["region", "relevantShapeIds"],
      message: "Whiteboard vision requires at least one relevant shape"
    });
  }
  const regionIds = new Set(upload.region.relevantShapeIds);
  const bindingIds = upload.relevantShapeRevisions.map((binding) => binding.shapeId);
  if (
    new Set(bindingIds).size !== bindingIds.length
    || bindingIds.length !== regionIds.size
    || !bindingIds.every((shapeId) => regionIds.has(shapeId))
  ) {
    context.addIssue({
      code: "custom",
      path: ["relevantShapeRevisions"],
      message: "Whiteboard vision shape revisions must exactly cover the region shape set"
    });
  }
});
export type WhiteboardVisionSnapshotUpload = z.infer<typeof WhiteboardVisionSnapshotUploadSchema>;

export const WhiteboardVisionSnapshotResponseSchema = z.object({
  protocolVersion: z.literal(VISION_PROTOCOL_VERSION),
  requestId: VisionRequestIdSchema,
  sessionId: VisionSessionIdSchema,
  status: z.enum(["ACCEPTED", "REJECTED", "VISION_UNAVAILABLE"]),
  reason: z.string().min(1).max(240).optional(),
  observationCount: z.number().int().nonnegative().max(1),
  evidenceCommittedCount: z.number().int().nonnegative().max(1)
}).strict().superRefine((response, context) => {
  if (response.status === "ACCEPTED" && response.reason !== undefined) {
    context.addIssue({ code: "custom", path: ["reason"], message: "Accepted vision responses must not carry a rejection reason" });
  }
  if (response.status !== "ACCEPTED" && response.reason === undefined) {
    context.addIssue({ code: "custom", path: ["reason"], message: "Non-accepted vision responses require a reason" });
  }
});
export type WhiteboardVisionSnapshotResponse = z.infer<typeof WhiteboardVisionSnapshotResponseSchema>;
