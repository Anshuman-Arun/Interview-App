import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  InterviewSessionConfigurationSchema,
  ProtocolErrorResponseSchema,
  QuantResearchPublicStateSchema,
  QuantResearchStateResponseSchema,
  QuantTradingPublicStateSchema,
  QuantTradingStateResponseSchema,
  SessionResumedResponseSchema,
  SessionsListResponseSchema,
  newInputEpisodeId,
  newRequestId,
  newSessionId,
  type InterviewSessionConfiguration,
  type RequestId,
  type SessionId
} from "../packages/domain/src/index.js";
import {
  QuantResearchAuthoritativeSnapshotEventSchema,
  QuantTradingResultEventSchema,
  QuantTradingRoundEvidenceEventSchema,
  type SessionState
} from "../packages/events/src/index.js";
import {
  QuantResearchCoordinator,
  QuantResearchCoordinatorOutcomeSchema,
  QuantTradingSessionCoordinator,
  TurnCoordinator,
  SessionRuntimeRegistry,
  SessionWriter,
  createCommandEnvelope,
  replayQuantTradingSessionState
} from "../packages/interview-engine/src/index.js";
import {
  QUANT_RESEARCH_FAMILIES,
  QUANT_RESEARCH_VERSION,
  QUANT_TRADER_SCENARIO_VERSION,
  QuantResearchEngine,
  QuantTraderScenarioFamilySchema,
  createProductionQuantResearchDefinition,
  createQuantTraderScenario
} from "../packages/local-compute/src/index.js";
import { SqliteEventStore } from "../packages/persistence/src/index.js";
import { sixPeopleProblem } from "../packages/problems/src/index.js";
import {
  projectSessionHistory,
  projectSessionReplayReadModel
} from "../packages/replay/src/index.js";
import {
  LoopbackCommandServer,
  ProductionSessionRuntime,
  ServerTurnOrchestrator,
  SessionRecoveryCoordinator,
  resolveInterviewSessionConfiguration,
  resolveSessionStateComposition
} from "../apps/server/src/index.js";

const CLIENT_TOKEN = "quant-runtime-integration-token-that-is-long-enough";
const CLIENT_ORIGIN = "http://127.0.0.1:5173";

function tradingConfiguration(
  family = "BASIC_MARKET_MAKING"
): Extract<InterviewSessionConfiguration, { readonly mode: "QUANT_TRADING" }> {
  const parsed = InterviewSessionConfigurationSchema.parse({
    configurationVersion: 1,
    mode: "QUANT_TRADING",
    scenario: {
      id: family,
      version: QUANT_TRADER_SCENARIO_VERSION
    },
    interventionPolicy: "STRICT"
  });
  if (parsed.mode !== "QUANT_TRADING") throw new Error("Expected Quant Trading configuration");
  return parsed;
}

function researchConfiguration(
  family: (typeof QUANT_RESEARCH_FAMILIES)[number] = "MODEL_COMPARISON"
): Extract<InterviewSessionConfiguration, { readonly mode: "QUANT_RESEARCH" }> {
  const parsed = InterviewSessionConfigurationSchema.parse({
    configurationVersion: 1,
    mode: "QUANT_RESEARCH",
    scenario: {
      id: family,
      version: QUANT_RESEARCH_VERSION
    },
    interventionPolicy: "BALANCED"
  });
  if (parsed.mode !== "QUANT_RESEARCH") throw new Error("Expected Quant Research configuration");
  return parsed;
}

