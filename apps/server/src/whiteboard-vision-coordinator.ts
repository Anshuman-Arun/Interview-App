import { createHash } from "node:crypto";
import {
  MAX_VISION_REGION_SHAPES,
  MAX_WHITEBOARD_VISION_DIMENSION,
  MAX_WHITEBOARD_VISION_PIXELS,
  MAX_WHITEBOARD_VISION_PNG_BYTES,
  VisionInferenceRequestSchema,
  WhiteboardVisionSnapshotResponseSchema,
  WhiteboardVisionSnapshotUploadSchema,
  type AuthoritativeBoardBounds,
  type SessionId,
  type VisionInferenceRequest,
  type WhiteboardVisionSnapshotResponse,
  type WhiteboardVisionSnapshotUpload
} from "../../../packages/domain/src/index.js";
import {
  TurnCoordinator,
  VisionRequestManager,
  createCommandEnvelope,
  type VisionEvidenceInterpreter,
  type VisionInferenceBackend
} from "../../../packages/interview-engine/src/index.js";
import {
  createValidatedImageSnapshot,
  prepareVisionBatch
} from "../../../packages/vision/src/index.js";
import type { SessionRecoveryCoordinator } from "./session-recovery-coordinator.js";

const PREPROCESSING_VERSION = "whiteboard-snapshot-v1";
const MAX_RESPONSE_TOMBSTONES = 64;
const DEFAULT_BACKEND_TIMEOUT_MS = 15_000;
const MAX_BACKEND_TIMEOUT_MS = 120_000;

interface ResponseTombstone {
  readonly fingerprint: string;
  readonly response: WhiteboardVisionSnapshotResponse;
}

export interface WhiteboardVisionCoordinatorOptions {
  readonly sessions: SessionRecoveryCoordinator;
  readonly backend?: VisionInferenceBackend;
  readonly evidenceInterpreter?: VisionEvidenceInterpreter;
  readonly backendTimeoutMs?: number;
}

export class WhiteboardVisionCoordinator {
  private readonly sessions: SessionRecoveryCoordinator;
  private readonly backend: VisionInferenceBackend | undefined;
  private readonly evidenceInterpreter: VisionEvidenceInterpreter | undefined;
  private readonly backendTimeoutMs: number;
  private readonly managers = new Map<SessionId, VisionRequestManager>();
  private readonly tombstones = new Map<string, ResponseTombstone>();

