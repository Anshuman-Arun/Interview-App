import { createHash } from "node:crypto";
import {
  AcceptedBoardObservationSchema,
  EvidenceProposalSchema,
  RequestIdSchema,
  MAX_VISION_REGION_SHAPES,
  MAX_WHITEBOARD_VISION_DIMENSION,
  MAX_WHITEBOARD_VISION_PIXELS,
  MAX_WHITEBOARD_VISION_PNG_BYTES,
  VisionEvidenceInterpreterFingerprintSchema,
  VisionInferenceRequestSchema,
  WhiteboardVisionSnapshotResponseSchema,
  WhiteboardVisionSnapshotUploadSchema,
  type AuthoritativeBoardBounds,
  type EventId,
  type RequestId,
  type SessionId,
  type VisionInferenceRequest,
  type VisionSnapshotBasis,
  type WhiteboardVisionSnapshotResponse,
  type WhiteboardVisionSnapshotUpload
} from "../../../packages/domain/src/index.js";
import {
  TurnCoordinator,
  VisionRequestManager,
  createCommandEnvelope,
  type SessionWriter,
  type VisionEvidenceInterpreter,
  type VisionInferenceBackend
} from "../../../packages/interview-engine/src/index.js";
import {
  createValidatedImageSnapshot,
  prepareVisionBatch,
  type PreparedVisionImageRequest
} from "../../../packages/vision/src/index.js";
import type { SessionState, VisionRequestState } from "../../../packages/events/src/index.js";
import type { SessionRecoveryCoordinator } from "./session-recovery-coordinator.js";
import type { SessionObservability } from "./session-observability.js";

const PREPROCESSING_VERSION = "whiteboard-snapshot-v1";
const MAX_RESPONSE_TOMBSTONES = 64;
const MAX_COORDINATOR_IN_FLIGHT_REQUESTS = 64;
const MAX_GLOBAL_BACKEND_RESERVATIONS = 16;
const MAX_SESSION_VISION_MANAGERS = 64;
const DEFAULT_BACKEND_TIMEOUT_MS = 15_000;
const MAX_BACKEND_TIMEOUT_MS = 120_000;

interface ResponseTombstone {
  readonly fingerprint: string;
  readonly response: WhiteboardVisionSnapshotResponse;
}

interface InFlightResponse {
  readonly fingerprint: string;
  readonly promise: Promise<WhiteboardVisionSnapshotResponse>;
}

export interface WhiteboardVisionCoordinatorOptions {
  readonly sessions: SessionRecoveryCoordinator;
  readonly backend?: VisionInferenceBackend;
  readonly evidenceInterpreter?: VisionEvidenceInterpreter;
  readonly backendTimeoutMs?: number;
  readonly observability?: SessionObservability;
}

export class WhiteboardVisionCoordinator {
  private readonly sessions: SessionRecoveryCoordinator;
  private readonly backend: VisionInferenceBackend | undefined;
  private readonly evidenceInterpreter: VisionEvidenceInterpreter | undefined;
  private readonly evidenceInterpreterFingerprint: string | undefined;
  private readonly backendTimeoutMs: number;
  private readonly observability: SessionObservability | undefined;
  private readonly unregisterVisionEvidenceRecovery: () => void;
  private readonly managers = new Map<SessionId, VisionRequestManager>();
  private readonly tombstones = new Map<string, ResponseTombstone>();
  private readonly inFlight = new Map<string, InFlightResponse>();

