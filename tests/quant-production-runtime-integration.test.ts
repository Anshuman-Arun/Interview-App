import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  InterviewSessionConfigurationSchema,
  ProtocolErrorResponseSchema,
  QuantResearchPublicStateSchema,
  QuantResearchStateResponseSchema,
  QuantTradingPublicStateSchema,
  QuantTradingStateResponseSchema,
  newRequestId,
  newSessionId,
  type InterviewSessionConfiguration,
  type SessionId
} from "../packages/domain/src/index.js";
import type { SessionState } from "../packages/events/src/index.js";
import {
  QuantResearchCoordinator,
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
  createProductionQuantResearchDefinition
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

function researchConfiguration(): Extract<InterviewSessionConfiguration, { readonly mode: "QUANT_RESEARCH" }> {
  const parsed = InterviewSessionConfigurationSchema.parse({
    configurationVersion: 1,
    mode: "QUANT_RESEARCH",
    scenario: {
      id: "MODEL_COMPARISON",
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

  it("rejects an unsupported configured Quant Trading scenario version before session authority is created", async () => {
    const sessionId = newSessionId();
    const configuration = {
      configurationVersion: 1,
      mode: "QUANT_TRADING",
      scenario: {
        id: "BASIC_MARKET_MAKING",
        version: "0.0.0"
      },
      interventionPolicy: "STRICT"
    };
    await expectProtocolError(postStart(
      sessionId,
      configuration as InterviewSessionConfiguration
    ), 404, "NOT_FOUND");
    expect(registry.hasSession(sessionId)).toBe(false);
    expect(store.eventCount(sessionId)).toBe(0);
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
    while (state.actionRequired) {
      state = QuantTradingStateResponseSchema.parse(
        await responseJson(await post({
          protocolVersion: 1,
          type: "SUBMIT_QUANT_TRADING_ACTION",
          requestId: newRequestId(),
          sessionId,
          expectedRound: state.currentRound,
          action: { type: "PASS" }
        }))
      ).state;
    }

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

    await restart();
    const recoveredTerminal = QuantTradingStateResponseSchema.parse(
      await responseJson(await getQuantState(sessionId))
    ).state;
    expect(recoveredTerminal).toEqual(state);
    expect(registry.get(sessionId).getState().status).toBe("COMPLETED");
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
      action: {
        actionId: "model-choice-conflict",
        kind: "CHOOSE_OPTION",
        option: "LINEAR"
      }
    }), 409, "CONFLICT");

    const completed = QuantResearchStateResponseSchema.parse(
      await responseJson(await post({
        protocolVersion: 1,
        type: "SUBMIT_QUANT_RESEARCH_ACTION",
        requestId: newRequestId(),
        sessionId: researchSession,
        expectedActionCount: first.acceptedActionCount,
        action: {
          actionId: "model-choice-2",
          kind: "CHOOSE_OPTION",
          option: "CONSTANT"
        }
      }))
    ).state;
    expect(completed.status).toBe("COMPLETE");
    expect(completed.acceptedActionCount).toBe(2);

    const tradingStillInitial = QuantTradingStateResponseSchema.parse(
      await responseJson(await getQuantState(tradingSession))
    ).state;
    expect(tradingStillInitial.currentRound).toBe(1);
    expect(tradingStillInitial.actionRequired).toBe(true);

    await restart();
    expect(QuantResearchStateResponseSchema.parse(
      await responseJson(await getQuantState(researchSession))
    ).state).toEqual(completed);
    expect(registry.get(researchSession).getState().status).toBe("COMPLETED");
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
    for (const sessionId of [tradingId, researchId]) {
      await expectStatus(post({
        protocolVersion: 1,
        type: "ARCHIVE_SESSION",
        requestId: newRequestId(),
        sessionId,
        reason: "finished"
      }), 200);
      expect(registry.get(sessionId).getState().status).toBe("ARCHIVED");
    }

    await restart();
    expect(QuantTradingStateResponseSchema.parse(
      await responseJson(await getQuantState(tradingId))
    ).state.status).toBe("COMPLETED");
    expect(QuantResearchStateResponseSchema.parse(
      await responseJson(await getQuantState(researchId))
    ).state.status).toBe("COMPLETE");
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
      )).rejects.toThrow(/input episode is active/u);
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
      }))).rejects.toThrow(/input episode is active/u);
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

  it("fails recovery and complete replay for configured quant streams missing deterministic initialization", async () => {
    const store = new SqliteEventStore(":memory:");
    try {
      for (const configuration of [tradingConfiguration(), researchConfiguration()]) {
        const sessionId = newSessionId();
        const writer = SessionWriter.open(store, sessionId);
        try {
          await new TurnCoordinator(writer).startConfiguredSession(
            { configuration },
            createCommandEnvelope({ sessionId, producer: "quant-adversarial-test" })
          );
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
