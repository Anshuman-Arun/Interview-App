import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ConfiguredSessionStartedResponseSchema,
  InterviewCatalogResponseSchema,
  InterviewSessionConfigurationSchema,
  InterviewSessionContextResponseSchema,
  OxfordInterviewSessionConfigurationSchema,
  ProtocolErrorResponseSchema,
  ProviderOptionsResponseSchema,
  SessionStartedResponseSchema,
  newRequestId,
  newSessionId,
  type InterviewSessionConfiguration,
  type SessionId
} from "../packages/domain/src/index.js";
import {
  QUANT_RESEARCH_VERSION,
  QUANT_TRADER_SCENARIO_VERSION
} from "../packages/local-compute/src/index.js";
import {
  QuantResearchCoordinator,
  QuantTradingSessionCoordinator,
  SessionRuntimeRegistry,
  TurnCoordinator,
  createCommandEnvelope
} from "../packages/interview-engine/src/index.js";
import { SqliteEventStore } from "../packages/persistence/src/index.js";
import { BrowserCommandClient } from "../apps/web/src/command-client.js";
import {
  LoopbackCommandServer,
  ProviderRuntimeResolver,
  ServerTurnOrchestrator,
  SessionRecoveryCoordinator,
  listInterviewCatalogEntries,
  resolveInterviewSessionConfiguration,
  resolveSessionStateComposition
} from "../apps/server/src/index.js";
import {
  getProblemByIdentity,
  sixPeopleProblem
} from "../packages/problems/src/index.js";

const CLIENT_TOKEN = "session-configuration-test-token-that-is-long-enough";
const CLIENT_ORIGIN = "http://127.0.0.1:5173";

