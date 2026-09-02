import { describe, expect, it } from "vitest";
import {
  InterviewSessionConfigurationSchema,
  newSessionId,
  type InterviewerProposal,
  type ProviderSelectionReference,
  type SessionId
} from "../packages/domain/src/index.js";
import {
  ClosedWorldDisclosureAnalyzer,
  DisclosureValidator,
  SessionRuntimeRegistry,
  TurnCoordinator
} from "../packages/interview-engine/src/index.js";
import { SqliteEventStore } from "../packages/persistence/src/index.js";
import { sixPeopleProblem } from "../packages/problems/src/index.js";
import type { ProviderSecretResolver } from "../packages/providers/src/index.js";
import {
  ProviderRuntimeResolutionError,
  ProviderRuntimeResolver,
  ServerTurnOrchestrator,
  SessionRecoveryCoordinator
} from "../apps/server/src/index.js";
import { realizeProblemInterviewerProposal } from "../apps/server/src/problem-realization.js";

const STUDENT_TEXT = "I choose vertex A and consider the five relationships from that person.";
const MOCK_SELECTION = {
  providerId: "mock-model",
  modelId: "mock-default"
} as const;
const GEMINI_SELECTION = {
  providerId: "gemini-api",
  modelId: "gemini-2.5-flash"
} as const;
const REMOTE_NO_METERED_POLICY = Object.freeze({
  allowMeteredUsage: false,
  maximumDataUse: "REMOTE_MAY_BE_USED_FOR_IMPROVEMENT" as const,
  billingVerificationMaxAgeMs: 60_000
});

