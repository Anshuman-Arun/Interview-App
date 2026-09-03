// @vitest-environment happy-dom
import fs from "node:fs";
import path from "node:path";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  InterviewSessionConfigurationSchema,
  QuantResearchPublicStateSchema,
  QuantTradingPublicStateSchema,
  newSessionId,
  type QuantTradingCandidateAction,
  type SessionId
} from "../packages/domain/src/index.js";
import {
  useInterviewSession,
  type UseInterviewSessionResult
} from "../apps/web/src/hooks/useInterviewSession.js";
import { QuantResearchWorkspace } from "../apps/web/src/quant/QuantResearchWorkspace.js";
import { QuantTradingWorkspace } from "../apps/web/src/quant/QuantTradingWorkspace.js";

const BASE_URL = "http://127.0.0.1:43123";
const RENDERER_URL = "http://127.0.0.1:43124/v1/renderer-stream";
const VOICE_URL = "http://127.0.0.1:43125";
const CLIENT_TOKEN = "quant-product-hook-token-0000000000000000000000";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function renderHook(fetchImpl: typeof fetch): {
  readonly root: Root;
  readonly container: HTMLDivElement;
  current(): UseInterviewSessionResult;
} {
  let current: UseInterviewSessionResult | undefined;
  function Probe() {
    current = useInterviewSession({
      baseUrl: BASE_URL,
      rendererStreamUrl: RENDERER_URL,
      voiceBaseUrl: VOICE_URL,
      clientToken: CLIENT_TOKEN,
      fetchImpl
    });
    return <div>{current.sessionId ?? "none"}</div>;
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(<Probe />));
  return {
    root,
    container,
    current: () => {
      if (current === undefined) throw new Error("Hook did not render");
      return current;
    }
  };
}

function portfolio(position = 0) {
  return {
    cash: 1000,
    position,
    realizedPnL: 0,
    unrealizedPnL: 0,
    totalPnL: 0,
    portfolioValue: 1000,
    averageCostBasis: 0,
    maxDrawdown: 0,
    tradeCount: 0
  };
}

function resolvedRound(round: number) {
  return {
    round,
    fairValue: 100,
    marketUpdates: [],
    fills: [],
    portfolio: portfolio(),
    riskBreached: false,
    accountingInvariantHolds: true
  };
}

function activeTradingState(round: number, plannedRounds = 3) {
  return QuantTradingPublicStateSchema.parse({
    mode: "QUANT_TRADING",
    scenario: { id: "BASIC_MARKET_MAKING", version: "1.0.0" },
    status: "ACTIVE",
    currentRound: round,
    plannedRounds,
    fairValue: 100,
    portfolio: portfolio(),
    marketUpdates: [],
    quoteRequest: {
      round,
      fairValue: 100,
      tickSize: 0.5,
      maxQuoteSize: 5,
      hardPositionLimit: true,
      maxPosition: 20
    },
    actionRequired: true,
    ...(round > 1 ? { lastRound: resolvedRound(round - 1) } : {})
  });
}

function completedTradingState(plannedRounds = 3) {
  return QuantTradingPublicStateSchema.parse({
    mode: "QUANT_TRADING",
    scenario: { id: "BASIC_MARKET_MAKING", version: "1.0.0" },
    status: "COMPLETED",
    currentRound: plannedRounds,
    plannedRounds,
    fairValue: 100,
    portfolio: portfolio(),
    marketUpdates: [],
    actionRequired: false,
    lastRound: resolvedRound(plannedRounds),
    completion: {
      completionStatus: "COMPLETED",
      plannedRounds,
      roundsCompleted: plannedRounds,
      completionRate: 1,
      tradeCount: 0,
      fillVolume: 0,
      averageSpread: 0,
      quoteParticipationRate: 1,
      riskBreachCount: 0,
      adverseSelectionPnL: 0,
      accountingInvariantHolds: true,
      objectiveScore: 82
    }
  });
}