  public constructor(options: WhiteboardVisionCoordinatorOptions) {
    this.sessions = options.sessions;
    this.backend = options.backend;
    this.evidenceInterpreter = options.evidenceInterpreter;
    this.backendTimeoutMs = options.backendTimeoutMs ?? DEFAULT_BACKEND_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(this.backendTimeoutMs)
      || this.backendTimeoutMs < 1
      || this.backendTimeoutMs > MAX_BACKEND_TIMEOUT_MS
    ) {
      throw new RangeError("Whiteboard vision backend timeout is outside its bounded range");
    }
  }

  public async process(
    input: unknown
  ): Promise<WhiteboardVisionSnapshotResponse> {
    const upload = WhiteboardVisionSnapshotUploadSchema.parse(input);
    const fingerprint = uploadFingerprint(upload);
    const tombstone = this.tombstones.get(upload.requestId);
    if (tombstone !== undefined) {
      if (tombstone.fingerprint !== fingerprint) {
        return rejected(upload, "CONFLICTING_REQUEST_ID");
      }
      return WhiteboardVisionSnapshotResponseSchema.parse(tombstone.response);
    }

    if (this.backend === undefined) {
      return this.remember(upload.requestId, fingerprint, {
        protocolVersion: 1,
        requestId: upload.requestId,
        sessionId: upload.sessionId,
        status: "VISION_UNAVAILABLE",
        reason: "No production vision inference backend is configured",
        observationCount: 0,
        evidenceCommittedCount: 0
      });
    }

    if (!this.sessions.hasSession(upload.sessionId)) {
      return this.remember(upload.requestId, fingerprint, rejected(
        upload,
        "UNKNOWN_SESSION"
      ));
    }
    await this.sessions.ensureRecovered(upload.sessionId);
    const writer = this.sessions.getWriter(upload.sessionId);
    const state = writer.getState();
    if (state.status !== "ACTIVE") {
      return this.remember(upload.requestId, fingerprint, rejected(
        upload,
        "SESSION_NOT_ACTIVE"
      ));
    }
    if (!state.boardShapeAuthorityKnown) {
      return this.remember(upload.requestId, fingerprint, rejected(
        upload,
        "BOARD_AUTHORITY_UNKNOWN"
      ));
    }
    if (state.boardRevision !== upload.sourceBoardRevision) {
      return this.remember(upload.requestId, fingerprint, rejected(
        upload,
        "STALE_BOARD"
      ));
    }

    const authoritativeShapeIds = relevantShapeIdsForRegion(
      state.boardShapes,
      upload.region.bounds
    );
    if (
      authoritativeShapeIds.length === 0
      || authoritativeShapeIds.length > MAX_VISION_REGION_SHAPES
      || !sameStringSet(authoritativeShapeIds, upload.region.relevantShapeIds)
    ) {
      return this.remember(upload.requestId, fingerprint, rejected(
        upload,
        "REGION_MISMATCH"
      ));
    }
    for (const binding of upload.relevantShapeRevisions) {
      const current = state.boardShapes[binding.shapeId];
      if (current === undefined || current.revision !== binding.expectedRevision) {
        return this.remember(upload.requestId, fingerprint, rejected(
          upload,
          "STALE_SHAPE"
        ));
      }
    }

    let bytes: Buffer;
    try {
      bytes = decodeBoundedBase64(upload.pngBase64);
    } catch {
      return this.remember(upload.requestId, fingerprint, rejected(
        upload,
        "INVALID_IMAGE"
      ));
    }

    let snapshot;
    try {
      snapshot = createValidatedImageSnapshot({
        snapshotId: upload.snapshotId,
        sourceType: "WHITEBOARD_SNAPSHOT",
        sourceRevision: upload.sourceBoardRevision,
        capturedAtMs: upload.capturedAtMs,
        mimeType: "image/png",
        declaredWidth: upload.declaredWidth,
        declaredHeight: upload.declaredHeight,
        encodedBytes: bytes
      }, {
        maxEncodedBytes: MAX_WHITEBOARD_VISION_PNG_BYTES,
        maxWidth: MAX_WHITEBOARD_VISION_DIMENSION,
        maxHeight: MAX_WHITEBOARD_VISION_DIMENSION,
        maxPixels: MAX_WHITEBOARD_VISION_PIXELS
      });
      prepareVisionBatch(
        [snapshot],
        "whiteboard-observation",
        {
          maxImages: 1,
          maxTotalBytes: MAX_WHITEBOARD_VISION_PNG_BYTES,
          maxTotalPixels: MAX_WHITEBOARD_VISION_PIXELS,
          maxCropsOrTiles: 1
        },
        "FAIL"
      );
    } catch {
      return this.remember(upload.requestId, fingerprint, rejected(
        upload,
        "INVALID_IMAGE"
      ));
    }

    const snapshotBasis = {
      snapshotId: snapshot.metadata.snapshotId,
      snapshotHash: snapshot.metadata.contentDigest,
      preprocessingVersion: PREPROCESSING_VERSION,
      sourceBoardRevision: upload.sourceBoardRevision
    };
    const turn = new TurnCoordinator(writer);
    const requested = await turn.requestVision(
      upload.region.regionId,
      authoritativeShapeIds,
      {
        visionRequestId: upload.requestId,
        snapshotBasis,
        relevantShapeRevisions: upload.relevantShapeRevisions,
        regionBounds: upload.region.bounds,
        requestedObservationKind: upload.requestedObservationKind
      }
    );
    if (requested.sourceBoardRevision !== upload.sourceBoardRevision) {
      await turn.discardVisionRequest(upload.requestId, "STALE_BOARD");
      return this.remember(upload.requestId, fingerprint, rejected(
        upload,
        "STALE_BOARD"
      ));
    }

    const request = VisionInferenceRequestSchema.parse({
      protocolVersion: 1,
      requestId: requested.visionRequestId,
      sessionId: upload.sessionId,
      sourceBoardRevision: requested.sourceBoardRevision,
      snapshotBasis,
      region: {
        regionId: upload.region.regionId,
        bounds: upload.region.bounds,
        relevantShapeIds: authoritativeShapeIds
      },
      relevantShapeRevisions: upload.relevantShapeRevisions,
      requestedObservationKind: upload.requestedObservationKind
    });
    const manager = this.managerFor(upload.sessionId);
    const admissionPromise = manager.submit(request, this.backend);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      admissionPromise.then((admission) => ({
        kind: "ADMISSION" as const,
        admission
      })),
      new Promise<{ readonly kind: "TIMEOUT" }>((resolve) => {
        timeout = setTimeout(() => {
          manager.cancel(upload.requestId);
          resolve({ kind: "TIMEOUT" });
        }, this.backendTimeoutMs);
      })
    ]);
    if (timeout !== undefined) clearTimeout(timeout);
    const admission = outcome.kind === "ADMISSION"
      ? outcome.admission
      : await admissionPromise;
    if (!admission.accepted) {
      const reason = outcome.kind === "TIMEOUT" ? "BACKEND_TIMEOUT" : admission.reason;
      await turn.discardVisionRequest(upload.requestId, reason);
      return this.remember(upload.requestId, fingerprint, rejected(
        upload,
        reason
      ));
    }

    const accepted = admission.observations[0];
    if (accepted === undefined || admission.observations.length !== 1) {
      await turn.discardVisionRequest(upload.requestId, "INVALID_OUTPUT");
      return this.remember(upload.requestId, fingerprint, rejected(
        upload,
        "INVALID_OUTPUT"
      ));
    }

    const persisted = await turn.processVisionResult({
      envelope: createCommandEnvelope({
        sessionId: upload.sessionId,
        producer: "vision-admission",
        correlationId: upload.requestId,
        sourceRevision: upload.sourceBoardRevision
      }),
      observation: accepted.observation,
      admission: accepted
    });
    if (!persisted.accepted) {
      return this.remember(upload.requestId, fingerprint, rejected(
        upload,
        "STALE_BOARD"
      ));
    }

    let evidenceCommittedCount = 0;
    const acceptedState = writer.getState();
    const requestState = acceptedState.visionRequests[upload.requestId];
    const evidenceEventId = requestState?.resultEventId;
    const problemId = acceptedState.problem?.id;
    if (
      this.evidenceInterpreter !== undefined
      && evidenceEventId !== undefined
      && problemId !== undefined
    ) {
      const proposal = this.evidenceInterpreter.propose({
        observation: accepted,
        problemId,
        evidenceEventId
      });
      if (proposal !== undefined) {
        const evidenceResult = await turn.processEvidenceProposal({
          envelope: createCommandEnvelope({
            sessionId: upload.sessionId,
            producer: "vision-evidence",
            correlationId: upload.requestId
          }),
          proposal,
          requiredBoardRevision: accepted.admittedAtBoardRevision
        });
        if (evidenceResult.committed) evidenceCommittedCount = 1;
      }
    }

    return this.remember(upload.requestId, fingerprint, {
      protocolVersion: 1,
      requestId: upload.requestId,
      sessionId: upload.sessionId,
      status: "ACCEPTED",
      observationCount: 1,
      evidenceCommittedCount
    });
  }

  public supersedeStaleRequests(sessionId: SessionId): number {
    return this.managers.get(sessionId)?.supersedeStaleRequests() ?? 0;
  }

  public shutdown(): void {
    for (const manager of this.managers.values()) manager.shutdown();
    this.managers.clear();
  }

  private managerFor(sessionId: SessionId): VisionRequestManager {
    const existing = this.managers.get(sessionId);
    if (existing !== undefined) return existing;
    const manager = new VisionRequestManager({
      maxInFlight: 4,
      maxObservationsPerResult: 1,
      authority: (request) => this.authorityFor(request)
    });
    this.managers.set(sessionId, manager);
    return manager;
  }

  private authorityFor(request: Readonly<VisionInferenceRequest>) {
    const writer = this.sessions.getWriter(request.sessionId);
    const state = writer.getState();
    if (!state.boardShapeAuthorityKnown) {
      return {
        sessionId: state.sessionId,
        boardRevision: state.boardRevision
      };
    }
    const currentShapeRevisions = request.relevantShapeRevisions.map((binding) => ({
      shapeId: binding.shapeId,
      currentRevision: state.boardShapes[binding.shapeId]?.revision ?? null
    }));
    const currentRegionIds = relevantShapeIdsForRegion(
      state.boardShapes,
      request.region.bounds
    );
    const regionCompatibility = currentRegionIds.length <= MAX_VISION_REGION_SHAPES
      && sameStringSet(currentRegionIds, request.region.relevantShapeIds)
      ? "COMPATIBLE" as const
      : "INCOMPATIBLE" as const;
    return {
      sessionId: state.sessionId,
      boardRevision: state.boardRevision,
      currentShapeRevisions,
      regionCompatibility
    };
  }

  private remember(
    requestId: string,
    fingerprint: string,
    response: WhiteboardVisionSnapshotResponse
  ): WhiteboardVisionSnapshotResponse {
    const parsed = WhiteboardVisionSnapshotResponseSchema.parse(response);
    this.tombstones.set(requestId, { fingerprint, response: parsed });
    while (this.tombstones.size > MAX_RESPONSE_TOMBSTONES) {
      const oldest = this.tombstones.keys().next().value;
      if (oldest === undefined) break;
      this.tombstones.delete(oldest);
    }
    return WhiteboardVisionSnapshotResponseSchema.parse(parsed);
  }
}