describe("generic interview session configuration", () => {
  let store: SqliteEventStore;
  let registry: SessionRuntimeRegistry;
  let sessions: SessionRecoveryCoordinator;
  let server: LoopbackCommandServer;
  let address: Awaited<ReturnType<LoopbackCommandServer["start"]>>;

  beforeEach(async () => {
    store = new SqliteEventStore(":memory:");
    registry = new SessionRuntimeRegistry(store);
    sessions = recoveryCoordinator(registry);
    server = commandServer(sessions);
    address = await server.start();
  });

  afterEach(async () => {
    await server.stop();
    await registry.closeAll();
    store.close();
  });

  it("starts Ramsey and another curated Oxford problem through the same exact-identity path", async () => {
    const ramseySession = newSessionId();
    const divisibilitySession = newSessionId();

    const ramseyConfiguration = oxfordConfiguration(
      sixPeopleProblem.id,
      sixPeopleProblem.version,
      sixPeopleProblem.interviewer.difficulty
    );
    const divisibility = getProblemByIdentity("oxford-divisibility-chain", "1.0.0");
    expect(divisibility).toBeDefined();
    if (divisibility === undefined) return;
    const divisibilityConfiguration = oxfordConfiguration(
      divisibility.id,
      divisibility.version,
      divisibility.interviewer.difficulty
    );

    const ramsey = ConfiguredSessionStartedResponseSchema.parse(
      await json(await postStart(ramseySession, ramseyConfiguration))
    );
    const other = ConfiguredSessionStartedResponseSchema.parse(
      await json(await postStart(divisibilitySession, divisibilityConfiguration))
    );

    expect(ramsey.configuration).toEqual(ramseyConfiguration);
    expect(other.configuration).toEqual(divisibilityConfiguration);
    expect(ramsey.problem).toMatchObject({
      id: sixPeopleProblem.id,
      version: sixPeopleProblem.version,
      prompt: sixPeopleProblem.public.prompt
    });
    expect(other.problem).toMatchObject({
      id: divisibility.id,
      version: divisibility.version,
      prompt: divisibility.public.prompt
    });
    expect(JSON.stringify(ramsey.problem)).not.toContain(sixPeopleProblem.private.canonicalSolution);
    expect(JSON.stringify(ramsey.problem)).not.toContain("protectedDisclosures");
    expect(ramsey.problem?.topics).toEqual([]);
    for (const topic of sixPeopleProblem.interviewer.topics) {
      expect(JSON.stringify(ramsey.problem)).not.toContain(topic);
    }
    expect(registry.get(ramseySession).getState().problem?.id).toBe(sixPeopleProblem.id);
    expect(registry.get(divisibilitySession).getState().problem?.id).toBe(divisibility.id);
    expect(registry.get(divisibilitySession).getState().problem?.version).toBe(divisibility.version);

    await server.stop();
    await registry.closeAll();
    registry = new SessionRuntimeRegistry(store);
    sessions = recoveryCoordinator(registry);
    server = commandServer(sessions);
    address = await server.start();

    await expect(sessions.ensureRecovered(ramseySession)).resolves.toEqual([]);
    await expect(sessions.ensureRecovered(divisibilitySession)).resolves.toEqual([]);
    expect(registry.get(ramseySession).getState().configuration).toEqual(ramseyConfiguration);
    expect(registry.get(divisibilitySession).getState().configuration)
      .toEqual(divisibilityConfiguration);
    expect(resolveSessionStateComposition(registry.get(divisibilitySession).getState()))
      .toMatchObject({ mode: "OXFORD_MATHEMATICS", problem: { id: divisibility.id } });
  });

  it("starts Quant Research with authoritative deterministic state and replays it after restart", async () => {
    const sessionId = newSessionId();
    const configuration = InterviewSessionConfigurationSchema.parse({
      configurationVersion: 1,
      mode: "QUANT_RESEARCH",
      scenario: {
        id: "MODEL_COMPARISON",
        version: QUANT_RESEARCH_VERSION
      },
      interventionPolicy: "BALANCED"
    });

    expect((await postStart(sessionId, configuration)).status).toBe(200);
    const writer = registry.get(sessionId);
    expect(writer.getState().configuration).toEqual(configuration);
    expect(writer.getState().quantResearch?.definition.family).toBe("MODEL_COMPARISON");
    expect(writer.getState().quantResearch?.definition.version).toBe(QUANT_RESEARCH_VERSION);
    expect(writer.getState().quantResearch?.definition.seed).toEqual(expect.any(Number));
    expect(writer.getState().problem?.id).toBe("MODEL_COMPARISON");
    expect(writer.getState().problem?.version).toBe(QUANT_RESEARCH_VERSION);

    const initializedState = writer.getState();
    const persistedProblem = initializedState.problem;
    expect(persistedProblem).toBeDefined();
    if (persistedProblem === undefined) return;
    expect(() => resolveSessionStateComposition({
      ...initializedState,
      problem: {
        ...persistedProblem,
        prompt: "substituted quant research prompt"
      }
    })).toThrow(/public prompt/);

    const beforeRestart = new QuantResearchCoordinator(writer).replay();
    await server.stop();
    await registry.closeAll();

    registry = new SessionRuntimeRegistry(store);
    sessions = recoveryCoordinator(registry);
    server = commandServer(sessions);
    address = await server.start();

    await expect(sessions.ensureRecovered(sessionId)).resolves.toEqual([]);
    const reopened = registry.get(sessionId);
    expect(resolveSessionStateComposition(reopened.getState()).mode).toBe("QUANT_RESEARCH");
    expect(new QuantResearchCoordinator(reopened).replay()).toEqual(beforeRestart);
  });

  it("starts and recovers a Quant Trading identity without routing it through InterviewProblem", async () => {
    const sessionId = newSessionId();
    const configuration = InterviewSessionConfigurationSchema.parse({
      configurationVersion: 1,
      mode: "QUANT_TRADING",
      scenario: {
        id: "BASIC_MARKET_MAKING",
        version: QUANT_TRADER_SCENARIO_VERSION
      },
      durationMinutes: 45,
      interventionPolicy: "STRICT",
      providerSelection: { providerId: "mock-model", modelId: "mock-default" }
    });

    const started = ConfiguredSessionStartedResponseSchema.parse(
      await json(await postStart(sessionId, configuration))
    );
    expect(started.configuration).toEqual(configuration);
    expect(started.problem).toBeUndefined();
    const persistedConfiguration = registry.get(sessionId).getState().configuration;
    expect(persistedConfiguration).toEqual(configuration);
    expect(Object.isFrozen(persistedConfiguration)).toBe(true);
    expect(Object.isFrozen(persistedConfiguration?.providerSelection)).toBe(true);
    expect(Object.isFrozen(
      persistedConfiguration?.mode === "QUANT_TRADING"
        ? persistedConfiguration.scenario
        : undefined
    )).toBe(true);
    const tradingWriter = registry.get(sessionId);
    expect(tradingWriter.getState().problem).toBeUndefined();
    expect(tradingWriter.getState().quantTrading?.definition.family).toBe("BASIC_MARKET_MAKING");
    expect(tradingWriter.getState().quantTrading?.definition.version).toBe(QUANT_TRADER_SCENARIO_VERSION);
    expect(tradingWriter.getState().quantTrading?.definition.seed).toEqual(expect.any(Number));
    const beforeRestart = new QuantTradingSessionCoordinator(tradingWriter).getPublicState();
    expect(JSON.stringify(beforeRestart)).not.toContain("seed");
    expect(JSON.stringify(beforeRestart)).not.toContain("INFORMED");
    expect(JSON.stringify(beforeRestart)).not.toContain("NOISE");

    await server.stop();
    await registry.closeAll();

    registry = new SessionRuntimeRegistry(store);
    sessions = recoveryCoordinator(registry);
    server = commandServer(sessions);
    address = await server.start();

    await expect(sessions.ensureRecovered(sessionId)).resolves.toEqual([]);
    const reopened = registry.get(sessionId);
    expect(reopened.getState().configuration).toEqual(configuration);
    expect(reopened.getState().problem).toBeUndefined();
    expect(new QuantTradingSessionCoordinator(reopened).getPublicState()).toEqual(beforeRestart);
  });

  it("supports configured start and catalog discovery through the browser command client", async () => {
    const client = new BrowserCommandClient({
      baseUrl: address.url,
      clientToken: CLIENT_TOKEN,
      fetchImpl: browserLikeFetch
    });
    const catalog = await client.listInterviewCatalog();
    expect(catalog.some(
      (entry) => entry.mode === "OXFORD_MATHEMATICS" && entry.id === "oxford-divisibility-chain"
    )).toBe(true);

    const problem = getProblemByIdentity("oxford-divisibility-chain", "1.0.0");
    expect(problem).toBeDefined();
    if (problem === undefined) return;
    const configuration = oxfordConfiguration(
      problem.id,
      problem.version,
      problem.interviewer.difficulty
    );
    const sessionId = newSessionId();
    const started = await client.startConfiguredSession(sessionId, configuration);
    expect(started.configuration).toEqual(configuration);
    expect(started.problem).toMatchObject({
      id: problem.id,
      version: problem.version,
      title: "A Divisibility Pair in {1,...,2n}",
      prompt: problem.public.prompt
    });
    const context = await client.getInterviewSessionContext(sessionId);
    expect(context.configuration).toEqual(configuration);
    expect(context.configurationSource).toBe("CONFIGURED");
    expect(context.problem?.id).toBe(problem.id);
    expect(registry.get(sessionId).getState().configuration).toEqual(configuration);
  });

  it("keeps the legacy start fingerprint idempotent across the protocol compatibility path", async () => {
    const sessionId = newSessionId();
    const requestId = newRequestId();
    const writer = registry.get(sessionId);
    const envelope = createCommandEnvelope({
      sessionId,
      requestId,
      producer: "authenticated-local-client"
    });

    await new TurnCoordinator(writer).startSession(sixPeopleProblem, envelope);
    const eventCount = store.eventCount(sessionId);

    const response = await post({
      protocolVersion: 1,
      type: "START_SESSION",
      requestId,
      sessionId
    });
    expect(response.status).toBe(200);
    const legacyStarted = SessionStartedResponseSchema.parse(await json(response));
    expect(legacyStarted.sessionId).toBe(sessionId);

    const contextResponse = await post({
      protocolVersion: 1,
      type: "GET_INTERVIEW_SESSION_CONTEXT",
      requestId: newRequestId(),
      sessionId
    });
    expect(contextResponse.status).toBe(200);
    const context = InterviewSessionContextResponseSchema.parse(await json(contextResponse));
    expect(context.configuration.mode).toBe("OXFORD_MATHEMATICS");
    expect(context.configurationSource).toBe("LEGACY_COMPATIBILITY");
    expect(context.problem?.id).toBe(sixPeopleProblem.id);
    expect(store.eventCount(sessionId)).toBe(eventCount);
  });

  it("infers pre-marker session provenance without treating every unmarked configuration as legacy", () => {
    const configuredSessionId = newSessionId();
    const configuredRequestId = newRequestId();
    const divisibility = getProblemByIdentity("oxford-divisibility-chain", "1.0.0");
    expect(divisibility).toBeDefined();
    if (divisibility === undefined) return;
    const configured = oxfordConfiguration(
      divisibility.id,
      divisibility.version,
      divisibility.interviewer.difficulty
    );

    store.appendIdempotent({
      sessionId: configuredSessionId,
      requestId: configuredRequestId,
      causationId: configuredRequestId,
      correlationId: configuredRequestId,
      elapsedMs: 0,
      expectedPriorSequence: 0,
      commandFingerprint: "1".repeat(64),
      drafts: [{
        source: "APPLICATION",
        type: "SESSION_STARTED",
        payload: {
          startedAt: "2026-09-02T12:00:00.000Z",
          configuration: configured
        }
      }],
      result: { started: true }
    });
    expect(sessions.getConfigurationSource(configuredSessionId)).toBe("CONFIGURED");

    const legacySessionId = newSessionId();
    const legacyRequestId = newRequestId();
    const legacyShape = oxfordConfiguration(
      sixPeopleProblem.id,
      sixPeopleProblem.version,
      sixPeopleProblem.interviewer.difficulty
    );
    store.appendIdempotent({
      sessionId: legacySessionId,
      requestId: legacyRequestId,
      causationId: legacyRequestId,
      correlationId: legacyRequestId,
      elapsedMs: 0,
      expectedPriorSequence: 0,
      commandFingerprint: "2".repeat(64),
      drafts: [{
        source: "APPLICATION",
        type: "SESSION_STARTED",
        payload: {
          startedAt: "2026-09-02T12:00:01.000Z",
          configuration: legacyShape
        }
      }],
      result: { started: true }
    });
    expect(sessions.getConfigurationSource(legacySessionId)).toBe("LEGACY_COMPATIBILITY");

    const quantSessionId = newSessionId();
    const quantRequestId = newRequestId();
    const quantConfiguration = InterviewSessionConfigurationSchema.parse({
      configurationVersion: 1,
      mode: "QUANT_TRADING",
      scenario: {
        id: "BASIC_MARKET_MAKING",
        version: QUANT_TRADER_SCENARIO_VERSION
      },
      interventionPolicy: "BALANCED"
    });
    store.appendIdempotent({
      sessionId: quantSessionId,
      requestId: quantRequestId,
      causationId: quantRequestId,
      correlationId: quantRequestId,
      elapsedMs: 0,
      expectedPriorSequence: 0,
      commandFingerprint: "3".repeat(64),
      drafts: [{
        source: "APPLICATION",
        type: "SESSION_STARTED",
        payload: {
          startedAt: "2026-09-02T12:00:02.000Z",
          configuration: quantConfiguration
        }
      }],
      result: { started: true }
    });
    expect(sessions.getConfigurationSource(quantSessionId)).toBe("CONFIGURED");
  });

  it("keeps exact configured retries idempotent even if provider readiness later changes", async () => {
    let readinessCalls = 0;
    const retryStore = new SqliteEventStore(":memory:");
    const retryRegistry = new SessionRuntimeRegistry(retryStore);
    const retrySessions = recoveryCoordinator(retryRegistry);
    const providerRuntimeResolver = new ProviderRuntimeResolver({
      configurationSource: {
        resolveConfiguration: () => {
          readinessCalls += 1;
          return { enabled: readinessCalls === 1 };
        }
      }
    });
    const retryServer = new LoopbackCommandServer({
      security: {
        host: "127.0.0.1",
        allowedOrigins: new Set([CLIENT_ORIGIN]),
        clientToken: CLIENT_TOKEN
      },
      sessions: retrySessions,
      providerRuntimeResolver
    });
    const retryAddress = await retryServer.start();

    try {
      const sessionId = newSessionId();
      const requestId = newRequestId();
      const configuration = InterviewSessionConfigurationSchema.parse({
        ...oxfordConfiguration(
          sixPeopleProblem.id,
          sixPeopleProblem.version,
          sixPeopleProblem.interviewer.difficulty
        ),
        providerSelection: {
          providerId: "mock-model",
          modelId: "mock-default"
        }
      });
      const postRetry = (body: unknown): Promise<Response> => fetch(
        `${retryAddress.url}/v1/commands`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-interview-client-token": CLIENT_TOKEN,
            origin: CLIENT_ORIGIN
          },
          body: JSON.stringify(body)
        }
      );
      const command = {
        protocolVersion: 1 as const,
        type: "START_CONFIGURED_SESSION" as const,
        requestId,
        sessionId,
        configuration
      };

      const first = await postRetry(command);
      expect(first.status).toBe(200);
      expect(readinessCalls).toBe(1);
      const eventCount = retryStore.eventCount(sessionId);

      const retried = await postRetry(command);
      expect(retried.status).toBe(200);
      expect(readinessCalls).toBe(1);
      expect(retryStore.eventCount(sessionId)).toBe(eventCount);
      expect(retryRegistry.get(sessionId).getState().configuration).toEqual(configuration);
    } finally {
      await retryServer.stop();
      await retryRegistry.closeAll();
      retryStore.close();
    }
  });

  it("keeps an exact configured retry idempotent after its provider registration disappears", async () => {
    const sessionId = newSessionId();
    const requestId = newRequestId();
    const configuration = InterviewSessionConfigurationSchema.parse({
      ...oxfordConfiguration(
        sixPeopleProblem.id,
        sixPeopleProblem.version,
        sixPeopleProblem.interviewer.difficulty
      ),
      providerSelection: {
        providerId: "retired-provider",
        modelId: "retired-model"
      }
    });
    const writer = registry.get(sessionId);
    const envelope = createCommandEnvelope({
      sessionId,
      requestId,
      producer: "authenticated-local-client"
    });

    await new TurnCoordinator(writer).startConfiguredSession({
      configuration,
      problem: sixPeopleProblem
    }, envelope);
    const eventCount = store.eventCount(sessionId);

    const retried = await postStart(sessionId, configuration, requestId);
    expect(retried.status).toBe(200);
    expect(ConfiguredSessionStartedResponseSchema.parse(await json(retried)).configuration)
      .toEqual(configuration);
    expect(store.eventCount(sessionId)).toBe(eventCount);
    expect(registry.get(sessionId).getState().configuration).toEqual(configuration);
  });

  it("serializes concurrent starts so only one authoritative configuration can win", async () => {
    const sessionId = newSessionId();
    const firstConfiguration = oxfordConfiguration(
      sixPeopleProblem.id,
      sixPeopleProblem.version,
      sixPeopleProblem.interviewer.difficulty
    );
    const secondProblem = getProblemByIdentity("oxford-divisibility-chain", "1.0.0");
    expect(secondProblem).toBeDefined();
    if (secondProblem === undefined) return;
    const secondConfiguration = oxfordConfiguration(
      secondProblem.id,
      secondProblem.version,
      secondProblem.interviewer.difficulty
    );

    const [first, second] = await Promise.all([
      postStart(sessionId, firstConfiguration),
      postStart(sessionId, secondConfiguration)
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);

    const state = registry.get(sessionId).getState();
    expect(state.sequence).toBe(2);
    expect(store.eventCount(sessionId)).toBe(2);
    expect(
      state.configuration?.mode === "OXFORD_MATHEMATICS"
        ? [firstConfiguration.problem.id, secondConfiguration.problem.id]
          .includes(state.configuration.problem.id)
        : false
    ).toBe(true);
    expect(state.problem?.id).toBe(
      state.configuration?.mode === "OXFORD_MATHEMATICS"
        ? state.configuration.problem.id
        : undefined
    );
  });

  it("never substitutes the mock provider for an authoritative non-mock selection", async () => {
    const sessionId = newSessionId();
    const configuration = InterviewSessionConfigurationSchema.parse({
      configurationVersion: 1,
      mode: "OXFORD_MATHEMATICS",
      problem: {
        id: sixPeopleProblem.id,
        version: sixPeopleProblem.version
      },
      difficulty: sixPeopleProblem.interviewer.difficulty,
      interventionPolicy: "BALANCED",
      providerSelection: {
        providerId: "gemini-api",
        modelId: "gemini-2.5-flash"
      }
    });

    const response = await postStart(sessionId, configuration);
    expect(response.status).toBe(409);
    const failure = ProtocolErrorResponseSchema.parse(await json(response));
    expect(failure.error.code).toBe("CONFLICT");
    expect(failure.error.message).toMatch(/provider|authentication|policy/i);
    expect(registry.hasSession(sessionId)).toBe(false);
  });

  it("rejects any later attempt to mutate a started session configuration", async () => {
    const sessionId = newSessionId();
    const firstConfiguration = oxfordConfiguration(
      sixPeopleProblem.id,
      sixPeopleProblem.version,
      sixPeopleProblem.interviewer.difficulty
    );
    const secondProblem = getProblemByIdentity("oxford-divisibility-chain", "1.0.0");
    expect(secondProblem).toBeDefined();
    if (secondProblem === undefined) return;
    const secondConfiguration = oxfordConfiguration(
      secondProblem.id,
      secondProblem.version,
      secondProblem.interviewer.difficulty
    );

    expect((await postStart(sessionId, firstConfiguration)).status).toBe(200);
    const mutation = await postStart(sessionId, secondConfiguration);
    expect(mutation.status).toBe(409);
    expect(registry.get(sessionId).getState().configuration).toEqual(firstConfiguration);
    expect(registry.get(sessionId).getState().problem?.id).toBe(sixPeopleProblem.id);
  });

  it("fails reconstruction when persisted Oxford provenance diverges from configuration", async () => {
    const sessionId = newSessionId();
    const configuration = oxfordConfiguration(
      sixPeopleProblem.id,
      sixPeopleProblem.version,
      sixPeopleProblem.interviewer.difficulty
    );
    expect((await postStart(sessionId, configuration)).status).toBe(200);
    const state = registry.get(sessionId).getState();
    expect(state.problem).toBeDefined();
    const persistedProblem = state.problem;
    if (persistedProblem === undefined) return;

    expect(() => resolveSessionStateComposition({
      ...state,
      problem: { ...persistedProblem, prompt: "same-id substituted prompt" }
    })).toThrow(/does not match/);

    expect(() => resolveSessionStateComposition({
      ...state,
      problem: {
        ...persistedProblem,
        providerContextSpecSha256:
          "0".repeat(64) as NonNullable<typeof persistedProblem.providerContextSpecSha256>
      }
    })).toThrow(/provenance/);
  });

  it("fails closed when the exact configured Oxford version is unavailable", async () => {
    const response = await postStart(
      newSessionId(),
      oxfordConfiguration(
        sixPeopleProblem.id,
        "999.0.0",
        sixPeopleProblem.interviewer.difficulty
      )
    );
    expect(response.status).toBe(404);
    const failure = ProtocolErrorResponseSchema.parse(await json(response));
    expect(failure.error.code).toBe("NOT_FOUND");
  });

  it("rejects an unknown provider with a bounded provider-specific conflict", async () => {
    const configuration = InterviewSessionConfigurationSchema.parse({
      ...oxfordConfiguration(
        sixPeopleProblem.id,
        sixPeopleProblem.version,
        sixPeopleProblem.interviewer.difficulty
      ),
      providerSelection: {
        providerId: "unknown-provider",
        modelId: "unknown-model"
      }
    });
    const response = await postStart(newSessionId(), configuration);
    expect(response.status).toBe(409);
    const failure = ProtocolErrorResponseSchema.parse(await json(response));
    expect(failure.error).toEqual({
      code: "CONFLICT",
      message: "Selected provider is unavailable"
    });
  });

  it("treats request-id reuse with a different configuration as a conflict", async () => {
    const sessionId = newSessionId();
    const requestId = newRequestId();
    const firstConfiguration = oxfordConfiguration(
      sixPeopleProblem.id,
      sixPeopleProblem.version,
      sixPeopleProblem.interviewer.difficulty
    );
    const secondProblem = getProblemByIdentity("oxford-divisibility-chain", "1.0.0");
    expect(secondProblem).toBeDefined();
    if (secondProblem === undefined) return;
    const secondConfiguration = oxfordConfiguration(
      secondProblem.id,
      secondProblem.version,
      secondProblem.interviewer.difficulty
    );

    const first = await postStart(sessionId, firstConfiguration, requestId);
    expect(first.status).toBe(200);

    const conflict = await postStart(sessionId, secondConfiguration, requestId);
    expect(conflict.status).toBe(409);
    const failure = ProtocolErrorResponseSchema.parse(await json(conflict));
    expect(failure.error.code).toBe("CONFLICT");
    expect(registry.get(sessionId).getState().configuration).toEqual(firstConfiguration);
  });

  it("rejects mode mismatches and secret-shaped provider data at the configuration boundary", async () => {
    expect(() => resolveInterviewSessionConfiguration({
      configurationVersion: 1,
      mode: "OXFORD_MATHEMATICS",
      problem: { id: "quant-gamblers-ruin", version: "1.0.0" },
      interventionPolicy: "BALANCED"
    })).toThrow();

    expect(() => InterviewSessionConfigurationSchema.parse({
      configurationVersion: 1,
      mode: "OXFORD_MATHEMATICS",
      problem: { id: sixPeopleProblem.id, version: sixPeopleProblem.version },
      interventionPolicy: "BALANCED",
      providerSelection: {
        providerId: "mock-model",
        modelId: "mock-default",
        apiKey: "must-never-persist"
      }
    })).toThrow();

    expect(() => InterviewSessionConfigurationSchema.parse({
      configurationVersion: 1,
      mode: "OXFORD_MATHEMATICS",
      problem: { id: sixPeopleProblem.id, version: sixPeopleProblem.version },
      interventionPolicy: "BALANCED",
      providerSelection: {
        providerId: "sk-abcdefghijklmnop",
        modelId: "mock-default"
      }
    })).toThrow(/credential material/);

    expect(() => InterviewSessionConfigurationSchema.parse({
      configurationVersion: 1,
      mode: "QUANT_TRADING",
      scenario: { id: "BASIC_MARKET_MAKING", version: QUANT_TRADER_SCENARIO_VERSION },
      durationMinutes: 10_000,
      interventionPolicy: "BALANCED"
    })).toThrow();

    const unresolvedProviderComposition = resolveInterviewSessionConfiguration({
      configurationVersion: 1,
      mode: "QUANT_TRADING",
      scenario: { id: "BASIC_MARKET_MAKING", version: QUANT_TRADER_SCENARIO_VERSION },
      interventionPolicy: "BALANCED",
      providerSelection: {
        providerId: "unregistered-provider",
        modelId: "unregistered-model"
      }
    });
    expect(unresolvedProviderComposition.configuration.providerSelection).toEqual({
      providerId: "unregistered-provider",
      modelId: "unregistered-model"
    });
  });

  it("reports disabled provider runtime state as disabled instead of a capability failure", async () => {
    const resolver = new ProviderRuntimeResolver({
      configurationSource: {
        resolveConfiguration: () => ({ enabled: false })
      }
    });

    const option = await resolver.evaluateLaunchOption({
      providerId: "mock-model",
      modelId: "mock-default"
    });
    expect(option).toMatchObject({
      availability: "UNAVAILABLE",
      reason: "DISABLED"
    });
  });

  it("enumerates only bounded public launch metadata", async () => {
    const response = await post({
      protocolVersion: 1,
      type: "LIST_INTERVIEW_CATALOG",
      requestId: newRequestId()
    });
    expect(response.status).toBe(200);
    const catalog = InterviewCatalogResponseSchema.parse(await json(response));
    expect(catalog.entries).toEqual(listInterviewCatalogEntries());
    expect(catalog.entries.some(
      (entry) => entry.mode === "OXFORD_MATHEMATICS" && entry.id === sixPeopleProblem.id
    )).toBe(true);
    expect(catalog.entries.some(
      (entry) => entry.mode === "OXFORD_MATHEMATICS" && entry.id === "oxford-divisibility-chain"
    )).toBe(true);
    expect(catalog.entries.some((entry) => entry.mode === "QUANT_TRADING")).toBe(true);
    expect(catalog.entries.some((entry) => entry.mode === "QUANT_RESEARCH")).toBe(true);

    const serialized = JSON.stringify(catalog);
    expect(serialized).not.toContain(sixPeopleProblem.private.canonicalSolution);
    expect(serialized).not.toContain(sixPeopleProblem.private.verificationNotes);
    expect(serialized).not.toContain("generatedParameters");
    expect(serialized).not.toContain("gradingData");

    const providersResponse = await post({
      protocolVersion: 1,
      type: "LIST_PROVIDER_OPTIONS",
      requestId: newRequestId()
    });
    expect(providersResponse.status).toBe(200);
    const providers = ProviderOptionsResponseSchema.parse(await json(providersResponse));
    const mock = providers.options.find(
      (option) => option.providerId === "mock-model" && option.modelId === "mock-default"
    );
    const gemini = providers.options.find(
      (option) => option.providerId === "gemini-api" && option.modelId === "gemini-2.5-flash"
    );
    expect(mock).toMatchObject({ availability: "AVAILABLE" });
    expect(gemini).toMatchObject({ availability: "UNAVAILABLE" });
    const providerSerialized = JSON.stringify(providers);
    expect(providerSerialized).not.toMatch(/api[_-]?key|credentialRef|token|executable|path/i);
  });

  function postStart(
    sessionId: SessionId,
    configuration: InterviewSessionConfiguration,
    requestId = newRequestId()
  ): Promise<Response> {
    return post({
      protocolVersion: 1,
      type: "START_CONFIGURED_SESSION",
      requestId,
      sessionId,
      configuration
    });
  }

  function post(body: unknown): Promise<Response> {
    return fetch(`${address.url}/v1/commands`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-interview-client-token": CLIENT_TOKEN,
        origin: CLIENT_ORIGIN
      },
      body: JSON.stringify(body)
    });
  }
});

