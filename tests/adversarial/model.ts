import type {
  DeliveryId,
  EvidenceKey,
  GenerationId,
  InputEpisodeId,
  RequestId,
  TurnId
} from "../../packages/domain/src/index.js";
import { evidenceKeyToString } from "../../packages/domain/src/index.js";

export type ModelDeliveryState =
  | "GENERATED"
  | "QUEUED"
  | "DELIVERING"
  | "EXPOSED"
  | "COMPLETED"
  | "CANCELLED"
  | "POSSIBLY_EXPOSED";

export type ModelGenerationState =
  | "ACTIVE"
  | "PROPOSAL_RECEIVED"
  | "VALIDATED"
  | "REJECTED"
  | "SUPERSEDED";

export type ModelRequestState = "PENDING" | "ACCEPTED" | "DISCARDED";

export interface RequestFingerprintRecord {
  readonly fingerprint: string;
  readonly resultFingerprint?: string;
}

export class AdversarialModel {
  public expectedSequence: number;
  public contextEpoch: number;
  public transcriptRevision: number;
  public boardRevision: number;
  public currentInputEpisodeId: InputEpisodeId;
  public currentTurnId: TurnId;
  public readonly generations = new Map<GenerationId, ModelGenerationState>();
  public readonly workerRequests = new Map<RequestId, ModelRequestState>();
  public readonly verifierRequests = new Map<RequestId, ModelRequestState>();
  public readonly visionRequests = new Map<RequestId, ModelRequestState>();
  public readonly deliveries = new Map<DeliveryId, ModelDeliveryState>();
  public readonly activeEvidence = new Map<string, string>();
  public readonly requestFingerprints = new Map<RequestId, RequestFingerprintRecord>();
  public readonly physicalPresentationMayHaveOccurred = new Set<DeliveryId>();
  public readonly positivelyNotExposed = new Set<DeliveryId>();

  public constructor(input: {
    readonly sequence: number;
    readonly contextEpoch: number;
    readonly transcriptRevision: number;
    readonly boardRevision: number;
    readonly inputEpisodeId: InputEpisodeId;
    readonly turnId: TurnId;
    readonly generationId: GenerationId;
  }) {
    this.expectedSequence = input.sequence;
    this.contextEpoch = input.contextEpoch;
    this.transcriptRevision = input.transcriptRevision;
    this.boardRevision = input.boardRevision;
    this.currentInputEpisodeId = input.inputEpisodeId;
    this.currentTurnId = input.turnId;
    this.generations.set(input.generationId, "ACTIVE");
  }

  public advanceSequenceBy(eventCount: number): void {
    if (!Number.isInteger(eventCount) || eventCount < 0) {
      throw new Error("Model sequence delta must be a non-negative integer");
    }
    this.expectedSequence += eventCount;
  }

  public noteCommittedInput(
    inputEpisodeId: InputEpisodeId,
    turnId: TurnId
  ): void {
    this.currentInputEpisodeId = inputEpisodeId;
    this.currentTurnId = turnId;
  }

  public noteTranscriptCorrection(): void {
    this.contextEpoch += 1;
    this.transcriptRevision += 1;
    this.activeEvidence.clear();
  }

  public noteBoardRevision(): void {
    this.boardRevision += 1;
  }

  public noteGeneration(generationId: GenerationId, status: ModelGenerationState): void {
    this.generations.set(generationId, status);
  }

  public notePolicyOutputInvalidation(): void {
    for (const [generationId, status] of this.generations) {
      if (status === "ACTIVE" || status === "PROPOSAL_RECEIVED" || status === "VALIDATED") {
        this.generations.set(generationId, "SUPERSEDED");
      }
    }
    for (const [deliveryId, status] of this.deliveries) {
      if (status === "QUEUED") this.deliveries.set(deliveryId, "CANCELLED");
      else if (status === "DELIVERING") this.deliveries.set(deliveryId, "POSSIBLY_EXPOSED");
    }
  }

  public noteRequest(
    family: "worker" | "verifier" | "vision",
    requestId: RequestId,
    status: ModelRequestState
  ): void {
    this.requestMap(family).set(requestId, status);
  }

  public noteDelivery(deliveryId: DeliveryId, status: ModelDeliveryState): void {
    this.deliveries.set(deliveryId, status);
  }

  public noteEvidence(key: EvidenceKey, value: string): void {
    this.activeEvidence.set(evidenceKeyToString(key), value);
  }

  public invalidateEvidence(key: EvidenceKey): void {
    this.activeEvidence.delete(evidenceKeyToString(key));
  }

  public noteRequestFingerprint(
    requestId: RequestId,
    fingerprint: string,
    resultFingerprint?: string
  ): void {
    const existing = this.requestFingerprints.get(requestId);
    if (existing !== undefined && existing.fingerprint !== fingerprint) {
      throw new Error(`Reference model detected conflicting RequestId reuse: ${requestId}`);
    }
    this.requestFingerprints.set(requestId, {
      fingerprint,
      ...(resultFingerprint === undefined ? {} : { resultFingerprint })
    });
  }

  public notePhysicalPresentation(deliveryId: DeliveryId): void {
    if (
      this.physicalPresentationMayHaveOccurred.has(deliveryId)
      && !this.positivelyNotExposed.has(deliveryId)
    ) {
      throw new Error(`Reference model detected duplicate physical presentation: ${deliveryId}`);
    }
    this.positivelyNotExposed.delete(deliveryId);
    this.physicalPresentationMayHaveOccurred.add(deliveryId);
  }

  public notePresenterProvedNonExposure(deliveryId: DeliveryId): void {
    this.physicalPresentationMayHaveOccurred.delete(deliveryId);
    this.positivelyNotExposed.add(deliveryId);
  }

  private requestMap(
    family: "worker" | "verifier" | "vision"
  ): Map<RequestId, ModelRequestState> {
    if (family === "worker") return this.workerRequests;
    if (family === "verifier") return this.verifierRequests;
    return this.visionRequests;
  }
}
