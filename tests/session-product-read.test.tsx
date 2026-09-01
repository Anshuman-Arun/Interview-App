import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import {
  SessionEvaluationSchema,
  SessionIdSchema,
  newSessionId,
  type SessionId
} from "../packages/domain/src/index.js";
import { DeliveryCoordinator } from "../packages/delivery/src/index.js";
import {
  ClosedWorldDisclosureAnalyzer,
  DisclosureValidator,
  TurnCoordinator,
  createCommandEnvelope
} from "../packages/interview-engine/src/index.js";
import { sixPeopleProblem } from "../packages/problems/src/index.js";
import {
  SessionReplayReadResponseSchema,
  projectGroundedEvaluationReadModel
} from "../packages/replay/src/index.js";
import { BrowserCommandClient } from "../apps/web/src/command-client.js";
import { BrowserSessionReadClient } from "../apps/web/src/session-read-client.js";
import {
  EvaluationPanel,
  ReplayPanel
} from "../apps/web/src/components/SessionReviewModal.js";
import { createAndStartServer } from "../apps/server/src/server.js";
import { SessionReadService } from "../apps/server/src/session-read-service.js";

const TOKEN = "grounded_read_product_test_token_0000000000000001";
const ORIGIN = "http://127.0.0.1:5173";

function evaluationFixture() {
  return SessionEvaluationSchema.parse({
    sessionId: SessionIdSchema.parse("session_product_evaluation_fixture"),
    problemId: "safe-problem",
    problemVersion: "1",
    evaluatedAt: "2026-09-01T17:00:00.000Z",
    rubric: {
      correctnessWeight: 0.35,
      rigorWeight: 0.20,
      independenceWeight: 0.20,
      communicationWeight: 0.15,
      errorRecoveryWeight: 0.10
    },
    lifecycle: {
      sessionStatus: "COMPLETED",
      completionState: "COMPLETED",
      totalTurns: 1
    },
    scores: {
      technicalCorrectness: 82,
      rigor: 75,
      independence: null,
      communication: null,
      hintResponsiveness: null,
      errorRecovery: 90,
      compositeScore: 81
    },
    dimensionResults: {
      technicalCorrectness: {
        score: 82,
        supportLevel: "STRONG",
        evidenceRefs: [{ kind: "TURN", id: "turn_safe" }]
      },
      rigor: {
        score: 75,
        supportLevel: "MODERATE",
        evidenceRefs: [{ kind: "EVIDENCE_EVENT", id: "evidence_safe" }]
      },
      independence: {
        score: null,
        supportLevel: "INSUFFICIENT",
        evidenceRefs: [],
        notScoredReason: "Exposure chronology is insufficient for a causal independence score."
      },
      communication: {
        score: null,
        supportLevel: "INSUFFICIENT",
        evidenceRefs: [],
        notScoredReason: "No validated communication-quality signal exists."
      },
      hintResponsiveness: {
        score: null,
        supportLevel: "INSUFFICIENT",
        evidenceRefs: [],
        notScoredReason: "Authoritative exposure ordering is unavailable."
      },
      errorRecovery: {
        score: 90,
        supportLevel: "MODERATE",
        evidenceRefs: [{ kind: "EVIDENCE_EVENT", id: "recovery_safe" }]
      }
    },
    composite: {
      status: "PARTIAL",
      supportLevel: "MODERATE",
      includedDimensions: ["technicalCorrectness", "rigor", "errorRecovery"],
      omittedDimensions: ["independence", "communication"]
    },
    milestones: [{
      milestoneId: "milestone_safe",
      description: "PRIVATE CANONICAL SOLUTION MUST NEVER REACH PRODUCT UI",
      achieved: true,
      achievedAtTurnId: "turn_safe",
      assistanceLevel: 0,
      supportLevel: "STRONG",
      evidenceRefs: [{ kind: "MILESTONE", id: "milestone_safe" }],
      assistanceDisclosureIds: [],
      approachIds: ["approach_safe"]
    }],
    disclosedInterventions: [],
    unassistedMilestoneCount: 1,
    assistedMilestoneCount: 0,
    totalTurns: 1,
    keyStrengths: ["Grounded correctness evidence was strong."],
    areasForImprovement: ["A grounded rigor gap remains."],
    summaryAssessment: "Completed interview with a partial grounded composite."
  });
}