describe("production quant runtime integration", () => {
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

  it("keeps Quant Trading protocol state bounded while rejecting forged and invalid market actions", async () => {
    const sessionId = newSessionId();
    const configuration = tradingConfiguration();
    const startRequestId = newRequestId();
    await expectStatus(postStart(sessionId, configuration, startRequestId), 200);
    const seedAfterStart = registry.get(sessionId).getState().quantTrading?.definition.seed;
    const eventCountAfterStart = store.eventCount(sessionId);
    expect(seedAfterStart).toEqual(expect.any(Number));

    await expectStatus(postStart(sessionId, configuration, startRequestId), 200);
    expect(store.eventCount(sessionId)).toBe(eventCountAfterStart);
    expect(registry.get(sessionId).getState().quantTrading?.definition.seed).toBe(seedAfterStart);

    const initial = QuantTradingStateResponseSchema.parse(
      await responseJson(await post({
        protocolVersion: 1,
        type: "GET_QUANT_SESSION_STATE",
        requestId: newRequestId(),
        sessionId
      }))
    );
    expect(initial.state.status).toBe("ACTIVE");
    expect(initial.state.actionRequired).toBe(true);
    expect(initial.state.quoteRequest).toBeDefined();

    const serialized = JSON.stringify(initial.state);
    expect(serialized).not.toContain('"seed"');
    expect(serialized).not.toContain("orderFlowType");
    expect(serialized).not.toContain("incomingMarketSide");
    expect(serialized).not.toContain("counterparty");
    expect(serialized).not.toContain("INFORMED");
    expect(serialized).not.toContain("NOISE");

    const request = initial.state.quoteRequest;
    if (request === undefined) throw new Error("Expected active quote request");

    await expectProtocolError(post({
      protocolVersion: 1,
      type: "SUBMIT_QUANT_TRADING_ACTION",
      requestId: newRequestId(),
      sessionId,
      expectedRound: request.round,
      action: {
        type: "QUOTE",
        quote: {
          bidPrice: request.fairValue + request.tickSize,
          bidSize: 1,
          askPrice: request.fairValue,
          askSize: 1
        }
      }
    }), 400, "INVALID_COMMAND");

    await expectProtocolError(post({
      protocolVersion: 1,
      type: "SUBMIT_QUANT_TRADING_ACTION",
      requestId: newRequestId(),
      sessionId,
      expectedRound: request.round,
      action: {
        type: "QUOTE",
        quote: {
          bidPrice: request.fairValue - request.tickSize / 2,
          bidSize: 1,
          askPrice: request.fairValue + request.tickSize / 2,
          askSize: 1
        }
      }
    }), 400, "INVALID_COMMAND");

    await expectProtocolError(post({
      protocolVersion: 1,
      type: "SUBMIT_QUANT_TRADING_ACTION",
      requestId: newRequestId(),
      sessionId,
      expectedRound: request.round,
      action: {
        type: "QUOTE",
        quote: {
          bidPrice: request.fairValue - request.tickSize,
          bidSize: request.maxQuoteSize + 1,
          askPrice: request.fairValue + request.tickSize,
          askSize: 1
        }
      }
    }), 400, "INVALID_COMMAND");

    await expectProtocolError(post({
      protocolVersion: 1,
      type: "SUBMIT_QUANT_TRADING_ACTION",
      requestId: newRequestId(),
      sessionId,
      expectedRound: request.round,
      action: {
        type: "PASS",
        marketOutcome: { filled: true },
        round: 9_999_999
      }
    }), 400, "INVALID_COMMAND");

    const overflowBody = JSON.stringify({
      protocolVersion: 1,
      type: "SUBMIT_QUANT_TRADING_ACTION",
      requestId: newRequestId(),
      sessionId,
      expectedRound: request.round,
      action: {
        type: "QUOTE",
        quote: {
          bidPrice: request.fairValue - request.tickSize,
          bidSize: 1,
          askPrice: request.fairValue + request.tickSize,
          askSize: 1
        }
      }
    }).replace(
      String(request.fairValue - request.tickSize),
      "1e309"
    );
    await expectProtocolError(postRaw(overflowBody), 400, "INVALID_COMMAND");

    await expectProtocolError(post({
      protocolVersion: 1,
      type: "ADVANCE_QUANT_TRADING",
      requestId: newRequestId(),
      sessionId
    }), 400, "INVALID_COMMAND");

    const unchanged = QuantTradingStateResponseSchema.parse(
      await responseJson(await post({
        protocolVersion: 1,
        type: "GET_QUANT_SESSION_STATE",
        requestId: newRequestId(),
        sessionId
      }))
    );
    expect(unchanged.state).toEqual(initial.state);
    expect(registry.get(sessionId).getState().quantTrading?.rounds).toHaveLength(0);
  });

  it("keeps legacy pre-runtime Quant sessions discoverable without reseeding or resuming them", async () => {
    const activeTrading = newSessionId();
    const activeResearch = newSessionId();
    for (const legacy of [
      { sessionId: activeTrading, configuration: tradingConfiguration() },
      { sessionId: activeResearch, configuration: researchConfiguration() }
    ] as const) {
      injectLegacyUninitializedQuant(store, legacy.sessionId, legacy.configuration);
      const writer = registry.get(legacy.sessionId);
      const state = writer.getState();
      expect(state.status).toBe("ACTIVE");
      expect(state.problem).toBeUndefined();
      expect(state.quantTrading).toBeUndefined();
      expect(state.quantResearch).toBeUndefined();

      const countBeforeRejectedWrites = store.eventCount(legacy.sessionId);
      const turns = new TurnCoordinator(writer);
      await expect(turns.completeSession(createCommandEnvelope({
        sessionId: legacy.sessionId,
        producer: "legacy-quant-fixture"
      }))).rejects.toThrow(/Cannot extend legacy Quant session/u);
      await expect(turns.commitInput("must not mutate legacy quant", createCommandEnvelope({
        sessionId: legacy.sessionId,
        producer: "legacy-quant-fixture"
      }))).rejects.toThrow(/Cannot extend legacy Quant session/u);
      expect(store.eventCount(legacy.sessionId)).toBe(countBeforeRejectedWrites);
    }

    const partialResearch = newSessionId();
    injectLegacyUninitializedQuant(
      store,
      partialResearch,
      researchConfiguration(),
      {
        problemId: "MODEL_COMPARISON",
        problemVersion: QUANT_RESEARCH_VERSION,
        prompt: "Legacy partial Quant Research prompt"
      }
    );
    const completedTrading = injectLegacyTerminalQuant(
      tradingConfiguration(),
      "COMPLETED"
    );
    const archivedResearch = injectLegacyTerminalQuant(
      researchConfiguration(),
      "ARCHIVED"
    );
    const legacySessions = [
      { sessionId: activeTrading, status: "ACTIVE", configuration: tradingConfiguration() },
      { sessionId: activeResearch, status: "ACTIVE", configuration: researchConfiguration() },
      { sessionId: partialResearch, status: "ACTIVE", configuration: researchConfiguration() },
      { sessionId: completedTrading, status: "COMPLETED", configuration: tradingConfiguration() },
      { sessionId: archivedResearch, status: "ARCHIVED", configuration: researchConfiguration() }
    ] as const;

    const listed = SessionsListResponseSchema.parse(
      await responseJson(await post({
        protocolVersion: 1,
        type: "LIST_SESSIONS",
        requestId: newRequestId()
      }))
    );
    for (const legacy of legacySessions) {
      const summary = listed.sessions.find((item) => item.sessionId === legacy.sessionId);
      expect(summary).toMatchObject({
        sessionId: legacy.sessionId,
        status: legacy.status
      });
      expect(summary?.problemId).toBeUndefined();
      const countBefore = store.eventCount(legacy.sessionId);

      await expectProtocolError(getQuantState(legacy.sessionId), 409, "CONFLICT");
      await expectProtocolError(post({
        protocolVersion: 1,
        type: "RESUME_SESSION",
        requestId: newRequestId(),
        sessionId: legacy.sessionId
      }), 409, "CONFLICT");
      await expectProtocolError(
        postStart(legacy.sessionId, legacy.configuration),
        409,
        "CONFLICT"
      );
      expect(store.eventCount(legacy.sessionId)).toBe(countBefore);
    }

    function injectLegacyTerminalQuant(
      configuration: InterviewSessionConfiguration,
      status: "COMPLETED" | "ARCHIVED"
    ): SessionId {
      const sessionId = newSessionId();
      const requestId = newRequestId();
      const terminalAt = new Date().toISOString();
      store.appendIdempotent({
        sessionId,
        requestId,
        causationId: requestId,
        correlationId: requestId,
        elapsedMs: 0,
        expectedPriorSequence: 0,
        commandFingerprint: status === "COMPLETED" ? "8".repeat(64) : "9".repeat(64),
        drafts: [
          {
            source: "APPLICATION",
            type: "SESSION_STARTED",
            payload: {
              startedAt: terminalAt,
              configuration
            }
          },
          status === "COMPLETED"
            ? {
                source: "APPLICATION",
                type: "SESSION_COMPLETED",
                payload: { completedAt: terminalAt }
              }
            : {
                source: "APPLICATION",
                type: "SESSION_ARCHIVED",
                payload: { archivedAt: terminalAt }
              }
        ],
        result: { injected: true }
      });
      return sessionId;
    }
  });

  it("rejects unsupported configured Quant Trading family/version before session authority is created", async () => {
    for (const scenario of [
      { id: "BASIC_MARKET_MAKING", version: "0.0.0" },
      { id: "NOT_A_TRADING_FAMILY", version: QUANT_TRADER_SCENARIO_VERSION }
    ]) {
      const sessionId = newSessionId();
      await expectProtocolError(postStart(sessionId, {
        configurationVersion: 1,
        mode: "QUANT_TRADING",
        scenario,
        interventionPolicy: "STRICT"
      }), 404, "NOT_FOUND");
      expect(registry.hasSession(sessionId)).toBe(false);
      expect(store.eventCount(sessionId)).toBe(0);
    }
  });

  it("rejects finite Trading arithmetic overflow as invalid without mutating the round", async () => {
    const sessionId = newSessionId();
    await expectStatus(postStart(sessionId, tradingConfiguration()), 200);

    const hugeQuote = {
      type: "QUOTE" as const,
      quote: {
        bidPrice: 1e307,
        bidSize: 1,
        askPrice: 8e307,
        askSize: 1
      }
    };

    let state = QuantTradingStateResponseSchema.parse(
      await responseJson(await getQuantState(sessionId))
    ).state;
    for (let index = 0; index < 2; index += 1) {
      state = QuantTradingStateResponseSchema.parse(
        await responseJson(await post({
          protocolVersion: 1,
          type: "SUBMIT_QUANT_TRADING_ACTION",
          requestId: newRequestId(),
          sessionId,
          expectedRound: state.currentRound,
          action: hugeQuote
        }))
      ).state;
    }

    const beforeOverflow = state;
    const countBeforeOverflow = store.eventCount(sessionId);
    await expectProtocolError(post({
      protocolVersion: 1,
      type: "SUBMIT_QUANT_TRADING_ACTION",
      requestId: newRequestId(),
      sessionId,
      expectedRound: beforeOverflow.currentRound,
      action: hugeQuote
    }), 400, "INVALID_COMMAND");

    expect(store.eventCount(sessionId)).toBe(countBeforeOverflow);
    expect(QuantTradingStateResponseSchema.parse(
      await responseJson(await getQuantState(sessionId))
    ).state).toEqual(beforeOverflow);
  });

  it("rejects a quote before RNG can overflow cumulative portfolio accounting", async () => {
    const hugeQuote = {
      type: "QUOTE" as const,
      quote: {
        bidPrice: 7e307,
        bidSize: 1,
        askPrice: 8e307,
        askSize: 1
      }
    };

    let seed: number | undefined;
    for (let candidate = 0; candidate < 1_000 && seed === undefined; candidate += 1) {
      const engine = createQuantTraderScenario({
        family: "BASIC_MARKET_MAKING",
        seed: candidate
      });
      let filledBidTwice = true;
      for (let round = 0; round < 2; round += 1) {
        engine.submitAction(hugeQuote);
        const evidence = engine.advance();
        if (!evidence.studentFills.some((fill) => fill.side === "BUY")) {
          filledBidTwice = false;
          break;
        }
      }
      if (filledBidTwice) seed = candidate;
    }
    if (seed === undefined) throw new Error("Expected a bounded seed with two consecutive bid fills");

    await server.stop();
    await registry.closeAll();
    registry = new SessionRuntimeRegistry(store);
    sessions = recoveryCoordinator(registry);
    server = commandServer(
      sessions,
      new ProductionSessionRuntime({ seedSource: () => seed })
    );
    address = await server.start();

    const sessionId = newSessionId();
    await expectStatus(postStart(sessionId, tradingConfiguration()), 200);

    let state = QuantTradingStateResponseSchema.parse(
      await responseJson(await getQuantState(sessionId))
    ).state;
    for (let round = 0; round < 2; round += 1) {
      state = QuantTradingStateResponseSchema.parse(
        await responseJson(await post({
          protocolVersion: 1,
          type: "SUBMIT_QUANT_TRADING_ACTION",
          requestId: newRequestId(),
          sessionId,
          expectedRound: state.currentRound,
          action: hugeQuote
        }))
      ).state;
      expect(state.lastRound?.fills.some((fill) => fill.side === "BUY")).toBe(true);
    }

    const countBeforeRejectedQuote = store.eventCount(sessionId);
    await expectProtocolError(post({
      protocolVersion: 1,
      type: "SUBMIT_QUANT_TRADING_ACTION",
      requestId: newRequestId(),
      sessionId,
      expectedRound: state.currentRound,
      action: hugeQuote
    }), 400, "INVALID_COMMAND");
    expect(store.eventCount(sessionId)).toBe(countBeforeRejectedQuote);
    expect(QuantTradingStateResponseSchema.parse(
      await responseJson(await getQuantState(sessionId))
    ).state).toEqual(state);
  });

  it("reports a reachable production risk stop with its bounded public reason", async () => {
    await server.stop();
    await registry.closeAll();
    registry = new SessionRuntimeRegistry(store);
    sessions = recoveryCoordinator(registry);
    server = commandServer(
      sessions,
      new ProductionSessionRuntime({ seedSource: () => 7 })
    );
    address = await server.start();

    const sessionId = newSessionId();
    await expectStatus(postStart(sessionId, tradingConfiguration("RISK_MANAGEMENT")), 200);
    const initial = QuantTradingStateResponseSchema.parse(
      await responseJson(await getQuantState(sessionId))
    ).state;

    const stopped = QuantTradingStateResponseSchema.parse(
      await responseJson(await post({
        protocolVersion: 1,
        type: "SUBMIT_QUANT_TRADING_ACTION",
        requestId: newRequestId(),
        sessionId,
        expectedRound: initial.currentRound,
        action: {
          type: "QUOTE",
          quote: {
            bidPrice: 50,
            bidSize: 1,
            askPrice: 50.5,
            askSize: 4
          }
        }
      }))
    ).state;

    expect(stopped.status).toBe("RISK_STOPPED");
    expect(stopped.currentRound).toBe(1);
    expect(stopped.fairValue).toBe(100);
    expect(stopped.lastRound).toMatchObject({
      round: 1,
      riskBreached: true
    });
    expect(stopped.lastRound?.fills).toEqual([
      { side: "SELL", price: 50.5, size: 4 }
    ]);
    expect(stopped.marketUpdates).toEqual([]);
    expect(stopped.completion?.lastRiskBreach).toEqual({
      round: 1,
      source: "POST_ROUND"
    });
    const stoppedSerialized = JSON.stringify(stopped);
    expect(stoppedSerialized).not.toContain("stop-loss");
    expect(stoppedSerialized).not.toContain("threshold");
    expect(stoppedSerialized).not.toContain("max drawdown");
    expect(registry.get(sessionId).getState().quantTrading?.rounds[0]?.riskReason)
      .toContain("stop-loss threshold");
    expect(stopped.completion?.riskBreachCount).toBe(1);
    expect(registry.get(sessionId).getState().status).toBe("COMPLETED");
  });

  it("enforces the hard position limit through the authenticated production command path", async () => {
    await server.stop();
    await registry.closeAll();
    registry = new SessionRuntimeRegistry(store);
    sessions = recoveryCoordinator(registry);
    server = commandServer(
      sessions,
      new ProductionSessionRuntime({ seedSource: () => 7 })
    );
    address = await server.start();

    const sessionId = newSessionId();
    await expectStatus(postStart(sessionId, tradingConfiguration("RISK_MANAGEMENT")), 200);
    const initial = QuantTradingStateResponseSchema.parse(
      await responseJson(await getQuantState(sessionId))
    ).state;
    expect(initial.quoteRequest).toMatchObject({
      round: 1,
      fairValue: 100,
      tickSize: 0.5,
      maxQuoteSize: 4,
      hardPositionLimit: true,
      maxPosition: 4
    });

    const afterFill = QuantTradingStateResponseSchema.parse(
      await responseJson(await post({
        protocolVersion: 1,
        type: "SUBMIT_QUANT_TRADING_ACTION",
        requestId: newRequestId(),
        sessionId,
        expectedRound: initial.currentRound,
        action: {
          type: "QUOTE",
          quote: {
            bidPrice: 99,
            bidSize: 1,
            askPrice: 99.5,
            askSize: 4
          }
        }
      }))
    ).state;
    expect(afterFill.portfolio.position).toBe(-4);
    expect(afterFill.currentRound).toBe(2);
    expect(afterFill.lastRound?.fills).toEqual([
      { side: "SELL", price: 99.5, size: 4 }
    ]);
    const filledSerialized = JSON.stringify(afterFill);
    expect(filledSerialized).not.toContain("counterparty");
    expect(filledSerialized).not.toContain("orderFlowType");
    expect(filledSerialized).not.toContain("incomingMarketSide");
    expect(filledSerialized).not.toContain("orderId");
    expect(filledSerialized).not.toContain("matchedOrderId");

    const countBeforeHardLimit = store.eventCount(sessionId);
    await expectProtocolError(post({
      protocolVersion: 1,
      type: "SUBMIT_QUANT_TRADING_ACTION",
      requestId: newRequestId(),
      sessionId,
      expectedRound: afterFill.currentRound,
      action: {
        type: "QUOTE",
        quote: {
          bidPrice: 99,
          bidSize: 1,
          askPrice: 99.5,
          askSize: 1
        }
      }
    }), 400, "INVALID_COMMAND");
    expect(store.eventCount(sessionId)).toBe(countBeforeHardLimit);
    expect(QuantTradingStateResponseSchema.parse(
      await responseJson(await getQuantState(sessionId))
    ).state).toEqual(afterFill);
  });

  it("rejects unsupported Quant Research family/version before session authority is created", async () => {
    for (const scenario of [
      { id: "MODEL_COMPARISON", version: "0.0.0" },
      { id: "NOT_A_RESEARCH_FAMILY", version: QUANT_RESEARCH_VERSION }
    ]) {
      const sessionId = newSessionId();
      await expectProtocolError(postStart(sessionId, {
        configurationVersion: 1,
        mode: "QUANT_RESEARCH",
        scenario,
        interventionPolicy: "BALANCED"
      }), 404, "NOT_FOUND");
      expect(registry.hasSession(sessionId)).toBe(false);
      expect(store.eventCount(sessionId)).toBe(0);
    }
  });

  it("makes Trading action requests idempotent, conflict-safe, restart-stable, and deterministically terminal", async () => {
    const sessionId = newSessionId();
    await expectStatus(postStart(sessionId, tradingConfiguration()), 200);

    const initial = QuantTradingStateResponseSchema.parse(
      await responseJson(await getQuantState(sessionId))
    ).state;

    await restart();
    const afterEmptyRestart = QuantTradingStateResponseSchema.parse(
      await responseJson(await getQuantState(sessionId))
    ).state;
    expect(afterEmptyRestart).toEqual(initial);

    const actionRequestId = newRequestId();
    const passCommand = {
      protocolVersion: 1 as const,
      type: "SUBMIT_QUANT_TRADING_ACTION" as const,
      requestId: actionRequestId,
      sessionId,
      expectedRound: initial.currentRound,
      action: { type: "PASS" as const }
    };
    const first = QuantTradingStateResponseSchema.parse(
      await responseJson(await post(passCommand))
    );
    const eventCountAfterFirst = store.eventCount(sessionId);

    const duplicate = QuantTradingStateResponseSchema.parse(
      await responseJson(await post(passCommand))
    );
    expect(duplicate.state).toEqual(first.state);
    expect(store.eventCount(sessionId)).toBe(eventCountAfterFirst);

    await expectProtocolError(post({
      protocolVersion: 1,
      type: "SUBMIT_QUANT_TRADING_ACTION",
      requestId: newRequestId(),
      sessionId,
      expectedRound: initial.currentRound,
      action: { type: "PASS" }
    }), 409, "CONFLICT");
    expect(store.eventCount(sessionId)).toBe(eventCountAfterFirst);

    await expectProtocolError(post({
      ...passCommand,
      expectedRound: first.state.currentRound
    }), 409, "CONFLICT");
    expect(store.eventCount(sessionId)).toBe(eventCountAfterFirst);

    await expectProtocolError(post({
      ...passCommand,
      action: {
        type: "QUOTE",
        quote: {
          bidPrice: 99,
          bidSize: 1,
          askPrice: 101,
          askSize: 1
        }
      }
    }), 409, "CONFLICT");
    expect(store.eventCount(sessionId)).toBe(eventCountAfterFirst);

    await restart();
    const afterCommittedRestart = QuantTradingStateResponseSchema.parse(
      await responseJson(await getQuantState(sessionId))
    ).state;
    expect(afterCommittedRestart).toEqual(first.state);

    const duplicateAfterRestart = QuantTradingStateResponseSchema.parse(
      await responseJson(await post(passCommand))
    );
    expect(duplicateAfterRestart.state).toEqual(first.state);
    expect(store.eventCount(sessionId)).toBe(eventCountAfterFirst);

    await expectProtocolError(post({
      protocolVersion: 1,
      type: "COMPLETE_SESSION",
      requestId: newRequestId(),
      sessionId
    }), 409, "CONFLICT");

    let state = duplicateAfterRestart.state;
    let terminalCommand:
      | {
          readonly protocolVersion: 1;
          readonly type: "SUBMIT_QUANT_TRADING_ACTION";
          readonly requestId: RequestId;
          readonly sessionId: SessionId;
          readonly expectedRound: number;
          readonly action: { readonly type: "PASS" };
        }
      | undefined;
    while (state.actionRequired) {
      const command = {
        protocolVersion: 1 as const,
        type: "SUBMIT_QUANT_TRADING_ACTION" as const,
        requestId: newRequestId(),
        sessionId,
        expectedRound: state.currentRound,
        action: { type: "PASS" as const }
      };
      if (state.currentRound === state.plannedRounds) terminalCommand = command;
      state = QuantTradingStateResponseSchema.parse(
        await responseJson(await post(command))
      ).state;
    }

    expect(terminalCommand).toBeDefined();
    expect(state.status).toBe("COMPLETED");
    expect(state.completion).toBeDefined();
    expect(state.completion?.roundsCompleted).toBe(state.plannedRounds);
    expect(state.completion?.accountingInvariantHolds).toBe(true);
    expect(JSON.stringify(state)).not.toContain('"seed"');

    const terminalEvents = store.load(sessionId).slice(-4);
    expect(terminalEvents.map((event) => event.type)).toEqual([
      "QUANT_TRADING_ACTION_ACCEPTED",
      "QUANT_TRADING_ROUND_RESOLVED",
      "QUANT_TRADING_SCENARIO_COMPLETED",
      "SESSION_COMPLETED"
    ]);
    expect(terminalEvents.map((event) => event.source)).toEqual([
      "USER",
      "APPLICATION",
      "APPLICATION",
      "APPLICATION"
    ]);
    expect(new Set(terminalEvents.map((event) => event.causationId)).size).toBe(1);
    expect(new Set(terminalEvents.map((event) => event.correlationId)).size).toBe(1);

    const history = projectSessionHistory(store.load(sessionId));
    const tradingTimeline = history.timeline.entries.filter(
      (entry) => entry.kind.startsWith("QUANT_TRADING_")
    );
    expect(tradingTimeline.some((entry) => entry.kind === "QUANT_TRADING_SCENARIO_COMPLETED"))
      .toBe(true);
    // Generic replay is intentionally specialized-unverified. Never surface a
    // persisted score there before deterministic Trading replay authenticates it.
    const serializedGenericTimeline = JSON.stringify(history.timeline);
    for (const withheldOutcomeField of [
      "objectiveScore",
      "fillCount",
      "riskBreached",
      "completionStatus"
    ]) {
      expect(serializedGenericTimeline).not.toContain(withheldOutcomeField);
    }
    const replayRead = projectSessionReplayReadModel(history);
    expect(replayRead.entries.some((entry) => entry.kind === "QUANT_TRADING_ROUND_RESOLVED"))
      .toBe(true);
    const serializedReplay = JSON.stringify(replayRead);
    expect(serializedReplay).not.toContain('"seed"');
    expect(serializedReplay).not.toContain("orderFlowType");
    expect(serializedReplay).not.toContain("incomingMarketSide");
    expect(serializedReplay).not.toContain("counterparty");

    await expectProtocolError(post({
      protocolVersion: 1,
      type: "SUBMIT_QUANT_TRADING_ACTION",
      requestId: newRequestId(),
      sessionId,
      expectedRound: state.currentRound,
      action: { type: "PASS" }
    }), 409, "CONFLICT");

    const terminalEventCount = store.eventCount(sessionId);
    if (terminalCommand === undefined) throw new Error("Expected terminal Trading command");
    expect(QuantTradingStateResponseSchema.parse(
      await responseJson(await post(terminalCommand))
    ).state).toEqual(state);
    expect(store.eventCount(sessionId)).toBe(terminalEventCount);

    await restart();
    const recoveredTerminal = QuantTradingStateResponseSchema.parse(
      await responseJson(await getQuantState(sessionId))
    ).state;
    expect(recoveredTerminal).toEqual(state);
    expect(registry.get(sessionId).getState().status).toBe("COMPLETED");
    expect(QuantTradingStateResponseSchema.parse(
      await responseJson(await post(terminalCommand))
    ).state).toEqual(state);
    expect(store.eventCount(sessionId)).toBe(terminalEventCount);
  });

  it("reprojects duplicate quant responses from authoritative events instead of cached JSON", async () => {
    const tradingId = newSessionId();
    await expectStatus(postStart(tradingId, tradingConfiguration()), 200);
    const tradingInitial = QuantTradingStateResponseSchema.parse(
      await responseJson(await getQuantState(tradingId))
    ).state;
    const tradingRequestId = newRequestId();
    const tradingCommand = {
      protocolVersion: 1 as const,
      type: "SUBMIT_QUANT_TRADING_ACTION" as const,
      requestId: tradingRequestId,
      sessionId: tradingId,
      expectedRound: tradingInitial.currentRound,
      action: { type: "PASS" as const }
    };
    const authoritativeTrading = QuantTradingStateResponseSchema.parse(
      await responseJson(await post(tradingCommand))
    ).state;
    const tradingCount = store.eventCount(tradingId);
    overwriteProcessedResult(store, tradingId, tradingRequestId, {
      ...authoritativeTrading,
      portfolio: {
        ...authoritativeTrading.portfolio,
        cash: authoritativeTrading.portfolio.cash + 1
      }
    });
    expect(QuantTradingStateResponseSchema.parse(
      await responseJson(await post(tradingCommand))
    ).state).toEqual(authoritativeTrading);
    expect(store.eventCount(tradingId)).toBe(tradingCount);

    const progressedTrading = QuantTradingStateResponseSchema.parse(
      await responseJson(await post({
        protocolVersion: 1,
        type: "SUBMIT_QUANT_TRADING_ACTION",
        requestId: newRequestId(),
        sessionId: tradingId,
        expectedRound: authoritativeTrading.currentRound,
        action: { type: "PASS" }
      }))
    ).state;
    expect(progressedTrading.currentRound).toBeGreaterThan(authoritativeTrading.currentRound);
    const progressedTradingCount = store.eventCount(tradingId);
    expect(QuantTradingStateResponseSchema.parse(
      await responseJson(await post(tradingCommand))
    ).state).toEqual(authoritativeTrading);
    expect(store.eventCount(tradingId)).toBe(progressedTradingCount);

    const researchId = newSessionId();
    await expectStatus(postStart(researchId, researchConfiguration()), 200);
    const researchInitial = QuantResearchStateResponseSchema.parse(
      await responseJson(await getQuantState(researchId))
    ).state;
    const first = QuantResearchStateResponseSchema.parse(
      await responseJson(await post({
        protocolVersion: 1,
        type: "SUBMIT_QUANT_RESEARCH_ACTION",
        requestId: newRequestId(),
        sessionId: researchId,
        expectedActionCount: researchInitial.acceptedActionCount,
        action: {
          actionId: "cached-result-first",
          kind: "CHOOSE_OPTION",
          option: "CONSTANT"
        }
      }))
    ).state;
    const terminalRequestId = newRequestId();
    const terminalCommand = {
      protocolVersion: 1 as const,
      type: "SUBMIT_QUANT_RESEARCH_ACTION" as const,
      requestId: terminalRequestId,
      sessionId: researchId,
      expectedActionCount: first.acceptedActionCount,
      action: {
        actionId: "cached-result-terminal",
        kind: "CHOOSE_OPTION" as const,
        option: "CONSTANT" as const
      }
    };
    const authoritativeResearch = QuantResearchStateResponseSchema.parse(
      await responseJson(await post(terminalCommand))
    ).state;
    const researchCount = store.eventCount(researchId);
    const cached = store.getProcessedResult(researchId, terminalRequestId);
    if (!cached.found) throw new Error("Expected persisted Research RequestId result");
    const cachedOutcome = QuantResearchCoordinatorOutcomeSchema.parse(cached.result);
    const completion = cachedOutcome.state.completion;
    if (completion === undefined) throw new Error("Expected terminal Research cached completion");
    overwriteProcessedResult(store, researchId, terminalRequestId, {
      ...cachedOutcome,
      state: {
        ...cachedOutcome.state,
        completion: {
          ...completion,
          overallScore: completion.overallScore === 0 ? 1 : 0
        }
      }
    });
    expect(QuantResearchStateResponseSchema.parse(
      await responseJson(await post(terminalCommand))
    ).state).toEqual(authoritativeResearch);
    expect(store.eventCount(researchId)).toBe(researchCount);
  });

  it("admits only one of two simultaneous Trading actions bound to the same round", async () => {
    const sessionId = newSessionId();
    await expectStatus(postStart(sessionId, tradingConfiguration()), 200);
    const initial = QuantTradingStateResponseSchema.parse(
      await responseJson(await getQuantState(sessionId))
    ).state;

    const responses = await Promise.all([
      post({
        protocolVersion: 1,
        type: "SUBMIT_QUANT_TRADING_ACTION",
        requestId: newRequestId(),
        sessionId,
        expectedRound: initial.currentRound,
        action: { type: "PASS" }
      }),
      post({
        protocolVersion: 1,
        type: "SUBMIT_QUANT_TRADING_ACTION",
        requestId: newRequestId(),
        sessionId,
        expectedRound: initial.currentRound,
        action: {
          type: "QUOTE",
          quote: {
            bidPrice: initial.fairValue - 1,
            bidSize: 1,
            askPrice: initial.fairValue + 1,
            askSize: 1
          }
        }
      })
    ]);
    const decoded = await Promise.all(responses.map(async (response) => ({
      status: response.status,
      body: await responseJson(response)
    })));
    expect(decoded.map((item) => item.status).sort((left, right) => left - right))
      .toEqual([200, 409]);

    const success = decoded.find((item) => item.status === 200);
    const conflict = decoded.find((item) => item.status === 409);
    if (success === undefined || conflict === undefined) {
      throw new Error("Expected one admitted Trading action and one stale conflict");
    }
    expect(QuantTradingStateResponseSchema.parse(success.body).state.currentRound).toBe(2);
    expect(ProtocolErrorResponseSchema.parse(conflict.body).error.code).toBe("CONFLICT");
    expect(QuantTradingStateResponseSchema.parse(
      await responseJson(await getQuantState(sessionId))
    ).state.currentRound).toBe(2);
    expect(store.load(sessionId).filter((event) => event.type === "QUANT_TRADING_ACTION_ACCEPTED"))
      .toHaveLength(1);
    expect(registry.get(sessionId).getState().quantTrading?.rounds).toHaveLength(1);
  });

  it("resumes Quant Research without exposing its synthetic replay problem as an Oxford problem", async () => {
    const sessionId = newSessionId();
    await expectStatus(postStart(sessionId, researchConfiguration()), 200);
    const before = QuantResearchStateResponseSchema.parse(
      await responseJson(await getQuantState(sessionId))
    ).state;

    const resumed = SessionResumedResponseSchema.parse(
      await responseJson(await post({
        protocolVersion: 1,
        type: "RESUME_SESSION",
        requestId: newRequestId(),
        sessionId
      }))
    );
    expect(resumed.problemId).toBeUndefined();
    expect(resumed.status).toBe("ACTIVE");
    expect(QuantResearchStateResponseSchema.parse(
      await responseJson(await getQuantState(sessionId))
    ).state).toEqual(before);
  });

  it("keeps synthetic Quant problem identities out of the mode-less session inventory", async () => {
    const researchId = newSessionId();
    const tradingId = newSessionId();
    const oxfordId = newSessionId();
    await expectStatus(postStart(researchId, researchConfiguration()), 200);
    await expectStatus(postStart(tradingId, tradingConfiguration()), 200);
    await expectStatus(postStart(oxfordId, InterviewSessionConfigurationSchema.parse({
      configurationVersion: 1,
      mode: "OXFORD_MATHEMATICS",
      problem: { id: sixPeopleProblem.id, version: sixPeopleProblem.version },
      difficulty: sixPeopleProblem.interviewer.difficulty,
      interventionPolicy: "BALANCED"
    })), 200);

    const inventory = SessionsListResponseSchema.parse(await responseJson(await post({
      protocolVersion: 1,
      type: "LIST_SESSIONS",
      requestId: newRequestId()
    })));
    const byId = new Map(inventory.sessions.map((summary) => [summary.sessionId, summary]));

    expect(byId.get(researchId)?.problemId).toBeUndefined();
    expect(byId.get(researchId)?.problemVersion).toBeUndefined();
    expect(byId.get(tradingId)?.problemId).toBeUndefined();
    expect(byId.get(tradingId)?.problemVersion).toBeUndefined();
    expect(byId.get(oxfordId)?.problemId).toBe(sixPeopleProblem.id);
    expect(byId.get(oxfordId)?.problemVersion).toBe(sixPeopleProblem.version);
  });

  it("routes Quant Research structured actions through the existing deterministic coordinator with mode isolation", async () => {
    const researchSession = newSessionId();
    const tradingSession = newSessionId();
    const oxfordSession = newSessionId();
    await expectStatus(postStart(researchSession, researchConfiguration()), 200);
    await expectStatus(postStart(tradingSession, tradingConfiguration()), 200);
    await expectStatus(postStart(oxfordSession, InterviewSessionConfigurationSchema.parse({
      configurationVersion: 1,
      mode: "OXFORD_MATHEMATICS",
      problem: { id: sixPeopleProblem.id, version: sixPeopleProblem.version },
      difficulty: sixPeopleProblem.interviewer.difficulty,
      interventionPolicy: "BALANCED"
    })), 200);

    const initialResearch = QuantResearchStateResponseSchema.parse(
      await responseJson(await getQuantState(researchSession))
    ).state;
    const serialized = JSON.stringify(initialResearch);
    expect(serialized).not.toContain('"seed"');
    expect(serialized).not.toContain("gradingData");
    expect(serialized).not.toContain("generatedParameters");
    expect(initialResearch.stage).toBe("INITIAL_MODEL_CHOICE");

    await expectProtocolError(post({
      protocolVersion: 1,
      type: "SUBMIT_QUANT_TRADING_ACTION",
      requestId: newRequestId(),
      sessionId: researchSession,
      expectedRound: 1,
      action: { type: "PASS" }
    }), 409, "CONFLICT");

    await expectProtocolError(getQuantState(oxfordSession), 409, "CONFLICT");

    await expectProtocolError(post({
      protocolVersion: 1,
      type: "SUBMIT_QUANT_TRADING_ACTION",
      requestId: newRequestId(),
      sessionId: oxfordSession,
      expectedRound: 1,
      action: { type: "PASS" }
    }), 409, "CONFLICT");

    await expectProtocolError(post({
      protocolVersion: 1,
      type: "SUBMIT_QUANT_RESEARCH_ACTION",
      requestId: newRequestId(),
      sessionId: tradingSession,
      expectedActionCount: 0,
      action: { actionId: "wrong-mode", kind: "CHOOSE_OPTION", option: "CONSTANT" }
    }), 409, "CONFLICT");

    await expectProtocolError(post({
      protocolVersion: 1,
      type: "SUBMIT_QUANT_RESEARCH_ACTION",
      requestId: newRequestId(),
      sessionId: researchSession,
      expectedActionCount: initialResearch.acceptedActionCount,
      action: {
        actionId: "too-large",
        kind: "SUBMIT_PARAMETERS",
        values: Array.from({ length: 9 }, () => 0)
      }
    }), 400, "INVALID_COMMAND");

    expect(QuantResearchStateResponseSchema.parse(
      await responseJson(await getQuantState(researchSession))
    ).state).toEqual(initialResearch);

    const firstRequestId = newRequestId();
    const firstCommand = {
      protocolVersion: 1 as const,
      type: "SUBMIT_QUANT_RESEARCH_ACTION" as const,
      requestId: firstRequestId,
      sessionId: researchSession,
      expectedActionCount: initialResearch.acceptedActionCount,
      action: {
        actionId: "model-choice-1",
        kind: "CHOOSE_OPTION" as const,
        option: "CONSTANT" as const
      }
    };
    const first = QuantResearchStateResponseSchema.parse(
      await responseJson(await post(firstCommand))
    ).state;
    expect(first.stage).toBe("OUTLIER_MODEL_CHOICE");

    const countAfterFirst = store.eventCount(researchSession);
    expect(QuantResearchStateResponseSchema.parse(
      await responseJson(await post(firstCommand))
    ).state).toEqual(first);
    expect(store.eventCount(researchSession)).toBe(countAfterFirst);

    await expectProtocolError(post({
      protocolVersion: 1,
      type: "SUBMIT_QUANT_RESEARCH_ACTION",
      requestId: newRequestId(),
      sessionId: researchSession,
      expectedActionCount: initialResearch.acceptedActionCount,
      action: {
        actionId: "model-choice-stale",
        kind: "CHOOSE_OPTION",
        option: "LINEAR"
      }
    }), 409, "CONFLICT");
    expect(store.eventCount(researchSession)).toBe(countAfterFirst);

    await expectProtocolError(post({
      ...firstCommand,
      expectedActionCount: first.acceptedActionCount
    }), 409, "CONFLICT");
    expect(store.eventCount(researchSession)).toBe(countAfterFirst);

    await expectProtocolError(post({
      ...firstCommand,
      action: {
        actionId: "model-choice-conflict",
        kind: "CHOOSE_OPTION",
        option: "LINEAR"
      }
    }), 409, "CONFLICT");

    await expectProtocolError(post({
      protocolVersion: 1,
      type: "SUBMIT_QUANT_RESEARCH_ACTION",
      requestId: newRequestId(),
      sessionId: researchSession,
      expectedActionCount: first.acceptedActionCount,
      action: {
        actionId: "model-choice-1",
        kind: "CHOOSE_OPTION",
        option: "CONSTANT"
      }
    }), 409, "CONFLICT");
    expect(store.eventCount(researchSession)).toBe(countAfterFirst);

    const terminalRequestId = newRequestId();
    const terminalCommand = {
      protocolVersion: 1 as const,
      type: "SUBMIT_QUANT_RESEARCH_ACTION" as const,
      requestId: terminalRequestId,
      sessionId: researchSession,
      expectedActionCount: first.acceptedActionCount,
      action: {
        actionId: "model-choice-2",
        kind: "CHOOSE_OPTION" as const,
        option: "CONSTANT" as const
      }
    };
    const completed = QuantResearchStateResponseSchema.parse(
      await responseJson(await post(terminalCommand))
    ).state;
    expect(completed.status).toBe("COMPLETE");
    expect(completed.acceptedActionCount).toBe(2);
    expect(completed.completion?.overallScore).toEqual(expect.any(Number));
    expect(completed.completion?.evidence.length).toBeGreaterThan(0);
    const completedSerialized = JSON.stringify(completed);
    expect(completedSerialized).not.toContain('"seed"');
    expect(completedSerialized).not.toContain("gradingData");
    expect(completedSerialized).not.toContain("generatedParameters");
    expect(completedSerialized).not.toContain("hiddenModel");

    const countAfterTerminal = store.eventCount(researchSession);
    expect(QuantResearchStateResponseSchema.parse(
      await responseJson(await post(firstCommand))
    ).state).toEqual(first);
    expect(store.eventCount(researchSession)).toBe(countAfterTerminal);

    await expectProtocolError(post({
      protocolVersion: 1,
      type: "SUBMIT_QUANT_RESEARCH_ACTION",
      requestId: newRequestId(),
      sessionId: researchSession,
      expectedActionCount: completed.acceptedActionCount,
      action: {
        actionId: "model-choice-after-completion",
        kind: "CHOOSE_OPTION",
        option: "LINEAR"
      }
    }), 409, "CONFLICT");

    const tradingStillInitial = QuantTradingStateResponseSchema.parse(
      await responseJson(await getQuantState(tradingSession))
    ).state;
    expect(tradingStillInitial.currentRound).toBe(1);
    expect(tradingStillInitial.actionRequired).toBe(true);

    const researchReplay = projectSessionReplayReadModel(
      projectSessionHistory(store.load(researchSession))
    );
    expect(
      researchReplay.entries
        .filter((entry) => entry.kind === "QUANT_RESEARCH_ACTION_ACCEPTED")
        .every((entry) => entry.category === "STUDENT")
    ).toBe(true);

    const terminalEventCount = store.eventCount(researchSession);
    await restart();
    expect(QuantResearchStateResponseSchema.parse(
      await responseJson(await getQuantState(researchSession))
    ).state).toEqual(completed);
    expect(registry.get(researchSession).getState().status).toBe("COMPLETED");
    expect(QuantResearchStateResponseSchema.parse(
      await responseJson(await post(terminalCommand))
    ).state).toEqual(completed);
    expect(store.eventCount(researchSession)).toBe(terminalEventCount);
  });

  it("admits only one of two simultaneous Research actions bound to the same progress", async () => {
    const sessionId = newSessionId();
    await expectStatus(postStart(sessionId, researchConfiguration()), 200);
    const initial = QuantResearchStateResponseSchema.parse(
      await responseJson(await getQuantState(sessionId))
    ).state;

    const responses = await Promise.all([
      post({
        protocolVersion: 1,
        type: "SUBMIT_QUANT_RESEARCH_ACTION",
        requestId: newRequestId(),
        sessionId,
        expectedActionCount: initial.acceptedActionCount,
        action: {
          actionId: "concurrent-choice-left",
          kind: "CHOOSE_OPTION",
          option: "CONSTANT"
        }
      }),
      post({
        protocolVersion: 1,
        type: "SUBMIT_QUANT_RESEARCH_ACTION",
        requestId: newRequestId(),
        sessionId,
        expectedActionCount: initial.acceptedActionCount,
        action: {
          actionId: "concurrent-choice-right",
          kind: "CHOOSE_OPTION",
          option: "LINEAR"
        }
      })
    ]);
    const decoded = await Promise.all(responses.map(async (response) => ({
      status: response.status,
      body: await responseJson(response)
    })));
    expect(decoded.map((item) => item.status).sort((left, right) => left - right))
      .toEqual([200, 409]);

    const success = decoded.find((item) => item.status === 200);
    const conflict = decoded.find((item) => item.status === 409);
    if (success === undefined || conflict === undefined) {
      throw new Error("Expected one admitted Research action and one stale conflict");
    }
    expect(QuantResearchStateResponseSchema.parse(success.body).state.acceptedActionCount).toBe(1);
    expect(ProtocolErrorResponseSchema.parse(conflict.body).error.code).toBe("CONFLICT");
    expect(QuantResearchStateResponseSchema.parse(
      await responseJson(await getQuantState(sessionId))
    ).state.acceptedActionCount).toBe(1);
  });

  it("classifies schema-valid persisted Research corruption as an internal recovery failure", async () => {
    const sessionId = newSessionId();
    await expectStatus(postStart(sessionId, researchConfiguration()), 200);

    await server.stop();
    await registry.closeAll();

    const injectedRequestId = newRequestId();
    store.appendIdempotent({
      sessionId,
      requestId: injectedRequestId,
      causationId: injectedRequestId,
      correlationId: injectedRequestId,
      elapsedMs: 10,
      expectedPriorSequence: 3,
      commandFingerprint: "7".repeat(64),
      drafts: [{
        source: "USER",
        type: "QUANT_RESEARCH_ACTION_ACCEPTED",
        payload: {
          action: {
            actionId: "persisted-wrong-stage",
            kind: "CHOOSE_OPTION",
            option: "A"
          }
        }
      }],
      result: { injected: true }
    });
    const countBeforeRecovery = store.eventCount(sessionId);

    registry = new SessionRuntimeRegistry(store);
    sessions = recoveryCoordinator(registry);
    server = commandServer(sessions);
    address = await server.start();

    const response = await getQuantState(sessionId);
    expect(response.status).toBe(500);
    const error = ProtocolErrorResponseSchema.parse(await responseJson(response));
    expect(error.error.code).toBe("INTERNAL_ERROR");
    expect(error.error.message.length).toBeLessThanOrEqual(200);
    expect(store.eventCount(sessionId)).toBe(countBeforeRecovery);
  });

  it("rejects active quant archive and allows archive only after deterministic completion", async () => {
    const tradingId = newSessionId();
    const researchId = newSessionId();
    await expectStatus(postStart(tradingId, tradingConfiguration()), 200);
    await expectStatus(postStart(researchId, researchConfiguration()), 200);

    for (const sessionId of [tradingId, researchId]) {
      await expectProtocolError(post({
        protocolVersion: 1,
        type: "ARCHIVE_SESSION",
        requestId: newRequestId(),
        sessionId,
        reason: "premature"
      }), 409, "CONFLICT");
      expect(registry.get(sessionId).getState().status).toBe("ACTIVE");
    }

    let trading = QuantTradingStateResponseSchema.parse(
      await responseJson(await getQuantState(tradingId))
    ).state;
    while (trading.actionRequired) {
      trading = QuantTradingStateResponseSchema.parse(
        await responseJson(await post({
          protocolVersion: 1,
          type: "SUBMIT_QUANT_TRADING_ACTION",
          requestId: newRequestId(),
          sessionId: tradingId,
          expectedRound: trading.currentRound,
          action: { type: "PASS" }
        }))
      ).state;
    }

    let research = QuantResearchStateResponseSchema.parse(
      await responseJson(await getQuantState(researchId))
    ).state;
    for (const [actionId, option] of [
      ["archive-research-1", "CONSTANT"],
      ["archive-research-2", "CONSTANT"]
    ] as const) {
      research = QuantResearchStateResponseSchema.parse(
        await responseJson(await post({
          protocolVersion: 1,
          type: "SUBMIT_QUANT_RESEARCH_ACTION",
          requestId: newRequestId(),
          sessionId: researchId,
          expectedActionCount: research.acceptedActionCount,
          action: { actionId, kind: "CHOOSE_OPTION", option }
        }))
      ).state;
    }

    expect(trading.status).toBe("COMPLETED");
    expect(research.status).toBe("COMPLETE");
    const archiveCommands = [tradingId, researchId].map((sessionId) => ({
      sessionId,
      requestId: newRequestId()
    }));
    const archivedEventCounts = new Map<SessionId, number>();
    for (const { sessionId, requestId } of archiveCommands) {
      await expectStatus(post({
        protocolVersion: 1,
        type: "ARCHIVE_SESSION",
        requestId,
        sessionId,
        reason: "finished"
      }), 200);
      expect(registry.get(sessionId).getState().status).toBe("ARCHIVED");
      archivedEventCounts.set(sessionId, store.eventCount(sessionId));
    }

    await restart();
    expect(QuantTradingStateResponseSchema.parse(
      await responseJson(await getQuantState(tradingId))
    ).state.status).toBe("COMPLETED");
    expect(QuantResearchStateResponseSchema.parse(
      await responseJson(await getQuantState(researchId))
    ).state.status).toBe("COMPLETE");
    for (const { sessionId, requestId } of archiveCommands) {
      await expectStatus(post({
        protocolVersion: 1,
        type: "ARCHIVE_SESSION",
        requestId,
        sessionId,
        reason: "finished"
      }), 200);
      expect(store.eventCount(sessionId)).toBe(archivedEventCounts.get(sessionId));

      await expectProtocolError(post({
        protocolVersion: 1,
        type: "ARCHIVE_SESSION",
        requestId: newRequestId(),
        sessionId,
        reason: "duplicate-with-new-request"
      }), 409, "CONFLICT");
      expect(store.eventCount(sessionId)).toBe(archivedEventCounts.get(sessionId));
    }
  });

  async function restart(): Promise<void> {
    await server.stop();
    await registry.closeAll();
    registry = new SessionRuntimeRegistry(store);
    sessions = recoveryCoordinator(registry);
    server = commandServer(sessions);
    address = await server.start();
  }

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

  function getQuantState(sessionId: SessionId): Promise<Response> {
    return post({
      protocolVersion: 1,
      type: "GET_QUANT_SESSION_STATE",
      requestId: newRequestId(),
      sessionId
    });
  }

  function post(body: unknown): Promise<Response> {
    return postRaw(JSON.stringify(body));
  }

  function postRaw(body: string): Promise<Response> {
    return fetch(`${address.url}/v1/commands`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-interview-client-token": CLIENT_TOKEN,
        origin: CLIENT_ORIGIN
      },
      body
    });
  }
});

