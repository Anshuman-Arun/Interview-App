import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  BoardObservationSchema,
  DeliveryAtomSchema,
  DisclosureIdSchema,
  EventIdSchema,
  RealizationRequestSchema,
  evidenceKeyToString,
  newDeliveryId,
  newRequestId,
  newSessionId,
  type CommandEnvelope,
  type DeliveryAtom,
  type DeliveryId,
  type DisclosureId,
  type DisclosureLevel,
  type EvidenceKey,
  type EvidenceRating,
  type GenerationId,
  type InputEpisodeId,
  type RequestId,
  type SessionId,
  type TurnId
} from "../../packages/domain/src/index.js";
import { DeliveryCoordinator } from "../../packages/delivery/src/index.js";
import {
  ClosedWorldDisclosureAnalyzer,
  DisclosureValidator,
  LocalComputeCoordinator,
  SessionRuntimeRegistry,
  TurnCoordinator,
  VerificationCoordinator,
  createCommandEnvelope,
  type SessionWriter,
  type VerificationWorkItem
} from "../../packages/interview-engine/src/index.js";
import { SqliteEventStore } from "../../packages/persistence/src/index.js";
import { sixPeopleProblem } from "../../packages/problems/src/index.js";
import {
  TWO_COLOUR_GRAPH_VERIFIER_NAME,
  TwoColourGraphVerifier
} from "../../packages/verification/src/index.js";
import { DeterministicScheduler } from "./deterministic-scheduler.js";
import { AdversarialModel } from "./model.js";

export const ADVERSARIAL_SECRET = "authorization=adversarial-secret-must-not-persist";

export const CLAIM_EVIDENCE_KEY: EvidenceKey = {
  problemId: "oxford-six-people",
  subject: {
    kind: "CLAIM",
    claimId: "encoded-graph-has-monochromatic-triangle"
  },
  dimension: "CORRECTNESS"
};

const VERIFICATION_SCOPES = [{
  verifier: TWO_COLOUR_GRAPH_VERIFIER_NAME,
  evidenceKey: CLAIM_EVIDENCE_KEY
}] as const;

export const MILESTONE_EVIDENCE_KEY: EvidenceKey = {
  problemId: "oxford-six-people",
  subject: {
    kind: "MILESTONE",
    milestoneId: "model-relations"
  },
  dimension: "PROGRESS"
};

export const CALLBACK_LABELS = {
  providerPrimary: "provider.primary",
  providerDuplicate: "provider.duplicate",
  visionPrimary: "vision.primary",
  visionDuplicate: "vision.duplicate",
  workerPrimary: "worker.primary",
  workerDuplicate: "worker.duplicate",
  verifierPrimary: "verifier.primary",
  verifierDuplicate: "verifier.duplicate"
} as const;

export interface ProviderCallbackResult {
  readonly accepted: boolean;
  readonly deliveryAtoms: readonly DeliveryAtom[];
  readonly reason?: string;
}

export class AdversarialFixture {
  public store: SqliteEventStore;
  public registry: SessionRuntimeRegistry;
  public writer: SessionWriter;
  public turns: TurnCoordinator;
  public localCompute: LocalComputeCoordinator;
  public verification: VerificationCoordinator;
  public delivery: DeliveryCoordinator;

  public readonly scheduler = new DeterministicScheduler();
  public readonly sessionId: SessionId;
  public readonly inputEpisodeId: InputEpisodeId;
  public readonly turnId: TurnId;
  public readonly initialGenerationId: GenerationId;
  public readonly safeProbe = "Why must that step be true?";
  public readonly validator: DisclosureValidator;
  public readonly providerEnvelope: CommandEnvelope;
  public readonly visionEnvelope: CommandEnvelope;
  public readonly workerEnvelope: CommandEnvelope;
  public readonly verifierEnvelope: CommandEnvelope;
  public readonly visionRequestId: RequestId;
  public readonly workerRequestId: RequestId;
  public readonly verificationWork: VerificationWorkItem;
  public readonly verifier = new TwoColourGraphVerifier();
  public readonly directory: string;
  public readonly databasePath: string;
  private closed = false;