describe("production provider runtime resolution", () => {
  it("keeps legacy/default mock execution working through the provider control plane", async () => {
    const harness = createHarness();
    try {
      const turns = new TurnCoordinator(harness.writer);
      await turns.startSession(sixPeopleProblem);
      const committed = await turns.commitInput(STUDENT_TEXT);

      const orchestrator = new ServerTurnOrchestrator(harness.sessions, () => undefined);
      await orchestrator.orchestrateTurn({
        sessionId: harness.sessionId,
        turnId: committed.turnId,
        inputEpisodeId: committed.inputEpisodeId,
        studentText: STUDENT_TEXT
      });

      expect(Object.values(harness.writer.getState().generations)).toEqual([
        expect.objectContaining({ provider: "mock-model", status: "VALIDATED" })
      ]);
      expect(Object.keys(harness.writer.getState().deliveries)).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });

  it("executes an explicitly selected mock provider without bypassing the registry/factory path", async () => {
    const harness = createHarness();
    try {
      const committed = await startConfiguredTurn(harness, MOCK_SELECTION);
      const orchestrator = new ServerTurnOrchestrator(harness.sessions, () => undefined);

      await orchestrator.orchestrateTurn({
        sessionId: harness.sessionId,
        turnId: committed.turnId,
        inputEpisodeId: committed.inputEpisodeId,
        studentText: STUDENT_TEXT
      });

      const generations = Object.values(harness.writer.getState().generations);
      expect(generations).toHaveLength(1);
      expect(generations[0]).toMatchObject({
        provider: "mock-model",
        status: "VALIDATED"
      });
    } finally {
      await harness.close();
    }
  });

  it("resolves configured Gemini through the control plane and reaches injected fetch with a legitimate test billing proof", async () => {
    const harness = createHarness();
    try {
      const committed = await startConfiguredTurn(harness, GEMINI_SELECTION);
      const turns = new TurnCoordinator(harness.writer);
      const request = await turns.selectAction(committed.turnId, sixPeopleProblem);
      expect(request.requiredAction).not.toBe("WAIT");
      const proposal = realizeProblemInterviewerProposal(
        sixPeopleProblem,
        STUDENT_TEXT,
        request
      );

      let fetchCalls = 0;
      const resolver = geminiResolver({
        proposal,
        onFetch: () => {
          fetchCalls += 1;
        },
        withBillingProof: true
      });
      const orchestrator = new ServerTurnOrchestrator(
        harness.sessions,
        () => undefined,
        validatorFor(proposal),
        resolver
      );

      await orchestrator.orchestrateTurn({
        sessionId: harness.sessionId,
        turnId: committed.turnId,
        inputEpisodeId: committed.inputEpisodeId,
        studentText: STUDENT_TEXT
      });

      expect(fetchCalls).toBe(1);
      const generations = Object.values(harness.writer.getState().generations);
      expect(generations).toHaveLength(1);
      expect(generations[0]).toMatchObject({
        provider: "gemini-api",
        status: "VALIDATED"
      });
      expect(Object.values(harness.writer.getState().deliveries)).toEqual([
        expect.objectContaining({ generationId: generations[0]?.generationId, status: "QUEUED" })
      ]);
      expect(harness.writer.getState().configuration?.providerSelection).toEqual(GEMINI_SELECTION);
    } finally {
      await harness.close();
    }
  });

  it("performs zero network dispatch for Gemini under no-metered policy without a technical billing proof and never falls back to mock", async () => {
    const harness = createHarness();
    try {
      const committed = await startConfiguredTurn(harness, GEMINI_SELECTION);
      let fetchCalls = 0;
      const resolver = geminiResolver({
        proposal: safeProbeProposal(),
        onFetch: () => {
          fetchCalls += 1;
        },
        withBillingProof: false
      });
      const orchestrator = new ServerTurnOrchestrator(
        harness.sessions,
        () => undefined,
        validatorFor(safeProbeProposal()),
        resolver
      );

      await orchestrator.orchestrateTurn({
        sessionId: harness.sessionId,
        turnId: committed.turnId,
        inputEpisodeId: committed.inputEpisodeId,
        studentText: STUDENT_TEXT
      });

      expect(fetchCalls).toBe(0);
      const generations = Object.values(harness.writer.getState().generations);
      expect(generations).toHaveLength(1);
      expect(generations[0]).toMatchObject({
        provider: "gemini-api",
        status: "SUPERSEDED"
      });
      expect(generations.some((generation) => generation.provider === "mock-model")).toBe(false);
      expect(Object.keys(harness.writer.getState().deliveries)).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });

  it("performs zero network dispatch and starts no generation when the selected provider credential is missing", async () => {
    const harness = createHarness();
    try {
      const committed = await startConfiguredTurn(harness, GEMINI_SELECTION);
      let fetchCalls = 0;
      const resolver = new ProviderRuntimeResolver({
        configurationSource: credentialReferenceSource(),
        secretResolver: {
          async resolveSecret() {
            return undefined;
          }
        },
        adapterRuntimeSource: {
          resolveRuntime() {
            return {
              fetchImpl: async () => {
                fetchCalls += 1;
                throw new Error("network must not be reached");
              }
            };
          }
        },
        policySource: {
          resolvePolicy() {
            return REMOTE_NO_METERED_POLICY;
          }
        }
      });
      const orchestrator = new ServerTurnOrchestrator(
        harness.sessions,
        () => undefined,
        undefined,
        resolver
      );

      await orchestrator.orchestrateTurn({
        sessionId: harness.sessionId,
        turnId: committed.turnId,
        inputEpisodeId: committed.inputEpisodeId,
        studentText: STUDENT_TEXT
      });

      expect(fetchCalls).toBe(0);
      expect(Object.keys(harness.writer.getState().generations)).toHaveLength(0);
      expect(Object.keys(harness.writer.getState().deliveries)).toHaveLength(0);
      expect(harness.writer.getState().configuration?.providerSelection).toEqual(GEMINI_SELECTION);
    } finally {
      await harness.close();
    }
  });

  it("fails closed on unknown, disabled, and hostile runtime configuration without invoking accessors", async () => {
    const resolver = new ProviderRuntimeResolver();
    await expect(resolver.resolve({
      selection: {
        providerId: "unknown-provider",
        modelId: "unknown-model"
      }
    })).rejects.toMatchObject({ code: "UNKNOWN_PROVIDER" });

    await expect(new ProviderRuntimeResolver({
      configurationSource: {
        resolveConfiguration() {
          return { enabled: false };
        }
      }
    }).resolve({
      selection: MOCK_SELECTION,
      mockProposal: safeProbeProposal()
    })).rejects.toMatchObject({ code: "DISABLED" });

    let getterCalls = 0;
    const hostile = Object.defineProperty({}, "enabled", {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error("Authorization: Bearer must-not-run");
      }
    });
    await expect(new ProviderRuntimeResolver({
      configurationSource: {
        resolveConfiguration() {
          return hostile;
        }
      }
    }).resolve({
      selection: MOCK_SELECTION,
      mockProposal: safeProbeProposal()
    })).rejects.toBeInstanceOf(ProviderRuntimeResolutionError);
    expect(getterCalls).toBe(0);
  });

  it("rejects a malicious Gemini adapter runtime before credential resolution or network access", async () => {
    let getterCalls = 0;
    let secretCalls = 0;
    const hostileRuntime = Object.defineProperty({}, "fetchImpl", {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error("credential-shaped malicious getter");
      }
    });

    const resolver = new ProviderRuntimeResolver({
      configurationSource: credentialReferenceSource(),
      secretResolver: {
        async resolveSecret() {
          secretCalls += 1;
          return "runtime-only-secret";
        }
      },
      adapterRuntimeSource: {
        resolveRuntime() {
          return hostileRuntime;
        }
      },
      policySource: {
        resolvePolicy() {
          return REMOTE_NO_METERED_POLICY;
        }
      }
    });

    await expect(resolver.resolve({ selection: GEMINI_SELECTION }))
      .rejects.toMatchObject({ code: "INVALID_FACTORY_INPUT" });
    expect(getterCalls).toBe(0);
    expect(secretCalls).toBe(0);
  });

  it("re-resolves the exact configured provider/model after restart and regenerates only through that selection", async () => {
    const store = new SqliteEventStore(":memory:");
    const sessionId = newSessionId();
    let registry = new SessionRuntimeRegistry(store);
    try {
      const firstSessions = new SessionRecoveryCoordinator(registry, store);
      const writer = registry.get(sessionId);
      const turns = new TurnCoordinator(writer);
      await turns.startConfiguredSession({
        configuration: configuredOxford(GEMINI_SELECTION),
        problem: sixPeopleProblem
      });
      const committed = await turns.commitInput(STUDENT_TEXT);
      const request = await turns.selectAction(committed.turnId, sixPeopleProblem);
      const proposal = realizeProblemInterviewerProposal(
        sixPeopleProblem,
        STUDENT_TEXT,
        request
      );
      expect(writer.getState().configuration?.providerSelection).toEqual(GEMINI_SELECTION);

      await registry.closeAll();
      registry = new SessionRuntimeRegistry(store);
      const recoveredSessions = new SessionRecoveryCoordinator(registry, store);
      let fetchCalls = 0;
      const recoveredOrchestrator = new ServerTurnOrchestrator(
        recoveredSessions,
        () => undefined,
        validatorFor(proposal),
        geminiResolver({
          proposal,
          onFetch: () => {
            fetchCalls += 1;
          },
          withBillingProof: true
        })
      );
      recoveredSessions.setTurnRecoveryDelegate(recoveredOrchestrator);

      await recoveredSessions.ensureRecovered(sessionId);

      const recoveredState = recoveredSessions.getWriter(sessionId).getState();
      expect(recoveredState.configuration?.providerSelection).toEqual(GEMINI_SELECTION);
      expect(fetchCalls).toBe(1);
      expect(Object.values(recoveredState.generations)).toEqual([
        expect.objectContaining({ provider: "gemini-api", status: "VALIDATED" })
      ]);
      expect(Object.values(recoveredState.generations).some(
        (generation) => generation.provider === "mock-model"
      )).toBe(false);
      void firstSessions;
    } finally {
      await registry.closeAll();
      store.close();
    }
  });

  it("keeps simultaneous sessions isolated when they select different providers", async () => {
    const store = new SqliteEventStore(":memory:");
    const registry = new SessionRuntimeRegistry(store);
    try {
      const sessions = new SessionRecoveryCoordinator(registry);
      const mockSessionId = newSessionId();
      const geminiSessionId = newSessionId();
      const mockWriter = registry.get(mockSessionId);
      const geminiWriter = registry.get(geminiSessionId);
      const mockTurn = await startConfiguredTurnForWriter(mockWriter, MOCK_SELECTION);
      const geminiTurn = await startConfiguredTurnForWriter(geminiWriter, GEMINI_SELECTION);
      const geminiTurns = new TurnCoordinator(geminiWriter);
      const request = await geminiTurns.selectAction(geminiTurn.turnId, sixPeopleProblem);
      const proposal = realizeProblemInterviewerProposal(sixPeopleProblem, STUDENT_TEXT, request);
      let fetchCalls = 0;
      const resolver = geminiResolver({
        proposal,
        onFetch: () => {
          fetchCalls += 1;
        },
        withBillingProof: true
      });
      const orchestrator = new ServerTurnOrchestrator(
        sessions,
        () => undefined,
        validatorFor(proposal),
        resolver
      );

      await Promise.all([
        orchestrator.orchestrateTurn({
          sessionId: mockSessionId,
          turnId: mockTurn.turnId,
          inputEpisodeId: mockTurn.inputEpisodeId,
          studentText: STUDENT_TEXT
        }),
        orchestrator.orchestrateTurn({
          sessionId: geminiSessionId,
          turnId: geminiTurn.turnId,
          inputEpisodeId: geminiTurn.inputEpisodeId,
          studentText: STUDENT_TEXT
        })
      ]);

      expect(fetchCalls).toBe(1);
      expect(Object.values(mockWriter.getState().generations)).toEqual([
        expect.objectContaining({ provider: "mock-model", status: "VALIDATED" })
      ]);
      expect(Object.values(geminiWriter.getState().generations)).toEqual([
        expect.objectContaining({ provider: "gemini-api", status: "VALIDATED" })
      ]);
    } finally {
      await registry.closeAll();
      store.close();
    }
  });
});