  public constructor(options: WhiteboardVisionCoordinatorOptions) {
    this.sessions = options.sessions;
    this.backend = options.backend;
    this.observability = options.observability;
    this.evidenceInterpreter = options.evidenceInterpreter;
    this.evidenceInterpreterFingerprint = options.evidenceInterpreter === undefined
      ? undefined
      : VisionEvidenceInterpreterFingerprintSchema.parse(options.evidenceInterpreter.fingerprint);
    this.backendTimeoutMs = options.backendTimeoutMs ?? DEFAULT_BACKEND_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(this.backendTimeoutMs)
      || this.backendTimeoutMs < 1
      || this.backendTimeoutMs > MAX_BACKEND_TIMEOUT_MS
    ) {
      throw new RangeError("Whiteboard vision backend timeout is outside its bounded range");
    }
    this.unregisterVisionEvidenceRecovery = this.sessions.setVisionEvidenceRecoveryDelegate({
      recoverPendingVisionEvidence: async (sessionId) => {
        await this.recoverPendingVisionEvidence(sessionId);
      }
    });
  }

  public async process(
    input: unknown
  ): Promise<WhiteboardVisionSnapshotResponse> {
    const upload = WhiteboardVisionSnapshotUploadSchema.parse(input);
    const fingerprint = uploadFingerprint(upload);
    const active = this.inFlight.get(upload.requestId);
    if (active !== undefined) {
      return active.fingerprint === fingerprint
        ? active.promise
        : rejected(upload, "CONFLICTING_REQUEST_ID");
    }
    if (this.inFlight.size >= MAX_COORDINATOR_IN_FLIGHT_REQUESTS) {
      return rejected(upload, "RESOURCE_LIMIT");
    }

    const promise = this.processRequest(upload);
    this.inFlight.set(upload.requestId, { fingerprint, promise });
    try {
      return await promise;
    } finally {
      if (this.inFlight.get(upload.requestId)?.promise === promise) {
        this.inFlight.delete(upload.requestId);
      }
    }
  }

  private async processRequest(
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

    if (!this.sessions.hasSession(upload.sessionId)) {
      return this.remember(upload.requestId, fingerprint, rejected(
        upload,
        "UNKNOWN_SESSION"
      ));
    }
    await this.sessions.ensureRecovered(upload.sessionId);
    const writer = this.sessions.getWriter(upload.sessionId);
    const state = writer.getState();
    const persistedRequest = state.visionRequests[upload.requestId];
    let snapshotBasis: VisionSnapshotBasis | undefined;
    let preparedImageRequest: PreparedVisionImageRequest | undefined;

    if (persistedRequest !== undefined) {
      try {
        const prepared = prepareSnapshot(upload);
        snapshotBasis = prepared.snapshotBasis;
        preparedImageRequest = prepared.imageRequest;
      } catch {
        return this.remember(upload.requestId, fingerprint, rejected(
          upload,
          "INVALID_IMAGE"
        ));
      }
      if (!persistedRequestMatchesUpload(persistedRequest, upload, snapshotBasis)) {
        return rejected(upload, "CONFLICTING_REQUEST_ID");
      }
      if (persistedRequest.status === "ACCEPTED") {
        if (persistedRequest.resultEventId === undefined || persistedRequest.observation === undefined) {
          return rejected(upload, "PERSISTED_REQUEST_CORRUPT");
        }
        const bridge = await this.completeEvidenceBridge(
          writer,
          new TurnCoordinator(writer),
          upload.requestId
        );
        if (!bridge.completed) {
          return rejected(upload, bridge.reason);
        }
        return this.remember(upload.requestId, fingerprint, {
          protocolVersion: 1,
          requestId: upload.requestId,
          sessionId: upload.sessionId,
          status: "ACCEPTED",
          observationCount: 1,
          evidenceCommittedCount: bridge.evidenceCommittedCount
        });
      }
      if (persistedRequest.status === "DISCARDED") {
        const reason = persistedRequest.discardReason ?? "PREVIOUSLY_DISCARDED";
        return this.remember(
          upload.requestId,
          fingerprint,
          reason === "VISION_UNAVAILABLE"
            ? visionUnavailable(upload)
            : rejected(upload, reason)
        );
      }
    }

    const turn = new TurnCoordinator(writer);

    if (state.status !== "ACTIVE") {
      if (persistedRequest?.status === "PENDING") {
        await turn.discardVisionRequest(upload.requestId, "SESSION_NOT_ACTIVE");
      }
      return this.remember(upload.requestId, fingerprint, rejected(
        upload,
        "SESSION_NOT_ACTIVE"
      ));
    }
    if (!state.boardShapeAuthorityKnown) {
      if (persistedRequest?.status === "PENDING") {
        await turn.discardVisionRequest(upload.requestId, "BOARD_AUTHORITY_UNKNOWN");
      }
      return this.remember(upload.requestId, fingerprint, rejected(
        upload,
        "BOARD_AUTHORITY_UNKNOWN"
      ));
    }
    if (state.boardRevision !== upload.sourceBoardRevision) {
      if (persistedRequest?.status === "PENDING") {
        await turn.discardVisionRequest(upload.requestId, "STALE_BOARD");
      }
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
      if (persistedRequest?.status === "PENDING") {
        await turn.discardVisionRequest(upload.requestId, "REGION_MISMATCH");
      }
      return this.remember(upload.requestId, fingerprint, rejected(
        upload,
        "REGION_MISMATCH"
      ));
    }
    for (const binding of upload.relevantShapeRevisions) {
      const current = state.boardShapes[binding.shapeId];
      if (current === undefined || current.revision !== binding.expectedRevision) {
        if (persistedRequest?.status === "PENDING") {
          await turn.discardVisionRequest(upload.requestId, "STALE_SHAPE");
        }
        return this.remember(upload.requestId, fingerprint, rejected(
          upload,
          "STALE_SHAPE"
        ));
      }
    }

    if (snapshotBasis === undefined) {
      try {
        const prepared = prepareSnapshot(upload);
        snapshotBasis = prepared.snapshotBasis;
        preparedImageRequest = prepared.imageRequest;
      } catch {
        return this.remember(upload.requestId, fingerprint, rejected(
          upload,
          "INVALID_IMAGE"
        ));
      }
    }
    if (this.backend === undefined && persistedRequest?.status === "PENDING") {
      await turn.discardVisionRequest(upload.requestId, "VISION_UNAVAILABLE");
      return this.remember(upload.requestId, fingerprint, visionUnavailable(upload));
    }

    let requested;
    try {
      requested = await turn.requestVision(
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
    } catch (error) {
      const latest = writer.getState();
      if (!latest.boardShapeAuthorityKnown) {
        return this.remember(
          upload.requestId,
          fingerprint,
          rejected(upload, "BOARD_AUTHORITY_UNKNOWN")
        );
      }
      if (latest.boardRevision !== upload.sourceBoardRevision) {
        return this.remember(
          upload.requestId,
          fingerprint,
          rejected(upload, "STALE_BOARD")
        );
      }
      throw error;
    }
    if (requested.sourceBoardRevision !== upload.sourceBoardRevision) {
      await turn.discardVisionRequest(upload.requestId, "STALE_BOARD");
      return this.remember(upload.requestId, fingerprint, rejected(
        upload,
        "STALE_BOARD"
      ));
    }
    if (this.backend === undefined) {
      await turn.discardVisionRequest(upload.requestId, "VISION_UNAVAILABLE");
      return this.remember(upload.requestId, fingerprint, visionUnavailable(upload));
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
    if (this.totalBackendReservations() >= MAX_GLOBAL_BACKEND_RESERVATIONS) {
      await turn.discardVisionRequest(upload.requestId, "RESOURCE_LIMIT");
      return this.remember(upload.requestId, fingerprint, rejected(
        upload,
        "RESOURCE_LIMIT"
      ));
    }
    const manager = this.managerFor(upload.sessionId);
    if (manager === undefined) {
      await turn.discardVisionRequest(upload.requestId, "RESOURCE_LIMIT");
      return this.remember(upload.requestId, fingerprint, rejected(
        upload,
        "RESOURCE_LIMIT"
      ));
    }
    if (preparedImageRequest === undefined) {
      await turn.discardVisionRequest(upload.requestId, "INVALID_IMAGE");
      return this.remember(upload.requestId, fingerprint, rejected(
        upload,
        "INVALID_IMAGE"
      ));
    }
    this.observability?.recordVisionRequest(upload.sessionId);
    const visionTiming = this.observability?.beginLocalTiming(upload.sessionId, "VISION");
    const admissionPromise = manager.submit(
      request,
      this.backend,
      preparedImageRequest.payload
    ).catch((error) => {
      visionTiming?.finish("FAILURE");
      throw error;
    });
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
    visionTiming?.finish(outcome.kind === "TIMEOUT" ? "FAILURE" : "SUCCESS");
    if (!admission.accepted) {
      const reason = outcome.kind === "TIMEOUT" ? "BACKEND_TIMEOUT" : admission.reason;
      await turn.discardVisionRequest(upload.requestId, reason);
      this.observability?.recordVisionRejected(
        upload.sessionId,
        reason.includes("STALE") || reason.includes("SUPERSEDED")
      );
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
      admission: accepted,
      evidenceInterpreterFingerprint: this.evidenceInterpreterFingerprint ?? null
    });
    if (!persisted.accepted) {
      this.observability?.recordVisionRejected(upload.sessionId, true);
      return this.remember(upload.requestId, fingerprint, rejected(
        upload,
        "STALE_BOARD"
      ));
    }
    this.observability?.recordVisionAccepted(upload.sessionId);

    const bridge = await this.completeEvidenceBridge(
      writer,
      turn,
      upload.requestId
    );
    if (!bridge.completed) {
      return rejected(upload, bridge.reason);
    }

    return this.remember(upload.requestId, fingerprint, {
      protocolVersion: 1,
      requestId: upload.requestId,
      sessionId: upload.sessionId,
      status: "ACCEPTED",
      observationCount: 1,
      evidenceCommittedCount: bridge.evidenceCommittedCount
    });
  }

  private async completeEvidenceBridge(
    writer: SessionWriter,
    turn: TurnCoordinator,
    visionRequestId: RequestId
  ): Promise<
    | { readonly completed: true; readonly evidenceCommittedCount: 0 | 1 }
    | { readonly completed: false; readonly reason: string }
  > {
    let state = writer.getState();
    let request = state.visionRequests[visionRequestId];
    if (
      request === undefined
      || request.status !== "ACCEPTED"
      || request.resultEventId === undefined
      || request.acceptedObservation === undefined
    ) {
      return { completed: false, reason: "PERSISTED_REQUEST_CORRUPT" };
    }

    if (request.evidenceBridge === undefined) {
      return {
        completed: true,
        evidenceCommittedCount: visionEvidenceWasCommitted(state, request.resultEventId) ? 1 : 0
      };
    }
    if (request.evidenceBridge.status === "SKIPPED_NO_INTERPRETER") {
      return { completed: true, evidenceCommittedCount: 0 };
    }
    if (request.evidenceBridge.status === "COMPLETED") {
      return {
        completed: true,
        evidenceCommittedCount: request.evidenceBridge.evidenceCommitted ? 1 : 0
      };
    }

    if (request.evidenceBridge.status === "PENDING") {
      const interpreter = this.evidenceInterpreter;
      if (
        interpreter === undefined
        || this.evidenceInterpreterFingerprint !== request.evidenceBridge.interpreterFingerprint
      ) {
        return {
          completed: false,
          reason: "EVIDENCE_INTERPRETER_MISMATCH"
        };
      }

      let proposal;
      try {
        const problemId = state.problem?.id;
        if (problemId === undefined) {
          return { completed: false, reason: "PERSISTED_REQUEST_CORRUPT" };
        }
        const candidate = interpreter.propose({
          observation: AcceptedBoardObservationSchema.parse(request.acceptedObservation),
          problemId,
          evidenceEventId: request.resultEventId
        });
        if (candidate !== undefined) {
          const parsed = EvidenceProposalSchema.safeParse(candidate);
          if (
            parsed.success
            && parsed.data.key.problemId === problemId
            && parsed.data.evidenceEventIds.length === 1
            && parsed.data.evidenceEventIds[0] === request.resultEventId
          ) {
            proposal = parsed.data;
          }
        }
      } catch {
        proposal = undefined;
      }

      await turn.recordVisionEvidenceBridgeDecision({
        envelope: createCommandEnvelope({
          sessionId: writer.sessionId,
          producer: "vision-evidence-bridge",
          requestId: RequestIdSchema.parse(`vision-evidence-decision:${visionRequestId}`),
          correlationId: visionRequestId
        }),
        interpreterFingerprint: request.evidenceBridge.interpreterFingerprint,
        ...(proposal === undefined ? {} : { proposal })
      });

      state = writer.getState();
      request = state.visionRequests[visionRequestId];
      if (
        request === undefined
        || request.status !== "ACCEPTED"
        || request.evidenceBridge?.status !== "DECIDED"
      ) {
        return { completed: false, reason: "PERSISTED_REQUEST_CORRUPT" };
      }
    }

    if (request.evidenceBridge.decision === "NO_PROPOSAL") {
      return { completed: true, evidenceCommittedCount: 0 };
    }
    const acceptedObservation = request.acceptedObservation;
    if (acceptedObservation === undefined) {
      return { completed: false, reason: "PERSISTED_REQUEST_CORRUPT" };
    }

    const bridge = request.evidenceBridge;

    const evidenceResult = await turn.processEvidenceProposal({
      envelope: createCommandEnvelope({
        sessionId: writer.sessionId,
        producer: "vision-evidence",
        requestId: RequestIdSchema.parse(`vision-evidence-commit:${visionRequestId}`),
        correlationId: visionRequestId
      }),
      proposal: bridge.proposal,
      requiredBoardRevision: acceptedObservation.admittedAtBoardRevision
    });

    await turn.recordVisionEvidenceBridgeCompletion({
      envelope: createCommandEnvelope({
        sessionId: writer.sessionId,
        producer: "vision-evidence-bridge",
        requestId: RequestIdSchema.parse(`vision-evidence-completion:${visionRequestId}`),
        correlationId: visionRequestId
      }),
      interpreterFingerprint: bridge.interpreterFingerprint,
      evidenceCommitted: evidenceResult.committed
    });

    state = writer.getState();
    request = state.visionRequests[visionRequestId];
    if (
      request === undefined
      || request.status !== "ACCEPTED"
      || request.evidenceBridge?.status !== "COMPLETED"
    ) {
      return { completed: false, reason: "PERSISTED_REQUEST_CORRUPT" };
    }
    return {
      completed: true,
      evidenceCommittedCount: request.evidenceBridge.evidenceCommitted ? 1 : 0
    };
  }

  public async recoverPendingVisionEvidence(sessionId: SessionId): Promise<void> {
    const writer = await this.sessions.getWriterAsync(sessionId);
    const candidates = Object.values(writer.getState().visionRequests)
      .filter((request) =>
        request.status === "ACCEPTED"
        && (
          request.evidenceBridge?.status === "PENDING"
          || (
            request.evidenceBridge?.status === "DECIDED"
            && request.evidenceBridge.decision === "PROPOSAL"
          )
        )
      )
      .map((request) => {
        if (request.resultSequence === undefined) {
          throw new Error("Accepted vision bridge is missing its authoritative result sequence");
        }
        return {
          visionRequestId: request.visionRequestId,
          resultSequence: request.resultSequence
        };
      })
      .sort((left, right) =>
        left.resultSequence - right.resultSequence
        || left.visionRequestId.localeCompare(right.visionRequestId)
      );

    const turn = new TurnCoordinator(writer);
    for (const candidate of candidates) {
      const recovered = await this.completeEvidenceBridge(
        writer,
        turn,
        candidate.visionRequestId
      );
      if (!recovered.completed) {
        throw new Error(
          `Vision evidence recovery failed for ${candidate.visionRequestId}: ${recovered.reason}`
        );
      }
    }
  }

  public supersedeStaleRequests(sessionId: SessionId): number {
    return this.managers.get(sessionId)?.supersedeStaleRequests() ?? 0;
  }

  public shutdown(): void {
    this.unregisterVisionEvidenceRecovery();
    for (const manager of this.managers.values()) manager.shutdown();
    this.managers.clear();
  }

  private managerFor(sessionId: SessionId): VisionRequestManager | undefined {
    const existing = this.managers.get(sessionId);
    if (existing !== undefined) return existing;

    if (this.managers.size >= MAX_SESSION_VISION_MANAGERS) {
      for (const [candidateSessionId, candidate] of this.managers) {
        if (candidate.inFlightCount !== 0) continue;
        candidate.shutdown();
        this.managers.delete(candidateSessionId);
        break;
      }
    }
    if (this.managers.size >= MAX_SESSION_VISION_MANAGERS) return undefined;

    const manager = new VisionRequestManager({
      maxInFlight: 4,
      maxObservationsPerResult: 1,
      authority: (request) => this.authorityFor(request)
    });
    this.managers.set(sessionId, manager);
    return manager;
  }

  private totalBackendReservations(): number {
    let count = 0;
    for (const manager of this.managers.values()) {
      count += manager.inFlightCount;
      if (count >= MAX_GLOBAL_BACKEND_RESERVATIONS) break;
    }
    return count;
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

interface PreparedWhiteboardSnapshot {
  readonly snapshotBasis: VisionSnapshotBasis;
  readonly imageRequest: PreparedVisionImageRequest;
}

function prepareSnapshot(
  upload: WhiteboardVisionSnapshotUpload
): PreparedWhiteboardSnapshot {
  const bytes = decodeBoundedBase64(upload.pngBase64);
  const snapshot = createValidatedImageSnapshot({
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
  const batch = prepareVisionBatch(
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
  const imageRequest = batch.requests[0];
  if (
    imageRequest === undefined
    || batch.requests.length !== 1
    || batch.truncated
    || imageRequest.contentDigest !== snapshot.metadata.contentDigest
  ) {
    throw new Error("Whiteboard snapshot preprocessing did not produce one exact image payload");
  }
  return {
    snapshotBasis: {
      snapshotId: snapshot.metadata.snapshotId,
      snapshotHash: snapshot.metadata.contentDigest,
      preprocessingVersion: PREPROCESSING_VERSION,
      sourceBoardRevision: upload.sourceBoardRevision
    },
    imageRequest
  };
}

function visionUnavailable(
  upload: WhiteboardVisionSnapshotUpload
): WhiteboardVisionSnapshotResponse {
  return WhiteboardVisionSnapshotResponseSchema.parse({
    protocolVersion: 1,
    requestId: upload.requestId,
    sessionId: upload.sessionId,
    status: "VISION_UNAVAILABLE",
    reason: "No production vision inference backend is configured",
    observationCount: 0,
    evidenceCommittedCount: 0
  });
}

function persistedRequestMatchesUpload(
  request: VisionRequestState,
  upload: WhiteboardVisionSnapshotUpload,
  snapshotBasis: VisionSnapshotBasis
): boolean {
  return request.sourceBoardRevision === upload.sourceBoardRevision
    && request.regionId === upload.region.regionId
    && sameStringSet(request.relevantShapeIds, upload.region.relevantShapeIds)
    && request.snapshotBasis !== undefined
    && JSON.stringify(request.snapshotBasis) === JSON.stringify(snapshotBasis)
    && request.relevantShapeRevisions !== undefined
    && sameShapeRevisions(request.relevantShapeRevisions, upload.relevantShapeRevisions)
    && request.regionBounds !== undefined
    && JSON.stringify(request.regionBounds) === JSON.stringify(upload.region.bounds)
    && request.requestedObservationKind === upload.requestedObservationKind;
}

function sameShapeRevisions(
  left: readonly { readonly shapeId: string; readonly expectedRevision: number }[],
  right: readonly { readonly shapeId: string; readonly expectedRevision: number }[]
): boolean {
  if (left.length !== right.length) return false;
  const rightById = new Map(right.map((binding) => [
    binding.shapeId,
    binding.expectedRevision
  ] as const));
  return left.every((binding) =>
    rightById.get(binding.shapeId) === binding.expectedRevision
  );
}

function visionEvidenceWasCommitted(
  state: SessionState,
  visionResultEventId: EventId
): boolean {
  return Object.values(state.evidenceHistory).some((records) =>
    records.some((record) =>
      record.value.evidenceEventIds.includes(visionResultEventId)
    )
  );
}