  private constructor(input: {
    readonly directory: string;
    readonly databasePath: string;
    readonly store: SqliteEventStore;
    readonly registry: SessionRuntimeRegistry;
    readonly writer: SessionWriter;
    readonly turns: TurnCoordinator;
    readonly localCompute: LocalComputeCoordinator;
    readonly verification: VerificationCoordinator;
    readonly delivery: DeliveryCoordinator;
    readonly sessionId: SessionId;
    readonly inputEpisodeId: InputEpisodeId;
    readonly turnId: TurnId;
    readonly initialGenerationId: GenerationId;
    readonly validator: DisclosureValidator;
    readonly providerEnvelope: CommandEnvelope;
    readonly visionEnvelope: CommandEnvelope;
    readonly workerEnvelope: CommandEnvelope;
    readonly verifierEnvelope: CommandEnvelope;
    readonly visionRequestId: RequestId;
    readonly workerRequestId: RequestId;
    readonly verificationWork: VerificationWorkItem;
  }) {
    this.directory = input.directory;
    this.databasePath = input.databasePath;
    this.store = input.store;
    this.registry = input.registry;
    this.writer = input.writer;
    this.turns = input.turns;
    this.localCompute = input.localCompute;
    this.verification = input.verification;
    this.delivery = input.delivery;
    this.sessionId = input.sessionId;
    this.inputEpisodeId = input.inputEpisodeId;
    this.turnId = input.turnId;
    this.initialGenerationId = input.initialGenerationId;
    this.validator = input.validator;
    this.providerEnvelope = input.providerEnvelope;
    this.visionEnvelope = input.visionEnvelope;
    this.workerEnvelope = input.workerEnvelope;
    this.verifierEnvelope = input.verifierEnvelope;
    this.visionRequestId = input.visionRequestId;
    this.workerRequestId = input.workerRequestId;
    this.verificationWork = input.verificationWork;
  }

  public static async create(): Promise<AdversarialFixture> {
    const directory = mkdtempSync(join(tmpdir(), "interview-adversarial-"));
    const databasePath = join(directory, "events.sqlite");
    const store = new SqliteEventStore(databasePath);
    const registry = new SessionRuntimeRegistry(store);
    const sessionId = newSessionId();
    const writer = registry.get(sessionId);
    const turns = new TurnCoordinator(writer);

    await turns.startSession(sixPeopleProblem);
    const utteranceId = await turns.beginUtterance();
    const finalized = await turns.finalizeUtterance({
      utteranceId,
      text: "I would prove both cases."
    });
    const turnId = await turns.commitInputEpisode(finalized.inputEpisodeId);
    const selected = await turns.selectAction(turnId, sixPeopleProblem);
    const generation = await turns.startGeneration(
      finalized.inputEpisodeId,
      turnId,
      "adversarial-provider-a"
    );

    const vision = await turns.requestVision("main-work", ["shape-1"]);
    const localCompute = new LocalComputeCoordinator(writer);
    const workerRequest = (
      await localCompute.requestTranscriptAnalysis(finalized.inputEpisodeId)
    ).value;
    const verification = new VerificationCoordinator(writer, VERIFICATION_SCOPES);
    const verificationWork = (
      await verification.requestVerification({
        inputEpisodeId: finalized.inputEpisodeId,
        turnId,
        verifier: TWO_COLOUR_GRAPH_VERIFIER_NAME,
        candidateFormalInterpretation: completeGraphStatement(6),
        interpretationConfidence: 1,
        evidenceKey: CLAIM_EVIDENCE_KEY
      })
    ).value;

    const validator = new DisclosureValidator(
      new ClosedWorldDisclosureAnalyzer(["Why must that step be true?"])
    );
    const providerEnvelope = createCommandEnvelope({
      sessionId,
      producer: "adversarial-provider-a",
      inputEpisodeId: finalized.inputEpisodeId,
      turnId,
      generationId: generation.generationId,
      contextEpoch: generation.basis.contextEpoch,
      sourceRevision: generation.basis.committedInputSequence
    });
    const visionEnvelope = createCommandEnvelope({
      sessionId,
      producer: "adversarial-vision",
      correlationId: vision.visionRequestId,
      sourceRevision: vision.sourceBoardRevision
    });
    const workerEnvelope = createCommandEnvelope({
      sessionId,
      producer: "adversarial-worker",
      correlationId: workerRequest.requestId,
      sourceRevision: workerRequest.sourceRevision
    });
    const verifierEnvelope = createCommandEnvelope({
      sessionId,
      producer: "adversarial-verifier",
      correlationId: verificationWork.verificationRequestId,
      inputEpisodeId: finalized.inputEpisodeId,
      turnId,
      contextEpoch: verificationWork.basis.contextEpoch,
      sourceRevision: verificationWork.basis.committedInputSequence
    });

    const fixture = new AdversarialFixture({
      directory,
      databasePath,
      store,
      registry,
      writer,
      turns,
      localCompute,
      verification,
      delivery: new DeliveryCoordinator(writer),
      sessionId,
      inputEpisodeId: finalized.inputEpisodeId,
      turnId,
      initialGenerationId: generation.generationId,
      validator,
      providerEnvelope,
      visionEnvelope,
      workerEnvelope,
      verifierEnvelope,
      visionRequestId: vision.visionRequestId,
      workerRequestId: workerRequest.requestId,
      verificationWork
    });

    fixture.armDeferredCallbacks(selected.requiredAction, vision.sourceBoardRevision);
    return fixture;
  }