function authenticatedFetch(fetchImpl: typeof fetch = fetch): typeof fetch {
  return async (input, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set("Origin", ORIGIN);
    return fetchImpl(input, { ...init, headers });
  };
}

describe("grounded evaluation/replay product surface", () => {
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

  it("preserves supported versus unsupported dimensions without leaking canonical reasoning", () => {
    const model = projectGroundedEvaluationReadModel(evaluationFixture());

    expect(model.dimensions.find((item) => item.name === "technicalCorrectness"))
      .toMatchObject({ score: 82, supportLevel: "STRONG" });
    expect(model.dimensions.find((item) => item.name === "communication"))
      .toMatchObject({
        score: null,
        supportLevel: "INSUFFICIENT",
        notScoredReason: "No validated communication-quality signal exists."
      });
    expect(JSON.stringify(model)).not.toContain("PRIVATE CANONICAL SOLUTION");

    const markup = renderToStaticMarkup(
      React.createElement(EvaluationPanel, { evaluation: model })
    );
    expect(markup).toContain("Technical Correctness");
    expect(markup).toContain("82");
    expect(markup).toContain("Communication");
    expect(markup).toContain("Not scored");
    expect(markup).not.toContain("PRIVATE CANONICAL SOLUTION");
  });

  it("renders possibly exposed replay as withheld and escapes transcript-like text", () => {
    const response = SessionReplayReadResponseSchema.parse({
      protocolVersion: 1,
      type: "SESSION_REPLAY_READ",
      sessionId: "session_replay_ui_fixture",
      available: true,
      replay: {
        sessionId: "session_replay_ui_fixture",
        lifecycle: {
          status: "COMPLETED",
          historyComplete: true,
          started: true,
          completed: true,
          archived: false,
          resumedCount: 0,
          recoveryOriginPossiblyExposedCount: 1
        },
        currentStateAvailable: true,
        complete: true,
        validatedThroughSequence: 3,
        observedThroughSequence: 3,
        totalEventCount: 3,
        counts: {
          turns: 1,
          deliveries: 1,
          exposedInterventions: 0,
          possiblyExposedInterventions: 1,
          cancelledInterventions: 0
        },
        evidenceSummary: {
          recordedUpdates: 0,
          recordedInvalidations: 0,
          currentActive: 0,
          superseded: 0,
          stale: 0
        },
        verificationSummary: {
          statusIsCurrent: true,
          pending: 0,
          verified: 0,
          contradicted: 0,
          unresolved: 0,
          discarded: 0
        },
        entries: [
          {
            sequence: 1,
            eventId: "event_student",
            occurredAt: "2026-09-01T17:00:00.000Z",
            kind: "TURN_COMMITTED",
            summary: "Turn committed",
            category: "STUDENT",
            stateValidation: "VALIDATED",
            source: "USER",
            relations: { turnId: "turn_1" },
            text: {
              text: "<img src=x onerror=alert(1)> student math",
              originalLength: 45,
              truncated: false
            }
          },
          {
            sequence: 2,
            eventId: "event_possible",
            occurredAt: "2026-09-01T17:00:01.000Z",
            kind: "DELIVERY_POSSIBLY_EXPOSED",
            summary: "Delivery possibly exposed",
            category: "RECOVERY",
            stateValidation: "VALIDATED",
            source: "RECOVERY",
            relations: { deliveryId: "delivery_uncertain" },
            delivery: {
              medium: "TEXT",
              status: "POSSIBLY_EXPOSED",
              presentationState: "POSSIBLY_PRESENTED",
              effectiveDisclosureLevel: 2,
              disclosureIdCount: 1,
              contentWithheld: true
            }
          }
        ],
        eventTruncation: { truncated: false, limit: 20_000, remainingCount: 0 },
        timelineTruncation: { truncated: false, limit: 1_000, remainingCount: 0 },
        issues: []
      }
    });

    if (!response.available) throw new Error("Expected replay fixture");
    const markup = renderToStaticMarkup(
      React.createElement(ReplayPanel, { response })
    );

    expect(markup).toContain("Possibly exposed content is intentionally withheld");
    expect(markup).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(markup).not.toContain("<img src=x onerror=alert(1)>");
    expect(markup).not.toContain("secret possibly exposed answer");
  });

  it("reads completed evaluation, replay, and history without appending or acknowledging events", async () => {
    server = await createAndStartServer({
      host: "127.0.0.1",
      commandPort: 0,
      rendererStreamPort: 0,
      clientToken: TOKEN,
      allowedOrigins: [ORIGIN],
      databasePath: ":memory:"
    });

    const fetchWithOrigin = authenticatedFetch();
    const command = new BrowserCommandClient({
      baseUrl: server.bound.command.url,
      clientToken: TOKEN,
      fetchImpl: fetchWithOrigin
    });
    const reads = new BrowserSessionReadClient({
      baseUrl: server.bound.command.url,
      clientToken: TOKEN,
      fetchImpl: fetchWithOrigin
    });

    const sessionId: SessionId = newSessionId();
    await command.startSession(sessionId);

    const writer = server.registry.get(sessionId);
    const turns = new TurnCoordinator(writer);
    await turns.commitInput(
      "A grounded claim with an explicit justification for evaluation."
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
          producer: "grounded-read-product-test"
        }),
        proposal: {
          key: {
            problemId: sixPeopleProblem.id,
            subject: { kind: "CLAIM", claimId: "grounded-read-claim" },
            dimension
          },
          proposedValue,
          inferenceConfidence: 0.95,
          evidenceEventIds: [supportingEvent]
        }
      });
      expect(result.committed).toBe(true);
    }
    await turns.completeSession();

    const before = server.store.eventCount(sessionId);
    const evaluation = await reads.getEvaluation(sessionId);
    const replay = await reads.getReplay(sessionId);
    const history = await reads.getHistory();
    const after = server.store.eventCount(sessionId);

    expect(evaluation.available).toBe(true);
    if (evaluation.available) {
      const correctness = evaluation.evaluation.dimensions.find(
        (item) => item.name === "technicalCorrectness"
      );
      const rigor = evaluation.evaluation.dimensions.find(
        (item) => item.name === "rigor"
      );
      const communication = evaluation.evaluation.dimensions.find(
        (item) => item.name === "communication"
      );
      expect(correctness?.score).toBe(100);
      expect(correctness?.supportLevel).not.toBe("INSUFFICIENT");
      expect(rigor?.score).toBe(100);
      expect(rigor?.supportLevel).not.toBe("INSUFFICIENT");
      expect(communication?.score).toBeNull();
      expect(communication?.supportLevel).toBe("INSUFFICIENT");
      expect(communication?.notScoredReason).toBeDefined();
    }
    expect(replay.available).toBe(true);
    expect(history.sessions.some((item) => item.sessionId === sessionId)).toBe(true);
    expect(after).toBe(before);

    await reads.getReplay(sessionId);
    await reads.getEvaluation(sessionId);
    expect(server.store.eventCount(sessionId)).toBe(before);
  });

  it("returns a structured exact-problem failure instead of evaluating against a substitute", async () => {
    server = await createAndStartServer({
      host: "127.0.0.1",
      commandPort: 0,
      rendererStreamPort: 0,
      clientToken: TOKEN,
      allowedOrigins: [ORIGIN],
      databasePath: ":memory:"
    });

    const fetchWithOrigin = authenticatedFetch();
    const command = new BrowserCommandClient({
      baseUrl: server.bound.command.url,
      clientToken: TOKEN,
      fetchImpl: fetchWithOrigin
    });
    const sessionId = newSessionId();
    await command.startSession(sessionId);
    await command.completeSession(sessionId);
    const before = server.store.eventCount(sessionId);

    const isolated = new SessionReadService({
      source: {
        hasSession: (id) => server?.store.hasSession(id) ?? false,
        listSessions: () => server?.store.listSessions() ?? [],
        loadEvents: (id) => server?.store.load(id) ?? []
      },
      problemResolver: {
        resolve: () => undefined
      }
    });
    const result = isolated.readEvaluation(sessionId);

    expect(result).toMatchObject({
      available: false,
      reason: "EXACT_PROBLEM_UNAVAILABLE"
    });
    expect(server.store.eventCount(sessionId)).toBe(before);
  });

  it("fails closed for active sessions and malicious read paths without mutating authority", async () => {
    server = await createAndStartServer({
      host: "127.0.0.1",
      commandPort: 0,
      rendererStreamPort: 0,
      clientToken: TOKEN,
      allowedOrigins: [ORIGIN],
      databasePath: ":memory:"
    });

    const fetchWithOrigin = authenticatedFetch();
    const command = new BrowserCommandClient({
      baseUrl: server.bound.command.url,
      clientToken: TOKEN,
      fetchImpl: fetchWithOrigin
    });
    const reads = new BrowserSessionReadClient({
      baseUrl: server.bound.command.url,
      clientToken: TOKEN,
      fetchImpl: fetchWithOrigin
    });

    const sessionId = newSessionId();
    await command.startSession(sessionId);
    const before = server.store.eventCount(sessionId);

    const evaluation = await reads.getEvaluation(sessionId);
    expect(evaluation).toMatchObject({
      available: false,
      reason: "SESSION_NOT_TERMINAL"
    });

    await command.archiveSession(sessionId);
    const archivedCount = server.store.eventCount(sessionId);
    const archivedEvaluation = await reads.getEvaluation(sessionId);
    expect(archivedEvaluation.available).toBe(true);
    if (archivedEvaluation.available) {
      expect(archivedEvaluation.evaluation.lifecycle).toEqual({
        sessionStatus: "ARCHIVED",
        completionState: "ARCHIVED_INCOMPLETE"
      });
    }
    expect(server.store.eventCount(sessionId)).toBe(archivedCount);

    const badPath = await fetch(
      `${server.bound.command.url}/v1/read/sessions/%2e%2e%2fcommands/replay`,
      {
        method: "GET",
        headers: {
          Origin: ORIGIN,
          "x-interview-client-token": TOKEN
        }
      }
    );
    expect(badPath.status).toBe(404);

    const queryInjection = await fetch(
      `${server.bound.command.url}/v1/read/sessions?sessionId=${encodeURIComponent(sessionId)}`,
      {
        method: "GET",
        headers: {
          Origin: ORIGIN,
          "x-interview-client-token": TOKEN
        }
      }
    );
    expect(queryInjection.status).toBe(404);
    expect(server.store.eventCount(sessionId)).toBe(archivedCount);
  });

  it("reopens completed history after restart and remains read-only", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "grounded-read-restart-"));
    const databasePath = path.join(tempDir, "interview.sqlite");

    server = await createAndStartServer({
      host: "127.0.0.1",
      commandPort: 0,
      rendererStreamPort: 0,
      clientToken: TOKEN,
      allowedOrigins: [ORIGIN],
      databasePath
    });
    const firstFetch = authenticatedFetch();
    const command = new BrowserCommandClient({
      baseUrl: server.bound.command.url,
      clientToken: TOKEN,
      fetchImpl: firstFetch
    });
    const sessionId = newSessionId();
    await command.startSession(sessionId);
    await command.completeSession(sessionId);
    const expectedCount = server.store.eventCount(sessionId);

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
    const reads = new BrowserSessionReadClient({
      baseUrl: server.bound.command.url,
      clientToken: TOKEN,
      fetchImpl: authenticatedFetch()
    });

    const replay = await reads.getReplay(sessionId);
    const history = await reads.getHistory();
    expect(replay.available).toBe(true);
    expect(history.sessions.find((item) => item.sessionId === sessionId)?.status)
      .toBe("COMPLETED");
    expect(server.store.eventCount(sessionId)).toBe(expectedCount);
  });
});
