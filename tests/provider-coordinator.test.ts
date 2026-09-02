import { isDeepStrictEqual } from "node:util";
import { describe, expect, it } from "vitest";
import {
  newSessionId,
  type GenerationId,
  type InterviewerProposal,
  type ModelCapabilities,
  type ReasoningProvider,
  type ReasoningSession
} from "../packages/domain/src/index.js";
import { replaySession } from "../packages/events/src/index.js";
import {
  ClosedWorldDisclosureAnalyzer,
  DisclosureValidator,
  ProviderCoordinator,
  createCommandEnvelope,
  SessionRuntimeRegistry,
  TurnCoordinator
} from "../packages/interview-engine/src/index.js";
import { SqliteEventStore } from "../packages/persistence/src/index.js";
import { sixPeopleProblem } from "../packages/problems/src/index.js";
import { MockModelAdapter } from "../packages/providers/src/index.js";

const NOW = new Date("2026-08-30T04:00:00.000Z");
const POLICY = {
  allowMeteredUsage: false,
  maximumDataUse: "LOCAL_ONLY" as const,
  billingVerificationMaxAgeMs: 1_000
};
const SAFE_PROBE = "Why must that step be true?";
const PROPOSAL: InterviewerProposal = {
  realizedAction: "PROBE_JUSTIFICATION",
  claimedDisclosureLevel: 0,
  claimedDisclosureIds: [],
  speechText: SAFE_PROBE
};
const CAPABILITIES: ModelCapabilities = {
  inputModalities: new Set(["text"]),
  textStreaming: false,
  structuredOutput: "FINAL_ONLY",
  persistentSession: false,
  resumableSession: false,
  cancellation: "NONE",
  sessionSurvivesClientAbort: false,
  sessionSurvivesProviderCancel: false,
  usageReporting: false,
  dataUse: "LOCAL_ONLY"
};

