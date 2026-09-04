import { describe, expect, it } from "vitest";
import {
  FormalInterpretationRequestSchema,
  InterpretationProviderResultSchema,
  type FormalInterpretationRequest
} from "../packages/domain/src/index.js";
import {
  isOxfordFormalAnalysisSourceRelevant,
  isOxfordFormalCandidateTargetAdmissible
} from "../apps/server/src/oxford-formal-candidate-admission.js";
import {
  resolveOxfordFormalAnalysisProfile
} from "../apps/server/src/oxford-formal-analysis-catalog.js";

function requestFor(
  problemId: string,
  sourceText: string
): FormalInterpretationRequest {
  const profile = resolveOxfordFormalAnalysisProfile({
    id: problemId,
    version: "1.0.0"
  });
  if (profile === undefined) throw new Error("Missing formal profile " + problemId);
  return FormalInterpretationRequestSchema.parse({
    protocolVersion: 1,
    requestId: "request-" + problemId,
    sessionId: "session-1",
    basis: {
      contextEpoch: 1,
      committedInputSequence: 1,
      transcriptRevision: 1,
      boardRevision: 0,
      problemStateRevision: 1,
      policyRevision: 0,
      inputEpisodeId: "episode-1",
      turnId: "turn-1"
    },
    source: {
      kind: "TURN_TEXT",
      inputEpisodeId: "episode-1",
      turnId: "turn-1",
      sourceRevision: 1,
      eventIds: ["event-1"],
      span: {
        start: 0,
        end: sourceText.length,
        text: sourceText
      }
    },
    problem: {
      id: profile.problemId,
      version: profile.problemVersion
    },
    target: profile.target,
    allowedProtocols: profile.allowedProtocols
  });
}

function candidateFor(
  request: FormalInterpretationRequest,
  formalStatement: string
) {
  const protocol = request.allowedProtocols[0];
  if (protocol === undefined) throw new Error("Expected allowed protocol");
  return InterpretationProviderResultSchema.parse({
    protocolVersion: 1,
    requestId: request.requestId,
    candidates: [{
      protocolVersion: 1,
      candidateId: "candidate-1",
      protocol,
      formalStatement,
      confidence: 1,
      target: request.target,
      source: {
        requestId: request.requestId,
        basis: request.basis,
        sourceRevision: request.source.sourceRevision,
        inputEpisodeId: request.source.inputEpisodeId,
        turnId: request.source.turnId,
        eventIds: request.source.eventIds,
        span: request.source.span,
        problem: request.problem
      }
    }]
  }).candidates[0];
}

function admitted(problemId: string, sourceText: string, formalStatement: string): boolean {
  const request = requestFor(problemId, sourceText);
  const profile = resolveOxfordFormalAnalysisProfile(request.problem);
  if (profile === undefined) throw new Error("Missing formal profile");
  const candidate = candidateFor(request, formalStatement);
  if (candidate === undefined) throw new Error("Missing candidate");
  return isOxfordFormalCandidateTargetAdmissible({
    profile,
    request,
    candidate
  });
}

function rational(value: string) {
  return {
    kind: "RATIONAL",
    value: { numerator: value, denominator: "1" }
  };
}

function integer(value: string) {
  return { kind: "INTEGER", value };
}