function recoveryCoordinator(registry: SessionRuntimeRegistry): SessionRecoveryCoordinator {
  const sessions = new SessionRecoveryCoordinator(registry);
  const orchestrator = new ServerTurnOrchestrator(sessions, () => undefined);
  sessions.setTurnRecoveryDelegate(orchestrator);
  return sessions;
}

function commandServer(sessions: SessionRecoveryCoordinator): LoopbackCommandServer {
  return new LoopbackCommandServer({
    security: {
      host: "127.0.0.1",
      allowedOrigins: new Set([CLIENT_ORIGIN]),
      clientToken: CLIENT_TOKEN
    },
    sessions
  });
}

function oxfordConfiguration(
  id: string,
  version: string,
  difficulty: string
): Extract<InterviewSessionConfiguration, { readonly mode: "OXFORD_MATHEMATICS" }> {
  return OxfordInterviewSessionConfigurationSchema.parse({
    configurationVersion: 1,
    mode: "OXFORD_MATHEMATICS",
    problem: { id, version },
    difficulty,
    interventionPolicy: "BALANCED"
  });
}

async function browserLikeFetch(
  input: RequestInfo | URL,
  init: RequestInit = {}
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("origin", CLIENT_ORIGIN);
  return fetch(input, { ...init, headers });
}

async function json(response: Response): Promise<unknown> {
  return response.json() as Promise<unknown>;
}