function researchState(
  family: "BAYESIAN_UPDATING" | "SAMPLING_ESTIMATION" | "EXPERIMENTAL_ALLOCATION" | "MODEL_COMPARISON" | "CONSTRAINED_OPTIMIZATION",
  stage: string,
  acceptedActionCount: number,
  visibleData: readonly Readonly<{ key: string; label: string; value: number | string | boolean | readonly number[] | readonly string[] }>[],
  complete = false
) {
  return QuantResearchPublicStateSchema.parse({
    family,
    version: "1.0.0",
    generatorVersion: "quant-research-generator-v1",
    rngVersion: "xorshift32-rejection-v1",
    status: complete ? "COMPLETE" : "IN_PROGRESS",
    stage: complete ? "COMPLETE" : stage,
    prompt: complete ? "Scenario complete." : "Make the next structured decision.",
    visibleData,
    acceptedActionCount,
    actionLimit: 64,
    ...(complete ? {
      completion: {
        overallScore: 88,
        metrics: { ROBUSTNESS: 88 },
        evidence: [{
          category: "ROBUSTNESS",
          stage,
          score: 88,
          summary: "Public deterministic evidence summary."
        }]
      }
    } : {})
  });
}

describe("Quant product hook authority", () => {
  const originalAct: unknown = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");

  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  });

  afterEach(() => {
    if (originalAct === undefined) Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    else Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", originalAct);
    document.body.innerHTML = "";
  });

  it("binds a Trading action to the loaded round, blocks rapid duplicates, and never emits generic completion", async () => {
    const sessionId: SessionId = newSessionId();
    const configuration = InterviewSessionConfigurationSchema.parse({
      configurationVersion: 1,
      mode: "QUANT_TRADING",
      scenario: { id: "BASIC_MARKET_MAKING", version: "1.0.0" },
      interventionPolicy: "BALANCED"
    });
    const initial = activeTradingState(1);
    const advanced = activeTradingState(2);
    const terminal = completedTradingState();
    const commands: Array<Record<string, unknown>> = [];
    let submitCount = 0;
    let resolveFirstSubmit: ((response: Response) => void) | undefined;

    const fetchImpl: typeof fetch = async (input, init = {}) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === RENDERER_URL) throw new Error("Quant must not attach Oxford renderer");
      if (url !== `${BASE_URL}/v1/commands` || typeof init.body !== "string") {
        throw new Error(`Unexpected request ${url}`);
      }
      const command = JSON.parse(init.body) as Record<string, unknown>;
      commands.push(command);
      const requestId = command.requestId;
      if (typeof requestId !== "string") throw new Error("Missing request ID");
      if (command.type === "START_CONFIGURED_SESSION") {
        return jsonResponse({ protocolVersion: 1, requestId, ok: true, type: "CONFIGURED_SESSION_STARTED", sessionId, configuration });
      }
      if (command.type === "GET_INTERVIEW_SESSION_CONTEXT") {
        return jsonResponse({ protocolVersion: 1, requestId, ok: true, type: "INTERVIEW_SESSION_CONTEXT", sessionId, configuration, configurationSource: "CONFIGURED" });
      }
      if (command.type === "GET_QUANT_SESSION_STATE") {
        return jsonResponse({ protocolVersion: 1, requestId, ok: true, type: "QUANT_TRADING_STATE", sessionId, state: initial });
      }
      if (command.type === "SUBMIT_QUANT_TRADING_ACTION") {
        submitCount += 1;
        if (submitCount === 1) {
          return new Promise<Response>((resolve) => {
            resolveFirstSubmit = resolve;
          });
        }
        return jsonResponse({ protocolVersion: 1, requestId, ok: true, type: "QUANT_TRADING_STATE", sessionId, state: terminal });
      }
      throw new Error(`Unexpected command ${String(command.type)}`);
    };

    const rendered = renderHook(fetchImpl);
    await act(async () => {
      await rendered.current().startConfiguredSession(configuration, sessionId);
    });
    await act(async () => {
      await rendered.current().refreshQuantState();
    });

    const action: QuantTradingCandidateAction = {
      type: "QUOTE",
      quote: { bidPrice: 99.5, bidSize: 2, askPrice: 100.5, askSize: 2 }
    };
    let first!: Promise<unknown>;
    act(() => {
      first = rendered.current().submitQuantTradingAction(action);
    });
    await expect(rendered.current().submitQuantTradingAction({ type: "PASS" }))
      .rejects.toThrow("already awaiting authoritative admission");
    expect(submitCount).toBe(1);

    const firstCommand = commands.find((command) => command.type === "SUBMIT_QUANT_TRADING_ACTION");
    expect(firstCommand?.expectedRound).toBe(1);
    expect(firstCommand?.action).toEqual(action);
    expect(firstCommand).not.toHaveProperty("fairValue");
    expect(firstCommand).not.toHaveProperty("seed");
    expect(firstCommand).not.toHaveProperty("futureFlow");

    if (resolveFirstSubmit === undefined) throw new Error("Submit request was not observed");
    resolveFirstSubmit(jsonResponse({
      protocolVersion: 1,
      requestId: firstCommand?.requestId,
      ok: true,
      type: "QUANT_TRADING_STATE",
      sessionId,
      state: advanced
    }));
    await act(async () => {
      await first;
    });
    expect(rendered.current().quantState).toEqual({ mode: "QUANT_TRADING", state: advanced });

    await act(async () => {
      await rendered.current().submitQuantTradingAction({ type: "PASS" });
    });
    const tradingCommands = commands.filter((command) => command.type === "SUBMIT_QUANT_TRADING_ACTION");
    expect(tradingCommands).toHaveLength(2);
    expect(tradingCommands[1]?.expectedRound).toBe(2);
    expect(rendered.current().sessionStatus).toBe("COMPLETED");
    expect(rendered.current().quantState).toEqual({ mode: "QUANT_TRADING", state: terminal });
    expect(commands.some((command) => command.type === "COMPLETE_SESSION")).toBe(false);

    await act(async () => rendered.root.unmount());
    rendered.container.remove();
  });

  it("does not let a superseded public-state read overwrite an admitted Trading action", async () => {
    const sessionId: SessionId = newSessionId();
    const configuration = InterviewSessionConfigurationSchema.parse({
      configurationVersion: 1,
      mode: "QUANT_TRADING",
      scenario: { id: "BASIC_MARKET_MAKING", version: "1.0.0" },
      interventionPolicy: "BALANCED"
    });
    const round1 = activeTradingState(1);
    const round2 = activeTradingState(2);
    let readCount = 0;
    let staleReadRequestId: string | undefined;
    let resolveStaleRead: ((response: Response) => void) | undefined;

    const fetchImpl: typeof fetch = async (_input, init = {}) => {
      if (typeof init.body !== "string") throw new Error("Expected JSON command");
      const command = JSON.parse(init.body) as Record<string, unknown>;
      const requestId = command.requestId;
      if (typeof requestId !== "string") throw new Error("Missing request ID");
      if (command.type === "START_CONFIGURED_SESSION") {
        return jsonResponse({ protocolVersion: 1, requestId, ok: true, type: "CONFIGURED_SESSION_STARTED", sessionId, configuration });
      }
      if (command.type === "GET_INTERVIEW_SESSION_CONTEXT") {
        return jsonResponse({ protocolVersion: 1, requestId, ok: true, type: "INTERVIEW_SESSION_CONTEXT", sessionId, configuration, configurationSource: "CONFIGURED" });
      }
      if (command.type === "GET_QUANT_SESSION_STATE") {
        readCount += 1;
        if (readCount === 1) {
          return jsonResponse({ protocolVersion: 1, requestId, ok: true, type: "QUANT_TRADING_STATE", sessionId, state: round1 });
        }
        staleReadRequestId = requestId;
        return new Promise<Response>((resolve) => {
          resolveStaleRead = resolve;
        });
      }
      if (command.type === "SUBMIT_QUANT_TRADING_ACTION") {
        return jsonResponse({ protocolVersion: 1, requestId, ok: true, type: "QUANT_TRADING_STATE", sessionId, state: round2 });
      }
      throw new Error(`Unexpected command ${String(command.type)}`);
    };

    const rendered = renderHook(fetchImpl);
    await act(async () => {
      await rendered.current().startConfiguredSession(configuration, sessionId);
    });
    await act(async () => {
      await rendered.current().refreshQuantState();
    });

    let staleRead!: Promise<unknown>;
    act(() => {
      staleRead = rendered.current().refreshQuantState();
    });
    expect(rendered.current().quantStateLoading).toBe(true);

    await act(async () => {
      await rendered.current().submitQuantTradingAction({ type: "PASS" });
    });
    expect(rendered.current().quantState).toEqual({ mode: "QUANT_TRADING", state: round2 });
    expect(rendered.current().quantStateLoading).toBe(false);

    if (resolveStaleRead === undefined) throw new Error("Expected a held Quant read");
    resolveStaleRead(jsonResponse({
      protocolVersion: 1,
      requestId: staleReadRequestId,
      ok: true,
      type: "QUANT_TRADING_STATE",
      sessionId,
      state: round1
    }));
    await act(async () => {
      await staleRead;
    });

    expect(rendered.current().quantState).toEqual({ mode: "QUANT_TRADING", state: round2 });
    expect(rendered.current().quantStateLoading).toBe(false);

    await act(async () => rendered.root.unmount());
    rendered.container.remove();
  });

  it("refreshes stale Trading progress without resubmitting candidate intent", async () => {
    const sessionId: SessionId = newSessionId();
    const configuration = InterviewSessionConfigurationSchema.parse({
      configurationVersion: 1,
      mode: "QUANT_TRADING",
      scenario: { id: "BASIC_MARKET_MAKING", version: "1.0.0" },
      interventionPolicy: "BALANCED"
    });
    const round1 = activeTradingState(1);
    const round2 = activeTradingState(2);
    let reads = 0;
    let submits = 0;

    const fetchImpl: typeof fetch = async (_input, init = {}) => {
      if (typeof init.body !== "string") throw new Error("Expected JSON command");
      const command = JSON.parse(init.body) as Record<string, unknown>;
      const requestId = command.requestId;
      if (typeof requestId !== "string") throw new Error("Missing request ID");
      if (command.type === "START_CONFIGURED_SESSION") {
        return jsonResponse({ protocolVersion: 1, requestId, ok: true, type: "CONFIGURED_SESSION_STARTED", sessionId, configuration });
      }
      if (command.type === "GET_INTERVIEW_SESSION_CONTEXT") {
        return jsonResponse({ protocolVersion: 1, requestId, ok: true, type: "INTERVIEW_SESSION_CONTEXT", sessionId, configuration, configurationSource: "CONFIGURED" });
      }
      if (command.type === "GET_QUANT_SESSION_STATE") {
        reads += 1;
        return jsonResponse({ protocolVersion: 1, requestId, ok: true, type: "QUANT_TRADING_STATE", sessionId, state: reads === 1 ? round1 : round2 });
      }
      if (command.type === "SUBMIT_QUANT_TRADING_ACTION") {
        submits += 1;
        expect(command.expectedRound).toBe(1);
        return jsonResponse({
          protocolVersion: 1,
          ok: false,
          error: { code: "CONFLICT", message: "Quant Trading action conflicts with current scenario state" }
        }, 409);
      }
      throw new Error(`Unexpected command ${String(command.type)}`);
    };

    const rendered = renderHook(fetchImpl);
    await act(async () => {
      await rendered.current().startConfiguredSession(configuration, sessionId);
    });
    await act(async () => {
      await rendered.current().refreshQuantState();
    });
    await act(async () => {
      await expect(rendered.current().submitQuantTradingAction({ type: "PASS" })).rejects.toThrow();
    });

    expect(submits).toBe(1);
    expect(reads).toBe(2);
    expect(rendered.current().quantState).toEqual({ mode: "QUANT_TRADING", state: round2 });
    expect(rendered.current().error).toContain("conflicts with the current scenario state");

    await act(async () => rendered.root.unmount());
    rendered.container.remove();
  });

  it("binds Research actions to acceptedActionCount and terminal state without client completion", async () => {
    const sessionId: SessionId = newSessionId();
    const configuration = InterviewSessionConfigurationSchema.parse({
      configurationVersion: 1,
      mode: "QUANT_RESEARCH",
      scenario: { id: "MODEL_COMPARISON", version: "1.0.0" },
      interventionPolicy: "BALANCED"
    });
    const initial = researchState(
      "MODEL_COMPARISON",
      "INITIAL_MODEL_CHOICE",
      0,
      [
        { key: "x", label: "x observations", value: [0, 1] },
        { key: "y", label: "y observations", value: [2, 4] }
      ]
    );
    const terminal = researchState(
      "MODEL_COMPARISON",
      "OUTLIER_MODEL_CHOICE",
      2,
      [
        { key: "x", label: "x observations", value: [0, 1] },
        { key: "y", label: "Perturbed y observations", value: [2, 20] }
      ],
      true
    );
    const commands: Array<Record<string, unknown>> = [];

    const fetchImpl: typeof fetch = async (_input, init = {}) => {
      if (typeof init.body !== "string") throw new Error("Expected JSON command");
      const command = JSON.parse(init.body) as Record<string, unknown>;
      commands.push(command);
      const requestId = command.requestId;
      if (typeof requestId !== "string") throw new Error("Missing request ID");
      if (command.type === "START_CONFIGURED_SESSION") {
        return jsonResponse({ protocolVersion: 1, requestId, ok: true, type: "CONFIGURED_SESSION_STARTED", sessionId, configuration });
      }
      if (command.type === "GET_INTERVIEW_SESSION_CONTEXT") {
        return jsonResponse({ protocolVersion: 1, requestId, ok: true, type: "INTERVIEW_SESSION_CONTEXT", sessionId, configuration, configurationSource: "CONFIGURED" });
      }
      if (command.type === "GET_QUANT_SESSION_STATE") {
        return jsonResponse({ protocolVersion: 1, requestId, ok: true, type: "QUANT_RESEARCH_STATE", sessionId, state: initial });
      }
      if (command.type === "SUBMIT_QUANT_RESEARCH_ACTION") {
        return jsonResponse({ protocolVersion: 1, requestId, ok: true, type: "QUANT_RESEARCH_STATE", sessionId, state: terminal });
      }
      throw new Error(`Unexpected command ${String(command.type)}`);
    };

    const rendered = renderHook(fetchImpl);
    await act(async () => {
      await rendered.current().startConfiguredSession(configuration, sessionId);
    });
    await act(async () => {
      await rendered.current().refreshQuantState();
    });
    await act(async () => {
      await rendered.current().submitQuantResearchAction({
        actionId: "model_choice_1",
        kind: "CHOOSE_OPTION",
        option: "LINEAR"
      });
    });

    const submitted = commands.find((command) => command.type === "SUBMIT_QUANT_RESEARCH_ACTION");
    expect(submitted?.expectedActionCount).toBe(0);
    expect(submitted?.action).toEqual({
      actionId: "model_choice_1",
      kind: "CHOOSE_OPTION",
      option: "LINEAR"
    });
    expect(rendered.current().sessionStatus).toBe("COMPLETED");
    expect(rendered.current().quantState).toEqual({ mode: "QUANT_RESEARCH", state: terminal });
    expect(commands.some((command) => command.type === "COMPLETE_SESSION")).toBe(false);

    await act(async () => rendered.root.unmount());
    rendered.container.remove();
  });
});