describe("Oxford formal target admission", () => {
  it("requires target-specific source context across every production profile", () => {
    const relevant = [
      ["oxford-domino-chessboard", "Thirty-two minus two leaves thirty black squares."],
      ["oxford-euclid-primes", "The product plus one leaves remainder one modulo each listed prime."],
      ["oxford-prefix-sums-mod-n", "Two prefix sums have the same residue, so subtract them."],
      ["oxford-triangle-medians", "The centroid lies two thirds of the way along each median."],
      ["oxford-divisibility-chain", "These two chosen numbers have the same odd part, so the smaller divides the larger."]
    ] as const;
    const irrelevant = [
      ["oxford-domino-chessboard", "One half equals two fourths."],
      ["oxford-euclid-primes", "Four leaves remainder one modulo three."],
      ["oxford-euclid-primes", "Two plus one is three."],
      ["oxford-prefix-sums-mod-n", "Four has residue zero."],
      ["oxford-prefix-sums-mod-n", "The prefix sums are two and four."],
      ["oxford-triangle-medians", "The ratio is two to one."],
      ["oxford-divisibility-chain", "Three divides twelve."],
      ["oxford-divisibility-chain", "The powers of two here are two and four."]
    ] as const;

    for (const [problemId, text] of relevant) {
      const profile = resolveOxfordFormalAnalysisProfile({ id: problemId, version: "1.0.0" });
      if (profile === undefined) throw new Error("Missing formal profile");
      expect(isOxfordFormalAnalysisSourceRelevant(profile, text)).toBe(true);
    }
    for (const [problemId, text] of irrelevant) {
      const profile = resolveOxfordFormalAnalysisProfile({ id: problemId, version: "1.0.0" });
      if (profile === undefined) throw new Error("Missing formal profile");
      expect(isOxfordFormalAnalysisSourceRelevant(profile, text)).toBe(false);
    }
  });

  it("admits only source-grounded target-shaped concrete statements", () => {
    expect(admitted(
      "oxford-domino-chessboard",
      "Thirty-two black squares minus two removed black corners equals thirty black squares.",
      JSON.stringify({
        protocol: "INTERVIEW_APP_RATIONAL_ARITHMETIC_CLAIM",
        protocolVersion: 1,
        claim: {
          kind: "EQUALITY",
          left: {
            kind: "SUBTRACT",
            left: rational("32"),
            right: rational("2")
          },
          right: rational("30")
        }
      })
    )).toBe(true);

    expect(admitted(
      "oxford-euclid-primes",
      "For listed primes 2, 3, and 5, the product plus one is 31 and leaves remainder 1 modulo 2.",
      JSON.stringify({
        protocol: "INTERVIEW_APP_MODULAR_ARITHMETIC_CLAIM",
        protocolVersion: 1,
        claim: {
          kind: "CONGRUENCE",
          left: integer("31"),
          right: integer("1"),
          modulus: "2"
        }
      })
    )).toBe(true);

    expect(admitted(
      "oxford-prefix-sums-mod-n",
      "For n 5, two prefix sums are 12 and 7, so their difference 5 is divisible by 5.",
      JSON.stringify({
        protocol: "INTERVIEW_APP_MODULAR_ARITHMETIC_CLAIM",
        protocolVersion: 1,
        claim: {
          kind: "DIVISIBILITY",
          divisor: "5",
          dividend: {
            kind: "SUBTRACT",
            left: integer("12"),
            right: integer("7")
          }
        }
      })
    )).toBe(true);

    expect(admitted(
      "oxford-triangle-medians",
      "Along the median, the centroid is two thirds from the vertex, leaving one third; two thirds divided by one third is two, so the ratio is two to one.",
      JSON.stringify({
        protocol: "INTERVIEW_APP_RATIONAL_ARITHMETIC_CLAIM",
        protocolVersion: 1,
        claim: {
          kind: "EQUALITY",
          left: {
            kind: "DIVIDE",
            left: {
              kind: "RATIONAL",
              value: { numerator: "2", denominator: "3" }
            },
            right: {
              kind: "RATIONAL",
              value: { numerator: "1", denominator: "3" }
            }
          },
          right: rational("2")
        }
      })
    )).toBe(true);

    expect(admitted(
      "oxford-divisibility-chain",
      "The chosen numbers 6 and 24 have the same odd part, and 6 divides 24.",
      JSON.stringify({
        protocol: "INTERVIEW_APP_MODULAR_ARITHMETIC_CLAIM",
        protocolVersion: 1,
        claim: {
          kind: "DIVISIBILITY",
          divisor: "6",
          dividend: integer("24")
        }
      })
    )).toBe(true);
  });

  it("admits source-faithful false claims so the deterministic verifier can contradict them", () => {
    expect(admitted(
      "oxford-domino-chessboard",
      "Thirty-two black squares minus two removed black corners equals thirty-one black squares.",
      JSON.stringify({
        protocol: "INTERVIEW_APP_RATIONAL_ARITHMETIC_CLAIM",
        protocolVersion: 1,
        claim: {
          kind: "EQUALITY",
          left: {
            kind: "SUBTRACT",
            left: rational("32"),
            right: rational("2")
          },
          right: rational("31")
        }
      })
    )).toBe(true);

    expect(admitted(
      "oxford-triangle-medians",
      "Along the median, the centroid is two thirds from the vertex, leaving one third; two thirds divided by one third is one.",
      JSON.stringify({
        protocol: "INTERVIEW_APP_RATIONAL_ARITHMETIC_CLAIM",
        protocolVersion: 1,
        claim: {
          kind: "EQUALITY",
          left: {
            kind: "DIVIDE",
            left: {
              kind: "RATIONAL",
              value: { numerator: "2", denominator: "3" }
            },
            right: {
              kind: "RATIONAL",
              value: { numerator: "1", denominator: "3" }
            }
          },
          right: rational("1")
        }
      })
    )).toBe(true);
  });

  it("rejects invented numerals and target-shaped trivial substitutions", () => {
    expect(admitted(
      "oxford-domino-chessboard",
      "Thirty-two black squares minus two removed black corners equals thirty black squares.",
      JSON.stringify({
        protocol: "INTERVIEW_APP_RATIONAL_ARITHMETIC_CLAIM",
        protocolVersion: 1,
        claim: {
          kind: "EQUALITY",
          left: {
            kind: "SUBTRACT",
            left: rational("32"),
            right: rational("2")
          },
          right: rational("31")
        }
      })
    )).toBe(false);

    expect(admitted(
      "oxford-domino-chessboard",
      "The domino color count uses the number two.",
      JSON.stringify({
        protocol: "INTERVIEW_APP_RATIONAL_ARITHMETIC_CLAIM",
        protocolVersion: 1,
        claim: {
          kind: "EQUALITY",
          left: rational("2"),
          right: rational("2")
        }
      })
    )).toBe(false);

    expect(admitted(
      "oxford-euclid-primes",
      "For the listed prime 31, the product plus one 31 leaves remainder 0 modulo 31.",
      JSON.stringify({
        protocol: "INTERVIEW_APP_MODULAR_ARITHMETIC_CLAIM",
        protocolVersion: 1,
        claim: {
          kind: "CONGRUENCE",
          left: integer("31"),
          right: integer("0"),
          modulus: "31"
        }
      })
    )).toBe(false);

    expect(admitted(
      "oxford-triangle-medians",
      "Along the median, the centroid ratio uses 2 and 1.",
      JSON.stringify({
        protocol: "INTERVIEW_APP_RATIONAL_ARITHMETIC_CLAIM",
        protocolVersion: 1,
        claim: {
          kind: "EQUALITY",
          left: rational("2"),
          right: rational("2")
        }
      })
    )).toBe(false);

    expect(admitted(
      "oxford-prefix-sums-mod-n",
      "The prefix sums are 5 and 10, and 5 divides 10.",
      JSON.stringify({
        protocol: "INTERVIEW_APP_MODULAR_ARITHMETIC_CLAIM",
        protocolVersion: 1,
        claim: {
          kind: "DIVISIBILITY",
          divisor: "5",
          dividend: integer("10")
        }
      })
    )).toBe(false);

    expect(admitted(
      "oxford-divisibility-chain",
      "The chosen numbers 6 and 24 have odd part 3, and 3 divides 24.",
      JSON.stringify({
        protocol: "INTERVIEW_APP_MODULAR_ARITHMETIC_CLAIM",
        protocolVersion: 1,
        claim: {
          kind: "DIVISIBILITY",
          divisor: "3",
          dividend: integer("24")
        }
      })
    )).toBe(false);

    expect(admitted(
      "oxford-divisibility-chain",
      "The numbers 6 and 24 have the same odd part.",
      JSON.stringify({
        protocol: "INTERVIEW_APP_MODULAR_ARITHMETIC_CLAIM",
        protocolVersion: 1,
        claim: {
          kind: "CONGRUENCE",
          left: integer("24"),
          right: integer("0"),
          modulus: "6"
        }
      })
    )).toBe(false);
  });
});