describe("adversarial persisted Trading fill semantics", () => {
  function informedFillEvidence() {
    const engine = createQuantTraderScenario({
      family: "ADVERSE_SELECTION",
      seed: 1,
      rounds: 1,
      fairValue: 100,
      tickSize: 1,
      informedTraderProbability: 1,
      noiseTraderProbability: 0
    });
    engine.submitQuote({ bidPrice: 95, bidSize: 2, askPrice: 99, askSize: 2 });
    const evidence = engine.advance();
    return QuantTradingRoundEvidenceEventSchema.parse({
      round: evidence.round,
      fairValue: evidence.fairValue,
      marketEvents: evidence.marketEvents,
      orderFlowType: evidence.orderFlowType,
      ...(evidence.incomingMarketSide === undefined
        ? {}
        : { incomingMarketSide: evidence.incomingMarketSide }),
      studentFills: evidence.studentFills,
      portfolio: evidence.portfolio,
      riskBreached: evidence.riskBreached,
      ...(evidence.riskReason === undefined ? {} : { riskReason: evidence.riskReason }),
      accountingInvariantHolds: evidence.accountingInvariantHolds,
      rngDrawCount: evidence.rngDrawCount
    });
  }

  it("rejects a persisted Trading fill whose side agrees with the incoming market order", () => {
    const evidence = informedFillEvidence();
    expect(evidence.incomingMarketSide).toBe("BUY");
    expect(evidence.studentFills).toHaveLength(1);
    const fill = evidence.studentFills[0];
    if (fill === undefined) throw new Error("Expected deterministic student fill");

    expect(QuantTradingRoundEvidenceEventSchema.safeParse({
      ...evidence,
      studentFills: [{ ...fill, side: "BUY" }]
    }).success).toBe(false);
  });

  it("rejects a persisted PASS round that reuses otherwise valid fill evidence", () => {
    const evidence = informedFillEvidence();
    const store = new SqliteEventStore(":memory:");
    const sessionId = newSessionId();
    try {
      const startRequestId = newRequestId();
      store.appendIdempotent({
        sessionId,
        requestId: startRequestId,
        causationId: startRequestId,
        correlationId: startRequestId,
        elapsedMs: 0,
        expectedPriorSequence: 0,
        commandFingerprint: "5".repeat(64),
        drafts: [
          {
            source: "APPLICATION",
            type: "SESSION_STARTED",
            payload: {
              startedAt: new Date().toISOString(),
              configuration: tradingConfiguration("ADVERSE_SELECTION")
            }
          },
          {
            source: "APPLICATION",
            type: "QUANT_TRADING_SCENARIO_INITIALIZED",
            payload: {
              definition: {
                family: "ADVERSE_SELECTION",
                version: QUANT_TRADER_SCENARIO_VERSION,
                seed: 1
              }
            }
          }
        ],
        result: { injected: true }
      });

      const roundRequestId = newRequestId();
      store.appendIdempotent({
        sessionId,
        requestId: roundRequestId,
        causationId: roundRequestId,
        correlationId: roundRequestId,
        elapsedMs: 10,
        expectedPriorSequence: 2,
        commandFingerprint: "6".repeat(64),
        drafts: [
          {
            source: "USER",
            type: "QUANT_TRADING_ACTION_ACCEPTED",
            payload: { action: { type: "PASS" } }
          },
          {
            source: "APPLICATION",
            type: "QUANT_TRADING_ROUND_RESOLVED",
            payload: { evidence }
          }
        ],
        result: { injected: true }
      });

      expect(() => SessionWriter.open(store, sessionId))
        .toThrow(/PASS action cannot produce student fills/u);
    } finally {
      store.close();
    }
  });
});

