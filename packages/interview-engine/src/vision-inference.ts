import {
  MAX_VISION_INTERPRETATION_LENGTH,
  MAX_VISION_OBSERVATIONS,
  MAX_VISION_REGION_SHAPES,
  VISION_PROTOCOL_VERSION,
  VisionBackendProvenanceSchema,
  VisionBackendResultSchema,
  VisionInferenceRequestSchema,
  type VisionBackendProvenance,
  type VisionInferenceRequest,
  type VisionObservationKind
} from "../../domain/src/index.js";

export interface VisionInferenceImagePayload {
  readonly metadata: {
    readonly mimeType: "image/png";
    readonly width: number;
    readonly height: number;
    readonly byteSize: number;
    readonly contentDigest: string;
  };
  /**
   * Returns a defensive copy of the validated encoded image bytes.
   * This payload is execution-only and must never enter semantic request/event state.
   */
  readonly readBytes: () => Uint8Array;
}

export interface VisionInferenceExecutionOptions {
  readonly signal: AbortSignal;
  readonly imagePayload?: VisionInferenceImagePayload;
}

export interface VisionInferenceBackend {
  readonly provenance: VisionBackendProvenance;
  readonly analyze: (
    request: Readonly<VisionInferenceRequest>,
    options: VisionInferenceExecutionOptions
  ) => Promise<unknown>;
}

export interface FakeVisionObservation {
  readonly observationKind: VisionObservationKind;
  readonly interpretation: string;
  readonly confidence: number;
  readonly relevantShapeIds?: readonly string[];
}

const DEFAULT_FAKE_PROVENANCE: VisionBackendProvenance = VisionBackendProvenanceSchema.parse({
  backendId: "deterministic-fake-vision",
  backendVersion: "1.0.0",
  providerId: "local-test",
  modelId: "deterministic-fixture",
  modelVersion: "1",
  visionCapabilityVersion: "1"
});

export class DeterministicFakeVisionBackend implements VisionInferenceBackend {
  public readonly provenance: VisionBackendProvenance;
  private readonly observations: readonly FakeVisionObservation[];
  private calls = 0;

  public constructor(
    observations: readonly FakeVisionObservation[] = [],
    provenance: VisionBackendProvenance = DEFAULT_FAKE_PROVENANCE
  ) {
    if (observations.length > MAX_VISION_OBSERVATIONS) {
      throw new RangeError("Deterministic fake vision backend observation fixture exceeds the result limit");
    }
    this.observations = observations.map((observation) => {
      if (observation.interpretation.length > MAX_VISION_INTERPRETATION_LENGTH) {
        throw new RangeError("Deterministic fake vision interpretation fixture exceeds the text limit");
      }
      if (
        observation.relevantShapeIds !== undefined
        && observation.relevantShapeIds.length > MAX_VISION_REGION_SHAPES
      ) {
        throw new RangeError("Deterministic fake vision shape fixture exceeds the shape limit");
      }
      return {
        ...observation,
        ...(observation.relevantShapeIds === undefined
          ? {}
          : { relevantShapeIds: [...observation.relevantShapeIds] })
      };
    });
    this.provenance = VisionBackendProvenanceSchema.parse(provenance);
  }

  public get analyzeCallCount(): number {
    return this.calls;
  }

  public async analyze(
    requestInput: Readonly<VisionInferenceRequest>,
    options: VisionInferenceExecutionOptions
  ): Promise<unknown> {
    if (options.signal.aborted) throw new Error("Vision inference was cancelled before execution");
    this.calls += 1;
    const request = VisionInferenceRequestSchema.parse(requestInput);
    const proposals = this.observations.map((observation, index) => ({
      proposalId: "proposal-" + String(index + 1),
      requestId: request.requestId,
      sessionId: request.sessionId,
      sourceBoardRevision: request.sourceBoardRevision,
      snapshotBasis: request.snapshotBasis,
      regionId: request.region.regionId,
      relevantShapeIds: observation.relevantShapeIds ?? request.region.relevantShapeIds,
      observationKind: observation.observationKind,
      interpretation: observation.interpretation,
      confidence: observation.confidence
    }));
    return VisionBackendResultSchema.parse({
      protocolVersion: VISION_PROTOCOL_VERSION,
      requestId: request.requestId,
      sessionId: request.sessionId,
      sourceBoardRevision: request.sourceBoardRevision,
      snapshotBasis: request.snapshotBasis,
      regionId: request.region.regionId,
      backend: this.provenance,
      proposals
    });
  }
}
