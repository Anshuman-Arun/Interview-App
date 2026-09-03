import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  InterviewSessionConfigurationSchema,
  newSessionId,
  type QuantTradingCandidateAction
} from "../packages/domain/src/index.js";
import { BrowserCommandClient } from "../apps/web/src/command-client.js";
import { BrowserSessionReadClient } from "../apps/web/src/session-read-client.js";
import { QuantResearchWorkspace } from "../apps/web/src/quant/QuantResearchWorkspace.js";
import { QuantTradingWorkspace } from "../apps/web/src/quant/QuantTradingWorkspace.js";
import { createAndStartServer } from "../apps/server/src/server.js";

const TOKEN = "quant-product-e2e-token-000000000000000000000001";
const ORIGIN = "http://127.0.0.1:5173";

type StartedServer = Awaited<ReturnType<typeof createAndStartServer>>;

async function startServer(databasePath: string): Promise<StartedServer> {
  return createAndStartServer({
    host: "127.0.0.1",
    commandPort: 0,
    rendererStreamPort: 0,
    voicePort: 0,
    clientToken: TOKEN,
    allowedOrigins: [ORIGIN],
    databasePath
  });
}

function browserFetch(
  input: RequestInfo | URL,
  init: RequestInit = {}
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("origin", ORIGIN);
  return fetch(input, { ...init, headers });
}

function commandClient(server: StartedServer): BrowserCommandClient {
  return new BrowserCommandClient({
    baseUrl: server.bound.command.url,
    clientToken: TOKEN,
    fetchImpl: browserFetch
  });
}

function readClient(server: StartedServer): BrowserSessionReadClient {
  return new BrowserSessionReadClient({
    baseUrl: server.bound.command.url,
    clientToken: TOKEN,
    fetchImpl: browserFetch
  });
}