describe("adversarial quant lifecycle invariants", () => {
  it("refuses deterministic Trading completion while a speech input episode is still active", async () => {
    const store = new SqliteEventStore(":memory:");
    const sessionId = newSessionId();
    const writer = SessionWriter.open(store, sessionId);
    const trading = new QuantTradingSessionCoordinator(writer);
    const turns = new TurnCoordinator(writer);
    try {
      await trading.initializeConfigured(
        tradingConfiguration(),
        321_654,
        createCommandEnvelope({ sessionId, producer: "quant-adversarial-test" })
      );
      let state = trading.getPublicState();
      while (state.currentRound < state.plannedRounds) {
        state = (await trading.applyAction(
          { type: "PASS" },
          state.currentRound,
          createCommandEnvelope({ sessionId, producer: "quant-adversarial-test" })
        )).value;
      }
      expect(state.status).toBe("ACTIVE");

      const utteranceId = await turns.beginUtterance();
      const activeInput = await turns.finalizeUtterance({
        utteranceId,
        text: "unfinished spoken thought"
      });
      expect(writer.getState().inputEpisodes[activeInput.inputEpisodeId]?.status).toBe("ACTIVE");
      const countBeforeRejectedTerminal = store.eventCount(sessionId);

      await expect(trading.applyAction(
        { type: "PASS" },
        state.currentRound,
        createCommandEnvelope({ sessionId, producer: "quant-adversarial-test" })
      )).rejects.toThrow(/candidate input is unresolved/u);
      expect(store.eventCount(sessionId)).toBe(countBeforeRejectedTerminal);
      expect(writer.getState().quantTrading?.rounds).toHaveLength(state.plannedRounds - 1);

      await turns.commitInputEpisode(activeInput.inputEpisodeId);
      const completed = await trading.applyAction(
        { type: "PASS" },
        state.currentRound,
        createCommandEnvelope({ sessionId, producer: "quant-adversarial-test" })
      );
      expect(completed.value.status).toBe("COMPLETED");
      expect(writer.getState().status).toBe("COMPLETED");
      expect(() => projectSessionHistory(store.load(sessionId))).not.toThrow();
    } finally {
      await writer.close();
      store.close();
    }
  });

  it("refuses deterministic Trading completion while an utterance is still being captured", async () => {
    const store = new SqliteEventStore(":memory:");
    const sessionId = newSessionId();
    const writer = SessionWriter.open(store, sessionId);
    const trading = new QuantTradingSessionCoordinator(writer);
    const turns = new TurnCoordinator(writer);
    try {
      await trading.initializeConfigured(
        tradingConfiguration(),
        654_321,
        createCommandEnvelope({ sessionId, producer: "quant-adversarial-test" })
      );
      let state = trading.getPublicState();
      while (state.currentRound < state.plannedRounds) {
        state = (await trading.applyAction(
          { type: "PASS" },
          state.currentRound,
          createCommandEnvelope({ sessionId, producer: "quant-adversarial-test" })
        )).value;
      }

      const utteranceId = await turns.beginUtterance();
      expect(writer.getState().utterances[utteranceId]?.status).toBe("CAPTURING");
      const countBeforeRejectedTerminal = store.eventCount(sessionId);
      await expect(trading.applyAction(
        { type: "PASS" },
        state.currentRound,
        createCommandEnvelope({ sessionId, producer: "quant-adversarial-test" })
      )).rejects.toThrow(/candidate input is unresolved/u);
      expect(store.eventCount(sessionId)).toBe(countBeforeRejectedTerminal);
      expect(writer.getState().status).toBe("ACTIVE");

      await turns.discardUtterance(utteranceId, "terminal race cleared");
      const completed = await trading.applyAction(
        { type: "PASS" },
        state.currentRound,
        createCommandEnvelope({ sessionId, producer: "quant-adversarial-test" })
      );
      expect(completed.value.status).toBe("COMPLETED");
      expect(writer.getState().status).toBe("COMPLETED");
    } finally {
      await writer.close();
      store.close();
    }
  });

  it("refuses deterministic Research completion while a speech input episode is still active", async () => {
    const store = new SqliteEventStore(":memory:");
    const sessionId = newSessionId();
    const writer = SessionWriter.open(store, sessionId);
    const research = new QuantResearchCoordinator(writer);
    const turns = new TurnCoordinator(writer);
    try {
      await research.initializeConfigured(
        researchConfiguration(),
        createProductionQuantResearchDefinition("MODEL_COMPARISON", 777),
        createCommandEnvelope({ sessionId, producer: "quant-adversarial-test" })
      );
      await research.applyActionAtExpectedCount({
        actionId: "research-before-active-input",
        kind: "CHOOSE_OPTION",
        option: "CONSTANT"
      }, 0, createCommandEnvelope({ sessionId, producer: "quant-adversarial-test" }));

      const utteranceId = await turns.beginUtterance();
      const activeInput = await turns.finalizeUtterance({
        utteranceId,
        text: "unfinished research explanation"
      });
      const countBeforeRejectedTerminal = store.eventCount(sessionId);

      await expect(research.applyActionAtExpectedCount({
        actionId: "research-terminal-blocked",
        kind: "CHOOSE_OPTION",
        option: "CONSTANT"
      }, 1, createCommandEnvelope({
        sessionId,
        producer: "quant-adversarial-test"
      }))).rejects.toThrow(/candidate input is unresolved/u);
      expect(store.eventCount(sessionId)).toBe(countBeforeRejectedTerminal);
      expect(research.getPublicState().acceptedActionCount).toBe(1);

      await turns.commitInputEpisode(activeInput.inputEpisodeId);
      const completed = await research.applyActionAtExpectedCount({
        actionId: "research-terminal-after-input",
        kind: "CHOOSE_OPTION",
        option: "CONSTANT"
      }, 1, createCommandEnvelope({
        sessionId,
        producer: "quant-adversarial-test"
      }));
      expect(completed.value.state.status).toBe("COMPLETE");
      expect(writer.getState().status).toBe("COMPLETED");
      expect(() => projectSessionHistory(store.load(sessionId))).not.toThrow();
    } finally {
      await writer.close();
      store.close();
    }
  });

  it("refuses deterministic Research completion while an utterance is still being captured", async () => {
    const store = new SqliteEventStore(":memory:");
    const sessionId = newSessionId();
    const writer = SessionWriter.open(store, sessionId);
    const research = new QuantResearchCoordinator(writer);
    const turns = new TurnCoordinator(writer);
    try {
      await research.initializeConfigured(
        researchConfiguration(),
        createProductionQuantResearchDefinition("MODEL_COMPARISON", 888),
        createCommandEnvelope({ sessionId, producer: "quant-adversarial-test" })
      );
      await research.applyActionAtExpectedCount({
        actionId: "research-before-capturing",
        kind: "CHOOSE_OPTION",
        option: "CONSTANT"
      }, 0, createCommandEnvelope({ sessionId, producer: "quant-adversarial-test" }));

      const utteranceId = await turns.beginUtterance();
      expect(writer.getState().utterances[utteranceId]?.status).toBe("CAPTURING");
      const countBeforeRejectedTerminal = store.eventCount(sessionId);
      await expect(research.applyActionAtExpectedCount({
        actionId: "research-terminal-capturing-blocked",
        kind: "CHOOSE_OPTION",
        option: "CONSTANT"
      }, 1, createCommandEnvelope({
        sessionId,
        producer: "quant-adversarial-test"
      }))).rejects.toThrow(/candidate input is unresolved/u);
      expect(store.eventCount(sessionId)).toBe(countBeforeRejectedTerminal);
      expect(research.getPublicState().acceptedActionCount).toBe(1);

      await turns.discardUtterance(utteranceId, "terminal race cleared");
      const completed = await research.applyActionAtExpectedCount({
        actionId: "research-terminal-after-discard",
        kind: "CHOOSE_OPTION",
        option: "CONSTANT"
      }, 1, createCommandEnvelope({
        sessionId,
        producer: "quant-adversarial-test"
      }));
      expect(completed.value.state.status).toBe("COMPLETE");
      expect(writer.getState().status).toBe("COMPLETED");
    } finally {
      await writer.close();
      store.close();
    }
  });

  it("prevents new seedless quant starts while still failing legacy missing-initialization replay closed", async () => {
    const store = new SqliteEventStore(":memory:");
    try {
      for (const configuration of [tradingConfiguration(), researchConfiguration()]) {
        const rejectedSessionId = newSessionId();
        const rejectedWriter = SessionWriter.open(store, rejectedSessionId);
        try {
          await expect(new TurnCoordinator(rejectedWriter).startConfiguredSession(
            { configuration },
            createCommandEnvelope({ sessionId: rejectedSessionId, producer: "quant-adversarial-test" })
          )).rejects.toThrow(/ProductionSessionRuntime/u);
          expect(store.eventCount(rejectedSessionId)).toBe(0);
        } finally {
          await rejectedWriter.close();
        }

        const sessionId = newSessionId();
        injectLegacyUninitializedQuant(store, sessionId, configuration);
        const writer = SessionWriter.open(store, sessionId);
        try {
          expect(() => resolveSessionStateComposition(writer.getState()))
            .toThrow(/lacks authoritative scenario state/u);
          expect(() => projectSessionHistory(store.load(sessionId))).toThrow();
        } finally {
          await writer.close();
        }
      }
    } finally {
      store.close();
    }
  });

  it("rejects schema-valid deterministic Trading corruption before recovery can append", async () => {
    const store = new SqliteEventStore(":memory:");
    const sessionId = newSessionId();
    const writer = SessionWriter.open(store, sessionId);
    const seed = 424_242;
    try {
      await new QuantTradingSessionCoordinator(writer).initializeConfigured(
        tradingConfiguration(),
        seed,
        createCommandEnvelope({ sessionId, producer: "quant-corruption-test" })
      );
      await writer.close();

      const engine = createQuantTraderScenario({
        family: "BASIC_MARKET_MAKING",
        seed
      });
      engine.submitAction({ type: "PASS" });
      const round = engine.advance();
      const tamperedFairValue = round.fairValue + 1;
      const requestId = newRequestId();
      store.appendIdempotent({
        sessionId,
        requestId,
        causationId: requestId,
        correlationId: requestId,
        elapsedMs: 10,
        expectedPriorSequence: 2,
        commandFingerprint: "0".repeat(64),
        drafts: [{
          source: "USER",
          type: "QUANT_TRADING_ACTION_ACCEPTED",
          payload: { action: { type: "PASS" } }
        }, {
          source: "APPLICATION",
          type: "QUANT_TRADING_ROUND_RESOLVED",
          payload: {
            evidence: {
              round: round.round,
              fairValue: tamperedFairValue,
              marketEvents: [...round.marketEvents],
              orderFlowType: round.orderFlowType,
              ...(round.incomingMarketSide === undefined
                ? {}
                : { incomingMarketSide: round.incomingMarketSide }),
              studentFills: [...round.studentFills],
              portfolio: round.portfolio,
              riskBreached: round.riskBreached,
              ...(round.riskReason === undefined ? {} : { riskReason: round.riskReason }),
              accountingInvariantHolds: round.accountingInvariantHolds,
              rngDrawCount: round.rngDrawCount
            }
          }
        }],
        result: { injected: true }
      });
      const countBeforeRecovery = store.eventCount(sessionId);

      const registry = new SessionRuntimeRegistry(store);
      const recovery = new SessionRecoveryCoordinator(registry);
      try {
        await expect(recovery.ensureRecovered(sessionId))
          .rejects.toThrow("Authoritative quant session recovery validation failed");
        expect(store.eventCount(sessionId)).toBe(countBeforeRecovery);
      } finally {
        await registry.closeAll();
      }
    } finally {
      store.close();
    }
  });

  it("rejects forged Trading event provenance before recovery writes even when outcomes are deterministic", async () => {
    const store = new SqliteEventStore(":memory:");
    const sessionId = newSessionId();
    const seed = 434_343;
    const writer = SessionWriter.open(store, sessionId);
    try {
      await new QuantTradingSessionCoordinator(writer).initializeConfigured(
        tradingConfiguration(),
        seed,
        createCommandEnvelope({ sessionId, producer: "quant-provenance-test" })
      );
      await writer.close();

      const engine = createQuantTraderScenario({
        family: "BASIC_MARKET_MAKING",
        seed
      });
      engine.submitAction({ type: "PASS" });
      const round = engine.advance();
      const requestId = newRequestId();
      store.appendIdempotent({
        sessionId,
        requestId,
        causationId: requestId,
        correlationId: requestId,
        elapsedMs: 10,
        expectedPriorSequence: 2,
        commandFingerprint: "2".repeat(64),
        drafts: [{
          // Structurally legal EventSource, but semantically forged: candidate
          // actions must originate from USER.
          source: "APPLICATION",
          type: "QUANT_TRADING_ACTION_ACCEPTED",
          payload: { action: { type: "PASS" } }
        }, {
          source: "APPLICATION",
          type: "QUANT_TRADING_ROUND_RESOLVED",
          payload: {
            evidence: {
              round: round.round,
              fairValue: round.fairValue,
              marketEvents: [...round.marketEvents],
              orderFlowType: round.orderFlowType,
              ...(round.incomingMarketSide === undefined
                ? {}
                : { incomingMarketSide: round.incomingMarketSide }),
              studentFills: [...round.studentFills],
              portfolio: round.portfolio,
              riskBreached: round.riskBreached,
              ...(round.riskReason === undefined ? {} : { riskReason: round.riskReason }),
              accountingInvariantHolds: round.accountingInvariantHolds,
              rngDrawCount: round.rngDrawCount
            }
          }
        }],
        result: { injected: true }
      });

      const reopened = SessionWriter.open(store, sessionId);
      try {
        // Specialized deterministic replay alone accepts the outcome; recovery
        // must still reject the forged provenance layer.
        expect(() => resolveSessionStateComposition(reopened.getState())).not.toThrow();
      } finally {
        await reopened.close();
      }

      const countBeforeRecovery = store.eventCount(sessionId);
      const registry = new SessionRuntimeRegistry(store);
      const recovery = new SessionRecoveryCoordinator(registry);
      try {
        await expect(recovery.ensureRecovered(sessionId)).rejects.toThrow();
        expect(store.eventCount(sessionId)).toBe(countBeforeRecovery);
      } finally {
        await registry.closeAll();
      }
    } finally {
      store.close();
    }
  });

  it("rejects a persisted Quant completion transition after archival during replay", async () => {
    const store = new SqliteEventStore(":memory:");
    const sessionId = newSessionId();
    const writer = SessionWriter.open(store, sessionId);
    const trading = new QuantTradingSessionCoordinator(writer);
    try {
      await trading.initializeConfigured(
        tradingConfiguration(),
        8_888,
        createCommandEnvelope({ sessionId, producer: "quant-terminal-replay-test" })
      );
      let state = trading.getPublicState();
      while (state.actionRequired) {
        state = (await trading.applyAction(
          { type: "PASS" },
          state.currentRound,
          createCommandEnvelope({ sessionId, producer: "quant-terminal-replay-test" })
        )).value;
      }
      expect(writer.getState().status).toBe("COMPLETED");
      await new TurnCoordinator(writer).archiveSession(
        createCommandEnvelope({ sessionId, producer: "quant-terminal-replay-test" }),
        "terminal lifecycle monotonicity test"
      );
      expect(writer.getState().status).toBe("ARCHIVED");
      await writer.close();

      const duplicateRequestId = newRequestId();
      const priorSequence = store.eventCount(sessionId);
      store.appendIdempotent({
        sessionId,
        requestId: duplicateRequestId,
        causationId: duplicateRequestId,
        correlationId: duplicateRequestId,
        elapsedMs: 0,
        expectedPriorSequence: priorSequence,
        commandFingerprint: "8".repeat(64),
        drafts: [{
          source: "APPLICATION",
          type: "SESSION_COMPLETED",
          payload: {
            completedAt: new Date().toISOString(),
            summary: "forged duplicate completion"
          }
        }],
        result: { injected: true }
      });

      expect(() => SessionWriter.open(store, sessionId))
        .toThrow(/Quant sessions can complete only from active state/u);
    } finally {
      if (!writer.isClosed()) await writer.close();
      store.close();
    }
  });

  it("keeps legacy Quant terminal replay compatible without allowing duplicate terminal events", () => {
    for (const terminalType of ["SESSION_COMPLETED", "SESSION_ARCHIVED"] as const) {
      const store = new SqliteEventStore(":memory:");
      const sessionId = newSessionId();
      try {
        const firstRequestId = newRequestId();
        const terminalAt = new Date().toISOString();
        store.appendIdempotent({
          sessionId,
          requestId: firstRequestId,
          causationId: firstRequestId,
          correlationId: firstRequestId,
          elapsedMs: 0,
          expectedPriorSequence: 0,
          commandFingerprint: terminalType === "SESSION_COMPLETED"
            ? "a".repeat(64)
            : "b".repeat(64),
          drafts: [
            {
              source: "APPLICATION",
              type: "SESSION_STARTED",
              payload: {
                startedAt: terminalAt,
                configuration: tradingConfiguration()
              }
            },
            terminalType === "SESSION_COMPLETED"
              ? {
                  source: "APPLICATION",
                  type: "SESSION_COMPLETED",
                  payload: { completedAt: terminalAt }
                }
              : {
                  source: "APPLICATION",
                  type: "SESSION_ARCHIVED",
                  payload: { archivedAt: terminalAt }
                }
          ],
          result: { injected: true }
        });

        const duplicateRequestId = newRequestId();
        store.appendIdempotent({
          sessionId,
          requestId: duplicateRequestId,
          causationId: duplicateRequestId,
          correlationId: duplicateRequestId,
          elapsedMs: 10,
          expectedPriorSequence: 2,
          commandFingerprint: terminalType === "SESSION_COMPLETED"
            ? "c".repeat(64)
            : "d".repeat(64),
          drafts: [
            terminalType === "SESSION_COMPLETED"
              ? {
                  source: "APPLICATION",
                  type: "SESSION_COMPLETED",
                  payload: { completedAt: new Date().toISOString() }
                }
              : {
                  source: "APPLICATION",
                  type: "SESSION_ARCHIVED",
                  payload: { archivedAt: new Date().toISOString() }
                }
          ],
          result: { injected: true }
        });

        expect(() => SessionWriter.open(store, sessionId)).toThrow(
          terminalType === "SESSION_COMPLETED"
            ? /Quant sessions can complete only from active state/u
            : /Legacy Quant sessions can be archived only from active or completed state/u
        );
      } finally {
        store.close();
      }
    }
  });

  it("does not let legacy Quant completion bypass the pre-runtime active-input guard", () => {
    const store = new SqliteEventStore(":memory:");
    const sessionId = newSessionId();
    const inputEpisodeId = newInputEpisodeId();
    try {
      const requestId = newRequestId();
      const terminalAt = new Date().toISOString();
      store.appendIdempotent({
        sessionId,
        requestId,
        causationId: requestId,
        correlationId: requestId,
        elapsedMs: 0,
        expectedPriorSequence: 0,
        commandFingerprint: "e".repeat(64),
        drafts: [
          {
            source: "APPLICATION",
            type: "SESSION_STARTED",
            payload: {
              startedAt: terminalAt,
              configuration: researchConfiguration()
            }
          },
          {
            source: "USER",
            type: "INPUT_EPISODE_STARTED",
            payload: { inputEpisodeId }
          },
          {
            source: "APPLICATION",
            type: "SESSION_COMPLETED",
            payload: { completedAt: terminalAt }
          }
        ],
        result: { injected: true }
      });

      expect(() => SessionWriter.open(store, sessionId))
        .toThrow(/cannot complete with unresolved candidate input/u);
    } finally {
      store.close();
    }
  });

  it("rejects impossible Trading terminal-result cross-field combinations at the event schema", async () => {
    const store = new SqliteEventStore(":memory:");
    const sessionId = newSessionId();
    const writer = SessionWriter.open(store, sessionId);
    const trading = new QuantTradingSessionCoordinator(writer);
    try {
      await trading.initializeConfigured(
        tradingConfiguration(),
        61_616,
        createCommandEnvelope({ sessionId, producer: "quant-schema-test" })
      );
      let state = trading.getPublicState();
      while (state.actionRequired) {
        state = (await trading.applyAction(
          { type: "PASS" },
          state.currentRound,
          createCommandEnvelope({ sessionId, producer: "quant-schema-test" })
        )).value;
      }
      const result = writer.getState().quantTrading?.result;
      if (result === undefined) throw new Error("Expected persisted Trading result");
      expect(QuantTradingResultEventSchema.parse(result)).toEqual(result);

      expect(QuantTradingResultEventSchema.safeParse({
        ...result,
        completionStatus: "RISK_STOPPED",
        riskBreaches: []
      }).success).toBe(false);
      expect(QuantTradingResultEventSchema.safeParse({
        ...result,
        roundsCompleted: result.plannedRounds - 1
      }).success).toBe(false);
      expect(QuantTradingResultEventSchema.safeParse({
        ...result,
        tradeCount: result.tradeCount + 1
      }).success).toBe(false);
      expect(QuantTradingResultEventSchema.safeParse({
        ...result,
        informedFlowCount: result.roundsCompleted,
        noiseFlowCount: result.roundsCompleted
      }).success).toBe(false);
      expect(QuantTradingResultEventSchema.safeParse({
        ...result,
        riskBreaches: [{
          round: result.plannedRounds + 1,
          source: "FAIR_VALUE_UPDATE",
          reason: "forged future breach"
        }]
      }).success).toBe(false);
    } finally {
      await writer.close();
      store.close();
    }
  });

  it("rejects Research initialization that disagrees with persisted configured family", () => {
    const store = new SqliteEventStore(":memory:");
    const sessionId = newSessionId();
    try {
      const definition = createProductionQuantResearchDefinition("BAYESIAN_UPDATING", 7_777);
      const engine = new QuantResearchEngine(definition);
      const requestId = newRequestId();
      store.appendIdempotent({
        sessionId,
        requestId,
        causationId: requestId,
        correlationId: requestId,
        elapsedMs: 0,
        expectedPriorSequence: 0,
        commandFingerprint: "6".repeat(64),
        drafts: [
          {
            source: "APPLICATION",
            type: "SESSION_STARTED",
            payload: {
              startedAt: new Date().toISOString(),
              configuration: researchConfiguration("MODEL_COMPARISON")
            }
          },
          {
            source: "APPLICATION",
            type: "PROBLEM_PRESENTED",
            payload: {
              problemId: definition.family,
              problemVersion: definition.version,
              prompt: engine.getState().prompt
            }
          },
          {
            source: "APPLICATION",
            type: "QUANT_RESEARCH_SCENARIO_INITIALIZED",
            payload: {
              definition,
              authoritativeSnapshot: QuantResearchAuthoritativeSnapshotEventSchema.parse(
                engine.getAuthoritativePersistenceSnapshot()
              )
            }
          }
        ],
        result: { injected: true }
      });

      expect(() => SessionWriter.open(store, sessionId))
        .toThrow();
    } finally {
      store.close();
    }
  });

  it("rejects schema-valid Research stage corruption during recovery", async () => {
    const store = new SqliteEventStore(":memory:");
    const sessionId = newSessionId();
    const writer = SessionWriter.open(store, sessionId);
    try {
      await new QuantResearchCoordinator(writer).initializeConfigured(
        researchConfiguration(),
        createProductionQuantResearchDefinition("MODEL_COMPARISON", 515_151),
        createCommandEnvelope({ sessionId, producer: "quant-corruption-test" })
      );
      await writer.close();

      const requestId = newRequestId();
      store.appendIdempotent({
        sessionId,
        requestId,
        causationId: requestId,
        correlationId: requestId,
        elapsedMs: 10,
        expectedPriorSequence: 3,
        commandFingerprint: "1".repeat(64),
        drafts: [{
          source: "USER",
          type: "QUANT_RESEARCH_ACTION_ACCEPTED",
          payload: {
            action: {
              actionId: "schema-valid-wrong-stage",
              kind: "CHOOSE_OPTION",
              option: "A"
            }
          }
        }],
        result: { injected: true }
      });
      const countBeforeRecovery = store.eventCount(sessionId);

      const registry = new SessionRuntimeRegistry(store);
      const recovery = new SessionRecoveryCoordinator(registry);
      try {
        await expect(recovery.ensureRecovered(sessionId)).rejects.toThrow();
        expect(store.eventCount(sessionId)).toBe(countBeforeRecovery);
      } finally {
        await registry.closeAll();
      }
    } finally {
      store.close();
    }
  });

  it("rejects impossible cross-field combinations in public quant state", async () => {
    const store = new SqliteEventStore(":memory:");
    const sessionId = newSessionId();
    const writer = SessionWriter.open(store, sessionId);
    const trading = new QuantTradingSessionCoordinator(writer);
    try {
      await trading.initializeConfigured(
        tradingConfiguration(),
        919_191,
        createCommandEnvelope({ sessionId, producer: "quant-adversarial-test" })
      );
      const validTrading = trading.getPublicState();
      expect(QuantTradingPublicStateSchema.safeParse(validTrading).success).toBe(true);
      expect(QuantTradingPublicStateSchema.safeParse({
        ...validTrading,
        currentRound: validTrading.plannedRounds + 1
      }).success).toBe(false);
      expect(QuantTradingPublicStateSchema.safeParse({
        ...validTrading,
        quoteRequest: validTrading.quoteRequest === undefined
          ? undefined
          : { ...validTrading.quoteRequest, round: validTrading.currentRound + 1 }
      }).success).toBe(false);

      const validResearch = new QuantResearchEngine(
        createProductionQuantResearchDefinition("MODEL_COMPARISON", 919_191)
      ).getState();
      expect(QuantResearchPublicStateSchema.safeParse(validResearch).success).toBe(true);
      expect(QuantResearchPublicStateSchema.safeParse({
        ...validResearch,
        acceptedActionCount: 2,
        actionLimit: 1
      }).success).toBe(false);
    } finally {
      await writer.close();
      store.close();
    }
  });
});