function rejected(
  upload: WhiteboardVisionSnapshotUpload,
  reason: string
): WhiteboardVisionSnapshotResponse {
  return WhiteboardVisionSnapshotResponseSchema.parse({
    protocolVersion: 1,
    requestId: upload.requestId,
    sessionId: upload.sessionId,
    status: "REJECTED",
    reason: reason.slice(0, 240),
    observationCount: 0,
    evidenceCommittedCount: 0
  });
}

function decodeBoundedBase64(value: string): Buffer {
  const bytes = Buffer.from(value, "base64");
  if (bytes.length === 0 || bytes.length > MAX_WHITEBOARD_VISION_PNG_BYTES) {
    throw new RangeError("Whiteboard vision image exceeds the byte limit");
  }
  if (bytes.toString("base64") !== value) {
    throw new RangeError("Whiteboard vision image must use canonical base64 encoding");
  }
  return bytes;
}

function uploadFingerprint(upload: WhiteboardVisionSnapshotUpload): string {
  return createHash("sha256")
    .update(JSON.stringify(upload), "utf8")
    .digest("hex");
}

function relevantShapeIdsForRegion(
  shapes: Readonly<Record<string, { readonly id: string; readonly bounds: AuthoritativeBoardBounds }>>,
  bounds: AuthoritativeBoardBounds
): string[] {
  return Object.values(shapes)
    .filter((shape) => boxesIntersect(shape.bounds, bounds))
    .map((shape) => shape.id)
    .sort();
}

function boxesIntersect(
  left: AuthoritativeBoardBounds,
  right: AuthoritativeBoardBounds
): boolean {
  return left.x < right.x + right.width
    && left.x + left.width > right.x
    && left.y < right.y + right.height
    && left.y + left.height > right.y;
}

function sameStringSet(
  left: readonly string[],
  right: readonly string[]
): boolean {
  if (left.length !== right.length) return false;
  const leftSorted = [...left].sort();
  const rightSorted = [...right].sort();
  return leftSorted.every((value, index) => value === rightSorted[index]);
}