describe("Quant product real-server E2E", () => {
  it("launches, acts, restarts, recovers, completes, and reviews Trading and Research", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "quant-product-e2e-"));
    const databasePath = path.join(directory, "sessions.sqlite");
    let server: StartedServer | undefined;

    try {
      server = await startServer(databasePath);
      let commands = commandClient(server);
      let reads = readClient(server);
      const catalog = await commands.listInterviewCatalog();
      const tradingEntry = catalog.find(
        (entry) => entry.mode === "QUANT_TRADING" && entry.id === "BASIC_MARKET_MAKING"
      );
      const researchEntry = catalog.find(
        (entry) => entry.mode === "QUANT_RESEARCH" && entry.id === "MODEL_COMPARISON"
      );
      if (tradingEntry === undefined || researchEntry === undefined) {
        throw new Error("Expected production Quant catalog entries");
      }

      const tradingConfiguration = InterviewSessionConfigurationSchema.parse({
        configurationVersion: 1,
        mode: "QUANT_TRADING",
        scenario: {
          id: tradingEntry.id,
          version: tradingEntry.version
        },
        interventionPolicy: "STRICT"
      });
      const tradingSessionId = newSessionId();
      await commands.startConfiguredSession(tradingSessionId, tradingConfiguration);

      const tradingInitialResponse = await commands.getQuantSessionState(tradingSessionId);
      if (tradingInitialResponse.type !== "QUANT_TRADING_STATE") {
        throw new Error("Expected Quant Trading public state");
      }
      const tradingInitial = tradingInitialResponse.state;
      expect(tradingInitial.currentRound).toBe(1);
      expect(tradingInitial.status).toBe("ACTIVE");
      expect(tradingInitial.quoteRequest).toBeDefined();
      expect(JSON.stringify(tradingInitial)).not.toMatch(
        /seed|futureFlow|orderFlowType|incomingMarketSide|informedTrader/iu
      );

      const quoteRequest = tradingInitial.quoteRequest;
      if (quoteRequest === undefined) throw new Error("Expected first quote request");

      const eventCountBeforeForgery = server.store.eventCount(tradingSessionId);
      const forgedAction = {
        type: "PASS",
        marketOutcome: { side: "BUY", filled: true },
        futureFairValue: 999_999
      } as unknown as QuantTradingCandidateAction;
      await expect(
        commands.submitQuantTradingAction(
          tradingSessionId,
          tradingInitial.currentRound,
          forgedAction
        )
      ).rejects.toThrow();
      expect(server.store.eventCount(tradingSessionId)).toBe(eventCountBeforeForgery);

      const firstTrading = await commands.submitQuantTradingAction(
        tradingSessionId,
        tradingInitial.currentRound,
        {
          type: "QUOTE",
          quote: {
            bidPrice: quoteRequest.fairValue - quoteRequest.tickSize,
            bidSize: 1,
            askPrice: quoteRequest.fairValue + quoteRequest.tickSize,
            askSize: 1
          }
        }
      );
      expect(firstTrading.state.lastRound?.round).toBe(1);
      expect(firstTrading.state.status).toBe("ACTIVE");

      const tradingBeforeRestart = firstTrading.state;
      await server.stop();
      server = undefined;

      server = await startServer(databasePath);
      commands = commandClient(server);
      reads = readClient(server);

      const recoveredTradingResponse = await commands.getQuantSessionState(tradingSessionId);
      if (recoveredTradingResponse.type !== "QUANT_TRADING_STATE") {
        throw new Error("Expected recovered Quant Trading state");
      }
      expect(recoveredTradingResponse.state).toEqual(tradingBeforeRestart);

      let tradingState = recoveredTradingResponse.state;
      let tradingGuard = 0;
      while (tradingState.status === "ACTIVE") {
        tradingGuard += 1;
        if (tradingGuard > 256) throw new Error("Trading scenario did not terminate");
        const next = await commands.submitQuantTradingAction(
          tradingSessionId,
          tradingState.currentRound,
          { type: "PASS" }
        );
        tradingState = next.state;
      }
      expect(tradingState.status).toBe("COMPLETED");
      expect(tradingState.completion).toBeDefined();

      const tradingMarkup = renderToStaticMarkup(
        <QuantTradingWorkspace
          state={tradingState}
          loading={false}
          actionPending={false}
          disabled
          onRefresh={async () => undefined}
          onSubmit={async () => tradingState}
          onReview={() => undefined}
        />
      );
      expect(tradingMarkup).toContain("Scenario complete");
      expect(tradingMarkup).toContain("Open review");
      expect(tradingMarkup).not.toMatch(
        /seed|futureFlow|orderFlowType|incomingMarketSide|informedTrader/iu
      );
      const tradingReplay = await reads.getReplay(tradingSessionId);
      expect(tradingReplay.available).toBe(true);

      const researchConfiguration = InterviewSessionConfigurationSchema.parse({
        configurationVersion: 1,
        mode: "QUANT_RESEARCH",
        scenario: {
          id: researchEntry.id,
          version: researchEntry.version
        },
        interventionPolicy: "BALANCED"
      });
      const researchSessionId = newSessionId();
      await commands.startConfiguredSession(researchSessionId, researchConfiguration);

      const researchInitialResponse = await commands.getQuantSessionState(researchSessionId);
      if (researchInitialResponse.type !== "QUANT_RESEARCH_STATE") {
        throw new Error("Expected Quant Research public state");
      }
      expect(researchInitialResponse.state.family).toBe("MODEL_COMPARISON");
      expect(researchInitialResponse.state.stage).toBe("INITIAL_MODEL_CHOICE");
      expect(researchInitialResponse.state.acceptedActionCount).toBe(0);
      expect(JSON.stringify(researchInitialResponse.state)).not.toMatch(
        /seed|generatedParameters|gradingData|hiddenModel|canonicalAnswer/iu
      );

      const firstResearch = await commands.submitQuantResearchAction(
        researchSessionId,
        researchInitialResponse.state.acceptedActionCount,
        {
          actionId: "product_e2e_model_first",
          kind: "CHOOSE_OPTION",
          option: "CONSTANT"
        }
      );
      expect(firstResearch.state.status).toBe("IN_PROGRESS");
      expect(firstResearch.state.acceptedActionCount).toBe(1);
      const researchBeforeRestart = firstResearch.state;

      await server.stop();
      server = undefined;

      server = await startServer(databasePath);
      commands = commandClient(server);
      reads = readClient(server);

      const recoveredResearchResponse = await commands.getQuantSessionState(researchSessionId);
      if (recoveredResearchResponse.type !== "QUANT_RESEARCH_STATE") {
        throw new Error("Expected recovered Quant Research state");
      }
      expect(recoveredResearchResponse.state).toEqual(researchBeforeRestart);

      const completedResearch = await commands.submitQuantResearchAction(
        researchSessionId,
        recoveredResearchResponse.state.acceptedActionCount,
        {
          actionId: "product_e2e_model_second",
          kind: "CHOOSE_OPTION",
          option: "CONSTANT"
        }
      );
      expect(completedResearch.state.status).toBe("COMPLETE");
      expect(completedResearch.state.completion).toBeDefined();

      const researchMarkup = renderToStaticMarkup(
        <QuantResearchWorkspace
          state={completedResearch.state}
          loading={false}
          actionPending={false}
          disabled
          onRefresh={async () => undefined}
          onSubmit={async () => completedResearch.state}
          onReview={() => undefined}
        />
      );
      expect(researchMarkup).toContain("Scenario complete");
      expect(researchMarkup).toContain("Open review");
      expect(researchMarkup).not.toMatch(
        /seed|generatedParameters|gradingData|hiddenModel|canonicalAnswer/iu
      );

      const researchReplay = await reads.getReplay(researchSessionId);
      expect(researchReplay.available).toBe(true);

      const sessions = await commands.listSessions();
      expect(sessions.find((item) => item.sessionId === tradingSessionId)?.status)
        .toBe("COMPLETED");
      expect(sessions.find((item) => item.sessionId === researchSessionId)?.status)
        .toBe("COMPLETED");
    } finally {
      if (server !== undefined) await server.stop();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