describe("production quant start seed lifecycle", () => {
  it("invokes the Trading seed source exactly once across concurrent duplicate starts", async () => {
    const store = new SqliteEventStore(":memory:");
    const sessionId = newSessionId();
    const writer = SessionWriter.open(store, sessionId);
    let seedCalls = 0;
    const runtime = new ProductionSessionRuntime({
      seedSource: () => {
        seedCalls += 1;
        return 123_456;
      }
    });
    const composition = resolveInterviewSessionConfiguration(tradingConfiguration());
    const envelope = createCommandEnvelope({
      sessionId,
      requestId: newRequestId(),
      producer: "quant-runtime-test"
    });

    try {
      await Promise.all([
        runtime.startConfigured(writer, composition, envelope),
        runtime.startConfigured(writer, composition, envelope)
      ]);
      expect(seedCalls).toBe(1);
      const persistedSeed = writer.getState().quantTrading?.definition.seed;
      expect(persistedSeed).toBe(123_456);

      await runtime.startConfigured(writer, composition, envelope);
      expect(seedCalls).toBe(1);
      expect(writer.getState().quantTrading?.definition.seed).toBe(persistedSeed);
    } finally {
      await writer.close();
      store.close();
    }
  });

  it("does not consume another seed for a losing concurrent start with a different RequestId", async () => {
    const store = new SqliteEventStore(":memory:");
    const sessionId = newSessionId();
    const writer = SessionWriter.open(store, sessionId);
    let seedCalls = 0;
    const runtime = new ProductionSessionRuntime({
      seedSource: () => {
        seedCalls += 1;
        return 456_789;
      }
    });
    const composition = resolveInterviewSessionConfiguration(tradingConfiguration());
    try {
      const outcomes = await Promise.allSettled([
        runtime.startConfigured(writer, composition, createCommandEnvelope({
          sessionId,
          requestId: newRequestId(),
          producer: "quant-runtime-test"
        })),
        runtime.startConfigured(writer, composition, createCommandEnvelope({
          sessionId,
          requestId: newRequestId(),
          producer: "quant-runtime-test"
        }))
      ]);
      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
      expect(seedCalls).toBe(1);
      expect(writer.getState().quantTrading?.definition.seed).toBe(456_789);
    } finally {
      await writer.close();
      store.close();
    }
  });

  it("invokes the Research seed source exactly once across concurrent duplicate starts", async () => {
    const store = new SqliteEventStore(":memory:");
    const sessionId = newSessionId();
    const writer = SessionWriter.open(store, sessionId);
    let seedCalls = 0;
    const runtime = new ProductionSessionRuntime({
      seedSource: () => {
        seedCalls += 1;
        return 42;
      }
    });
    const composition = resolveInterviewSessionConfiguration(researchConfiguration());
    const envelope = createCommandEnvelope({
      sessionId,
      requestId: newRequestId(),
      producer: "quant-runtime-test"
    });
    try {
      await Promise.all([
        runtime.startConfigured(writer, composition, envelope),
        runtime.startConfigured(writer, composition, envelope)
      ]);
      expect(seedCalls).toBe(1);
      expect(writer.getState().quantResearch?.definition.seed).toEqual(expect.any(Number));
    } finally {
      await writer.close();
      store.close();
    }
  });
  it("does not consume another Research seed for a losing concurrent start with a different RequestId", async () => {
    const store = new SqliteEventStore(":memory:");
    const sessionId = newSessionId();
    const writer = SessionWriter.open(store, sessionId);
    let seedCalls = 0;
    const runtime = new ProductionSessionRuntime({
      seedSource: () => {
        seedCalls += 1;
        return 99;
      }
    });
    const composition = resolveInterviewSessionConfiguration(researchConfiguration());
    try {
      const outcomes = await Promise.allSettled([
        runtime.startConfigured(writer, composition, createCommandEnvelope({
          sessionId,
          requestId: newRequestId(),
          producer: "quant-runtime-test"
        })),
        runtime.startConfigured(writer, composition, createCommandEnvelope({
          sessionId,
          requestId: newRequestId(),
          producer: "quant-runtime-test"
        }))
      ]);
      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
      expect(seedCalls).toBe(1);
      expect(writer.getState().quantResearch?.definition.seed).toEqual(expect.any(Number));
    } finally {
      await writer.close();
      store.close();
    }
  });

});

