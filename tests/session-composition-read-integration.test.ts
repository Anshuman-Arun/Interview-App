import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  InterviewSessionConfigurationSchema,
  newSessionId,
  type SessionId
} from "../packages/domain/src/index.js";
import {
  QuantResearchCoordinator,
  QuantTradingSessionCoordinator,
  TurnCoordinator,
  createCommandEnvelope
} from "../packages/interview-engine/src/index.js";
import {
  QUANT_RESEARCH_VERSION,
  QUANT_TRADER_SCENARIO_VERSION
} from "../packages/local-compute/src/index.js";
import { getProblemByIdentity } from "../packages/problems/src/index.js";
import { createAndStartServer } from "../apps/server/src/server.js";
import { BrowserCommandClient } from "../apps/web/src/command-client.js";
import { BrowserSessionReadClient } from "../apps/web/src/session-read-client.js";

const TOKEN = "session_composition_read_integration_token_00000001";
const ORIGIN = "http://127.0.0.1:5173";

function authenticatedFetch(): typeof fetch {
  return async (input, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set("Origin", ORIGIN);
    return fetch(input, { ...init, headers });
  };
}

describe("generic session composition + grounded product reads", () => {
  let server: Awaited<ReturnType<typeof createAndStartServer>> | undefined;
  let tempDir = "";

  afterEach(async () => {
    if (server !== undefined) {
      await server.stop();
      server = undefined;
    }
    if (tempDir !== "" && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = "";
    }
  });

  it("evaluates and replays a configured non-Ramsey Oxford problem from exact provenance after restart", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "configured-read-integration-"));
    const databasePath = path.join(tempDir, "interview.sqlite");
    const problem = getProblemByIdentity("oxford-divisibility-chain", "1.0.0");
    expect(problem).toBeDefined();
    if (problem === undefined) return;

    server = await createAndStartServer({
      host: "127.0.0.1",
      commandPort: 0,
      rendererStreamPort: 0,
      clientToken: TOKEN,
      allowedOrigins: [ORIGIN],
      databasePath
    });
    const command = new BrowserCommandClient({
      baseUrl: server.bound.command.url,
      clientToken: TOKEN,
      fetchImpl: authenticatedFetch()
    });
    const reads = new BrowserSessionReadClient({
      baseUrl: server.bound.command.url,
      clientToken: TOKEN,
      fetchImpl: authenticatedFetch()
    });

    const sessionId: SessionId = newSessionId();
    const configuration = InterviewSessionConfigurationSchema.parse({
      configurationVersion: 1,
      mode: "OXFORD_MATHEMATICS",
      problem: {
        id: problem.id,
        version: problem.version
      },
      difficulty: problem.interviewer.difficulty,
      interventionPolicy: "BALANCED"
    });
    const started = await command.startConfiguredSession(sessionId, configuration);
    expect(started.problem).toMatchObject({
      id: problem.id,
      version: problem.version,
      prompt: problem.public.prompt
    });
    expect(JSON.stringify(started.problem)).not.toContain("canonicalSolution");
    expect(JSON.stringify(started.problem)).not.toContain("reasoningGraph");
    expect(JSON.stringify(started.problem)).not.toContain("protectedDisclosures");

    const writer = server.registry.get(sessionId);
    const turns = new TurnCoordinator(writer);
    await turns.commitInput(
      "The ordered divisibility chain forces a comparable pair, and the larger selected value is a multiple of the smaller."
    );
    const supportEventId = writer.getState().eventIds.at(-1);
    if (supportEventId === undefined) throw new Error("Expected committed turn provenance");

    for (const [dimension, proposedValue] of [
      ["CORRECTNESS", "CORRECT"],
      ["JUSTIFICATION", "JUSTIFIED"]
    ] as const) {
      const admitted = await turns.processEvidenceProposal({
        envelope: createCommandEnvelope({
          sessionId,
          producer: "composition-read-integration"
        }),
        proposal: {
          key: {
            problemId: problem.id,
            subject: { kind: "CLAIM", claimId: "divisibility-integration-claim" },
            dimension
          },
          proposedValue,
          inferenceConfidence: 0.95,
          evidenceEventIds: [supportEventId]
        }
      });
      expect(admitted.committed).toBe(true);
    }

    await command.completeSession(sessionId);
    const eventCount = server.store.eventCount(sessionId);

    const evaluation = await reads.getEvaluation(sessionId);
    const replay = await reads.getReplay(sessionId);
    const history = await reads.getHistory();
    expect(evaluation.available).toBe(true);
    if (evaluation.available) {
      expect(evaluation.evaluation.problemId).toBe(problem.id);
      expect(evaluation.evaluation.problemVersion).toBe(problem.version);
    }
    expect(replay.available).toBe(true);
    if (replay.available) {
      expect(replay.replay.problem).toEqual({
        problemId: problem.id,
        problemVersion: problem.version
      });
    }
    expect(history.sessions.find((entry) => entry.sessionId === sessionId))
      .toMatchObject({
        problemId: problem.id,
        problemVersion: problem.version,
        status: "COMPLETED",
        readStatus: "AVAILABLE"
      });
    expect(server.store.eventCount(sessionId)).toBe(eventCount);

    await server.stop();
    server = undefined;

    server = await createAndStartServer({
      host: "127.0.0.1",
      commandPort: 0,
      rendererStreamPort: 0,
      clientToken: TOKEN,
      allowedOrigins: [ORIGIN],
      databasePath
    });
    const reopenedReads = new BrowserSessionReadClient({
      baseUrl: server.bound.command.url,
      clientToken: TOKEN,
      fetchImpl: authenticatedFetch()
    });

    const reopenedEvaluation = await reopenedReads.getEvaluation(sessionId);
    const reopenedReplay = await reopenedReads.getReplay(sessionId);
    expect(reopenedEvaluation.available).toBe(true);
    if (reopenedEvaluation.available) {
      expect(reopenedEvaluation.evaluation.problemId).toBe(problem.id);
      expect(reopenedEvaluation.evaluation.problemVersion).toBe(problem.version);
    }
    expect(reopenedReplay.available).toBe(true);
    expect(server.store.eventCount(sessionId)).toBe(eventCount);
  });

  it("keeps Quant Trading and Quant Research readable without coercing them through Oxford evaluation", async () => {
    server = await createAndStartServer({
      host: "127.0.0.1",
      commandPort: 0,
      rendererStreamPort: 0,
      clientToken: TOKEN,
      allowedOrigins: [ORIGIN],
      databasePath: ":memory:"
    });
    const command = new BrowserCommandClient({
      baseUrl: server.bound.command.url,
      clientToken: TOKEN,
      fetchImpl: authenticatedFetch()
    });
    const reads = new BrowserSessionReadClient({
      baseUrl: server.bound.command.url,
      clientToken: TOKEN,
      fetchImpl: authenticatedFetch()
    });

    const tradingId = newSessionId();
    const tradingConfiguration = InterviewSessionConfigurationSchema.parse({
      configurationVersion: 1,
      mode: "QUANT_TRADING",
      scenario: {
        id: "BASIC_MARKET_MAKING",
        version: QUANT_TRADER_SCENARIO_VERSION
      },
      interventionPolicy: "STRICT"
    });
    const tradingStarted = await command.startConfiguredSession(
      tradingId,
      tradingConfiguration
    );
    expect(tradingStarted.problem).toBeUndefined();
    const trading = new QuantTradingSessionCoordinator(server.registry.get(tradingId));
    let tradingState = trading.getPublicState();
    while (tradingState.actionRequired) {
      tradingState = (await trading.applyAction(
        { type: "PASS" },
        tradingState.currentRound,
        createCommandEnvelope({
          sessionId: tradingId,
          producer: "composition-read-integration"
        })
      )).value;
    }
    expect(tradingState.status).toBe("COMPLETED");

    const researchId = newSessionId();
    const researchConfiguration = InterviewSessionConfigurationSchema.parse({
      configurationVersion: 1,
      mode: "QUANT_RESEARCH",
      scenario: {
        id: "MODEL_COMPARISON",
        version: QUANT_RESEARCH_VERSION
      },
      interventionPolicy: "BALANCED"
    });
    const researchStarted = await command.startConfiguredSession(
      researchId,
      researchConfiguration
    );
    expect(researchStarted.problem).toBeUndefined();

    const research = new QuantResearchCoordinator(server.registry.get(researchId));
    expect(research.getPublicState().stage).toBe("INITIAL_MODEL_CHOICE");
    await research.applyAction({
      actionId: "composition-model-choice-base",
      kind: "CHOOSE_OPTION",
      option: "CONSTANT"
    }, createCommandEnvelope({
      sessionId: researchId,
      producer: "composition-read-integration"
    }));
    const completedResearch = await research.applyAction({
      actionId: "composition-model-choice-perturbed",
      kind: "CHOOSE_OPTION",
      option: "CONSTANT"
    }, createCommandEnvelope({
      sessionId: researchId,
      producer: "composition-read-integration"
    }));
    expect(completedResearch.value.state.status).toBe("COMPLETE");

    const tradingCount = server.store.eventCount(tradingId);
    const researchCount = server.store.eventCount(researchId);
    const [tradingEvaluation, researchEvaluation, tradingReplay, researchReplay, history] =
      await Promise.all([
        reads.getEvaluation(tradingId),
        reads.getEvaluation(researchId),
        reads.getReplay(tradingId),
        reads.getReplay(researchId),
        reads.getHistory()
      ]);

    expect(tradingEvaluation).toMatchObject({
      available: false,
      reason: "EXACT_PROBLEM_UNAVAILABLE"
    });
    expect(researchEvaluation).toMatchObject({
      available: false,
      reason: "EXACT_PROBLEM_UNAVAILABLE"
    });
    expect(tradingReplay.available).toBe(true);
    expect(researchReplay.available).toBe(true);
    if (tradingReplay.available) {
      expect(tradingReplay.replay.problem).toBeUndefined();
    }
    if (researchReplay.available) {
      expect(researchReplay.replay.problem).toBeUndefined();
    }

    const tradingHistory = history.sessions.find(
      (entry) => entry.sessionId === tradingId
    );
    const researchHistory = history.sessions.find(
      (entry) => entry.sessionId === researchId
    );
    expect(tradingHistory).toMatchObject({
      status: "COMPLETED",
      readStatus: "AVAILABLE"
    });
    expect(researchHistory).toMatchObject({
      status: "COMPLETED",
      readStatus: "AVAILABLE"
    });
    expect(researchHistory?.problemId).toBeUndefined();
    expect(researchHistory?.problemVersion).toBeUndefined();
    expect(history.longitudinal.includedSessionCount).toBe(0);
    expect(history.longitudinal.sessionTruncation.remainingCount).toBe(2);
    expect(server.store.eventCount(tradingId)).toBe(tradingCount);
    expect(server.store.eventCount(researchId)).toBe(researchCount);
  });
});