  public async restart(): Promise<void> {
    if (this.closed) throw new Error("Cannot restart a closed adversarial fixture");
    this.store.close();
    this.store = new SqliteEventStore(this.databasePath);
    this.registry = new SessionRuntimeRegistry(this.store);
    this.writer = this.registry.get(this.sessionId);
    this.turns = new TurnCoordinator(this.writer);
    this.localCompute = new LocalComputeCoordinator(this.writer);
    this.verification = new VerificationCoordinator(this.writer, VERIFICATION_SCOPES);
    this.delivery = new DeliveryCoordinator(this.writer);
  }

  public async release<T>(label: string): Promise<T> {
    return this.scheduler.releaseAndSettle<T>(label);
  }

  public async proposeEvidence(value: EvidenceRating): Promise<boolean> {
    const eventId = EventIdSchema.parse(this.writer.getState().eventIds.at(-1));
    const result = await this.turns.processEvidenceProposal({
      envelope: createCommandEnvelope({
        sessionId: this.sessionId,
        producer: "adversarial-evidence",
        correlationId: newRequestId()
      }),
      proposal: {
        key: MILESTONE_EVIDENCE_KEY,
        proposedValue: value,
        inferenceConfidence: 0.9,
        evidenceEventIds: [eventId]
      }
    });
    return result.committed;
  }

  public async startReplacementGeneration(provider = "adversarial-provider-b"): Promise<GenerationId> {
    const generation = await this.turns.startGeneration(
      this.inputEpisodeId,
      this.turnId,
      provider
    );
    return generation.generationId;
  }

  public queuedDeliveryIds(): readonly DeliveryId[] {
    return Object.values(this.writer.getState().deliveries)
      .filter((atom) => atom.status === "QUEUED")
      .map((atom) => atom.deliveryId);
  }

  public async queueSyntheticDelivery(input: {
    readonly medium?: "TEXT" | "AUDIO";
    readonly disclosureIds?: readonly DisclosureId[];
  } = {}): Promise<DeliveryAtom> {
    const disclosureIds = input.disclosureIds ?? [];
    const provenance = await this.authorizeSyntheticDeliveryProvenance(
      disclosureIds
    );
    const medium = input.medium ?? "TEXT";
    const content = medium === "TEXT"
      ? { medium: "TEXT" as const, text: "Adversarial reviewed delivery" }
      : {
          medium: "AUDIO" as const,
          text: "Adversarial reviewed audio",
          audioRef: "/fixtures/adversarial.wav"
        };
    const atom = DeliveryAtomSchema.parse({
      deliveryId: newDeliveryId(),
      generationId: provenance.generationId,
      content,
      disclosureIds,
      effectiveDisclosureLevel: provenance.effectiveDisclosureLevel,
      status: "VALIDATED"
    });
    await this.writer.execute(
      createCommandEnvelope({
        sessionId: this.sessionId,
        producer: "adversarial-delivery-fixture"
      }),
      {
        operation: "QUEUE_ADVERSARIAL_DELIVERY",
        payload: { deliveryId: atom.deliveryId }
      },
      z.object({ queued: z.literal(true) }).strict(),
      () => ({
        drafts: [{
          source: "APPLICATION",
          type: "DELIVERY_QUEUED",
          payload: { atom }
        }],
        result: { queued: true as const }
      })
    );
    return atom;
  }

