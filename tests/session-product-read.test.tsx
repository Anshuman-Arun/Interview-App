import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SessionEvaluationSchema,
  SessionIdSchema,
  newSessionId,
  type SessionId
} from "../packages/domain/src/index.js";
import {
  TurnCoordinator,
  createCommandEnvelope
} from "../packages/interview-engine/src/index.js";
import { sixPeopleProblem } from "../packages/problems/src/index.js";
import {
  DEFAULT_REPLAY_BOUNDS,
  GroundedEvaluationReadModelSchema,
  ReplayReadEntrySchema,
  SessionHistoryReadResponseSchema,
  SessionReplayReadModelSchema,
  SessionReplayReadResponseSchema,
  projectGroundedEvaluationReadModel,
  projectSessionReplayReadModel,
  type SessionHistoryProjection
} from "../packages/replay/src/index.js";
import { BrowserCommandClient } from "../apps/web/src/command-client.js";
import {
  BrowserSessionReadClient,
  MAX_SESSION_READ_RESPONSE_BYTES
} from "../apps/web/src/session-read-client.js";
import {
  EvaluationPanel,
  ReplayPanel
} from "../apps/web/src/components/SessionReviewModal.js";
import { createAndStartServer } from "../apps/server/src/server.js";
import {
  SessionReadService,
  createCatalogSessionProblemResolver
} from "../apps/server/src/session-read-service.js";

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
        validatedThroughSequence: 2,
        observedThroughSequence: 2,
        totalEventCount: 2,
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

    expect(ReplayReadEntrySchema.safeParse({
      sequence: 3,
      eventId: "event_smuggled_possible",
      occurredAt: "2026-09-01T17:00:02.000Z",
      kind: "DELIVERY_POSSIBLY_EXPOSED",
      summary: "Delivery possibly exposed",
      category: "RECOVERY",
      stateValidation: "VALIDATED",
      source: "RECOVERY",
      relations: { deliveryId: "delivery_smuggled" },
      text: {
        text: "secret possibly exposed answer",
        originalLength: 32,
        truncated: false
      },
      delivery: {
        medium: "TEXT",
        status: "POSSIBLY_EXPOSED",
        presentationState: "POSSIBLY_PRESENTED",
        effectiveDisclosureLevel: 3,
        disclosureIdCount: 1,
        contentWithheld: true
      }
    }).success).toBe(false);
  });

  it("enforces code-point text bounds and nested replay identifier bounds", () => {
    const emoji = "😀";
    expect(ReplayReadEntrySchema.safeParse({
      sequence: 1,
      eventId: "event_unicode",
      occurredAt: "2026-09-01T17:00:00.000Z",
      kind: "TURN_COMMITTED",
      summary: "Turn committed",
      category: "STUDENT",
      stateValidation: "VALIDATED",
      source: "APPLICATION",
      relations: { turnId: "turn_unicode" },
      text: {
        text: emoji.repeat(512),
        originalLength: 512,
        truncated: false
      }
    }).success).toBe(true);

    expect(ReplayReadEntrySchema.safeParse({
      sequence: 1,
      eventId: "event_oversized_evidence",
      occurredAt: "2026-09-01T17:00:00.000Z",
      kind: "STUDENT_EVIDENCE_UPDATED",
      summary: "Evidence updated",
      category: "EVIDENCE",
      stateValidation: "VALIDATED",
      source: "APPLICATION",
      relations: {},
      evidence: {
        transition: "UPDATED",
        key: {
          problemId: "p",
          subject: { kind: "CLAIM", claimId: "x".repeat(513) },
          dimension: "CORRECTNESS"
        },
        value: "CORRECT",
        inferenceConfidence: 0.9
      }
    }).success).toBe(false);
  });

  it("keeps known payloads withheld after an unknown replay semantic boundary", () => {
    expect(ReplayReadEntrySchema.safeParse({
      sequence: 3,
      eventId: "event_after_unknown",
      occurredAt: "2026-09-01T17:00:02.000Z",
      kind: "TURN_COMMITTED",
      summary: "Known event after unknown semantic boundary; payload intentionally withheld",
      category: "STUDENT",
      stateValidation: "UNAVAILABLE_AFTER_UNKNOWN",
      source: "APPLICATION",
      relations: {}
    }).success).toBe(true);

    expect(ReplayReadEntrySchema.safeParse({
      sequence: 3,
      eventId: "event_after_unknown_leak",
      occurredAt: "2026-09-01T17:00:02.000Z",
      kind: "TURN_COMMITTED",
      summary: "Known event after unknown semantic boundary; payload intentionally withheld",
      category: "STUDENT",
      stateValidation: "UNAVAILABLE_AFTER_UNKNOWN",
      source: "APPLICATION",
      relations: { turnId: "turn_should_be_hidden" },
      text: {
        text: "payload must not survive unknown boundary",
        originalLength: 41,
        truncated: false
      }
    }).success).toBe(false);

    expect(ReplayReadEntrySchema.safeParse({
      sequence: 2,
      eventId: "event_unknown",
      occurredAt: "2026-09-01T17:00:01.000Z",
      kind: "UNKNOWN_EVENT",
      summary: "Unknown authoritative event; payload intentionally withheld",
      category: "SYSTEM",
      stateValidation: "UNKNOWN_EVENT",
      source: "APPLICATION",
      relations: {}
    }).success).toBe(true);
  });

  it("rejects internally contradictory replay and longitudinal DTOs", () => {
    expect(ReplayReadEntrySchema.safeParse({
      sequence: 1,
      eventId: "event_bad_delivery",
      occurredAt: "2026-09-01T17:00:00.000Z",
      kind: "DELIVERY_POSSIBLY_EXPOSED",
      summary: "Delivery possibly exposed",
      category: "RECOVERY",
      stateValidation: "VALIDATED",
      source: "RECOVERY",
      relations: { deliveryId: "delivery_bad" },
      delivery: {
        medium: "TEXT",
        status: "COMPLETED",
        presentationState: "PRESENTED",
        effectiveDisclosureLevel: 2,
        disclosureIdCount: 1,
        contentWithheld: true
      }
    }).success).toBe(false);

    expect(SessionReplayReadModelSchema.safeParse({
      sessionId: "session_bad_prefix",
      lifecycle: {
        status: "ACTIVE",
        historyComplete: true,
        started: true,
        completed: false,
        archived: false,
        resumedCount: 0,
        recoveryOriginPossiblyExposedCount: 0
      },
      currentStateAvailable: true,
      complete: false,
      validatedThroughSequence: 2,
      observedThroughSequence: 2,
      totalEventCount: 2,
      counts: {
        turns: 1,
        deliveries: 0,
        exposedInterventions: 0,
        possiblyExposedInterventions: 0,
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
      entries: [{
        sequence: 2,
        eventId: "event_gap",
        occurredAt: "2026-09-01T17:00:00.000Z",
        kind: "TURN_COMMITTED",
        summary: "Turn committed",
        category: "STUDENT",
        stateValidation: "VALIDATED",
        source: "APPLICATION",
        relations: { turnId: "turn_gap" }
      }],
      eventTruncation: { truncated: false, limit: 20_000, remainingCount: 0 },
      timelineTruncation: { truncated: true, limit: 1, remainingCount: 1 },
      issues: [{ code: "TIMELINE_LIMIT_REACHED" }]
    }).success).toBe(false);

    expect(SessionHistoryReadResponseSchema.safeParse({
      protocolVersion: 1,
      type: "SESSION_HISTORY_READ",
      sessions: [],
      sessionTruncation: { truncated: false, limit: 100, remainingCount: 0 },
      longitudinal: {
        includedSessionCount: 1,
        sessionTruncation: { truncated: false, limit: 100, remainingCount: 0 },
        completedSessions: 1,
        problemsAttempted: 1,
        repeatedProblems: [],
        repeatedProblemsTruncation: { truncated: false, limit: 100, remainingCount: 0 },
        evaluationStatistics: [{
          problemId: "problem",
          problemVersion: "1",
          sessionCount: 1,
          scoredSessionCount: {
            technicalCorrectness: 0,
            rigor: 0,
            independence: 0,
            communication: 0,
            hintResponsiveness: 0,
            errorRecovery: 0,
            compositeScore: 0
          },
          average: {
            technicalCorrectness: null,
            rigor: null,
            independence: null,
            communication: null,
            hintResponsiveness: null,
            errorRecovery: null,
            compositeScore: 50
          },
          median: {
            technicalCorrectness: null,
            rigor: null,
            independence: null,
            communication: null,
            hintResponsiveness: null,
            errorRecovery: null,
            compositeScore: 50
          }
        }],
        evaluationStatisticsTruncation: { truncated: false, limit: 100, remainingCount: 0 },
        improvement: [],
        improvementTruncation: { truncated: false, limit: 100, remainingCount: 0 },
        improvementComparisonsSkipped: 0,
        comparability: {
          problems: "EXACT_PROBLEM_ID_AND_VERSION",
          evidence: "EXACT_EVIDENCE_KEY_ONLY",
          skillTaxonomyAvailable: false
        }
      }
    }).success).toBe(false);
  });

  it("rejects inconsistent grounded evaluation coverage metadata", () => {
    const projected = projectGroundedEvaluationReadModel(evaluationFixture());
    expect(GroundedEvaluationReadModelSchema.safeParse({
      ...projected,
      composite: {
        ...projected.composite,
        includedDimensions: [
          ...projected.composite.includedDimensions,
          "communication"
        ]
      }
    }).success).toBe(false);
  });

  it("rejects an oversized response before JSON parsing", async () => {
    const client = new BrowserSessionReadClient({
      baseUrl: "http://127.0.0.1:43123",
      clientToken: TOKEN,
      fetchImpl: async () => new Response("{}", {
        status: 200,
        headers: {
          "content-type": "application/json",
          "content-length": String(MAX_SESSION_READ_RESPONSE_BYTES + 1)
        }
      })
    });

    await expect(client.getHistory()).rejects.toMatchObject({
      reason: "BODY_TOO_LARGE"
    });
  });

  it("fails closed if an upstream replay object accidentally carries uncertain delivery text", () => {
    const sessionId = SessionIdSchema.parse("session_uncertain_fail_closed");
    const projection = {
      sessionId,
      lifecycle: {
        status: "COMPLETED",
        historyComplete: true,
        started: true,
        completed: true,
        archived: false,
        resumedCount: 1,
        recoveryOriginPossiblyExposedCount: 1
      },
      counts: {
        turns: 0,
        inputEpisodes: 0,
        utterances: 0,
        generations: 1,
        deliveries: 1,
        exposedInterventions: 0,
        possiblyExposedInterventions: 1,
        cancelledInterventions: 0
      },
      currentStateAvailable: true,
      validatedThroughSequence: 1,
      observedThroughSequence: 1,
      countsComplete: true,
      totalEventCount: 1,
      timeline: {
        sessionId,
        totalEventCount: 1,
        entries: [{
          kind: "DELIVERY_POSSIBLY_EXPOSED",
          summary: "Delivery possibly exposed",
          stateValidation: "VALIDATED",
          provenance: {
            eventId: "event_uncertain",
            sessionId,
            sequence: 1,
            persistedSchemaVersion: 1,
            persistedType: "DELIVERY_POSSIBLY_EXPOSED",
            source: "RECOVERY",
            wallTime: "2026-09-01T17:00:00.000Z",
            elapsedMs: 10,
            causationId: "request_uncertain",
            correlationId: "request_uncertain"
          },
          relations: { deliveryId: "delivery_uncertain" },
          delivery: {
            deliveryId: "delivery_uncertain",
            generationId: "generation_uncertain",
            medium: "TEXT",
            persistedAtomStatus: "POSSIBLY_EXPOSED",
            status: "POSSIBLY_EXPOSED",
            presentationState: "POSSIBLY_PRESENTED",
            disclosure: {
              effectiveDisclosureLevel: 3,
              disclosureIdCount: 1,
              disclosureIds: ["private_disclosure_id"]
            },
            text: {
              text: "SECRET UNCERTAIN INTERVIEWER CONTENT",
              originalLength: 36,
              truncated: false
            }
          }
        }],
        eventTruncation: {
          truncated: false,
          limit: DEFAULT_REPLAY_BOUNDS.maxEvents,
          remainingCount: 0
        },
        timelineTruncation: {
          truncated: false,
          limit: 1_000,
          remainingCount: 0
        },
        complete: true,
        issues: [],
        bounds: DEFAULT_REPLAY_BOUNDS
      },
      evidenceHistory: [],
      evidenceHistoryTruncation: { truncated: false, limit: 1, remainingCount: 0 },
      evidenceHistoryComplete: true,
      currentEvidence: [],
      currentEvidenceTruncation: { truncated: false, limit: 1, remainingCount: 0 },
      evidenceSummary: {
        recordedUpdates: 0,
        recordedInvalidations: 0,
        currentActive: 0,
        superseded: 0,
        stale: 0
      },
      verificationHistory: [],
      verificationTruncation: { truncated: false, limit: 1, remainingCount: 0 },
      verificationHistoryComplete: true,
      verificationSummary: {
        statusIsCurrent: true,
        pending: 0,
        verified: 0,
        contradicted: 0,
        unresolved: 0,
        discarded: 0
      },
      generationHistory: [],
      generationTruncation: { truncated: false, limit: 1, remainingCount: 0 },
      generationHistoryComplete: true
    } as unknown as SessionHistoryProjection;

    const model = projectSessionReplayReadModel(projection);
    expect(model.entries).toHaveLength(1);
    expect(model.entries[0]?.text).toBeUndefined();
    expect(model.entries[0]?.delivery?.contentWithheld).toBe(true);
    expect(JSON.stringify(model)).not.toContain("SECRET UNCERTAIN INTERVIEWER CONTENT");
    expect(JSON.stringify(model)).not.toContain("private_disclosure_id");
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
    const mutableIndexRead = vi.spyOn(server.store, "listSessions");
    const evaluation = await reads.getEvaluation(sessionId);
    const replay = await reads.getReplay(sessionId);
    const history = await reads.getHistory();
    const after = server.store.eventCount(sessionId);
    expect(mutableIndexRead).not.toHaveBeenCalled();

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

  it("rejects ambiguous exact-problem catalogs instead of silently choosing a duplicate", () => {
    expect(() => createCatalogSessionProblemResolver([
      sixPeopleProblem,
      sixPeopleProblem
    ])).toThrow("duplicate id/version");
  });

  it("does not expose session identities that cannot be addressed safely by the read route", async () => {
    const unsafeIds = [
      SessionIdSchema.parse("session/unsafe"),
      SessionIdSchema.parse("."),
      SessionIdSchema.parse("..")
    ];
    const reads = new SessionReadService({
      source: {
        hasSession: () => true,
        sessionCount: () => unsafeIds.length,
        listRecentSessionIds: () => unsafeIds,
        eventCount: () => 0,
        loadEvents: () => []
      }
    });

    const history = reads.readHistory();
    expect(history.sessions).toEqual([]);
    expect(history.sessionTruncation).toEqual({
      truncated: true,
      limit: 100,
      remainingCount: unsafeIds.length
    });
    expect(history.longitudinal.sessionTruncation).toEqual({
      truncated: true,
      limit: 100,
      remainingCount: unsafeIds.length
    });

    const client = new BrowserSessionReadClient({
      baseUrl: "http://127.0.0.1:43123",
      clientToken: TOKEN,
      fetchImpl: vi.fn()
    });
    await expect(client.getReplay(SessionIdSchema.parse("..")))
      .rejects.toThrow("cannot be addressed");
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
        sessionCount: () => server?.store.sessionCount() ?? 0,
        listRecentSessionIds: (limit) =>
          server?.store.listRecentSessionIds(limit) ?? [],
        eventCount: (id) => server?.store.eventCount(id) ?? 0,
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

  it("tolerates a session created between bounded inventory reads", () => {
    const first = SessionIdSchema.parse("session_inventory_race_first");
    const second = SessionIdSchema.parse("session_inventory_race_second");
    let idsRead = false;
    const reads = new SessionReadService({
      source: {
        hasSession: () => true,
        listRecentSessionIds: () => {
          idsRead = true;
          return [first, second];
        },
        sessionCount: () => idsRead ? 3 : 1,
        eventCount: () => 0,
        loadEvents: () => []
      }
    });

    const history = reads.readHistory();
    expect(history.sessions.map((item) => item.sessionId)).toEqual([first, second]);
    expect(history.sessions.every((item) => item.readStatus === "UNAVAILABLE")).toBe(true);
    expect(history.sessionTruncation).toEqual({
      truncated: true,
      limit: 100,
      remainingCount: 1
    });
    expect(history.longitudinal.sessionTruncation).toEqual({
      truncated: true,
      limit: 100,
      remainingCount: 3
    });
  });

  it("isolates corrupt and oversized histories behind bounded structured reads", () => {
    const sessionId = SessionIdSchema.parse("session_bounded_failure_fixture");
    let loadCalls = 0;
    const oversized = new SessionReadService({
      source: {
        hasSession: () => true,
        sessionCount: () => 1,
        listRecentSessionIds: () => [sessionId],
        eventCount: () => DEFAULT_REPLAY_BOUNDS.maxEvents + 1,
        loadEvents: () => {
          loadCalls += 1;
          throw new Error("must not load oversized history");
        }
      }
    });

    expect(oversized.readEvaluation(sessionId)).toMatchObject({
      available: false,
      reason: "READ_LIMIT_EXCEEDED"
    });
    expect(oversized.readReplay(sessionId)).toMatchObject({
      available: false,
      reason: "READ_LIMIT_EXCEEDED"
    });
    const oversizedHistory = oversized.readHistory();
    expect(oversizedHistory.sessions).toEqual([{
      sessionId,
      status: "UNKNOWN",
      eventCount: DEFAULT_REPLAY_BOUNDS.maxEvents + 1,
      readStatus: "BUDGET_EXCLUDED"
    }]);
    expect(oversizedHistory.longitudinal.sessionTruncation).toEqual({
      truncated: true,
      limit: 100,
      remainingCount: 1
    });
    expect(loadCalls).toBe(0);

    const corrupt = new SessionReadService({
      source: {
        hasSession: () => true,
        sessionCount: () => 1,
        listRecentSessionIds: () => [sessionId],
        eventCount: () => 2,
        loadEvents: () => {
          throw new Error("corrupt persisted event stream");
        }
      }
    });
    expect(corrupt.readEvaluation(sessionId)).toMatchObject({
      available: false,
      reason: "AUTHORITATIVE_HISTORY_UNAVAILABLE"
    });
    expect(corrupt.readReplay(sessionId)).toMatchObject({
      available: false,
      reason: "AUTHORITATIVE_HISTORY_UNAVAILABLE"
    });
    const corruptHistory = corrupt.readHistory();
    expect(corruptHistory.sessions).toEqual([{
      sessionId,
      status: "UNKNOWN",
      eventCount: 2,
      readStatus: "UNAVAILABLE"
    }]);
    expect(corruptHistory.longitudinal.sessionTruncation).toEqual({
      truncated: true,
      limit: 100,
      remainingCount: 1
    });
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

  it("keeps read CORS/authentication exact and mutation-free", async () => {
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
    const sessionId = newSessionId();
    await command.startSession(sessionId);
    await command.completeSession(sessionId);
    const before = server.store.eventCount(sessionId);
    const evaluationPath =
      `${server.bound.command.url}/v1/read/sessions/${encodeURIComponent(sessionId)}/evaluation`;

    const allowed = await fetch(evaluationPath, {
      method: "OPTIONS",
      headers: {
        Origin: ORIGIN,
        "access-control-request-method": "GET",
        "access-control-request-headers": "x-interview-client-token"
      }
    });
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(allowed.headers.get("access-control-allow-origin")).not.toBe("*");
    expect(allowed.headers.get("access-control-allow-methods")).toBe("GET");

    const wrongMethod = await fetch(evaluationPath, {
      method: "OPTIONS",
      headers: {
        Origin: ORIGIN,
        "access-control-request-method": "POST",
        "access-control-request-headers": "x-interview-client-token"
      }
    });
    expect(wrongMethod.status).toBe(400);

    const missingToken = await fetch(evaluationPath, {
      method: "GET",
      headers: { Origin: ORIGIN }
    });
    expect(missingToken.status).toBe(401);

    const wrongOrigin = await fetch(evaluationPath, {
      method: "GET",
      headers: {
        Origin: "http://attacker.invalid",
        "x-interview-client-token": TOKEN
      }
    });
    expect(wrongOrigin.status).toBe(403);
    expect(wrongOrigin.headers.get("access-control-allow-origin")).toBeNull();
    expect(server.store.eventCount(sessionId)).toBe(before);
  });

  it("returns bounded structured failures for corrupted and oversized histories", () => {
    const corruptedId = SessionIdSchema.parse("session_corrupt_read_fixture");
    const corrupted = new SessionReadService({
      source: {
        hasSession: () => true,
        sessionCount: () => 1,
        listRecentSessionIds: () => [corruptedId],
        eventCount: () => 1,
        loadEvents: () => {
          throw new Error("corrupt persistence fixture");
        }
      }
    });

    expect(corrupted.readEvaluation(corruptedId)).toMatchObject({
      available: false,
      reason: "AUTHORITATIVE_HISTORY_UNAVAILABLE"
    });
    expect(corrupted.readReplay(corruptedId)).toMatchObject({
      available: false,
      reason: "AUTHORITATIVE_HISTORY_UNAVAILABLE"
    });

    const oversizedId = SessionIdSchema.parse("session_oversized_read_fixture");
    let loadCalls = 0;
    const oversized = new SessionReadService({
      source: {
        hasSession: () => true,
        sessionCount: () => 1,
        listRecentSessionIds: () => [oversizedId],
        eventCount: () => DEFAULT_REPLAY_BOUNDS.maxEvents + 1,
        loadEvents: () => {
          loadCalls += 1;
          return [];
        }
      }
    });

    expect(oversized.readEvaluation(oversizedId)).toMatchObject({
      available: false,
      reason: "READ_LIMIT_EXCEEDED"
    });
    expect(oversized.readReplay(oversizedId)).toMatchObject({
      available: false,
      reason: "READ_LIMIT_EXCEEDED"
    });
    expect(loadCalls).toBe(0);
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