describe("production Quant Trading public serialization", () => {
  it("keeps every advertised Trading family bounded and replayable through terminal state", async () => {
    for (const [familyIndex, family] of QuantTraderScenarioFamilySchema.options.entries()) {
      const store = new SqliteEventStore(":memory:");
      const sessionId = newSessionId();
      const writer = SessionWriter.open(store, sessionId);
      const coordinator = new QuantTradingSessionCoordinator(writer);
      try {
        await coordinator.initializeConfigured(
          tradingConfiguration(family),
          20_000 + familyIndex,
          createCommandEnvelope({ sessionId, producer: "quant-public-schema-test" })
        );

        let state = coordinator.getPublicState();
        while (state.actionRequired) {
          expect(QuantTradingPublicStateSchema.parse(state)).toEqual(state);
          const serialized = JSON.stringify(state);
          expect(serialized).not.toContain('"seed"');
          expect(serialized).not.toContain("orderFlowType");
          expect(serialized).not.toContain("incomingMarketSide");
          expect(serialized).not.toContain("counterparty");

          state = (await coordinator.applyAction(
            { type: "PASS" },
            state.currentRound,
            createCommandEnvelope({ sessionId, producer: "quant-public-schema-test" })
          )).value;
        }

        expect(QuantTradingPublicStateSchema.parse(state)).toEqual(state);
        expect(state.status === "COMPLETED" || state.status === "RISK_STOPPED").toBe(true);
        expect(writer.getState().status).toBe("COMPLETED");
        expect(replayQuantTradingSessionState(writer.getState())).toEqual(state);
      } finally {
        await writer.close();
        store.close();
      }
    }
  });
});

