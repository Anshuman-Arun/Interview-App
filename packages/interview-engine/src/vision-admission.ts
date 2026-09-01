import { z } from "zod";
import {
  AcceptedBoardObservationSchema,
  BoundedBoardObservationSchema,
  MAX_VISION_INTERPRETATION_LENGTH,
  MAX_VISION_OBSERVATIONS,
  MAX_VISION_REGION_SHAPES,
  VisionBackendProvenanceSchema,
  VisionBackendResultSchema,
  VisionBoardRevisionSchema,
  VisionInferenceRequestSchema,
  VisionSessionIdSchema,
  VisionShapeRevisionBindingSchema,
  type BoardRevision,
  type VisionAdmissionReason,
  type VisionAdmissionResult,
  type VisionBackendProvenance,
  type VisionInferenceRequest,
  type VisionSnapshotBasis
} from "../../domain/src/index.js";

export const VisionCompatibilitySchema = z.enum(["COMPATIBLE", "INCOMPATIBLE", "UNKNOWN"]);
export type VisionCompatibility = z.infer<typeof VisionCompatibilitySchema>;

export const VisionCurrentShapeStateSchema = z.object({
  shapeId: VisionShapeRevisionBindingSchema.shape.shapeId,
  currentRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable()
}).strict();
export type VisionCurrentShapeState = z.infer<typeof VisionCurrentShapeStateSchema>;

export const VisionAuthorityViewSchema = z.object({
  sessionId: VisionSessionIdSchema,
  boardRevision: VisionBoardRevisionSchema,
  currentShapeRevisions: z.array(VisionCurrentShapeStateSchema).max(MAX_VISION_REGION_SHAPES).optional(),
  regionCompatibility: VisionCompatibilitySchema.optional()
}).strict().superRefine((value, context) => {
  if (value.currentShapeRevisions === undefined) return;
  const ids = value.currentShapeRevisions.map((shape) => shape.shapeId);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({
      code: "custom",
      path: ["currentShapeRevisions"],
      message: "Authority shape states must use unique shape IDs"
    });
  }
});
export type VisionAuthorityView = z.infer<typeof VisionAuthorityViewSchema>;

export type VisionFreshnessAssessment =
  | { readonly fresh: true; readonly currentBoardRevision: BoardRevision }
  | { readonly fresh: false; readonly reason: VisionAdmissionReason };

const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const getPrototypeOf: (value: object) => object | null = Object.getPrototypeOf;
const reflectOwnKeys = Reflect.ownKeys;
const arrayIsArray = Array.isArray;
const objectPrototype = Object.prototype;
const BACKEND_RESULT_KEYS = new Set([
  "protocolVersion",
  "requestId",
  "sessionId",
  "sourceBoardRevision",
  "snapshotBasis",
  "regionId",
  "backend",
  "proposals"
]);
const SNAPSHOT_BASIS_KEYS = new Set([
  "snapshotId",
  "snapshotHash",
  "preprocessingVersion",
  "sourceBoardRevision"
]);
const BACKEND_PROVENANCE_KEYS = new Set([
  "backendId",
  "backendVersion",
  "providerId",
  "modelId",
  "modelVersion",
  "visionCapabilityVersion"
]);
const PROPOSAL_KEYS = new Set([
  "proposalId",
  "requestId",
  "sessionId",
  "sourceBoardRevision",
  "snapshotBasis",
  "regionId",
  "relevantShapeIds",
  "observationKind",
  "interpretation",
  "confidence"
]);

function snapshotsEqual(left: VisionSnapshotBasis, right: VisionSnapshotBasis): boolean {
  return left.snapshotId === right.snapshotId
    && left.snapshotHash === right.snapshotHash
    && left.preprocessingVersion === right.preprocessingVersion
    && left.sourceBoardRevision === right.sourceBoardRevision;
}

function backendsEqual(left: VisionBackendProvenance, right: VisionBackendProvenance): boolean {
  return left.backendId === right.backendId
    && left.backendVersion === right.backendVersion
    && left.providerId === right.providerId
    && left.modelId === right.modelId
    && left.modelVersion === right.modelVersion
    && left.visionCapabilityVersion === right.visionCapabilityVersion;
}

