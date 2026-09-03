import type {
  EvidenceKey,
  FormalProtocolRef
} from "../../../packages/domain/src/index.js";
import {
  FORMAL_PROTOCOL_ROUTES,
  type FormalProtocolRoutingScope
} from "../../../packages/interview-engine/src/index.js";

export interface OxfordFormalAnalysisProfile {
  readonly problemId: string;
  readonly problemVersion: string;
  readonly target: EvidenceKey;
  readonly allowedProtocols: readonly FormalProtocolRef[];
  readonly scopes: readonly FormalProtocolRoutingScope[];
}

interface ProfileSpec {
  readonly problemId: string;
  readonly problemVersion: string;
  readonly claimId: string;
  readonly allowedProtocols: readonly FormalProtocolRef[];
}

const PROFILE_SPECS: readonly ProfileSpec[] = Object.freeze([
  {
    problemId: "oxford-domino-chessboard",
    problemVersion: "1.0.0",
    claimId: "color-count-arithmetic",
    allowedProtocols: [{ protocol: "RATIONAL_ARITHMETIC", version: 1 }]
  },
  {
    problemId: "oxford-euclid-primes",
    problemVersion: "1.0.0",
    claimId: "listed-prime-remainder",
    allowedProtocols: [{ protocol: "MODULAR_ARITHMETIC", version: 1 }]
  },
  {
    problemId: "oxford-prefix-sums-mod-n",
    problemVersion: "1.0.0",
    claimId: "prefix-residue-arithmetic",
    allowedProtocols: [{ protocol: "MODULAR_ARITHMETIC", version: 1 }]
  },
  {
    problemId: "oxford-triangle-medians",
    problemVersion: "1.0.0",
    claimId: "median-ratio-arithmetic",
    allowedProtocols: [{ protocol: "RATIONAL_ARITHMETIC", version: 1 }]
  },
  {
    problemId: "oxford-divisibility-chain",
    problemVersion: "1.0.0",
    claimId: "divisibility-step",
    allowedProtocols: [{ protocol: "MODULAR_ARITHMETIC", version: 1 }]
  }
]);

const PROFILES = new Map<string, OxfordFormalAnalysisProfile>(
  PROFILE_SPECS.map((spec) => {
    const target: EvidenceKey = {
      problemId: spec.problemId,
      subject: { kind: "CLAIM", claimId: spec.claimId },
      dimension: "CORRECTNESS"
    };
    const scopes = spec.allowedProtocols.map((protocol) => {
      const route = FORMAL_PROTOCOL_ROUTES.find((candidate) =>
        candidate.protocol === protocol.protocol && candidate.version === protocol.version
      );
      if (route === undefined) {
        throw new Error("Oxford formal-analysis profile references an unavailable protocol");
      }
      return {
        verifier: route.verifier,
        evidenceKey: target
      } satisfies FormalProtocolRoutingScope;
    });
    const profile: OxfordFormalAnalysisProfile = Object.freeze({
      problemId: spec.problemId,
      problemVersion: spec.problemVersion,
      target: Object.freeze({
        ...target,
        subject: Object.freeze({ ...target.subject })
      }),
      allowedProtocols: Object.freeze(spec.allowedProtocols.map((protocol) => Object.freeze({ ...protocol }))),
      scopes: Object.freeze(scopes.map((scope) => Object.freeze({
        verifier: scope.verifier,
        evidenceKey: scope.evidenceKey
      })))
    });
    return [profile.problemId + "\u0000" + profile.problemVersion, profile] as const;
  })
);

export function resolveOxfordFormalAnalysisProfile(
  problem: { readonly id: string; readonly version: string }
): OxfordFormalAnalysisProfile | undefined {
  return PROFILES.get(problem.id + "\u0000" + problem.version);
}

export function listOxfordFormalAnalysisProfiles(): readonly OxfordFormalAnalysisProfile[] {
  return [...PROFILES.values()];
}