  private async authorizeSyntheticDeliveryProvenance(
    disclosureIds: readonly DisclosureId[]
  ): Promise<{
    readonly generationId: GenerationId;
    readonly effectiveDisclosureLevel: DisclosureLevel;
  }> {
    if (disclosureIds.length === 0) {
      const state = this.writer.getState();
      const generation = state.generations[this.initialGenerationId];
      if (generation === undefined) {
        throw new Error("Synthetic delivery fixture generation is missing");
      }
      const action = state.pedagogicalActions[generation.basis.turnId];
      if (action === undefined || action.maximumDisclosure < 0) {
        throw new Error("Synthetic delivery fixture lacks application authorization");
      }
      return {
        generationId: this.initialGenerationId,
        effectiveDisclosureLevel: 0
      };
    }

    let effectiveDisclosureLevel: DisclosureLevel = 0;
    for (const disclosureId of disclosureIds) {
      const disclosure = sixPeopleProblem.interviewer.protectedDisclosures.find(
        (candidate) => candidate.id === disclosureId
      );
      if (disclosure === undefined) {
        throw new Error("Synthetic delivery fixture references an unknown disclosure");
      }
      if (disclosure.minimumDisclosureLevel > effectiveDisclosureLevel) {
        effectiveDisclosureLevel = disclosure.minimumDisclosureLevel;
      }
    }

    const committed = await this.turns.commitInput(
      "Adversarial reviewed disclosure-delivery fixture."
    );
    const request = RealizationRequestSchema.parse({
      requiredAction: "EXPLICIT_HINT",
      target: "the reviewed disclosure fixture",
      maximumDisclosure: effectiveDisclosureLevel,
      allowedDisclosureIds: [...disclosureIds]
    });
    await this.writer.execute(
      createCommandEnvelope({
        sessionId: this.sessionId,
        producer: "adversarial-pedagogy-fixture",
        turnId: committed.turnId
      }),
      {
        operation: "SELECT_ADVERSARIAL_PEDAGOGICAL_ACTION",
        payload: {
          turnId: committed.turnId,
          maximumDisclosure: effectiveDisclosureLevel
        }
      },
      z.object({ selected: z.literal(true) }).strict(),
      () => ({
        drafts: [{
          source: "APPLICATION",
          type: "PEDAGOGICAL_ACTION_SELECTED",
          payload: {
            turnId: committed.turnId,
            request
          }
        }],
        result: { selected: true as const }
      })
    );
    const generation = await this.turns.startGeneration(
      committed.inputEpisodeId,
      committed.turnId,
      "adversarial-reviewed-disclosure-fixture"
    );
    return {
      generationId: generation.generationId,
      effectiveDisclosureLevel
    };
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.scheduler.cancelPendingAndDrain();
    this.store.close();
    rmSync(this.directory, { recursive: true, force: true });
  }