function isSubset(values: readonly string[], allowedValues: readonly string[]): boolean {
  const allowed = new Set(allowedValues);
  return values.every((value) => allowed.has(value));
}

function ownDataValue(value: object, key: PropertyKey): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  try {
    const descriptor = getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) return { ok: true, value: undefined };
    if (!("value" in descriptor)) return { ok: false };
    return { ok: true, value: descriptor.value };
  } catch {
    return { ok: false };
  }
}

function isInertDataObject(value: unknown, allowedKeys?: ReadonlySet<string>): value is object {
  if (typeof value !== "object" || value === null || arrayIsArray(value)) return false;
  try {
    const prototype = getPrototypeOf(value);
    if (prototype !== objectPrototype && prototype !== null) return false;
    let stringKeyCount = 0;
    for (const key of reflectOwnKeys(value)) {
      if (typeof key !== "string") return false;
      if (allowedKeys !== undefined && !allowedKeys.has(key)) return false;
      const descriptor = getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor)) return false;
      stringKeyCount += 1;
    }
    return allowedKeys === undefined || stringKeyCount === allowedKeys.size;
  } catch {
    return false;
  }
}

function isDenseInertArray(value: unknown, maximum: number): value is readonly unknown[] {
  if (!arrayIsArray(value) || value.length > maximum) return false;
  try {
    let elementCount = 0;
    for (const key of reflectOwnKeys(value)) {
      if (key === "length") continue;
      if (typeof key !== "string") return false;
      const index = Number(key);
      if (
        !Number.isSafeInteger(index)
        || index < 0
        || index >= value.length
        || String(index) !== key
      ) return false;
      const descriptor = getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor)) return false;
      elementCount += 1;
    }
    return elementCount === value.length;
  } catch {
    return false;
  }
}

function inertNestedObject(value: unknown, allowedKeys: ReadonlySet<string>): boolean {
  return typeof value !== "object" || value === null || isInertDataObject(value, allowedKeys);
}

function backendResultWithinPreflightBounds(rawResult: unknown, maximum: number): boolean {
  if (!isInertDataObject(rawResult, BACKEND_RESULT_KEYS)) return false;

  const snapshot = ownDataValue(rawResult, "snapshotBasis");
  if (!snapshot.ok || !inertNestedObject(snapshot.value, SNAPSHOT_BASIS_KEYS)) return false;
  const backend = ownDataValue(rawResult, "backend");
  if (!backend.ok || !inertNestedObject(backend.value, BACKEND_PROVENANCE_KEYS)) return false;

  const proposalsProperty = ownDataValue(rawResult, "proposals");
  if (!proposalsProperty.ok) return false;
  if (!arrayIsArray(proposalsProperty.value)) return true;
  if (!isDenseInertArray(proposalsProperty.value, Math.min(maximum, MAX_VISION_OBSERVATIONS))) return false;
  const proposals = proposalsProperty.value;

  for (let index = 0; index < proposals.length; index += 1) {
    const proposalProperty = ownDataValue(proposals, String(index));
    if (!proposalProperty.ok) return false;
    const proposal = proposalProperty.value;
    if (!isInertDataObject(proposal, PROPOSAL_KEYS)) return false;

    const snapshotProperty = ownDataValue(proposal, "snapshotBasis");
    if (!snapshotProperty.ok || !inertNestedObject(snapshotProperty.value, SNAPSHOT_BASIS_KEYS)) return false;

    const shapesProperty = ownDataValue(proposal, "relevantShapeIds");
    if (!shapesProperty.ok) return false;
    if (
      arrayIsArray(shapesProperty.value)
      && !isDenseInertArray(shapesProperty.value, MAX_VISION_REGION_SHAPES)
    ) return false;

    const interpretationProperty = ownDataValue(proposal, "interpretation");
    if (!interpretationProperty.ok) return false;
    if (
      typeof interpretationProperty.value === "string"
      && interpretationProperty.value.length > MAX_VISION_INTERPRETATION_LENGTH
    ) return false;
  }
  return true;
}

function currentShapeState(
  states: readonly VisionCurrentShapeState[],
  shapeId: string
): VisionCurrentShapeState | undefined {
  return states.find((state) => state.shapeId === shapeId);
}

