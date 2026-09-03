import { createHash } from "node:crypto";
import {
  VisionBackendResultSchema,
  VisionObservationKindSchema,
  type VisionBackendProvenance,
  type VisionInferenceRequest,
  type VisionObservationKind
} from "../../../../packages/domain/src/index.js";
import type {
  VisionInferenceBackend,
  VisionInferenceExecutionOptions
} from "../../../../packages/interview-engine/src/index.js";
import {
  ManagedModelWorkerClient
} from "./managed-worker-client.js";

const MAX_WORKER_INTERPRETATION_CHARS = 1_000;
const MAX_WORKER_RESPONSE_BYTES = 16 * 1024;
const VISION_INFERENCE_TIMEOUT_MS = 20_000;

export const LOCAL_VISION_BACKEND_PROVENANCE: VisionBackendProvenance = Object.freeze({
  backendId: "desktop-local-vision",
  backendVersion: "1",
  providerId: "local-offline",
  modelId: "rapid-latex-ocr-hybrid",
  modelVersion: "rapidlatex-v0.0.0+geometry-v1",
  visionCapabilityVersion: "1"
});

type ConfidenceClass = "LOW" | "MEDIUM" | "HIGH";

interface WorkerVisionObservation {
  readonly observationKind: VisionObservationKind;
  readonly interpretation: string;
  readonly confidenceClass: ConfidenceClass;
}

interface LocalVisionWorkerClient {
  readonly postJson: ManagedModelWorkerClient["postJson"];
  readonly workerInstanceIdentity: ManagedModelWorkerClient["workerInstanceIdentity"];
  readonly markHealthy: ManagedModelWorkerClient["markHealthy"];
  readonly recycleAfterUncertainRequest: ManagedModelWorkerClient["recycleAfterUncertainRequest"];
}

/**
 * Production adapter for the supervised local vision worker.
 *
 * The Python worker is deliberately treated as an untrusted, fallible
 * observation source. It may only return a narrow semantic payload. All
 * authoritative request/session/revision/snapshot/region provenance in the
 * VisionBackendResult is rebuilt here from the application-owned request.
 */
export class ManagedLocalVisionBackend implements VisionInferenceBackend {
  public readonly provenance = LOCAL_VISION_BACKEND_PROVENANCE;

  public constructor(private readonly client: LocalVisionWorkerClient) {}

  public async analyze(
    request: Readonly<VisionInferenceRequest>,
    options: VisionInferenceExecutionOptions
  ): Promise<unknown> {
    if (options.signal.aborted) throw abortError();
    const payload = options.imagePayload;
    if (payload === undefined) {
      throw new Error("Local vision inference requires the exact prepared image payload");
    }
    if (
      payload.metadata.mimeType !== "image/png"
      || payload.metadata.contentDigest !== request.snapshotBasis.snapshotHash
      || payload.metadata.byteSize <= 0
      || payload.metadata.width <= 0
      || payload.metadata.height <= 0
    ) {
      throw new Error("Local vision inference image provenance is invalid");
    }

    const bytes = payload.readBytes();
    if (bytes.byteLength !== payload.metadata.byteSize) {
      throw new Error("Local vision inference image byte size changed after admission");
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== request.snapshotBasis.snapshotHash) {
      throw new Error("Local vision inference image digest changed after admission");
    }

    const workerInstance = this.client.workerInstanceIdentity();
    let candidate: unknown;
    try {
      candidate = await this.client.postJson(
        "/v1/vision",
        {
          requestId: request.requestId,
          requestedObservationKind: request.requestedObservationKind,
          width: payload.metadata.width,
          height: payload.metadata.height,
          snapshotHash: request.snapshotBasis.snapshotHash,
          pngBase64: Buffer.from(bytes).toString("base64")
        },
        {
          signal: options.signal,
          timeoutMs: VISION_INFERENCE_TIMEOUT_MS,
          maxResponseBytes: MAX_WORKER_RESPONSE_BYTES
        }
      );
    } catch (error) {
      if (isAbortError(error) || options.signal.aborted) throw abortError();
      await this.recycleWorkerAfterUncertainFailure(workerInstance);
      throw error;
    }

    let observation: WorkerVisionObservation;
    try {
      observation = parseWorkerObservation(candidate);
    } catch (error) {
      await this.recycleWorkerAfterUncertainFailure(workerInstance);
      throw error;
    }
    this.client.markHealthy("vision");

    if (
      request.requestedObservationKind !== "ANY"
      && observation.observationKind !== request.requestedObservationKind
    ) {
      throw new Error("Local vision worker returned an observation outside the requested class");
    }

    return VisionBackendResultSchema.parse({
      protocolVersion: 1,
      requestId: request.requestId,
      sessionId: request.sessionId,
      sourceBoardRevision: request.sourceBoardRevision,
      snapshotBasis: request.snapshotBasis,
      regionId: request.region.regionId,
      backend: this.provenance,
      proposals: [{
        proposalId: proposalIdFor(request),
        requestId: request.requestId,
        sessionId: request.sessionId,
        sourceBoardRevision: request.sourceBoardRevision,
        snapshotBasis: request.snapshotBasis,
        regionId: request.region.regionId,
        relevantShapeIds: request.region.relevantShapeIds,
        observationKind: observation.observationKind,
        interpretation: observation.interpretation,
        confidence: confidenceAdmissionScore(observation.confidenceClass)
      }]
    });
  }

  private async recycleWorkerAfterUncertainFailure(
    workerInstance: string
  ): Promise<void> {
    try {
      await this.client.recycleAfterUncertainRequest(workerInstance, "vision");
    } catch {
      // Recovery failure does not convert an untrusted inference into a valid
      // result. The LocalRuntimeManager retains the authoritative FAILED state.
    }
  }
}

function parseWorkerObservation(value: unknown): WorkerVisionObservation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Local vision worker returned a malformed response");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== 3
    || keys[0] !== "confidenceClass"
    || keys[1] !== "interpretation"
    || keys[2] !== "observationKind"
  ) {
    throw new Error("Local vision worker returned unexpected response fields");
  }
  const kind = VisionObservationKindSchema.safeParse(record["observationKind"]);
  const interpretation = record["interpretation"];
  const confidenceClass = record["confidenceClass"];
  if (
    !kind.success
    || typeof interpretation !== "string"
    || interpretation.length < 1
    || interpretation.length > MAX_WORKER_INTERPRETATION_CHARS
    || interpretation.trim().length === 0
    || (
      confidenceClass !== "LOW"
      && confidenceClass !== "MEDIUM"
      && confidenceClass !== "HIGH"
    )
  ) {
    throw new Error("Local vision worker returned an invalid bounded observation");
  }
  return Object.freeze({
    observationKind: kind.data,
    interpretation,
    confidenceClass
  });
}

function confidenceAdmissionScore(value: ConfidenceClass): number {
  // These are conservative admission tiers, not calibrated probabilities.
  // Only HIGH crosses the existing rule-based evidence bridge's 0.70 floor.
  if (value === "HIGH") return 0.75;
  if (value === "MEDIUM") return 0.55;
  return 0.25;
}

function proposalIdFor(request: Readonly<VisionInferenceRequest>): string {
  const digest = createHash("sha256")
    .update(request.requestId, "utf8")
    .update("\0", "utf8")
    .update(request.snapshotBasis.snapshotHash, "utf8")
    .digest("hex");
  return `vision-proposal_${digest.slice(0, 32)}`;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function abortError(): Error {
  const error = new Error("Local vision inference was cancelled");
  error.name = "AbortError";
  return error;
}