function createHarness(): {
  readonly store: SqliteEventStore;
  readonly registry: SessionRuntimeRegistry;
  readonly sessions: SessionRecoveryCoordinator;
  readonly sessionId: SessionId;
  readonly writer: ReturnType<SessionRuntimeRegistry["get"]>;
  readonly close: () => Promise<void>;
} {
  const store = new SqliteEventStore(":memory:");
  const registry = new SessionRuntimeRegistry(store);
  const sessions = new SessionRecoveryCoordinator(registry);
  const sessionId = newSessionId();
  const writer = registry.get(sessionId);
  return {
    store,
    registry,
    sessions,
    sessionId,
    writer,
    async close() {
      await registry.closeAll();
      store.close();
    }
  };
}

async function startConfiguredTurn(
  harness: ReturnType<typeof createHarness>,
  selection: ProviderSelectionReference
) {
  return startConfiguredTurnForWriter(harness.writer, selection);
}

async function startConfiguredTurnForWriter(
  writer: ReturnType<SessionRuntimeRegistry["get"]>,
  selection: ProviderSelectionReference
) {
  const turns = new TurnCoordinator(writer);
  await turns.startConfiguredSession({
    configuration: configuredOxford(selection),
    problem: sixPeopleProblem
  });
  return turns.commitInput(STUDENT_TEXT);
}