describe("Quant workspace lifecycle source invariants", () => {
  it("defers a skipped authoritative refresh until an in-flight action settles", () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), "apps/web/src/quant/QuantSessionWorkspace.tsx"),
      "utf8"
    );

    expect(source).toContain("const deferredRefreshRef = useRef(false)");
    expect(source).toContain("deferredRefreshRef.current = true");
    expect(source).toContain("!deferredRefreshRef.current");
    expect(source).toContain("quantActionPending");
    expect(source).toContain("void onRefresh().catch(() => undefined)");
  });
});

describe("Quant workspace public rendering", () => {
  it("renders rapid-entry Trading controls from public state without hidden engine fields", () => {
    const markup = renderToStaticMarkup(
      <QuantTradingWorkspace
        state={activeTradingState(1)}
        loading={false}
        actionPending={false}
        disabled={false}
        onRefresh={async () => undefined}
        onSubmit={async () => activeTradingState(2)}
        onReview={() => undefined}
      />
    );

    expect(markup).toContain("Submit quote");
    expect(markup).toContain("Public fair value");
    expect(markup).toContain("position limit");
    expect(markup).toContain('inputMode="decimal"');
    expect(markup).not.toContain('type="number"');
    expect(markup).not.toContain("seed");
    expect(markup).not.toContain("futureFlow");
    expect(markup).not.toContain("informedTrader");
  });

  it("uses exact structured controls for every registered Research family", () => {
    const cases = [
      {
        state: researchState("BAYESIAN_UPDATING", "PRIOR_ESTIMATE", 0, [
          { key: "priorAlpha", label: "Prior alpha", value: 2 },
          { key: "priorBeta", label: "Prior beta", value: 3 }
        ]),
        expected: "Probability"
      },
      {
        state: researchState("SAMPLING_ESTIMATION", "SAMPLING", 0, [
          { key: "maxSamples", label: "Maximum observation budget", value: 10 },
          { key: "observations", label: "Revealed observations", value: [] }
        ]),
        expected: "Request observations"
      },
      {
        state: researchState("EXPERIMENTAL_ALLOCATION", "INITIAL_ALLOCATION", 0, [
          { key: "totalBudget", label: "Total sample budget", value: 20 }
        ]),
        expected: "Samples A"
      },
      {
        state: researchState("MODEL_COMPARISON", "INITIAL_MODEL_CHOICE", 0, [
          { key: "x", label: "x observations", value: [0, 1] },
          { key: "y", label: "y observations", value: [2, 4] }
        ]),
        expected: "Linear trend"
      },
      {
        state: researchState("CONSTRAINED_OPTIMIZATION", "BASE_OPTIMIZATION", 0, [
          { key: "objective", label: "Current objective", value: "4*x + 5*y" }
        ]),
        expected: ">x<"
      }
    ] as const;

    for (const item of cases) {
      const markup = renderToStaticMarkup(
        <QuantResearchWorkspace
          state={item.state}
          loading={false}
          actionPending={false}
          disabled={false}
          onRefresh={async () => undefined}
          onSubmit={async () => item.state}
          onReview={() => undefined}
        />
      );
      expect(markup).toContain(item.expected);
      expect(markup).not.toContain("generatedParameters");
      expect(markup).not.toContain("gradingData");
      expect(markup).not.toContain("hiddenModel");
      expect(markup).not.toContain("seed");
    }
  });

  it("renders only deterministic public Research completion evidence", () => {
    const terminal = researchState(
      "MODEL_COMPARISON",
      "OUTLIER_MODEL_CHOICE",
      2,
      [{ key: "outlierIntroduced", label: "Outlier introduced", value: true }],
      true
    );
    const markup = renderToStaticMarkup(
      <QuantResearchWorkspace
        state={terminal}
        loading={false}
        actionPending={false}
        disabled
        onRefresh={async () => undefined}
        onSubmit={async () => terminal}
        onReview={() => undefined}
      />
    );

    expect(markup).toContain("88");
    expect(markup).toContain("Public deterministic evidence summary.");
    expect(markup).not.toContain("canonical");
    expect(markup).not.toContain("latent");
    expect(markup).not.toContain("seed");
  });
});