describe("production Quant Research public serialization", () => {
  it("keeps bounded public serialization valid through every family stage", async () => {
    const scenarios = [
      {
        family: "BAYESIAN_UPDATING",
        actions: [
          { actionId: "bayes-prior", kind: "SUBMIT_PROBABILITY", value: 0.5 },
          { actionId: "bayes-posterior", kind: "SUBMIT_PROBABILITY", value: 0.5 },
          { actionId: "bayes-perturbed", kind: "SUBMIT_PROBABILITY", value: 0.5 }
        ]
      },
      {
        family: "SAMPLING_ESTIMATION",
        actions: [
          { actionId: "sampling-observe", kind: "REQUEST_OBSERVATION", count: 2 },
          { actionId: "sampling-estimate", kind: "SUBMIT_NUMERIC_ESTIMATE", value: 0 },
          { actionId: "sampling-perturbed", kind: "SUBMIT_NUMERIC_ESTIMATE", value: 0 }
        ]
      },
      {
        family: "EXPERIMENTAL_ALLOCATION",
        actions: [
          { actionId: "experiment-allocation", kind: "ALLOCATE_SAMPLE", a: 1, b: 1 },
          { actionId: "experiment-choice", kind: "CHOOSE_OPTION", option: "A" },
          { actionId: "experiment-perturbed", kind: "ALLOCATE_SAMPLE", a: 1, b: 1 }
        ]
      },
      {
        family: "MODEL_COMPARISON",
        actions: [
          { actionId: "model-initial", kind: "CHOOSE_OPTION", option: "CONSTANT" },
          { actionId: "model-perturbed", kind: "CHOOSE_OPTION", option: "CONSTANT" }
        ]
      },
      {
        family: "CONSTRAINED_OPTIMIZATION",
        actions: [
          { actionId: "optimization-base", kind: "SUBMIT_PARAMETERS", values: [0, 0] },
          { actionId: "optimization-perturbed", kind: "SUBMIT_PARAMETERS", values: [0, 0] }
        ]
      }
    ] as const;

    for (const [scenarioIndex, scenario] of scenarios.entries()) {
      const store = new SqliteEventStore(":memory:");
      const sessionId = newSessionId();
      const writer = SessionWriter.open(store, sessionId);
      const coordinator = new QuantResearchCoordinator(writer);
      try {
        await coordinator.initializeConfigured(
          researchConfiguration(scenario.family),
          createProductionQuantResearchDefinition(scenario.family, 10_000 + scenarioIndex),
          createCommandEnvelope({ sessionId, producer: "quant-public-schema-test" })
        );
        const initial = coordinator.getPublicState();
        expect(QuantResearchPublicStateSchema.parse(initial)).toEqual(initial);

        for (const action of scenario.actions) {
          const before = coordinator.getPublicState();
          const applied = await coordinator.applyActionAtExpectedCount(
            action,
            before.acceptedActionCount,
            createCommandEnvelope({ sessionId, producer: "quant-public-schema-test" })
          );
          expect(QuantResearchPublicStateSchema.parse(applied.value.state))
            .toEqual(applied.value.state);
        }

        expect(coordinator.getPublicState().status).toBe("COMPLETE");
        expect(writer.getState().status).toBe("COMPLETED");
      } finally {
        await writer.close();
        store.close();
      }
    }
  });
});