  private armDeferredCallbacks(
    requiredAction: Parameters<DisclosureValidator["validate"]>[0]["request"]["requiredAction"],
    sourceBoardRevision: number
  ): void {
    const providerProposal = {
      realizedAction: requiredAction,
      claimedDisclosureLevel: 0 as const,
      claimedDisclosureIds: [],
      speechText: this.safeProbe
    };
    const providerOperation = () => this.turns.processProposal({
      envelope: this.providerEnvelope,
      problem: sixPeopleProblem,
      proposal: providerProposal,
      validator: this.validator
    });
    this.scheduler.schedule(CALLBACK_LABELS.providerPrimary, providerOperation);
    this.scheduler.schedule(CALLBACK_LABELS.providerDuplicate, providerOperation);

    const observation = BoardObservationSchema.parse({
      regionId: "main-work",
      sourceBoardRevision,
      relevantShapeIds: ["shape-1"],
      bounds: { x: 0, y: 0, width: 100, height: 100 },
      interpretation: "two-colour graph work",
      confidence: 0.9
    });
    const visionOperation = () => this.turns.processVisionResult({
      envelope: this.visionEnvelope,
      observation
    });
    this.scheduler.schedule(CALLBACK_LABELS.visionPrimary, visionOperation);
    this.scheduler.schedule(CALLBACK_LABELS.visionDuplicate, visionOperation);

    const workerResponse = {
      protocolVersion: 1 as const,
      requestId: this.workerRequestId,
      type: "TRANSCRIPT_ANALYSIS_RESULT" as const,
      sourceRevision: this.workerEnvelope.sourceRevision,
      normalizedText: "I would prove both cases.",
      tokenCount: 5
    };
    const workerOperation = () => this.localCompute.processResult({
      envelope: this.workerEnvelope,
      response: workerResponse
    });
    this.scheduler.schedule(CALLBACK_LABELS.workerPrimary, workerOperation);
    this.scheduler.schedule(CALLBACK_LABELS.workerDuplicate, workerOperation);

    const verificationOperation = async () => {
      const result = await this.verifier.verify(
        this.verificationWork.candidateFormalInterpretation,
        this.verificationWork.interpretationConfidence
      );
      return this.verification.processResult({
        envelope: this.verifierEnvelope,
        result,
        verifier: this.verifier
      });
    };
    this.scheduler.schedule(CALLBACK_LABELS.verifierPrimary, verificationOperation);
    this.scheduler.schedule(CALLBACK_LABELS.verifierDuplicate, verificationOperation);
  }
}

export function firstDisclosureId(): DisclosureId {
  const disclosure = sixPeopleProblem.interviewer.protectedDisclosures[0];
  if (disclosure === undefined) throw new Error("Problem fixture has no protected disclosure");
  return DisclosureIdSchema.parse(disclosure.id);
}

export function evidenceKeyString(key: EvidenceKey): string {
  return evidenceKeyToString(key);
}

export function completeGraphStatement(vertexCount: number): string {
  const vertices = Array.from(
    { length: vertexCount },
    (_, index) => String.fromCharCode(65 + index)
  );
  const edges: Array<{
    endpoints: [string, string];
    relation: "ACQUAINTANCE";
  }> = [];
  for (let left = 0; left < vertices.length - 1; left += 1) {
    for (let right = left + 1; right < vertices.length; right += 1) {
      const leftVertex = vertices[left];
      const rightVertex = vertices[right];
      if (leftVertex !== undefined && rightVertex !== undefined) {
        edges.push({
          endpoints: [leftVertex, rightVertex],
          relation: "ACQUAINTANCE"
        });
      }
    }
  }
  return JSON.stringify({
    protocol: "INTERVIEW_APP_TWO_COLOUR_GRAPH_CLAIM",
    protocolVersion: 1,
    problemId: "oxford-six-people",
    problemVersion: "1.0.0",
    claim: "ENCODED_GRAPH_HAS_MONOCHROMATIC_TRIANGLE",
    vertices,
    edges
  });
}

export function createReferenceModel(fixture: AdversarialFixture): AdversarialModel {
  const state = fixture.writer.getState();
  const model = new AdversarialModel({
    sequence: state.sequence,
    contextEpoch: state.contextEpoch,
    transcriptRevision: state.transcriptRevision,
    boardRevision: state.boardRevision,
    inputEpisodeId: fixture.inputEpisodeId,
    turnId: fixture.turnId,
    generationId: fixture.initialGenerationId
  });
  model.noteRequest("vision", fixture.visionRequestId, "PENDING");
  model.noteRequest("worker", fixture.workerRequestId, "PENDING");
  model.noteRequest(
    "verifier",
    fixture.verificationWork.verificationRequestId,
    "PENDING"
  );
  model.noteRequestFingerprint(
    fixture.providerEnvelope.requestId,
    `provider:${fixture.initialGenerationId}`
  );
  model.noteRequestFingerprint(
    fixture.visionEnvelope.requestId,
    `vision:${fixture.visionRequestId}`
  );
  model.noteRequestFingerprint(
    fixture.workerEnvelope.requestId,
    `worker:${fixture.workerRequestId}`
  );
  model.noteRequestFingerprint(
    fixture.verifierEnvelope.requestId,
    `verifier:${fixture.verificationWork.verificationRequestId}`
  );
  return model;
}
