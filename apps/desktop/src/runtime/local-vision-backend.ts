import { createHash } from "node:crypto";
import {
  MAX_VISION_INTERPRETATION_LENGTH,
  VISION_PROTOCOL_VERSION,
  VisionBackendProvenanceSchema,
  VisionBackendResultSchema,
  VisionInferenceRequestSchema,
  VisionObservationKindSchema,
  type VisionBackendProvenance,
  type VisionInferenceRequest
} from "../../../../packages/domain/src/index.js";
import type {
  VisionInferenceBackend,
  VisionInferenceExecutionOptions
} from "../../../../packages/interview-engine/src/index.js";
import {
  ManagedWorkerRequestTimeoutError,
  ManagedWorkerResponseError,
  ManagedWorkerTransportError,
  type ManagedModelWorkerClient
} from "./managed-worker-client.js";

import {
  RAPID_LATEX_OCR_MODEL_SET_SHA256,
  VISION_WORKER_MODEL_IDENTITY
} from "./model-assets.js";

const MAX_VISION_QUEUE_RESERVATIONS = 4;
const MAX_VISION_WORKER_RESPONSE_BYTES = 16 * 1024;
const VISION_WORKER_TIMEOUT_MS = 15_000;

export const LOCAL_VISION_RUNTIME_VERSION =
  "onnxruntime/1.29.0;numpy/2.5.2;pillow/12.3.0;tokenizers/0.23.1;vision/4";
export const LOCAL_VISION_MODEL_IDENTITY = VISION_WORKER_MODEL_IDENTITY;

const LOCAL_VISION_PROVENANCE: VisionBackendProvenance =
  VisionBackendProvenanceSchema.parse({
    backendId: "desktop-local-whiteboard-vision",
    backendVersion: "1.2.0",
    providerId: "local-offline",
    modelId: "rapid-latex-ocr",
    modelVersion: `v0.0.0+${RAPID_LATEX_OCR_MODEL_SET_SHA256}`,
    visionCapabilityVersion: "3"
  });

interface ParsedWorkerObservation {
  readonly observationKind: ReturnType<typeof VisionObservationKindSchema.parse>;
  readonly interpretation: string;
  readonly confidence: number;
}

export class ManagedLocalVisionBackend implements VisionInferenceBackend {
  public readonly provenance = LOCAL_VISION_PROVENANCE;
  private inferenceTail: Promise<void> = Promise.resolve();
  private reservations = 0;
  private readonly activeRequestIds = new Set<string>();

  public constructor(private readonly client: ManagedModelWorkerClient) {}

  public analyze(
    requestInput: Readonly<VisionInferenceRequest>,
    options: VisionInferenceExecutionOptions
  ): Promise<unknown> {
    const request = VisionInferenceRequestSchema.parse(requestInput);
    const payload = options.imagePayload;
    if (payload === undefined) {
      return Promise.reject(new Error("Local vision requires an execution-only image payload"));
    }
    if (payload.metadata.contentDigest !== request.snapshotBasis.snapshotHash) {
      return Promise.reject(new Error("Local vision image payload does not match the request snapshot basis"));
    }
    if (this.reservations >= MAX_VISION_QUEUE_RESERVATIONS) {
      return Promise.reject(new Error("Local vision inference queue is full"));
    }
    if (this.activeRequestIds.has(request.requestId)) {
      return Promise.reject(new Error("Local vision request ID is already queued"));
    }
    if (options.signal.aborted) return Promise.reject(abortError());

    const bytes = payload.readBytes();
    if (bytes.byteLength !== payload.metadata.byteSize) {
      return Promise.reject(new Error("Local vision image payload byte size changed before dispatch"));
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== payload.metadata.contentDigest) {
      return Promise.reject(new Error("Local vision image payload digest changed before dispatch"));
    }

    this.reservations += 1;
    this.activeRequestIds.add(request.requestId);
    let nativeLaneEntered = false;
    let removeAbortListener: (() => void) | undefined;
    const queuedAbort = new Promise<never>((_resolve, reject) => {
      const listener = (): void => {
        if (!nativeLaneEntered) reject(abortError());
        else reject(abortError());
      };
      removeAbortListener = () => options.signal.removeEventListener("abort", listener);
      options.signal.addEventListener("abort", listener, { once: true });
      if (options.signal.aborted) listener();
    });

    const scheduled = this.inferenceTail.then(async () => {
      if (options.signal.aborted) throw abortError();
      nativeLaneEntered = true;

      // RapidLaTeXOCR is batch inference and cannot be safely preempted inside
      // ONNXRuntime. Once native inference begins, application cancellation
      // suppresses the result through the race below while this lane finishes.
      // This prevents a cancelled request from overlapping another native
      // decode or being misreported as interrupted.
      const workerInstance = this.client.workerInstanceIdentity();
      const raw = await runWithWorkerRecycleOnFailure(
        this.client,
        workerInstance,
        () => this.client.postJson("/v1/vision", {
          requestId: request.requestId,
          imageSha256: digest,
          pngBase64: Buffer.from(bytes).toString("base64"),
          requestedObservationKind: request.requestedObservationKind
        }, {
          timeoutMs: VISION_WORKER_TIMEOUT_MS,
          maxResponseBytes: MAX_VISION_WORKER_RESPONSE_BYTES
        })
      );
      let observation: ParsedWorkerObservation;
      try {
        observation = parseWorkerObservation(
          raw,
          request.requestId,
          digest,
          request.requestedObservationKind
        );
      } catch (protocolError) {
        try {
          await this.client.recycleAfterUncertainRequest(workerInstance, "vision");
        } catch (recycleError) {
          throw new AggregateError(
            [protocolError, recycleError],
            "Local vision protocol failed and its worker could not be safely recycled",
            { cause: recycleError }
          );
        }
        throw protocolError;
      }
      this.client.markHealthy("vision");
      return VisionBackendResultSchema.parse({
        protocolVersion: VISION_PROTOCOL_VERSION,
        requestId: request.requestId,
        sessionId: request.sessionId,
        sourceBoardRevision: request.sourceBoardRevision,
        snapshotBasis: request.snapshotBasis,
        regionId: request.region.regionId,
        backend: this.provenance,
        proposals: [{
          proposalId: `proposal-${createHash("sha256")
            .update(request.requestId)
            .update("\0")
            .update(digest)
            .digest("hex")
            .slice(0, 32)}`,
          requestId: request.requestId,
          sessionId: request.sessionId,
          sourceBoardRevision: request.sourceBoardRevision,
          snapshotBasis: request.snapshotBasis,
          regionId: request.region.regionId,
          relevantShapeIds: request.region.relevantShapeIds,
          observationKind: observation.observationKind,
          interpretation: observation.interpretation,
          confidence: observation.confidence
        }]
      });
    });

    this.inferenceTail = scheduled.then(
      () => undefined,
      () => undefined
    );
    const release = (): void => {
      removeAbortListener?.();
      removeAbortListener = undefined;
      this.activeRequestIds.delete(request.requestId);
      this.reservations = Math.max(0, this.reservations - 1);
    };
    void scheduled.then(release, release);

    return Promise.race([scheduled, queuedAbort]);
  }
}

