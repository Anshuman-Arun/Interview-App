import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  InterviewSessionConfigurationSchema,
  OxfordInterviewSessionConfigurationSchema,
  newSessionId
} from "../packages/domain/src/index.js";
import {
  QUANT_RESEARCH_VERSION,
  QUANT_TRADER_SCENARIO_VERSION
} from "../packages/local-compute/src/index.js";
import {
  QuantResearchCoordinator,
  QuantTradingSessionCoordinator,
  TurnCoordinator,
  createCommandEnvelope
} from "../packages/interview-engine/src/index.js";
import { getProblemByIdentity } from "../packages/problems/src/index.js";
import { BrowserCommandClient } from "../apps/web/src/command-client.js";
import { BrowserSessionReadClient } from "../apps/web/src/session-read-client.js";
import { createAndStartServer } from "../apps/server/src/server.js";

const TOKEN = "configured-read-integration-token-0000000000000001";
const ORIGIN = "http://127.0.0.1:5173";

type StartedServer = Awaited<ReturnType<typeof createAndStartServer>>;

interface StoreWithDatabase {
  readonly database: DatabaseSync;
}

describe("configured session product-read integration", () => {
  it("evaluates and replays an exact non-Ramsey Oxford session read-only across restart", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "configured-read-"));
    const databasePath = path.join(directory, "session.sqlite");
    let server: StartedServer | undefined;

    try {
      server = await startServer(databasePath);
      const command = commandClient(server);
      const reads = readClient(server);

      const problem = getProblemByIdentity("oxford-divisibility-chain", "1.0.0");
      if (problem === undefined) throw new Error("Expected curated divisibility problem");
      const configuration = OxfordInterviewSessionConfigurationSchema.parse({
        configurationVersion: 1,
        mode: "OXFORD_MATHEMATICS",
        problem: { id: problem.id, version: problem.version },
        difficulty: problem.interviewer.difficulty,
        interventionPolicy: "BALANCED"
      });
      const sessionId = newSessionId();

      const started = await command.startConfiguredSession(sessionId, configuration);
      expect(started.configuration).toEqual(configuration);
      expect(started.problem).toMatchObject({
        id: problem.id,
        version: problem.version,
        prompt: problem.public.prompt
      });
      expect(JSON.stringify(started.problem)).not.toContain(problem.private.canonicalSolution);
      expect(JSON.stringify(started.problem)).not.toContain("reasoningGraph");

      const writer = server.registry.get(sessionId);
      const turns = new TurnCoordinator(writer);
      await turns.commitInput(
        "Assume no chosen number divides another; pairing each chosen value with its double creates the contradiction."
      );
      const supportingEvent = writer.getState().eventIds.at(-1);
      if (supportingEvent === undefined) throw new Error("Expected committed turn provenance");

      for (const [dimension, proposedValue] of [
        ["CORRECTNESS", "CORRECT"],
        ["JUSTIFICATION", "JUSTIFIED"]
      ] as const) {
        const result = await turns.processEvidenceProposal({
          envelope: createCommandEnvelope({
            sessionId,
            producer: "configured-read-integration-test"
          }),
          proposal: {
            key: {
              problemId: problem.id,
              subject: { kind: "CLAIM", claimId: "configured-divisibility-claim" },
              dimension
            },
            proposedValue,
            inferenceConfidence: 0.95,
            evidenceEventIds: [supportingEvent]
          }
        });
        expect(result.committed).toBe(true);
      }

      await command.completeSession(sessionId);
      const beforeReads = server.store.eventCount(sessionId);
      const evaluation = await reads.getEvaluation(sessionId);
      const replay = await reads.getReplay(sessionId);
      const history = await reads.getHistory();

      expect(evaluation.available).toBe(true);
      if (evaluation.available) {
        expect(evaluation.evaluation.problemId).toBe(problem.id);
        expect(evaluation.evaluation.problemVersion).toBe(problem.version);
        expect(
          evaluation.evaluation.dimensions.find(
            (dimension) => dimension.name === "technicalCorrectness"
          )?.score
        ).toBe(100);
      }
      expect(replay.available).toBe(true);
      if (replay.available) {
        expect(replay.replay.problem).toEqual({
          problemId: problem.id,
          problemVersion: problem.version
        });
      }
      expect(history.sessions.find((item) => item.sessionId === sessionId)).toMatchObject({
        problemId: problem.id,
        problemVersion: problem.version,
        status: "COMPLETED",
        readStatus: "AVAILABLE"
      });
      expect(server.store.eventCount(sessionId)).toBe(beforeReads);

      const serializedReads = JSON.stringify({ evaluation, replay, history });
      expect(serializedReads).not.toContain(problem.private.canonicalSolution);
      expect(serializedReads).not.toContain("reasoningGraph");

      await server.stop();
      server = undefined;

      server = await startServer(databasePath);
      const restartedReads = readClient(server);
      const beforeRestartReads = server.store.eventCount(sessionId);
      const restartedEvaluation = await restartedReads.getEvaluation(sessionId);
      const restartedReplay = await restartedReads.getReplay(sessionId);

      expect(restartedEvaluation.available).toBe(true);
      if (restartedEvaluation.available) {
        expect(restartedEvaluation.evaluation.problemId).toBe(problem.id);
        expect(restartedEvaluation.evaluation.problemVersion).toBe(problem.version);
      }
      expect(restartedReplay.available).toBe(true);
      if (restartedReplay.available) {
        expect(restartedReplay.replay.problem).toEqual({
          problemId: problem.id,
          problemVersion: problem.version
        });
      }
      expect(server.store.eventCount(sessionId)).toBe(beforeRestartReads);
    } finally {
      if (server !== undefined) await server.stop();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps Quant Research metrics deterministic without routing them into the Oxford evaluator", async () => {
    let server: StartedServer | undefined;
    try {
      server = await startServer(":memory:");
      const command = commandClient(server);
      const reads = readClient(server);
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

      await command.startConfiguredSession(sessionId, configuration);
      const research = new QuantResearchCoordinator(server.registry.get(sessionId));
      const first = await research.applyActionAtExpectedCount({
        actionId: "read-model-first",
        kind: "CHOOSE_OPTION",
        option: "CONSTANT"
      }, 0, createCommandEnvelope({
        sessionId,
        producer: "configured-read-integration-test"
      }));
      await research.applyActionAtExpectedCount({
        actionId: "read-model-second",
        kind: "CHOOSE_OPTION",
        option: "CONSTANT"
      }, first.value.state.acceptedActionCount, createCommandEnvelope({
        sessionId,
        producer: "configured-read-integration-test"
      }));

      const quant = await command.getQuantSessionState(sessionId);
      expect(quant.type).toBe("QUANT_RESEARCH_STATE");
      if (quant.type !== "QUANT_RESEARCH_STATE") {
        throw new Error("Expected Quant Research state");
      }
      expect(quant.state.status).toBe("COMPLETE");
      expect(quant.state.completion?.overallScore).toEqual(expect.any(Number));

      const evaluation = await reads.getEvaluation(sessionId);
      expect(evaluation).toMatchObject({
        available: false,
        reason: "EXACT_PROBLEM_UNAVAILABLE"
      });
      const history = await reads.getHistory();
      const researchCard = history.sessions.find((item) => item.sessionId === sessionId);
      expect(researchCard?.evaluation).toBeUndefined();
      expect(researchCard?.problemId).toBeUndefined();
      expect(researchCard?.problemVersion).toBeUndefined();
      expect(history.longitudinal.includedSessionCount).toBe(0);
      expect(history.longitudinal.problemsAttempted).toBe(0);
      expect(history.longitudinal.evaluationStatistics).toEqual([]);
    } finally {
      if (server !== undefined) await server.stop();
    }
  });

  it("fails product reads closed on schema-valid deterministic Quant Trading tampering", async () => {
    let server: StartedServer | undefined;
    try {
      server = await startServer(":memory:");
      const command = commandClient(server);
      const reads = readClient(server);
      const sessionId = newSessionId();
      const configuration = InterviewSessionConfigurationSchema.parse({
        configurationVersion: 1,
        mode: "QUANT_TRADING",
        scenario: {
          id: "BASIC_MARKET_MAKING",
          version: QUANT_TRADER_SCENARIO_VERSION
        },
        interventionPolicy: "STRICT"
      });
      await command.startConfiguredSession(sessionId, configuration);
      const healthySessionId = newSessionId();
      await command.startConfiguredSession(healthySessionId, configuration);
      const reducerInvalidSessionId = newSessionId();
      await command.startConfiguredSession(reducerInvalidSessionId, configuration);
      const forgedTerminalRequestId = newRequestId();
      server.store.appendIdempotent({
        sessionId: reducerInvalidSessionId,
        requestId: forgedTerminalRequestId,
        causationId: forgedTerminalRequestId,
        correlationId: forgedTerminalRequestId,
        elapsedMs: 10,
        expectedPriorSequence: server.store.eventCount(reducerInvalidSessionId),
        commandFingerprint: "9".repeat(64),
        drafts: [{
          source: "APPLICATION",
          type: "SESSION_COMPLETED",
          payload: { completedAt: new Date().toISOString() }
        }],
        result: { injected: true }
      });

      const trading = new QuantTradingSessionCoordinator(server.registry.get(sessionId));
      await trading.applyAction(
        { type: "PASS" },
        1,
        createCommandEnvelope({
          sessionId,
          producer: "configured-read-tamper-test"
        })
      );

      const db = (server.store as unknown as StoreWithDatabase).database;
      const rows = db.prepare(
        "SELECT sequence, event_json FROM session_events WHERE session_id = ? ORDER BY sequence"
      ).all(sessionId) as Array<{ sequence: number; event_json: string }>;
      const roundRow = rows.find((row) => {
        const parsed = JSON.parse(row.event_json) as { readonly type?: unknown };
        return parsed.type === "QUANT_TRADING_ROUND_RESOLVED";
      });
      if (roundRow === undefined) throw new Error("Expected persisted Quant Trading round");
      const tampered = JSON.parse(roundRow.event_json) as {
        type: string;
        payload: { evidence: { fairValue: number } };
      };
      tampered.payload.evidence.fairValue += 1;
      db.prepare(
        "UPDATE session_events SET event_json = ? WHERE session_id = ? AND sequence = ?"
      ).run(JSON.stringify(tampered), sessionId, roundRow.sequence);

      const listed = await command.listSessions();
      expect(listed.some((item) => item.sessionId === sessionId)).toBe(false);
      expect(listed.some((item) => item.sessionId === reducerInvalidSessionId)).toBe(false);
      expect(listed.find((item) => item.sessionId === healthySessionId)).toMatchObject({
        sessionId: healthySessionId,
        status: "ACTIVE"
      });

      const replay = await reads.getReplay(sessionId);
      expect(replay).toMatchObject({
        available: false,
        reason: "AUTHORITATIVE_HISTORY_UNAVAILABLE"
      });
      const history = await reads.getHistory();
      expect(history.sessions.find((item) => item.sessionId === sessionId)).toMatchObject({
        readStatus: "UNAVAILABLE"
      });
    } finally {
      if (server !== undefined) await server.stop();
    }
  });

  it("keeps configured Quant Trading replayable without fabricating an Oxford evaluation", async () => {
    let server: StartedServer | undefined;
    try {
      server = await startServer(":memory:");
      const command = commandClient(server);
      const reads = readClient(server);
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
        providerSelection: {
          providerId: "mock-model",
          modelId: "mock-default"
        }
      });

      await command.startConfiguredSession(sessionId, configuration);
      const trading = new QuantTradingSessionCoordinator(server.registry.get(sessionId));
      let tradingState = trading.getPublicState();
      while (tradingState.actionRequired) {
        tradingState = (await trading.applyAction(
          { type: "PASS" },
          tradingState.currentRound,
          createCommandEnvelope({
            sessionId,
            producer: "configured-read-integration-test"
          })
        )).value;
      }
      expect(tradingState.status).toBe("COMPLETED");
      const beforeReads = server.store.eventCount(sessionId);

      const evaluation = await reads.getEvaluation(sessionId);
      const replay = await reads.getReplay(sessionId);
      const history = await reads.getHistory();

      expect(evaluation).toMatchObject({
        available: false,
        reason: "EXACT_PROBLEM_UNAVAILABLE"
      });
      expect(replay.available).toBe(true);
      expect(history.sessions.find((item) => item.sessionId === sessionId)).toMatchObject({
        status: "COMPLETED",
        readStatus: "AVAILABLE"
      });
      expect(history.sessions.find((item) => item.sessionId === sessionId)?.evaluation)
        .toBeUndefined();
      expect(history.longitudinal.includedSessionCount).toBe(0);
      expect(history.longitudinal.sessionTruncation).toMatchObject({
        truncated: true,
        remainingCount: 1
      });
      expect(server.store.eventCount(sessionId)).toBe(beforeReads);
    } finally {
      if (server !== undefined) await server.stop();
    }
  });
});

async function startServer(databasePath: string): Promise<StartedServer> {
  return createAndStartServer({
    host: "127.0.0.1",
    commandPort: 0,
    rendererStreamPort: 0,
    clientToken: TOKEN,
    allowedOrigins: [ORIGIN],
    databasePath
  });
}

function commandClient(server: StartedServer): BrowserCommandClient {
  return new BrowserCommandClient({
    baseUrl: server.bound.command.url,
    clientToken: TOKEN,
    fetchImpl: browserLikeFetch
  });
}

function readClient(server: StartedServer): BrowserSessionReadClient {
  return new BrowserSessionReadClient({
    baseUrl: server.bound.command.url,
    clientToken: TOKEN,
    fetchImpl: browserLikeFetch
  });
}

async function browserLikeFetch(
  input: RequestInfo | URL,
  init: RequestInit = {}
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("origin", ORIGIN);
  return fetch(input, { ...init, headers });
}