describe("application-owned ProviderCoordinator", () => {
  it("runs the admitted context-to-proposal path and leaves replay independent of provider state", async () => {
    const harness = await coordinatorHarness();
    try {
      const provider = new MockModelAdapter({ proposal: PROPOSAL });
      const execution = await harness.coordinator.start({
        inputEpisodeId: harness.inputEpisodeId,
        turnId: harness.turnId,
        provider,
        policy: POLICY,
        problem: sixPeopleProblem,
        validator: harness.validator,
        now: NOW
      });
      const outcome = await execution.completion;

      expect(outcome.status).toBe("ACCEPTED");
      if (outcome.status !== "ACCEPTED") throw new Error("Expected accepted provider proposal");
      expect(outcome.deliveryAtoms).toHaveLength(1);
      expect(harness.writer.getState().generations[execution.generationId]).toMatchObject({
        provider: "mock-model",
        status: "VALIDATED"
      });
      expect(harness.writer.getState().deliveries[outcome.deliveryAtoms[0]?.deliveryId ?? ""]?.status).toBe("QUEUED");

      const events = harness.store.load(harness.sessionId);
      expect(events.findIndex((event) => event.type === "GENERATION_CONTEXT_COMPILED"))
        .toBeLessThan(events.findIndex((event) => event.type === "MODEL_PROPOSAL_RECEIVED"));
      expect(isDeepStrictEqual(replaySession(harness.sessionId, events), harness.writer.getState())).toBe(true);
    } finally {
      harness.store.close();
    }
  });

  it("suppresses output released after cancellation even when the provider ignores cancellation", async () => {
    const harness = await coordinatorHarness();
    try {
      const provider = new DeferredProvider();
      const execution = await harness.coordinator.start(startInput(harness, provider));
      await provider.turnStarted;
      const report = await harness.coordinator.cancelGeneration(execution.generationId, "student barge-in");
      provider.release();
      const outcome = await execution.completion;

      expect(report).toEqual({
        generationId: execution.generationId,
        outputDisposition: "DROP_OUTPUT",
        adapterResult: { semantics: "NONE" }
      });
      expect(outcome.status).toBe("CANCELLED");
      expect(provider.cancelledGenerationIds).toEqual([execution.generationId]);
      expect(harness.writer.getState().generations[execution.generationId]?.status).toBe("SUPERSEDED");
      expect(harness.store.load(harness.sessionId).some((event) => event.type === "MODEL_PROPOSAL_RECEIVED")).toBe(false);
      expect(Object.keys(harness.writer.getState().deliveries)).toHaveLength(0);
    } finally {
      harness.store.close();
    }
  });

  it("completes authoritative cancellation while provider session creation never resolves", async () => {
    const harness = await coordinatorHarness();
    try {
      let signalSessionCreation: (() => void) | undefined;
      const sessionCreationStarted = new Promise<void>((resolve) => {
        signalSessionCreation = resolve;
      });
      const never = new Promise<ReasoningSession>(() => undefined);
      const provider = testProvider(async () => {
        signalSessionCreation?.();
        return await never;
      });

      const execution = await harness.coordinator.start(startInput(harness, provider));
      await sessionCreationStarted;
      await harness.coordinator.cancelGeneration(
        execution.generationId,
        "student barge-in during provider admission"
      );

      await expect(execution.completion).resolves.toEqual({
        status: "CANCELLED",
        generationId: execution.generationId
      });
      expect(harness.writer.getState().generations[execution.generationId]?.status)
        .toBe("SUPERSEDED");
      expect(Object.keys(harness.writer.getState().deliveries)).toHaveLength(0);
    } finally {
      harness.store.close();
    }
  });

  it("completes authoritative cancellation even when provider stream, cancel, and close never resolve", async () => {
    const harness = await coordinatorHarness();
    try {
      let signalTurnStarted: (() => void) | undefined;
      const turnStarted = new Promise<void>((resolve) => {
        signalTurnStarted = resolve;
      });
      const never = new Promise<never>(() => undefined);
      const provider = testProvider(async () => ({
        async *sendTurn() {
          signalTurnStarted?.();
          await never;
        },
        async cancelTurn() {
          await never;
          return { semantics: "NONE" as const };
        },
        async close() {
          await never;
        }
      }));

      const execution = await harness.coordinator.start(startInput(harness, provider));
      await turnStarted;
      void harness.coordinator.cancelGeneration(
        execution.generationId,
        "student barge-in"
      );

      const outcome = await execution.completion;
      expect(outcome).toEqual({
        status: "CANCELLED",
        generationId: execution.generationId
      });
      expect(harness.writer.getState().generations[execution.generationId]?.status)
        .toBe("SUPERSEDED");
      expect(Object.keys(harness.writer.getState().deliveries)).toHaveLength(0);
    } finally {
      harness.store.close();
    }
  });

  it("rejects a late proposal after a basis-changing mutation proactively supersedes its generation", async () => {
    const harness = await coordinatorHarness();
    try {
      const provider = new DeferredProvider();
      const execution = await harness.coordinator.start(startInput(harness, provider));
      await provider.turnStarted;
      await harness.turns.commitBoardPatch("student replaced the board argument");
      expect(harness.writer.getState().generations[execution.generationId]?.status).toBe("SUPERSEDED");

      provider.release();
      const outcome = await execution.completion;

      expect(outcome).toMatchObject({ status: "REJECTED", reason: "Generation is not active" });
      expect(harness.writer.getState().generations[execution.generationId]?.status).toBe("SUPERSEDED");
      expect(Object.keys(harness.writer.getState().deliveries)).toHaveLength(0);
    } finally {
      harness.store.close();
    }
  });

  it("admits only the first final proposal from a misbehaving multi-result stream", async () => {
    const harness = await coordinatorHarness();
    try {
      const provider = testProvider(async () => ({
        async *sendTurn() {
          yield PROPOSAL;
          yield { ...PROPOSAL, speechText: "A conflicting second proposal." };
        },
        async close() {}
      }));
      const execution = await harness.coordinator.start(startInput(harness, provider));
      expect((await execution.completion).status).toBe("ACCEPTED");
      expect(harness.store.load(harness.sessionId).filter((event) => event.type === "MODEL_PROPOSAL_RECEIVED"))
        .toHaveLength(1);
      expect(Object.keys(harness.writer.getState().deliveries)).toHaveLength(1);
    } finally {
      harness.store.close();
    }
  });

  it("fails before provider use when new evidence makes the stored pedagogical action stale", async () => {
    const harness = await coordinatorHarness();
    try {
      const state = harness.writer.getState();
      const turn = state.turns[harness.turnId];
      expect(turn).toBeDefined();
      if (turn === undefined) throw new Error("missing turn");
      const evidenceEventId = state.eventIds[turn.committedSequence - 1];
      expect(evidenceEventId).toBeDefined();
      if (evidenceEventId === undefined) throw new Error("missing evidence provenance");

      const evidence = await harness.turns.processEvidenceProposal({
        envelope: createCommandEnvelope({
          sessionId: harness.sessionId,
          producer: "evidence-test",
          inputEpisodeId: harness.inputEpisodeId,
          turnId: harness.turnId
        }),
        proposal: {
          key: {
            problemId: sixPeopleProblem.id,
            subject: { kind: "MILESTONE", milestoneId: "model-relations" },
            dimension: "PROGRESS"
          },
          proposedValue: "PROGRESSING",
          inferenceConfidence: 0.95,
          evidenceEventIds: [evidenceEventId]
        }
      });
      expect(evidence.committed).toBe(true);

      let verificationCalls = 0;
      let sessionCreations = 0;
      const provider = testProvider(async () => {
        sessionCreations += 1;
        return proposalSession();
      }, () => { verificationCalls += 1; });

      const execution = await harness.coordinator.start(startInput(harness, provider));
      const outcome = await execution.completion;

      expect(outcome).toMatchObject({
        status: "FAILED",
        stage: "CONTEXT",
        code: "ACTION_STALE"
      });
      expect(verificationCalls).toBe(0);
      expect(sessionCreations).toBe(0);
      expect(harness.writer.getState().generations[execution.generationId]?.status)
        .toBe("SUPERSEDED");
    } finally {
      harness.store.close();
    }
  });

  it("fails closed before provider use when context does not match the authoritative problem", async () => {
    const harness = await coordinatorHarness();
    try {
      let verificationCalls = 0;
      let sessionCreations = 0;
      const provider = testProvider(async () => {
        sessionCreations += 1;
        return proposalSession();
      }, () => { verificationCalls += 1; });
      const execution = await harness.coordinator.start({
        ...startInput(harness, provider),
        problem: { ...sixPeopleProblem, id: "different-problem" }
      });
      const outcome = await execution.completion;

      expect(outcome).toMatchObject({ status: "FAILED", stage: "CONTEXT", code: "PROBLEM_MISMATCH" });
      expect(verificationCalls).toBe(0);
      expect(sessionCreations).toBe(0);
      expect(harness.writer.getState().generations[execution.generationId]?.status).toBe("SUPERSEDED");
    } finally {
      harness.store.close();
    }
  });

  it("supersedes the generation when adapter billing admission fails", async () => {
    const harness = await coordinatorHarness();
    try {
      let sessionCreations = 0;
      const provider = new MockModelAdapter({
        proposal: PROPOSAL,
        billingVerificationFactory: () => ({
          ...validVerification(new Date(NOW.getTime() - 1_001)),
          adapterVersion: "1.0.0"
        })
      });
      const originalCreateSession = provider.createSession.bind(provider);
      provider.createSession = async () => {
        sessionCreations += 1;
        return originalCreateSession();
      };
      const execution = await harness.coordinator.start(startInput(harness, provider));
      const outcome = await execution.completion;

      expect(outcome).toMatchObject({
        status: "FAILED",
        stage: "PROVIDER_ADMISSION",
        code: "VERIFICATION_STALE"
      });
      expect(sessionCreations).toBe(0);
      expect(harness.writer.getState().generations[execution.generationId]?.status).toBe("SUPERSEDED");
    } finally {
      harness.store.close();
    }
  });

  it("switches providers while late output from the superseded provider remains inert", async () => {
    const harness = await coordinatorHarness();
    try {
      const oldProvider = new DeferredProvider("mock-provider-a");
      const oldExecution = await harness.coordinator.start(startInput(harness, oldProvider));
      await oldProvider.turnStarted;
      await harness.coordinator.cancelGeneration(oldExecution.generationId, "provider failover");

      const replacement = new MockModelAdapter({ proposal: PROPOSAL });
      const replacementExecution = await harness.coordinator.start(startInput(harness, replacement));
      const replacementOutcome = await replacementExecution.completion;
      oldProvider.release();
      const oldOutcome = await oldExecution.completion;

      expect(oldOutcome.status).toBe("CANCELLED");
      expect(replacementOutcome.status).toBe("ACCEPTED");
      expect(harness.writer.getState().generations[oldExecution.generationId]?.status).toBe("SUPERSEDED");
      expect(harness.writer.getState().generations[replacementExecution.generationId]?.status).toBe("VALIDATED");
      expect(Object.values(harness.writer.getState().deliveries).map((atom) => atom.generationId))
        .toEqual([replacementExecution.generationId]);
    } finally {
      harness.store.close();
    }
  });

  it("cancels an accepted generation and its queued atoms before exposure", async () => {
    const harness = await coordinatorHarness();
    try {
      const execution = await harness.coordinator.start(startInput(
        harness,
        new MockModelAdapter({ proposal: PROPOSAL })
      ));
      const outcome = await execution.completion;
      expect(outcome.status).toBe("ACCEPTED");
      if (outcome.status !== "ACCEPTED") throw new Error("Expected accepted provider proposal");
      const deliveryId = outcome.deliveryAtoms[0]?.deliveryId;
      if (deliveryId === undefined) throw new Error("Expected queued delivery");

      const report = await harness.coordinator.cancelGeneration(execution.generationId, "student resumed work");

      expect(report).toBeUndefined();
      expect(harness.writer.getState().generations[execution.generationId]?.status).toBe("SUPERSEDED");
      expect(harness.writer.getState().deliveries[deliveryId]?.status).toBe("CANCELLED");
    } finally {
      harness.store.close();
    }
  });

  it("resolves as cancelled when cancellation races provider-session close after proposal admission", async () => {
    const harness = await coordinatorHarness();
    try {
      let signalCloseStarted: (() => void) | undefined;
      let releaseClose: (() => void) | undefined;
      const closeStarted = new Promise<void>((resolve) => { signalCloseStarted = resolve; });
      const closeReleased = new Promise<void>((resolve) => { releaseClose = resolve; });
      const provider = testProvider(async () => ({
        async *sendTurn() { yield PROPOSAL; },
        async close() {
          signalCloseStarted?.();
          await closeReleased;
        }
      }));
      const execution = await harness.coordinator.start(startInput(harness, provider));
      await closeStarted;

      await harness.coordinator.cancelGeneration(execution.generationId, "cancel during provider close");
      releaseClose?.();
      const outcome = await execution.completion;

      expect(outcome.status).toBe("CANCELLED");
      expect(harness.writer.getState().generations[execution.generationId]?.status).toBe("SUPERSEDED");
      expect(Object.values(harness.writer.getState().deliveries)).toHaveLength(1);
      expect(Object.values(harness.writer.getState().deliveries)[0]?.status).toBe("CANCELLED");
    } finally {
      harness.store.close();
    }
  });
});

