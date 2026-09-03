import { z } from "zod";
import { describe, expect, it } from "vitest";
import {
  BoardActionSchema,
  CommandIdentityValueSchema,
  GenerationBasisSchema,
  SessionSummaryResponseSchema,
  evidenceKeyToString,
  newGenerationId,
  newRequestId,
  newTurnId,
  type BillingVerification,
  type DeliveryId,
  type ModelCapabilities,
  type ProviderPolicy
} from "../../packages/domain/src/index.js";
import {
  RendererStreamAttachRequestSchema,
  RendererStreamMessageSchema,
  type RendererAcknowledgementCommand
} from "../../packages/delivery/src/index.js";
import { replaySession } from "../../packages/events/src/index.js";
import {
  createCommandEnvelope,
  isGenerationBasisStillCompatible
} from "../../packages/interview-engine/src/index.js";
import { MockModelAdapter } from "../../packages/providers/src/index.js";
import {
  ProviderPolicyError,
  assertProviderPermitted
} from "../../packages/providers/src/index.js";
import { sixPeopleProblem } from "../../packages/problems/src/index.js";
import {
  LocalInterviewTransportRuntime
} from "../../apps/server/src/index.js";
import {
  RendererClient,
  RendererPresentationNotExposedError,
  type AudioPlayer,
  type RendererAcknowledgementSender
} from "../../apps/web/src/index.js";
import { DeterministicScheduler } from "./deterministic-scheduler.js";
import {
  ADVERSARIAL_SECRET,
  CALLBACK_LABELS,
  MILESTONE_EVIDENCE_KEY,
  AdversarialFixture,
  firstDisclosureId
} from "./fixtures.js";

const SILENT_AUDIO: AudioPlayer = {
  playAudio: () => undefined
};