function parseWorkerObservation(
  value: unknown,
  expectedRequestId: string,
  expectedDigest: string,
  requestedKind: VisionInferenceRequest["requestedObservationKind"]
): ParsedWorkerObservation {
  if (!isRecord(value) || !hasExactKeys(value, ["requestId", "imageSha256", "observation"])) {
    throw new Error("Local vision worker returned an invalid response envelope");
  }
  if (value["requestId"] !== expectedRequestId || value["imageSha256"] !== expectedDigest) {
    throw new Error("Local vision worker response identity did not match the dispatched request");
  }
  const observation = value["observation"];
  if (!isRecord(observation)
      || !hasExactKeys(observation, ["observationKind", "interpretation", "confidence"])) {
    throw new Error("Local vision worker returned an invalid observation");
  }
  const observationKind = VisionObservationKindSchema.parse(observation["observationKind"]);
  if (
    requestedKind !== "ANY"
    && observationKind !== requestedKind
    && observationKind !== "GENERAL_BOARD_DESCRIPTION"
  ) {
    throw new Error("Local vision worker returned an observation outside the requested class");
  }
  const interpretation = observation["interpretation"];
  const confidence = observation["confidence"];
  if (
    typeof interpretation !== "string"
    || interpretation.length === 0
    || interpretation.length > MAX_VISION_INTERPRETATION_LENGTH
    || interpretation.trim().length === 0
    || typeof confidence !== "number"
    || !Number.isFinite(confidence)
    || confidence < 0
    || confidence > 1
  ) {
    throw new Error("Local vision worker returned an unbounded observation");
  }
  return { observationKind, interpretation, confidence };
}

async function runWithWorkerRecycleOnFailure<T>(
  client: ManagedModelWorkerClient,
  expectedWorkerInstance: string,
  operation: () => Promise<T>
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const uncertainNativeState =
      error instanceof ManagedWorkerRequestTimeoutError
      || error instanceof ManagedWorkerTransportError
      || (error instanceof ManagedWorkerResponseError && error.statusCode >= 500);
    if (!uncertainNativeState) throw error;
    try {
      await client.recycleAfterUncertainRequest(expectedWorkerInstance, "vision");
    } catch (recycleError) {
      throw new AggregateError(
        [error, recycleError],
        "Local vision worker failed and could not be safely recycled",
        { cause: recycleError }
      );
    }
    throw error;
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  record: Readonly<Record<string, unknown>>,
  expected: readonly string[]
): boolean {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function abortError(): Error {
  const error = new Error("Local vision inference was cancelled");
  error.name = "AbortError";
  return error;
}