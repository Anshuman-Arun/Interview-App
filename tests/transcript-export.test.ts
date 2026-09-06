import { describe, expect, it } from "vitest";
import { generateLatexTranscript } from "../apps/web/src/export/transcript-export.js";
import { SessionIdSchema } from "../packages/domain/src/index.js";
import type { SessionEvaluationReadResponse, SessionReplayReadResponse } from "../packages/replay/src/index.js";

describe("Oxford tutorial transcript export", () => {
  it("generates a formatted LaTeX tutorial transcript with evaluation and dialogue", () => {
    const sessionId = SessionIdSchema.parse("session_test-123");
    const evaluation = {
      available: true,
      sessionId: sessionId,
      evaluation: {
        sessionId: sessionId,
        evaluatedAt: new Date().toISOString(),
        composite: { score: 88, supportLevel: "STRONG", status: "FULL", includedDimensions: ["technicalCorrectness", "rigor"], omittedDimensions: [] },
        summaryAssessment: "Excellent grasp of invariant subspaces.",
        dimensions: [
          { name: "technicalCorrectness", score: 90, supportLevel: "STRONG", evidenceRefs: [], evidenceRefTruncation: { truncated: false, limit: 32, remainingCount: 0 } },
          { name: "rigor", score: 85, supportLevel: "STRONG", evidenceRefs: [], evidenceRefTruncation: { truncated: false, limit: 32, remainingCount: 0 } }
        ],
        keyStrengths: ["Clear proof structure", "Proactive error checking"],
        areasForImprovement: ["State boundary conditions explicitly"],
        milestoneSummary: { achieved: 3, total: 3, unassisted: 2, assisted: 1 },
        disclosedInterventions: []
      }
    } as unknown as SessionEvaluationReadResponse;

    const replay = {
      available: true,
      sessionId: sessionId,
      replay: {
        sessionId: sessionId,
        complete: true,
        currentStateAvailable: true,
        entries: [
          {
            eventId: "evt-1",
            sequence: 1,
            occurredAt: new Date().toISOString(),
            category: "INTERVIEWER_DELIVERY",
            summary: "Initial problem presentation",
            text: { text: "Consider a finite-dimensional vector space V...", originalLength: 46, truncated: false }
          },
          {
            eventId: "evt-2",
            sequence: 2,
            occurredAt: new Date().toISOString(),
            category: "STUDENT",
            summary: "Student formulation",
            text: { text: "Let T: V -> V be a linear operator...", originalLength: 36, truncated: false }
          },
          {
            eventId: "evt-3",
            sequence: 3,
            occurredAt: new Date().toISOString(),
            category: "WHITEBOARD",
            summary: "Whiteboard drawing",
            delivery: {
              deliveryId: "del-1",
              generationId: "gen-1",
              medium: "WHITEBOARD",
              persistedAtomStatus: "DELIVERED",
              status: "DELIVERED",
              presentationState: "PRESENTED",
              disclosure: { effectiveDisclosureLevel: 0, disclosureIdCount: 0 },
              boardAction: {
                operation: "write_equation",
                content: { text: "det(T - \\lambda I) = 0", originalLength: 22, truncated: false }
              }
            }
          }
        ]
      }
    } as unknown as SessionReplayReadResponse;

    const latex = generateLatexTranscript({
      sessionId: sessionId,
      problemTitle: "Eigenvalues & Invariants",
      evaluation,
      replay
    });

    expect(latex).toContain("\\documentclass");
    expect(latex).toContain("Oxford Tutorial Summary");
    expect(latex).toContain("Eigenvalues \\& Invariants");
    expect(latex).toContain("Excellent grasp of invariant subspaces.");
    expect(latex).toContain("Clear proof structure");
    expect(latex).toContain("Consider a finite-dimensional vector space V...");
    expect(latex).toContain("Let T: V -> V be a linear operator...");
    expect(latex).toContain("det(T - \\textbackslash\\{\\}lambda I) = 0");
  });
});