describe("adversarial named regression schedules", () => {
  it("provider ignores cancellation and returns after a new generation", async () => {
    const fixture = await AdversarialFixture.create();
    const provider = new MockModelAdapter({
      cancellationBehavior: "IGNORE",
      proposal: {
        realizedAction:
          fixture.writer.getState().pedagogicalActions[fixture.turnId]?.requiredAction
          ?? "PROBE_JUSTIFICATION",
        claimedDisclosureLevel: 0,
        claimedDisclosureIds: [],
        speechText: fixture.safeProbe
      }
    });
    const session = await provider.createSession();

    try {
      await session.cancelTurn?.(fixture.initialGenerationId);
      await fixture.turns.supersedeGeneration(
        fixture.initialGenerationId,
        "provider failover"
      );
      const replacement = await fixture.startReplacementGeneration();

      for await (const proposal of session.sendTurn({
        context: {},
        generationId: fixture.initialGenerationId
      })) {
        const result = await fixture.turns.processProposal({
          envelope: createCommandEnvelope({
            sessionId: fixture.sessionId,
            producer: provider.name,
            generationId: fixture.initialGenerationId,
            inputEpisodeId: fixture.inputEpisodeId,
            turnId: fixture.turnId,
            contextEpoch: fixture.providerEnvelope.contextEpoch,
            ...(fixture.providerEnvelope.sourceRevision === undefined
              ? {}
              : { sourceRevision: fixture.providerEnvelope.sourceRevision })
          }),
          problem: sixPeopleProblem,
          proposal,
          validator: fixture.validator
        });
        expect(result.accepted).toBe(false);
      }

      expect(
        fixture.writer.getState().generations[replacement]?.status
      ).toBe("ACTIVE");
      expect(
        Object.values(fixture.writer.getState().deliveries)
          .filter((atom) => atom.generationId === fixture.initialGenerationId)
      ).toEqual([]);
    } finally {
      await session.close();
      await fixture.close();
    }
  }, 15_000);

  it("transcript correction changes Context Epoch before an old provider result returns", async () => {
    const fixture = await AdversarialFixture.create();
    try {
      const oldEpoch = fixture.writer.getState().contextEpoch;
      const oldBasis =
        fixture.writer.getState().generations[fixture.initialGenerationId]?.basis;
      if (oldBasis === undefined) throw new Error("Missing generation basis");

      await fixture.turns.correctTranscript("corrected before provider return");
      expect(fixture.writer.getState().contextEpoch).toBe(oldEpoch + 1);
      expect(
        isGenerationBasisStillCompatible(oldBasis, fixture.writer.getState())
      ).toBe("INCOMPATIBLE");

      const result = await fixture.release<{
        readonly accepted: boolean;
        readonly deliveryAtoms: readonly unknown[];
      }>(CALLBACK_LABELS.providerPrimary);
      expect(result.accepted).toBe(false);
      expect(result.deliveryAtoms).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  it("late vision result after board revision is discarded", async () => {
    const fixture = await AdversarialFixture.create();
    try {
      await fixture.turns.commitBoardPatch("shape-1 replaced");
      const result = await fixture.release<{ readonly accepted: boolean }>(
        CALLBACK_LABELS.visionPrimary
      );
      expect(result.accepted).toBe(false);
      expect(
        fixture.writer.getState().visionRequests[fixture.visionRequestId]?.status
      ).toBe("DISCARDED");
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("duplicate local-worker response across restart is durably idempotent", async () => {
    const fixture = await AdversarialFixture.create();
    try {
      const first = await fixture.release<{
        readonly duplicate: boolean;
        readonly value: { readonly accepted: boolean };
      }>(CALLBACK_LABELS.workerPrimary);
      expect(first.value.accepted).toBe(true);
      const count = fixture.store.eventCount(fixture.sessionId);

      await fixture.restart();
      const duplicate = await fixture.release<{
        readonly duplicate: boolean;
        readonly value: { readonly accepted: boolean };
      }>(CALLBACK_LABELS.workerDuplicate);

      expect(duplicate.duplicate).toBe(true);
      expect(duplicate.value.accepted).toBe(true);
      expect(fixture.store.eventCount(fixture.sessionId)).toBe(count);
    } finally {
      await fixture.close();
    }
  });

  it("verifier result becomes stale and is then duplicated without new authority", async () => {
    const fixture = await AdversarialFixture.create();
    try {
      await fixture.turns.correctTranscript("verification basis corrected");
      const first = await fixture.release<{
        readonly duplicate: boolean;
        readonly value: {
          readonly accepted: boolean;
          readonly reason?: string;
        };
      }>(CALLBACK_LABELS.verifierPrimary);
      expect(first.value).toMatchObject({
        accepted: false,
        reason: "COMPATIBILITY_INCOMPATIBLE"
      });
      const count = fixture.store.eventCount(fixture.sessionId);

      await fixture.restart();
      const duplicate = await fixture.release<{
        readonly duplicate: boolean;
        readonly value: {
          readonly accepted: boolean;
          readonly reason?: string;
        };
      }>(CALLBACK_LABELS.verifierDuplicate);

      expect(duplicate.duplicate).toBe(true);
      expect(duplicate.value).toEqual(first.value);
      expect(fixture.store.eventCount(fixture.sessionId)).toBe(count);
    } finally {
      await fixture.close();
    }
  });

  it("evidence is updated, superseded, corrected stale, and rebuilt after restart", async () => {
    const fixture = await AdversarialFixture.create();
    const key = evidenceKeyToString(MILESTONE_EVIDENCE_KEY);
    try {
      expect(await fixture.proposeEvidence("PROGRESSING")).toBe(true);
      expect(await fixture.proposeEvidence("COMPLETE")).toBe(true);
      await fixture.turns.correctTranscript("retract prior evidence");
      await fixture.restart();

      const historyBeforeFresh = fixture.writer.getState().evidenceHistory[key];
      expect(historyBeforeFresh?.map((record) => record.status)).toEqual([
        "SUPERSEDED",
        "STALE"
      ]);
      expect(fixture.writer.getState().studentEvidence[key]).toBeUndefined();

      expect(await fixture.proposeEvidence("PROGRESSING")).toBe(true);
      expect(
        fixture.writer.getState().evidenceHistory[key]?.map(
          (record) => record.status
        )
      ).toEqual(["SUPERSEDED", "STALE", "ACTIVE"]);
      expect(fixture.writer.getState().studentEvidence[key]?.value).toBe(
        "PROGRESSING"
      );
    } finally {
      await fixture.close();
    }
  });

  it("generated hint is cancelled before exposure", async () => {
    const fixture = await AdversarialFixture.create();
    try {
      const result = await fixture.release<{
        readonly accepted: boolean;
        readonly deliveryAtoms: readonly { readonly deliveryId: DeliveryId }[];
      }>(CALLBACK_LABELS.providerPrimary);
      expect(result.accepted).toBe(true);
      const deliveryId = result.deliveryAtoms[0]?.deliveryId;
      if (deliveryId === undefined) throw new Error("Expected queued delivery");

      await fixture.delivery.cancelBeforeExposure(
        deliveryId,
        "student continued before exposure"
      );
      expect(
        fixture.writer.getState().deliveries[deliveryId]?.status
      ).toBe("CANCELLED");
      expect(fixture.writer.getState().disclosureLedger).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  it("renderer exposes then crashes before acknowledgement persistence", async () => {
    const fixture = await AdversarialFixture.create();
    try {
      const atom = await fixture.queueSyntheticDelivery({
        disclosureIds: [firstDisclosureId()]
      });
      const command = await fixture.delivery.markStarted(atom.deliveryId);
      const visible: DeliveryId[] = [];
      const renderer = new RendererClient({
        sessionId: fixture.sessionId,
        acknowledgementSender: {
          send: () => Promise.reject(
            new Error("simulated acknowledgement transport crash")
          )
        },
        textPresenter: {
          presentText: (_text, deliveryId) => {
            visible.push(deliveryId);
          }
        },
        audioPlayer: SILENT_AUDIO
      });

      await renderer.handleMessage({
        protocolVersion: 1,
        type: "DELIVERY_COMMAND",
        command
      });
      expect(visible).toEqual([atom.deliveryId]);
      expect(
        fixture.writer.getState().deliveries[atom.deliveryId]?.status
      ).toBe("DELIVERING");

      await fixture.restart();
      await fixture.delivery.recoverUncertainDeliveries();
      expect(
        fixture.writer.getState().deliveries[atom.deliveryId]?.status
      ).toBe("POSSIBLY_EXPOSED");
      expect(fixture.writer.getState().disclosureLedger).toContain(
        firstDisclosureId()
      );
    } finally {
      await fixture.close();
    }
  });

  it("acknowledgement persisted immediately before crash is not demoted on restart", async () => {
    const fixture = await AdversarialFixture.create();
    try {
      const atom = await fixture.queueSyntheticDelivery();
      const command = await fixture.delivery.markStarted(atom.deliveryId);
      const sender = backendAcknowledgementSender(fixture, {
        failCompletion: true
      });
      const renderer = new RendererClient({
        sessionId: fixture.sessionId,
        acknowledgementSender: sender,
        textPresenter: { presentText: () => undefined },
        audioPlayer: SILENT_AUDIO
      });

      await renderer.handleMessage({
        protocolVersion: 1,
        type: "DELIVERY_COMMAND",
        command
      });
      expect(
        fixture.writer.getState().deliveries[atom.deliveryId]?.status
      ).toBe("EXPOSED");

      await fixture.restart();
      const recovered = await fixture.delivery.recoverUncertainDeliveries();
      expect(recovered).toEqual([]);
      expect(
        fixture.writer.getState().deliveries[atom.deliveryId]?.status
      ).toBe("EXPOSED");
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("reconnect retries the same DeliveryId without duplicate visible output", async () => {
    const fixture = await AdversarialFixture.create();
    try {
      const atom = await fixture.queueSyntheticDelivery();
      const command = await fixture.delivery.markStarted(atom.deliveryId);
      const visible: DeliveryId[] = [];
      const renderer = new RendererClient({
        sessionId: fixture.sessionId,
        acknowledgementSender: { send: async () => undefined },
        textPresenter: {
          presentText: (_text, deliveryId) => {
            visible.push(deliveryId);
          }
        },
        audioPlayer: SILENT_AUDIO
      });
      const message = RendererStreamMessageSchema.parse({
        protocolVersion: 1,
        type: "DELIVERY_COMMAND",
        command
      });

      await renderer.handleMessage(message);
      const reconnect = await fixture.delivery.reconnect(
        atom.deliveryId,
        createCommandEnvelope({
          sessionId: fixture.sessionId,
          producer: "renderer-reconnect"
        })
      );
      expect(reconnect.deliveryId).toBe(atom.deliveryId);
      if (reconnect.command !== undefined) {
        await renderer.handleMessage({
          protocolVersion: 1,
          type: "DELIVERY_COMMAND",
          command: reconnect.command
        });
      }
      expect(visible).toEqual([atom.deliveryId]);
    } finally {
      await fixture.close();
    }
  });

  it("ambiguous renderer failure suppresses retry", async () => {
    const fixture = await AdversarialFixture.create();
    try {
      const atom = await fixture.queueSyntheticDelivery();
      const command = await fixture.delivery.markStarted(atom.deliveryId);
      let attempts = 0;
      const renderer = new RendererClient({
        sessionId: fixture.sessionId,
        acknowledgementSender: { send: async () => undefined },
        textPresenter: {
          presentText: () => {
            attempts += 1;
            throw new Error("presentation outcome unknown");
          }
        },
        audioPlayer: SILENT_AUDIO
      });
      const message = {
        protocolVersion: 1,
        type: "DELIVERY_COMMAND",
        command
      };

      await expect(renderer.handleMessage(message)).rejects.toThrow(
        "outcome unknown"
      );
      const duplicate = await renderer.handleMessage(message);
      expect(duplicate).toMatchObject({
        duplicate: true,
        phase: "RECEIVED"
      });
      expect(attempts).toBe(1);
    } finally {
      await fixture.close();
    }
  });

  it("presenter-proven non-exposure permits same-ID retry", async () => {
    const fixture = await AdversarialFixture.create();
    try {
      const atom = await fixture.queueSyntheticDelivery();
      const command = await fixture.delivery.markStarted(atom.deliveryId);
      let attempts = 0;
      const visible: DeliveryId[] = [];
      const renderer = new RendererClient({
        sessionId: fixture.sessionId,
        acknowledgementSender: { send: async () => undefined },
        textPresenter: {
          presentText: (_text, deliveryId) => {
            attempts += 1;
            if (attempts === 1) {
              throw new RendererPresentationNotExposedError(
                "fixture proves no exposure"
              );
            }
            visible.push(deliveryId);
          }
        },
        audioPlayer: SILENT_AUDIO
      });
      const message = {
        protocolVersion: 1,
        type: "DELIVERY_COMMAND",
        command
      };

      await expect(renderer.handleMessage(message)).rejects.toThrow(
        "proves no exposure"
      );
      expect(renderer.snapshot()).toEqual([]);
      await renderer.handleMessage(message);
      expect(attempts).toBe(2);
      expect(visible).toEqual([atom.deliveryId]);
    } finally {
      await fixture.close();
    }
  });

  it("missing or stale billing verification fails closed", () => {
    expectPolicyFailure(undefined, "MISSING_BILLING_VERIFICATION");
    expectPolicyFailure({
      billingClass: "VERIFIED_FREE_ONLY",
      enforcementMechanism: "technical no-spend fixture",
      verifiedAt: "2026-08-29T19:59:58.000Z",
      adapterVersion: "adversarial@1",
      spendImpossible: true
    }, "VERIFICATION_STALE");
  });

  it("malformed secret-bearing error material is never persisted or reflected", async () => {
    const fixture = await AdversarialFixture.create();
    try {
      const sourceRevision = fixture.workerEnvelope.sourceRevision;
      if (sourceRevision === undefined) throw new Error("Missing worker basis");
      const result = await fixture.localCompute.processResult({
        envelope: createCommandEnvelope({
          sessionId: fixture.sessionId,
          producer: "secret-bearing-worker-error",
          correlationId: fixture.workerRequestId,
          sourceRevision
        }),
        response: {
          protocolVersion: 1,
          requestId: fixture.workerRequestId,
          type: "WORKER_ERROR",
          code: "INTERNAL_ERROR",
          message: ADVERSARIAL_SECRET
        }
      });

      expect(result.value).toMatchObject({
        accepted: false,
        reason: "WORKER_ERROR"
      });
      expect(JSON.stringify(result.value)).not.toContain(ADVERSARIAL_SECRET);
      expect(
        JSON.stringify(fixture.store.load(fixture.sessionId))
      ).not.toContain(ADVERSARIAL_SECRET);
    } finally {
      await fixture.close();
    }
  });

  it("UNKNOWN generation provenance never creates a DeliveryAtom", async () => {
    const fixture = await AdversarialFixture.create();
    try {
      const generationId = newGenerationId();
      const missingTurnId = newTurnId();
      const state = fixture.writer.getState();
      const basis = GenerationBasisSchema.parse({
        contextEpoch: state.contextEpoch,
        committedInputSequence: state.lastCommittedInputSequence,
        transcriptRevision: state.transcriptRevision,
        boardRevision: state.boardRevision,
        problemStateRevision: state.problemStateRevision,
        policyRevision: state.policyRevision,
        inputEpisodeId: fixture.inputEpisodeId,
        turnId: missingTurnId
      });
      expect(isGenerationBasisStillCompatible(basis, state)).toBe("UNKNOWN");

      await fixture.writer.execute(
        createCommandEnvelope({
          sessionId: fixture.sessionId,
          producer: "unknown-generation-fixture"
        }),
        {
          operation: "START_UNKNOWN_PROVENANCE_GENERATION",
          payload: {
            generationId,
            basis: CommandIdentityValueSchema.parse(
              JSON.parse(JSON.stringify(basis))
            )
          }
        },
        z.object({ started: z.literal(true) }).strict(),
        () => ({
          drafts: [{
            source: "APPLICATION",
            type: "MODEL_GENERATION_STARTED",
            payload: {
              generationId,
              basis,
              provider: "unknown-provenance-provider"
            }
          }],
          result: { started: true as const }
        })
      );

      const result = await fixture.turns.processProposal({
        envelope: createCommandEnvelope({
          sessionId: fixture.sessionId,
          producer: "unknown-provenance-provider",
          generationId,
          inputEpisodeId: fixture.inputEpisodeId,
          turnId: missingTurnId,
          contextEpoch: basis.contextEpoch,
          sourceRevision: basis.committedInputSequence
        }),
        problem: sixPeopleProblem,
        proposal: {
          realizedAction: "PROBE_JUSTIFICATION",
          claimedDisclosureLevel: 0,
          claimedDisclosureIds: [],
          speechText: fixture.safeProbe
        },
        validator: fixture.validator
      });
      expect(result.accepted).toBe(false);
      expect(result.reason).toContain("UNKNOWN");
      expect(
        Object.values(fixture.writer.getState().deliveries)
          .some((atom) => atom.generationId === generationId)
      ).toBe(false);
    } finally {
      await fixture.close();
    }
  });

  it("AI whiteboard runtime schema cannot mutate the student-owned layer", () => {
    expect(() => BoardActionSchema.parse({
      operation: "highlight",
      layer: "STUDENT",
      targetShapeId: "student-shape",
      annotationPurpose: "adversarial mutation attempt"
    })).toThrow();
  });

  it("stale queued delivery cannot start after its generation basis becomes incompatible", async () => {
    const fixture = await AdversarialFixture.create();
    try {
      const result = await fixture.release<{
        readonly accepted: boolean;
        readonly deliveryAtoms: readonly { readonly deliveryId: DeliveryId }[];
      }>(CALLBACK_LABELS.providerPrimary);
      expect(result.accepted).toBe(true);
      const deliveryId = result.deliveryAtoms[0]?.deliveryId;
      if (deliveryId === undefined) throw new Error("Expected queued provider delivery");

      const generation =
        fixture.writer.getState().generations[fixture.initialGenerationId];
      if (generation === undefined) throw new Error("Missing provider generation");
      expect(
        isGenerationBasisStillCompatible(
          generation.basis,
          fixture.writer.getState()
        )
      ).toBe("COMPATIBLE");

      await fixture.turns.commitBoardPatch(
        "minimal counterexample: relevant board state changed"
      );
      expect(
        isGenerationBasisStillCompatible(
          generation.basis,
          fixture.writer.getState()
        )
      ).toBe("INCOMPATIBLE");

      expect(
        fixture.writer.getState().generations[fixture.initialGenerationId]?.status
      ).toBe("SUPERSEDED");
      expect(
        fixture.writer.getState().deliveries[deliveryId]?.status
      ).toBe("CANCELLED");

      const count = fixture.store.eventCount(fixture.sessionId);
      await expect(
        fixture.delivery.markStarted(deliveryId)
      ).rejects.toThrow();
      expect(fixture.store.eventCount(fixture.sessionId)).toBe(count);
    } finally {
      await fixture.close();
    }
  });

  it("racing command and renderer first use share one recovery and never replay POSSIBLY_EXPOSED", async () => {
    const fixture = await AdversarialFixture.create();
    const scheduler = new DeterministicScheduler();
    let runtime: LocalInterviewTransportRuntime | undefined;
    let streamAbort: AbortController | undefined;
    let streamResponse: Response | undefined;

    try {
      const atom = await fixture.queueSyntheticDelivery();
      await fixture.delivery.markStarted(atom.deliveryId);
      expect(
        fixture.writer.getState().deliveries[atom.deliveryId]?.status
      ).toBe("DELIVERING");

      await fixture.restart();

      runtime = new LocalInterviewTransportRuntime({
        security: recoverySecurity(),
        registry: fixture.registry
      });
      const activeRuntime = runtime;
      const bound = await activeRuntime.start();
      streamAbort = new AbortController();
      const activeAbort = streamAbort;

      scheduler.schedule("transport.command-first-use", () =>
        fetch(`${bound.command.url}/v1/commands`, {
          method: "POST",
          headers: recoveryHeaders(),
          body: JSON.stringify({
            protocolVersion: 1,
            type: "GET_SESSION_SUMMARY",
            requestId: newRequestId(),
            sessionId: fixture.sessionId
          })
        })
      );
      scheduler.schedule("transport.renderer-first-use", () =>
        fetch(bound.rendererStream.streamUrl, {
          method: "POST",
          headers: recoveryHeaders(),
          body: JSON.stringify(RendererStreamAttachRequestSchema.parse({
            protocolVersion: 1,
            type: "ATTACH_RENDERER_STREAM",
            sessionId: fixture.sessionId
          })),
          signal: activeAbort.signal
        })
      );
      scheduler.schedule(
        "transport.duplicate-recovery",
        () => activeRuntime.sessions.ensureRecovered(fixture.sessionId)
      );

      scheduler.release("transport.command-first-use");
      scheduler.release("transport.renderer-first-use");
      scheduler.release("transport.duplicate-recovery");

      const [summaryResponse, rendererResponse, duplicateRecovery] =
        await Promise.all([
          scheduler.settle<Response>("transport.command-first-use"),
          scheduler.settle<Response>("transport.renderer-first-use"),
          scheduler.settle<readonly DeliveryId[]>(
            "transport.duplicate-recovery"
          )
        ]);
      streamResponse = rendererResponse;

      expect(summaryResponse.status).toBe(200);
      expect(rendererResponse.status).toBe(200);
      expect(duplicateRecovery).toContain(atom.deliveryId);

      const summary = SessionSummaryResponseSchema.parse(
        await summaryResponse.json()
      );
      expect(summary.deliveryStatuses[atom.deliveryId]).toBe(
        "POSSIBLY_EXPOSED"
      );

      const recoveryEvents = fixture.store.load(fixture.sessionId).filter(
        (event) => event.type === "DELIVERY_POSSIBLY_EXPOSED"
      );
      expect(recoveryEvents).toHaveLength(1);
      expect(recoveryEvents[0]?.payload.deliveryId).toBe(atom.deliveryId);

      expect(
        await activeRuntime.rendererStreamServer.publishDelivery(
          fixture.sessionId,
          atom.deliveryId
        )
      ).toEqual({
        outcome: "NOT_DELIVERABLE",
        deliveryId: atom.deliveryId,
        status: "POSSIBLY_EXPOSED"
      });

      const writer = activeRuntime.sessions.getWriter(fixture.sessionId);
      expect(
        replaySession(
          fixture.sessionId,
          fixture.store.load(fixture.sessionId)
        )
      ).toEqual(writer.getState());

      await activeRuntime.sessions.ensureRecovered(fixture.sessionId);
      expect(
        fixture.store.load(fixture.sessionId).filter(
          (event) => event.type === "DELIVERY_POSSIBLY_EXPOSED"
        )
      ).toHaveLength(1);
    } finally {
      streamAbort?.abort();
      await streamResponse?.body?.cancel().catch(() => undefined);
      if (runtime !== undefined) await runtime.stop();
      await scheduler.cancelPendingAndDrain();
      await fixture.close();
    }
  });

  it("conflicting RequestId reuse fails closed instead of silently acknowledging a different command", async () => {
    const fixture = await AdversarialFixture.create();
    try {
      const atom = await fixture.queueSyntheticDelivery();
      await fixture.delivery.markStarted(atom.deliveryId);
      const reused = createCommandEnvelope({
        sessionId: fixture.sessionId,
        producer: "adversarial-conflicting-request"
      });
      await fixture.delivery.acknowledgeExposed(atom.deliveryId, reused);
      const count = fixture.store.eventCount(fixture.sessionId);

      await expect(
        fixture.delivery.acknowledgeCompleted(atom.deliveryId, reused)
      ).rejects.toThrow(/request|conflict|reuse/iu);
      expect(fixture.store.eventCount(fixture.sessionId)).toBe(count);
      expect(
        fixture.writer.getState().deliveries[atom.deliveryId]?.status
      ).toBe("EXPOSED");
    } finally {
      await fixture.close();
    }
  });
});

function backendAcknowledgementSender(
  fixture: AdversarialFixture,
  options: { readonly failCompletion: boolean }
): RendererAcknowledgementSender {
  return {
    send: async (command: RendererAcknowledgementCommand) => {
      const envelope = createCommandEnvelope({
        sessionId: fixture.sessionId,
        producer: "adversarial-renderer",
        requestId: command.requestId
      });
      if (command.type === "ACK_DELIVERY_EXPOSED") {
        await fixture.delivery.acknowledgeExposed(
          command.deliveryId,
          envelope
        );
        return;
      }
      if (options.failCompletion) {
        throw new Error("simulated crash after exposure acknowledgement");
      }
      await fixture.delivery.acknowledgeCompleted(
        command.deliveryId,
        envelope
      );
    }
  };
}

const POLICY: ProviderPolicy = {
  allowMeteredUsage: false,
  maximumDataUse: "LOCAL_ONLY",
  billingVerificationMaxAgeMs: 1_000
};

const CAPABILITIES: ModelCapabilities = {
  inputModalities: new Set(["text"]),
  textStreaming: false,
  structuredOutput: "FINAL_ONLY",
  persistentSession: false,
  resumableSession: false,
  cancellation: "DROP_OUTPUT",
  sessionSurvivesClientAbort: false,
  sessionSurvivesProviderCancel: false,
  usageReporting: false,
  dataUse: "LOCAL_ONLY"
};

function expectPolicyFailure(
  billingVerification: BillingVerification | undefined,
  expectedCode: ProviderPolicyError["code"]
): void {
  let caught: unknown;
  try {
    assertProviderPermitted({
      policy: POLICY,
      capabilities: CAPABILITIES,
      adapterVersion: "adversarial@1",
      now: new Date("2026-08-29T20:00:00.500Z"),
      ...(billingVerification === undefined ? {} : { billingVerification })
    });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ProviderPolicyError);
  if (!(caught instanceof ProviderPolicyError)) {
    throw new Error("Expected ProviderPolicyError");
  }
  expect(caught.code).toBe(expectedCode);
}

const RECOVERY_CLIENT_TOKEN =
  "adversarial-shared-recovery-client-token-long-enough";
const RECOVERY_CLIENT_ORIGIN = "http://127.0.0.1:5173";

function recoverySecurity() {
  return {
    host: "127.0.0.1" as const,
    allowedOrigins: new Set([RECOVERY_CLIENT_ORIGIN]),
    clientToken: RECOVERY_CLIENT_TOKEN
  };
}

function recoveryHeaders(): Record<string, string> {
  return {
    origin: RECOVERY_CLIENT_ORIGIN,
    "content-type": "application/json",
    "x-interview-client-token": RECOVERY_CLIENT_TOKEN
  };
}
