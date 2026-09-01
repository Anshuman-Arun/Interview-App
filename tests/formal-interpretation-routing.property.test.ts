import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  InterpretationProviderResultSchema,
  type EvidenceKey,
  type FormalProtocolRef
} from "../packages/domain/src/index.js";
import { createFormalInterpretationRequest } from "../packages/interview-engine/src/formal-interpretation.js";
import { FormalProtocolRoutingRegistry } from "../packages/interview-engine/src/formal-protocol-routing.js";
import { echoInterpretationCandidateSource } from "../packages/interview-engine/src/interpretation-coordinator.js";
import { DETERMINISTIC_MATH_VERIFIERS } from "../packages/verification/src/index.js";
import { createCoreHarness } from "./formal-interpretation-harness.js";

const target: EvidenceKey = {
  problemId: "oxford-six-people",
  subject: { kind: "CLAIM", claimId: "eta-property-claim" },
  dimension: "CORRECTNESS"
};

const scopes = DETERMINISTIC_MATH_VERIFIERS.map((entry) => ({
  verifier: entry.verifier,
  evidenceKey: target
}));

const supported: readonly FormalProtocolRef[] = [
  { protocol: "MODULAR_ARITHMETIC", version: 1 },
  { protocol: "RATIONAL_ARITHMETIC", version: 1 },
  { protocol: "FINITE_RECURRENCE", version: 1 },
  { protocol: "COMBINATORIAL_COUNTING", version: 1 },
  { protocol: "PROBABILITY_ARITHMETIC", version: 1 }
];

describe("formal interpretation routing properties", () => {
  it("never allows a provider-supplied verifier field into a candidate", async () => {
    const harness = await createCoreHarness();
    try {
      const request = createFormalInterpretationRequest(harness.writer, {
        generationId: harness.generationId,
        target,
        allowedProtocols: supported
      });
      await fc.assert(fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 80 }),
        async (verifier) => {
          const candidate = {
            protocolVersion: 1,
            candidateId: "candidate",
            protocol: supported[0],
            formalStatement: "{}",
            confidence: 1,
            target,
            source: echoInterpretationCandidateSource(request),
            verifier
          };
          expect(InterpretationProviderResultSchema.safeParse({
            protocolVersion: 1,
            requestId: request.requestId,
            candidates: [candidate]
          }).success).toBe(false);
        }
      ), { numRuns: 50, seed: 20260831 });
    } finally {
      harness.store.close();
    }
  });

  it("each supported protocol resolves to exactly one application-owned authorized verifier", () => {
    const registry = new FormalProtocolRoutingRegistry(scopes);
    fc.assert(fc.property(
      fc.integer({ min: 0, max: supported.length - 1 }),
      (index) => {
        const protocol = supported[index];
        if (protocol === undefined) throw new Error("Generated protocol index is impossible");
        const resolution = registry.resolve(protocol, target);
        expect(resolution.ok).toBe(true);
        if (!resolution.ok) return;
        expect(DETERMINISTIC_MATH_VERIFIERS.filter((descriptor) =>
          descriptor.verifier === resolution.definition.verifier
          && descriptor.protocol === resolution.definition.verifierProtocol
          && descriptor.protocolVersion === resolution.definition.verifierProtocolVersion
        )).toHaveLength(1);
      }
    ), { numRuns: 100, seed: 20260831 });
  });

  it("never authorizes a different evidence target merely because the protocol is supported", () => {
    const registry = new FormalProtocolRoutingRegistry(scopes);
    fc.assert(fc.property(
      fc.integer({ min: 0, max: supported.length - 1 }),
      fc.string({ minLength: 1, maxLength: 40 }),
      (index, suffix) => {
        const protocol = supported[index];
        if (protocol === undefined) throw new Error("Generated protocol index is impossible");
        const otherTarget: EvidenceKey = {
          ...target,
          subject: { kind: "CLAIM", claimId: `other-${suffix}` }
        };
        expect(registry.resolve(protocol, otherTarget)).toEqual({
          ok: false,
          reason: "VERIFIER_UNAUTHORIZED"
        });
      }
    ), { numRuns: 100, seed: 20260831 });
  });
});
