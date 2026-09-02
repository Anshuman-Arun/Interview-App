import { describe, expect, it } from "vitest";
import {
  InterviewSessionConfigurationSchema,
  newSessionId,
  type InterviewerProposal,
  type ProviderSelectionReference,
  type SessionId
} from "../packages/domain/src/index.js";
import {
  SessionRuntimeRegistry,
  TurnCoordinator
} from "../packages/interview-engine/src/index.js";
import { SqliteEventStore } from "../packages/persistence/src/index.js";
import { sixPeopleProblem } from "../packages/problems/src/index.js";
import type { ProviderSecretResolver } from "../packages/providers/src/index.js";
import {
  LocalInterviewTransportRuntime,
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
  it("rejects ambiguous composition instead of silently ignoring a provider runtime resolver", async () => {
    const store = new SqliteEventStore(":memory:");
    const registry = new SessionRuntimeRegistry(store);
    try {
      const sessions = new SessionRecoveryCoordinator(registry, store);
      const orchestrator = new ServerTurnOrchestrator(sessions, () => undefined);

      expect(() => new LocalInterviewTransportRuntime({
        security: {
          host: "127.0.0.1",
          allowedOrigins: new Set(["http://127.0.0.1:5173"]),
          clientToken: "provider-runtime-composition-token-long-enough"
        },
        registry,
        store,
        orchestrator,
        providerRuntimeResolver: new ProviderRuntimeResolver()
      })).toThrow(/both an orchestrator and a provider runtime resolver/u);
    } finally {
      await registry.closeAll();
      store.close();
    }
  });

  it("graceful shutdown cancels a provider runtime source that never resolves", async () => {
    const store = new SqliteEventStore(":memory:");
    const registry = new SessionRuntimeRegistry(store);
    let enteredResolution: (() => void) | undefined;
    const resolutionEntered = new Promise<void>((resolve) => {
      enteredResolution = resolve;
    });
    const providerRuntimeResolver = new ProviderRuntimeResolver({
      configurationSource: {
        async resolveConfiguration() {
          enteredResolution?.();
          return await new Promise<never>(() => {
            // Intentionally never resolves; shutdown must detach from this source.
          });
        }
      }
    });
    const runtime = new LocalInterviewTransportRuntime({
      security: {
        host: "127.0.0.1",
        allowedOrigins: new Set(["http://127.0.0.1:5173"]),
        clientToken: "provider-runtime-shutdown-token-long-enough"
      },
      registry,
      store,
      providerRuntimeResolver
    });

    try {
      const sessionId = newSessionId();
      const writer = registry.get(sessionId);
      const turns = new TurnCoordinator(writer);
      await turns.startSession(sixPeopleProblem);
      const committed = await turns.commitInput(STUDENT_TEXT);

      const orchestration = runtime.orchestrator.orchestrateTurn({
        sessionId,
        turnId: committed.turnId,
        inputEpisodeId: committed.inputEpisodeId,
        studentText: STUDENT_TEXT
      });
      await resolutionEntered;

      await expect(runtime.stop()).resolves.toBeUndefined();
      await expect(orchestration).resolves.toBeUndefined();
    } finally {
      store.close();
    }
  });

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
        undefined,
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
    await expect(resolver.resolve({
      selection: {
        providerId: "mock-model",
        modelId: "unknown-model"
      },
      mockProposal: safeProbeProposal()
    })).rejects.toMatchObject({ code: "UNKNOWN_MODEL" });

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

    await expect(new ProviderRuntimeResolver({
      configurationSource: {
        resolveConfiguration() {
          return { enabled: null };
        }
      }
    }).resolve({
      selection: MOCK_SELECTION,
      mockProposal: safeProbeProposal()
    })).rejects.toMatchObject({ code: "MALFORMED_CONFIGURATION" });

    await expect(new ProviderRuntimeResolver({
      configurationSource: {
        resolveConfiguration() {
          return { providerId: "gemini-api" };
        }
      }
    }).resolve({
      selection: MOCK_SELECTION,
      mockProposal: safeProbeProposal()
    })).rejects.toMatchObject({ code: "RUNTIME_CONFIGURATION_FAILED" });

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

  it("captures runtime source operations without invoking accessors and snapshots provider identity before awaits", async () => {
    let sourceGetterCalls = 0;
    const hostileSource = Object.defineProperty({}, "resolveConfiguration", {
      enumerable: true,
      get() {
        sourceGetterCalls += 1;
        throw new Error("runtime source getter must not execute");
      }
    });

    expect(() => new ProviderRuntimeResolver({
      configurationSource: hostileSource as never
    })).toThrow(expect.objectContaining({ code: "RUNTIME_CONFIGURATION_FAILED" }));
    expect(sourceGetterCalls).toBe(0);

    let enteredResolve: (() => void) | undefined;
    let releaseResolve: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      enteredResolve = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseResolve = resolve;
    });
    const mutableSelection = {
      providerId: "mock-model",
      modelId: "mock-default"
    };
    const resolver = new ProviderRuntimeResolver({
      configurationSource: {
        async resolveConfiguration() {
          enteredResolve?.();
          await release;
          return undefined;
        }
      }
    });

    const pending = resolver.resolve({
      selection: mutableSelection,
      mockProposal: safeProbeProposal()
    });
    await entered;
    mutableSelection.providerId = "gemini-api";
    mutableSelection.modelId = "gemini-2.5-flash";
    releaseResolve?.();

    await expect(pending).resolves.toMatchObject({
      providerId: "mock-model",
      modelId: "mock-default",
      provider: { name: "mock-model" }
    });
  });

  it("stops stale runtime resolution before credential access after cancellation", async () => {
    let enteredResolve: (() => void) | undefined;
    let releaseResolve: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      enteredResolve = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseResolve = resolve;
    });
    let cancelled = false;
    let secretCalls = 0;

    const resolver = new ProviderRuntimeResolver({
      configurationSource: {
        async resolveConfiguration() {
          enteredResolve?.();
          await release;
          return {
            credentialRef: {
              id: "gemini-test-key",
              purpose: "API_KEY" as const
            }
          };
        }
      },
      secretResolver: {
        async resolveSecret() {
          secretCalls += 1;
          return "runtime-only-secret-must-not-be-read";
        }
      },
      policySource: {
        resolvePolicy() {
          return REMOTE_NO_METERED_POLICY;
        }
      }
    });

    const pending = resolver.resolve({
      selection: GEMINI_SELECTION,
      cancellationRequested: () => cancelled
    });
    await entered;
    cancelled = true;
    releaseResolve?.();

    await expect(pending).rejects.toMatchObject({
      code: "RUNTIME_RESOLUTION_CANCELLED"
    });
    expect(secretCalls).toBe(0);
  });

  it("resolves and validates policy before adapter runtime or credential material", async () => {
    let adapterRuntimeCalls = 0;
    let secretCalls = 0;
    const resolver = new ProviderRuntimeResolver({
      configurationSource: credentialReferenceSource(),
      secretResolver: {
        async resolveSecret() {
          secretCalls += 1;
          return "runtime-secret-must-not-be-read";
        }
      },
      adapterRuntimeSource: {
        resolveRuntime() {
          adapterRuntimeCalls += 1;
          return {};
        }
      },
      policySource: {
        resolvePolicy() {
          throw new Error("Authorization: Bearer policy-source-secret");
        }
      }
    });

    await expect(resolver.resolve({ selection: GEMINI_SELECTION }))
      .rejects.toMatchObject({ code: "POLICY_RESOLUTION_FAILED" });
    expect(adapterRuntimeCalls).toBe(0);
    expect(secretCalls).toBe(0);
  });

  it("rejects malformed runtime credentials before constructing a Gemini adapter", async () => {
    for (const malformedSecret of [
      "header-safe-prefix\nInjected: value",
      "x".repeat(4_097)
    ]) {
      const resolver = new ProviderRuntimeResolver({
        configurationSource: credentialReferenceSource(),
        secretResolver: {
          async resolveSecret() {
            return malformedSecret;
          }
        },
        adapterRuntimeSource: {
          resolveRuntime() {
            return {
              fetchImpl: async () => new Response("must not be reached")
            };
          }
        },
        policySource: {
          resolvePolicy() {
            return REMOTE_NO_METERED_POLICY;
          }
        }
      });

      await expect(resolver.resolve({ selection: GEMINI_SELECTION }))
        .rejects.toMatchObject({ code: "CREDENTIAL_RESOLUTION_FAILED" });
    }
  });

  it("fails closed when a selected credentialed provider has no secret resolver", async () => {
    const resolver = new ProviderRuntimeResolver({
      configurationSource: credentialReferenceSource(),
      adapterRuntimeSource: {
        resolveRuntime() {
          return {
            fetchImpl: async () => {
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

    await expect(resolver.resolve({ selection: GEMINI_SELECTION }))
      .rejects.toMatchObject({ code: "CREDENTIALS_REQUIRED" });
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

  it("physically aborts Gemini work after authoritative generation supersession", async () => {
    const harness = createHarness();
    try {
      const committed = await startConfiguredTurn(harness, GEMINI_SELECTION);
      let fetchStartedResolve: (() => void) | undefined;
      const fetchStarted = new Promise<void>((resolve) => {
        fetchStartedResolve = resolve;
      });
      let aborted = false;
      let signalRef: AbortSignal | undefined;
      const resolver = new ProviderRuntimeResolver({
        configurationSource: credentialReferenceSource(),
        secretResolver: {
          async resolveSecret() {
            return "runtime-only-cancellation-secret";
          }
        },
        adapterRuntimeSource: {
          resolveRuntime() {
            return {
              fetchImpl: async (_url: RequestInfo | URL, init?: RequestInit) => {
                signalRef = init?.signal ?? undefined;
                fetchStartedResolve?.();
                return await new Promise<Response>((_resolve, reject) => {
                  signalRef?.addEventListener("abort", () => {
                    aborted = true;
                    const error = new Error("aborted");
                    error.name = "AbortError";
                    reject(error);
                  });
                });
              },
              billingVerificationFactory: (now: Date) => ({
                billingClass: "VERIFIED_FREE_ONLY" as const,
                enforcementMechanism: "deterministic test-only technical no-spend proof",
                verifiedAt: now.toISOString(),
                adapterVersion: "1.0.0",
                spendImpossible: true
              })
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

      const orchestration = orchestrator.orchestrateTurn({
        sessionId: harness.sessionId,
        turnId: committed.turnId,
        inputEpisodeId: committed.inputEpisodeId,
        studentText: STUDENT_TEXT
      });
      await fetchStarted;

      await new TurnCoordinator(harness.writer).commitInput(
        "I am replacing that argument with a newer one."
      );
      const generation = Object.values(harness.writer.getState().generations)[0];
      expect(generation?.status).toBe("SUPERSEDED");

      orchestrator.requestCancellationForSupersededWork(harness.sessionId);
      await expect(orchestration).resolves.toBeUndefined();
      expect(aborted).toBe(true);
      expect(signalRef?.aborted).toBe(true);
      expect(Object.keys(harness.writer.getState().deliveries)).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });

  it("retries restart recovery after missing credentials become available without changing provider identity", async () => {
    const store = new SqliteEventStore(":memory:");
    const sessionId = newSessionId();
    let registry = new SessionRuntimeRegistry(store);
    try {
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

      await registry.closeAll();
      registry = new SessionRuntimeRegistry(store);
      const sessions = new SessionRecoveryCoordinator(registry, store);
      let credentialAvailable = false;
      let fetchCalls = 0;
      const resolver = new ProviderRuntimeResolver({
        configurationSource: credentialReferenceSource(),
        secretResolver: {
          async resolveSecret() {
            return credentialAvailable ? "runtime-only-recovery-key" : undefined;
          }
        },
        adapterRuntimeSource: {
          resolveRuntime() {
            return {
              fetchImpl: async () => {
                fetchCalls += 1;
                return new Response(createGeminiResponse(proposal), {
                  status: 200,
                  headers: { "Content-Type": "application/json" }
                });
              },
              billingVerificationFactory: (now: Date) => ({
                billingClass: "VERIFIED_FREE_ONLY" as const,
                enforcementMechanism: "deterministic test-only technical no-spend proof",
                verifiedAt: now.toISOString(),
                adapterVersion: "1.0.0",
                spendImpossible: true
              })
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
        sessions,
        () => undefined,
        undefined,
        resolver
      );
      sessions.setTurnRecoveryDelegate(orchestrator);

      await expect(sessions.ensureRecovered(sessionId)).resolves.toEqual([]);
      expect(fetchCalls).toBe(0);
      expect(Object.keys(sessions.getWriter(sessionId).getState().generations))
        .toHaveLength(0);

      credentialAvailable = true;
      // Ordinary reads/attaches remain coalesced and do not repeatedly dispatch
      // a provider that previously failed runtime recovery.
      await expect(sessions.ensureRecovered(sessionId)).resolves.toEqual([]);
      expect(fetchCalls).toBe(0);

      await expect(sessions.retryPendingTurnRecovery(sessionId)).resolves.toEqual([]);

      const recovered = sessions.getWriter(sessionId).getState();
      expect(fetchCalls).toBe(1);
      expect(recovered.configuration?.providerSelection).toEqual(GEMINI_SELECTION);
      expect(Object.values(recovered.generations)).toEqual([
        expect.objectContaining({ provider: "gemini-api", status: "VALIDATED" })
      ]);
    } finally {
      await registry.closeAll();
      store.close();
    }
  });

  it("retries restart recovery after a provider stream crash without persisting raw provider errors", async () => {
    const store = new SqliteEventStore(":memory:");
    const sessionId = newSessionId();
    let registry = new SessionRuntimeRegistry(store);
    const secret = "runtime-only-stream-recovery-secret";
    try {
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

      await registry.closeAll();
      registry = new SessionRuntimeRegistry(store);
      const sessions = new SessionRecoveryCoordinator(registry, store);
      let fetchCalls = 0;
      const resolver = new ProviderRuntimeResolver({
        configurationSource: credentialReferenceSource(),
        secretResolver: {
          async resolveSecret() {
            return secret;
          }
        },
        adapterRuntimeSource: {
          resolveRuntime() {
            return {
              fetchImpl: async () => {
                fetchCalls += 1;
                if (fetchCalls === 1) {
                  throw new Error(`network failed with Authorization: Bearer ${secret}`);
                }
                return new Response(createGeminiResponse(proposal), {
                  status: 200,
                  headers: { "Content-Type": "application/json" }
                });
              },
              billingVerificationFactory: (now: Date) => ({
                billingClass: "VERIFIED_FREE_ONLY" as const,
                enforcementMechanism: "deterministic test-only technical no-spend proof",
                verifiedAt: now.toISOString(),
                adapterVersion: "1.0.0",
                spendImpossible: true
              })
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
        sessions,
        () => undefined,
        undefined,
        resolver
      );
      sessions.setTurnRecoveryDelegate(orchestrator);

      await expect(sessions.ensureRecovered(sessionId)).resolves.toEqual([]);
      expect(fetchCalls).toBe(1);
      expect(JSON.stringify(store.load(sessionId))).not.toContain(secret);

      await expect(sessions.ensureRecovered(sessionId)).resolves.toEqual([]);
      expect(fetchCalls).toBe(1);

      await expect(sessions.retryPendingTurnRecovery(sessionId)).resolves.toEqual([]);
      const recovered = sessions.getWriter(sessionId).getState();
      expect(fetchCalls).toBe(2);
      expect(Object.values(recovered.generations).some(
        (generation) => generation.provider === "mock-model"
      )).toBe(false);
      expect(Object.values(recovered.generations).filter(
        (generation) => generation.provider === "gemini-api"
      )).toEqual([
        expect.objectContaining({ status: "SUPERSEDED" }),
        expect.objectContaining({ status: "VALIDATED" })
      ]);
      expect(JSON.stringify(store.load(sessionId))).not.toContain(secret);
    } finally {
      await registry.closeAll();
      store.close();
    }
  });

  it("re-resolves the exact configured provider/model after restart and regenerates only through that selection", async () => {
    const store = new SqliteEventStore(":memory:");
    const sessionId = newSessionId();
    let registry = new SessionRuntimeRegistry(store);
    try {
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
        undefined,
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
    } finally {
      await registry.closeAll();
      store.close();
    }
  });

  it("fails safely when a newer turn commits while provider runtime resolution is in flight", async () => {
    const harness = createHarness();
    try {
      const first = await startConfiguredTurn(harness, MOCK_SELECTION);
      let enteredResolve: (() => void) | undefined;
      let resolutionCalls = 0;
      const entered = new Promise<void>((resolve) => {
        enteredResolve = resolve;
      });
      const never = new Promise<never>(() => undefined);
      const resolver = new ProviderRuntimeResolver({
        configurationSource: {
          async resolveConfiguration() {
            resolutionCalls += 1;
            if (resolutionCalls === 1) {
              enteredResolve?.();
              await never;
            }
            return undefined;
          }
        }
      });
      const orchestrator = new ServerTurnOrchestrator(
        harness.sessions,
        () => undefined,
        undefined,
        resolver
      );

      const orchestration = orchestrator.orchestrateTurn({
        sessionId: harness.sessionId,
        turnId: first.turnId,
        inputEpisodeId: first.inputEpisodeId,
        studentText: STUDENT_TEXT
      });
      await entered;

      const turns = new TurnCoordinator(harness.writer);
      const newer = await turns.commitInput("I have a newer argument for the problem.");
      const newerOrchestration = orchestrator.orchestrateTurn({
        sessionId: harness.sessionId,
        turnId: newer.turnId,
        inputEpisodeId: newer.inputEpisodeId,
        studentText: "I have a newer argument for the problem."
      });

      await expect(orchestration).resolves.toBeUndefined();
      await expect(newerOrchestration).resolves.toBeUndefined();
      expect(resolutionCalls).toBe(2);
      expect(Object.values(harness.writer.getState().generations)).toEqual([
        expect.objectContaining({ provider: "mock-model", status: "VALIDATED" })
      ]);
      expect(harness.writer.getState().lastCommittedInputSequence)
        .toBe(harness.writer.getState().turns[newer.turnId]?.committedSequence);
    } finally {
      await harness.close();
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
        undefined,
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