describe("production Quant Research definition admission", () => {
  it("deterministically normalizes representative uint32 seeds to runnable scenarios for every family", () => {
    const seeds = [0, 1, 2, 3, 17, 42, 91, 0xffff_ffff];
    for (const family of QUANT_RESEARCH_FAMILIES) {
      for (const initialSeed of seeds) {
        const first = createProductionQuantResearchDefinition(family, initialSeed);
        const second = createProductionQuantResearchDefinition(family, initialSeed);
        expect(first).toEqual(second);
        expect(first.seed).toBeGreaterThanOrEqual(0);
        expect(first.seed).toBeLessThanOrEqual(0xffff_ffff);
        expect(() => new QuantResearchEngine(first)).not.toThrow();
      }
    }
  });
});

describe("Quant Trading coordinator isolation and replay determinism", () => {
  it("keeps concurrent sessions independent even with the same seed and action stream", async () => {
    const store = new SqliteEventStore(":memory:");
    const leftId = newSessionId();
    const rightId = newSessionId();
    const leftWriter = SessionWriter.open(store, leftId);
    const rightWriter = SessionWriter.open(store, rightId);
    const left = new QuantTradingSessionCoordinator(leftWriter);
    const right = new QuantTradingSessionCoordinator(rightWriter);
    const configuration = tradingConfiguration();
    const seed = 0x12_34_56_78;

    try {
      await Promise.all([
        left.initializeConfigured(configuration, seed, createCommandEnvelope({
          sessionId: leftId,
          producer: "quant-runtime-test"
        })),
        right.initializeConfigured(configuration, seed, createCommandEnvelope({
          sessionId: rightId,
          producer: "quant-runtime-test"
        }))
      ]);

      expect(left.getPublicState()).toEqual(right.getPublicState());

      await Promise.all([
        left.applyAction({ type: "PASS" }, 1, createCommandEnvelope({
          sessionId: leftId,
          producer: "quant-runtime-test"
        })),
        right.applyAction({ type: "PASS" }, 1, createCommandEnvelope({
          sessionId: rightId,
          producer: "quant-runtime-test"
        }))
      ]);
      expect(left.getPublicState()).toEqual(right.getPublicState());

      await left.applyAction({ type: "PASS" }, 2, createCommandEnvelope({
        sessionId: leftId,
        producer: "quant-runtime-test"
      }));
      expect(left.getPublicState().currentRound).toBe(3);
      expect(right.getPublicState().currentRound).toBe(2);
      expect(rightWriter.getState().quantTrading?.rounds).toHaveLength(1);
    } finally {
      await leftWriter.close();
      await rightWriter.close();
      store.close();
    }
  });

  it("rejects persisted deterministic round tampering instead of accepting changed outcomes", async () => {
    const store = new SqliteEventStore(":memory:");
    const sessionId = newSessionId();
    const writer = SessionWriter.open(store, sessionId);
    const coordinator = new QuantTradingSessionCoordinator(writer);

    try {
      await coordinator.initializeConfigured(
        tradingConfiguration(),
        123_456,
        createCommandEnvelope({ sessionId, producer: "quant-runtime-test" })
      );
      await coordinator.applyAction(
        { type: "PASS" },
        1,
        createCommandEnvelope({ sessionId, producer: "quant-runtime-test" })
      );

      const state = writer.getState();
      const firstRound = state.quantTrading?.rounds[0];
      if (firstRound === undefined || state.quantTrading === undefined) {
        throw new Error("Expected persisted Quant Trading round");
      }
      const tampered = {
        ...state,
        quantTrading: {
          ...state.quantTrading,
          rounds: [{
            ...firstRound,
            fairValue: firstRound.fairValue + 1
          }]
        }
      } as SessionState;

      expect(() => replayQuantTradingSessionState(tampered))
        .toThrow(/does not match deterministic replay/);
      expect(replayQuantTradingSessionState(state))
        .toEqual(coordinator.getPublicState());
    } finally {
      await writer.close();
      store.close();
    }
  });
});

function overwriteProcessedResult(
  store: SqliteEventStore,
  sessionId: SessionId,
  requestId: RequestId,
  result: unknown
): void {
  const database = (store as unknown as {
    readonly database: {
      prepare(sql: string): {
        run(...values: readonly unknown[]): unknown;
      };
    };
  }).database;
  database.prepare(
    "UPDATE processed_requests SET result_json = ? WHERE session_id = ? AND request_id = ?"
  ).run(JSON.stringify(result), sessionId, requestId);
}

function injectLegacyUninitializedQuant(
  store: SqliteEventStore,
  sessionId: SessionId,
  configuration: InterviewSessionConfiguration,
  syntheticProblem?: {
    readonly problemId: string;
    readonly problemVersion: string;
    readonly prompt: string;
  }
): void {
  const requestId = newRequestId();
  store.appendIdempotent({
    sessionId,
    requestId,
    causationId: requestId,
    correlationId: requestId,
    elapsedMs: 0,
    expectedPriorSequence: 0,
    commandFingerprint: "a".repeat(64),
    drafts: [{
      source: "APPLICATION",
      type: "SESSION_STARTED",
      payload: {
        startedAt: new Date().toISOString(),
        configuration
      }
    }, ...(syntheticProblem === undefined
      ? []
      : [{
          source: "APPLICATION" as const,
          type: "PROBLEM_PRESENTED" as const,
          payload: syntheticProblem
        }])],
    result: { injected: true }
  });
}

function recoveryCoordinator(registry: SessionRuntimeRegistry): SessionRecoveryCoordinator {
  const sessions = new SessionRecoveryCoordinator(registry);
  const orchestrator = new ServerTurnOrchestrator(sessions, () => undefined);
  sessions.setTurnRecoveryDelegate(orchestrator);
  return sessions;
}

function commandServer(
  sessions: SessionRecoveryCoordinator,
  productionRuntime?: ProductionSessionRuntime
): LoopbackCommandServer {
  return new LoopbackCommandServer({
    security: {
      host: "127.0.0.1",
      allowedOrigins: new Set([CLIENT_ORIGIN]),
      clientToken: CLIENT_TOKEN
    },
    sessions,
    ...(productionRuntime === undefined ? {} : { productionRuntime })
  });
}

async function responseJson(response: Response): Promise<unknown> {
  return response.json() as Promise<unknown>;
}

async function expectStatus(responsePromise: Promise<Response>, expected: number): Promise<void> {
  const response = await responsePromise;
  expect(response.status).toBe(expected);
}

async function expectProtocolError(
  responsePromise: Promise<Response>,
  status: number,
  code: "INVALID_COMMAND" | "CONFLICT" | "NOT_FOUND"
): Promise<void> {
  const response = await responsePromise;
  expect(response.status).toBe(status);
  const error = ProtocolErrorResponseSchema.parse(await responseJson(response));
  expect(error.error.code).toBe(code);
  expect(error.error.message.length).toBeLessThanOrEqual(200);
}
