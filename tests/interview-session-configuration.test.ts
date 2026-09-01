import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  InterviewCatalogResponseSchema,
  InterviewSessionConfigurationSchema,
  ProtocolErrorResponseSchema,
  SessionStartedResponseSchema,
  newRequestId,
  newSessionId,
  type InterviewSessionConfiguration,
  type SessionId
} from "../packages/domain/src/index.js";
import { QUANT_TRADER_SCENARIO_VERSION } from "../packages/local-compute/src/index.js";
import { SessionRuntimeRegistry } from "../packages/interview-engine/src/index.js";
import { SqliteEventStore } from "../packages/persistence/src/index.js";
import {
  LoopbackCommandServer,
  ServerTurnOrchestrator,
  SessionRecoveryCoordinator,
  listInterviewCatalogEntries,
  resolveInterviewSessionConfiguration
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

    const ramsey = SessionStartedResponseSchema.parse(
      await json(await postStart(ramseySession, ramseyConfiguration))
    );
    const other = SessionStartedResponseSchema.parse(
      await json(await postStart(divisibilitySession, divisibilityConfiguration))
    );

    expect(ramsey.configuration).toEqual(ramseyConfiguration);
    expect(other.configuration).toEqual(divisibilityConfiguration);
    expect(registry.get(ramseySession).getState().problem?.id).toBe(sixPeopleProblem.id);
    expect(registry.get(divisibilitySession).getState().problem?.id).toBe(divisibility.id);
    expect(registry.get(divisibilitySession).getState().problem?.version).toBe(divisibility.version);
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
      providerSelection: { profileId: "local-default" }
    });

    const started = SessionStartedResponseSchema.parse(
      await json(await postStart(sessionId, configuration))
    );
    expect(started.configuration).toEqual(configuration);
    expect(registry.get(sessionId).getState().problem).toBeUndefined();

    await server.stop();
    await registry.closeAll();

    registry = new SessionRuntimeRegistry(store);
    sessions = recoveryCoordinator(registry);
    server = commandServer(sessions);
    address = await server.start();

    await expect(sessions.ensureRecovered(sessionId)).resolves.toEqual([]);
    expect(registry.get(sessionId).getState().configuration).toEqual(configuration);
    expect(registry.get(sessionId).getState().problem).toBeUndefined();
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
        profileId: "local-default",
        apiKey: "must-never-persist"
      }
    })).toThrow();

    expect(() => InterviewSessionConfigurationSchema.parse({
      configurationVersion: 1,
      mode: "QUANT_TRADING",
      scenario: { id: "BASIC_MARKET_MAKING", version: QUANT_TRADER_SCENARIO_VERSION },
      durationMinutes: 10_000,
      interventionPolicy: "BALANCED"
    })).toThrow();
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
  });

  function postStart(
    sessionId: SessionId,
    configuration: InterviewSessionConfiguration,
    requestId = newRequestId()
  ): Promise<Response> {
    return post({
      protocolVersion: 1,
      type: "START_SESSION",
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
): InterviewSessionConfiguration {
  return InterviewSessionConfigurationSchema.parse({
    configurationVersion: 1,
    mode: "OXFORD_MATHEMATICS",
    problem: { id, version },
    difficulty,
    interventionPolicy: "BALANCED"
  });
}

async function json(response: Response): Promise<unknown> {
  return response.json() as Promise<unknown>;
}