function expectedShapeRevision(request: VisionInferenceRequest, shapeId: string): number | undefined {
  return request.relevantShapeRevisions.find((binding) => binding.shapeId === shapeId)?.expectedRevision;
}

function assessBoundShapeFreshness(
  request: VisionInferenceRequest,
  authority: VisionAuthorityView,
  boardAdvanced: boolean
): VisionFreshnessAssessment | undefined {
  if (request.relevantShapeRevisions.length === 0) {
    return boardAdvanced ? { fresh: false, reason: "STALE_BOARD" } : undefined;
  }

  const currentStates = authority.currentShapeRevisions;
  if (currentStates === undefined) {
    return boardAdvanced ? { fresh: false, reason: "STALE_BOARD" } : undefined;
  }
  if (currentStates.length !== request.region.relevantShapeIds.length) {
    return { fresh: false, reason: "FRESHNESS_UNKNOWN" };
  }

  for (const shapeId of request.region.relevantShapeIds) {
    const expectedRevision = expectedShapeRevision(request, shapeId);
    const current = currentShapeState(currentStates, shapeId);
    if (expectedRevision === undefined || current === undefined) {
      return { fresh: false, reason: "FRESHNESS_UNKNOWN" };
    }
    if (current.currentRevision === null) return { fresh: false, reason: "STALE_SHAPE" };
    if (current.currentRevision !== expectedRevision) return { fresh: false, reason: "STALE_SHAPE" };
  }
  return undefined;
}

export function assessVisionRequestFreshness(
  requestInput: VisionInferenceRequest,
  authorityInput: VisionAuthorityView
): VisionFreshnessAssessment {
  const request = VisionInferenceRequestSchema.parse(requestInput);
  let authority: ReturnType<typeof VisionAuthorityViewSchema.safeParse>;
  try {
    authority = VisionAuthorityViewSchema.safeParse(authorityInput);
  } catch {
    return { fresh: false, reason: "FRESHNESS_UNKNOWN" };
  }
  if (!authority.success) return { fresh: false, reason: "FRESHNESS_UNKNOWN" };
  if (authority.data.sessionId !== request.sessionId) return { fresh: false, reason: "SOURCE_MISMATCH" };
  if (authority.data.boardRevision < request.sourceBoardRevision) {
    return { fresh: false, reason: "SOURCE_MISMATCH" };
  }

  const boardAdvanced = authority.data.boardRevision > request.sourceBoardRevision;
  const shapeFreshness = assessBoundShapeFreshness(request, authority.data, boardAdvanced);
  if (shapeFreshness !== undefined) return shapeFreshness;

  const regionCompatibility = authority.data.regionCompatibility;
  if (boardAdvanced && regionCompatibility === undefined) {
    return { fresh: false, reason: "FRESHNESS_UNKNOWN" };
  }
  if (regionCompatibility === "UNKNOWN") return { fresh: false, reason: "FRESHNESS_UNKNOWN" };
  if (regionCompatibility === "INCOMPATIBLE") return { fresh: false, reason: "REGION_MISMATCH" };

  return { fresh: true, currentBoardRevision: authority.data.boardRevision };
}