async function coordinatorHarness() {
  const store = new SqliteEventStore(":memory:");
  const sessionId = newSessionId();
  const writer = new SessionRuntimeRegistry(store).get(sessionId);
  const turns = new TurnCoordinator(writer);
  await turns.startSession(sixPeopleProblem);
  const { inputEpisodeId, turnId } = await turns.commitInput("I have a claim, but I have not justified it yet.");
  await turns.selectAction(turnId, sixPeopleProblem);
  const validator = new DisclosureValidator(new ClosedWorldDisclosureAnalyzer([SAFE_PROBE]));
  return {
    store,
    sessionId,
    writer,
    turns,
    inputEpisodeId,
    turnId,
    validator,
    coordinator: new ProviderCoordinator(writer)
  };
}

function startInput(harness: Awaited<ReturnType<typeof coordinatorHarness>>, provider: ReasoningProvider) {
  return {
    inputEpisodeId: harness.inputEpisodeId,
    turnId: harness.turnId,
    provider,
    policy: POLICY,
    problem: sixPeopleProblem,
    validator: harness.validator,
    now: NOW
  };
}

class DeferredProvider implements ReasoningProvider {
  public readonly adapterVersion = "deferred@1";
  public readonly capabilities = CAPABILITIES;
  public readonly cancelledGenerationIds: GenerationId[] = [];
  public readonly turnStarted: Promise<void>;
  private resolveTurnStarted: (() => void) | undefined;
  private releaseTurn: (() => void) | undefined;
  private readonly released: Promise<void>;