function configuredOxford(selection: ProviderSelectionReference) {
  return InterviewSessionConfigurationSchema.parse({
    configurationVersion: 1,
    mode: "OXFORD_MATHEMATICS",
    problem: {
      id: sixPeopleProblem.id,
      version: sixPeopleProblem.version
    },
    difficulty: sixPeopleProblem.interviewer.difficulty,
    interventionPolicy: "BALANCED",
    providerSelection: selection
  });
}

function credentialReferenceSource() {
  return {
    resolveConfiguration(selection: ProviderSelectionReference) {
      if (
        selection.providerId !== GEMINI_SELECTION.providerId
        || selection.modelId !== GEMINI_SELECTION.modelId
      ) {
        return undefined;
      }
      return {
        credentialRef: {
          id: "gemini-test-key",
          purpose: "API_KEY" as const
        }
      };
    }
  };
}

function geminiResolver(input: {
  readonly proposal: InterviewerProposal;
  readonly onFetch: () => void;
  readonly withBillingProof: boolean;
}): ProviderRuntimeResolver {
  const secretResolver: ProviderSecretResolver = {
    async resolveSecret() {
      return "runtime-only-gemini-test-secret";
    }
  };
  return new ProviderRuntimeResolver({
    configurationSource: credentialReferenceSource(),
    secretResolver,
    adapterRuntimeSource: {
      resolveRuntime(selection) {
        if (
          selection.providerId !== GEMINI_SELECTION.providerId
          || selection.modelId !== GEMINI_SELECTION.modelId
        ) {
          return undefined;
        }
        return {
          fetchImpl: async () => {
            input.onFetch();
            return new Response(createGeminiResponse(input.proposal), {
              status: 200,
              headers: { "Content-Type": "application/json" }
            });
          },
          ...(input.withBillingProof
            ? {
                billingVerificationFactory: (now: Date) => ({
                  billingClass: "VERIFIED_FREE_ONLY" as const,
                  enforcementMechanism: "deterministic test-only technical no-spend proof",
                  verifiedAt: now.toISOString(),
                  adapterVersion: "1.0.0",
                  spendImpossible: true
                })
              }
            : {})
        };
      }
    },
    policySource: {
      resolvePolicy(selection) {
        return selection.providerId === "mock-model"
          ? {
              allowMeteredUsage: false,
              maximumDataUse: "LOCAL_ONLY",
              billingVerificationMaxAgeMs: 60_000
            }
          : REMOTE_NO_METERED_POLICY;
      }
    }
  });
}

function validatorFor(proposal: InterviewerProposal): DisclosureValidator {
  return new DisclosureValidator(
    new ClosedWorldDisclosureAnalyzer([
      proposal.speechText ?? "Why must that step be true?"
    ])
  );
}

function safeProbeProposal(): InterviewerProposal {
  return {
    realizedAction: "PROBE_JUSTIFICATION",
    claimedDisclosureLevel: 0,
    claimedDisclosureIds: [],
    speechText: "Why must that step be true?"
  };
}

function createGeminiResponse(proposal: InterviewerProposal): string {
  return JSON.stringify({
    candidates: [{
      content: {
        parts: [{ text: JSON.stringify(proposal) }],
        role: "model"
      },
      finishReason: "STOP"
    }]
  });
}