export function admitVisionBackendResult(input: {
  readonly request: VisionInferenceRequest;
  readonly rawResult: unknown;
  readonly authority: VisionAuthorityView;
  readonly expectedBackend: VisionBackendProvenance;
  readonly maxObservations?: number;
}): VisionAdmissionResult {
  const request = VisionInferenceRequestSchema.parse(input.request);
  const expectedBackend = VisionBackendProvenanceSchema.parse(input.expectedBackend);
  const maximum = input.maxObservations ?? MAX_VISION_OBSERVATIONS;
  if (!Number.isInteger(maximum) || maximum < 0 || maximum > MAX_VISION_OBSERVATIONS) {
    return { accepted: false, requestId: request.requestId, reason: "RESOURCE_LIMIT" };
  }
  const preflightValid = (() => {
    try {
      return backendResultWithinPreflightBounds(input.rawResult, maximum);
    } catch {
      return false;
    }
  })();
  if (!preflightValid) {
    return { accepted: false, requestId: request.requestId, reason: "INVALID_OUTPUT" };
  }

  let parsed: ReturnType<typeof VisionBackendResultSchema.safeParse>;
  try {
    parsed = VisionBackendResultSchema.safeParse(input.rawResult);
  } catch {
    return { accepted: false, requestId: request.requestId, reason: "INVALID_OUTPUT" };
  }
  if (!parsed.success) return { accepted: false, requestId: request.requestId, reason: "INVALID_OUTPUT" };
  const result = parsed.data;
  if (result.proposals.length > maximum) {
    return { accepted: false, requestId: request.requestId, reason: "INVALID_OUTPUT" };
  }

  if (
    result.requestId !== request.requestId
    || result.sessionId !== request.sessionId
    || result.sourceBoardRevision !== request.sourceBoardRevision
  ) {
    return { accepted: false, requestId: request.requestId, reason: "SOURCE_MISMATCH" };
  }
  if (!snapshotsEqual(result.snapshotBasis, request.snapshotBasis)) {
    return { accepted: false, requestId: request.requestId, reason: "SNAPSHOT_MISMATCH" };
  }
  if (result.regionId !== request.region.regionId) {
    return { accepted: false, requestId: request.requestId, reason: "REGION_MISMATCH" };
  }
  if (!backendsEqual(result.backend, expectedBackend)) {
    return { accepted: false, requestId: request.requestId, reason: "SOURCE_MISMATCH" };
  }

  const proposalIds = new Set<string>();
  for (const proposal of result.proposals) {
    if (proposalIds.has(proposal.proposalId)) {
      return { accepted: false, requestId: request.requestId, reason: "INVALID_OUTPUT" };
    }
    proposalIds.add(proposal.proposalId);
    if (
      proposal.requestId !== request.requestId
      || proposal.sessionId !== request.sessionId
      || proposal.sourceBoardRevision !== request.sourceBoardRevision
    ) {
      return { accepted: false, requestId: request.requestId, reason: "SOURCE_MISMATCH" };
    }
    if (!snapshotsEqual(proposal.snapshotBasis, request.snapshotBasis)) {
      return { accepted: false, requestId: request.requestId, reason: "SNAPSHOT_MISMATCH" };
    }
    if (proposal.regionId !== request.region.regionId) {
      return { accepted: false, requestId: request.requestId, reason: "REGION_MISMATCH" };
    }
    if (!isSubset(proposal.relevantShapeIds, request.region.relevantShapeIds)) {
      return { accepted: false, requestId: request.requestId, reason: "SOURCE_MISMATCH" };
    }
    if (
      request.requestedObservationKind !== "ANY"
      && proposal.observationKind !== request.requestedObservationKind
    ) {
      return { accepted: false, requestId: request.requestId, reason: "INVALID_OUTPUT" };
    }
  }

  const freshness = assessVisionRequestFreshness(request, input.authority);
  if (!freshness.fresh) {
    return { accepted: false, requestId: request.requestId, reason: freshness.reason };
  }

  const observations = result.proposals.map((proposal) => AcceptedBoardObservationSchema.parse({
    requestId: request.requestId,
    sessionId: request.sessionId,
    proposalId: proposal.proposalId,
    observationKind: proposal.observationKind,
    observation: BoundedBoardObservationSchema.parse({
      regionId: request.region.regionId,
      sourceBoardRevision: request.sourceBoardRevision,
      relevantShapeIds: proposal.relevantShapeIds,
      bounds: request.region.bounds,
      interpretation: proposal.interpretation,
      confidence: proposal.confidence
    }),
    snapshotBasis: request.snapshotBasis,
    sourceRelevantShapeIds: request.region.relevantShapeIds,
    shapeRevisionBindings: request.relevantShapeRevisions,
    backend: result.backend,
    admittedAtBoardRevision: freshness.currentBoardRevision,
    freshnessProof: freshness.currentBoardRevision === request.sourceBoardRevision
      ? "EXACT_BOARD_REVISION"
      : "SHAPE_AND_REGION_COMPATIBLE"
  }));

  return {
    accepted: true,
    requestId: request.requestId,
    observations,
    backend: result.backend
  };
}