  public constructor(public readonly name = "deferred-provider") {
    this.turnStarted = new Promise<void>((resolve) => { this.resolveTurnStarted = resolve; });
    this.released = new Promise<void>((resolve) => { this.releaseTurn = resolve; });
  }

  public async verifyBillingSafety({ now }: { readonly now: Date }) {
    return validVerification(now, this.adapterVersion);
  }

  public async createSession(): Promise<ReasoningSession> {
    const resolveTurnStarted = this.resolveTurnStarted;
    const released = this.released;
    const cancelledGenerationIds = this.cancelledGenerationIds;
    return {
      async *sendTurn() {
        resolveTurnStarted?.();
        await released;
        yield PROPOSAL;
      },
      async cancelTurn(generationId: GenerationId) {
        cancelledGenerationIds.push(generationId);
        return { semantics: "NONE" as const };
      },
      async close() {}
    };
  }

  public release(): void {
    this.releaseTurn?.();
  }
}

function testProvider(
  createSession: () => Promise<ReasoningSession>,
  onVerify: () => void = () => undefined
): ReasoningProvider {
  return {
    name: "test-provider",
    adapterVersion: "test@1",
    capabilities: CAPABILITIES,
    async verifyBillingSafety({ now }) {
      onVerify();
      return validVerification(now);
    },
    createSession
  };
}

function proposalSession(): ReasoningSession {
  return {
    async *sendTurn() { yield PROPOSAL; },
    async close() {}
  };
}

function validVerification(now: Date, adapterVersion = "test@1") {
  return {
    billingClass: "VERIFIED_FREE_ONLY" as const,
    enforcementMechanism: "Test adapter has no spend path",
    verifiedAt: now.toISOString(),
    adapterVersion,
    spendImpossible: true
  };
}
