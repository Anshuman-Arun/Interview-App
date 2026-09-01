import { describe, expect, it } from "vitest";
import { MockModelAdapter } from "../packages/providers/src/index.js";
import { sixPeopleProblem } from "../packages/problems/src/index.js";
import { createCommandEnvelope } from "../packages/interview-engine/src/index.js";
import { createCoreHarness } from "./harness.js";

function proposalEnvelope(
  harness: Awaited<ReturnType<typeof createCoreHarness>>,
  generationId: typeof harness.generationId,
  producer: string
) {
  const generation = harness.writer.getState().generations[generationId];
  if (generation === undefined) throw new Error("Missing generation basis");
  return createCommandEnvelope({
    sessionId: harness.sessionId,
    producer,
    generationId,
    ...(generation.basis.inputEpisodeId === undefined
      ? {}
      : { inputEpisodeId: generation.basis.inputEpisodeId }),
    turnId: generation.basis.turnId,
    contextEpoch: generation.basis.contextEpoch,
    sourceRevision: generation.basis.committedInputSequence
  });
}

describe("provider lifecycle remains subordinate to application state", () => {
  it("rejects output that arrives after an ignored provider cancellation", async () => {
    const harness = await createCoreHarness();
    try {
      const provider = new MockModelAdapter({
        cancellationBehavior: "IGNORE",
        proposal: { realizedAction: "PROBE_JUSTIFICATION", claimedDisclosureLevel: 0, claimedDisclosureIds: [], speechText: harness.safeProbe }
      });
      const session = await provider.createSession();
      await session.cancelTurn?.(harness.generationId);
      await harness.turns.commitBoardPatch("new user work supersedes the request");
      for await (const proposal of session.sendTurn({ context: {}, generationId: harness.generationId })) {
        const result = await harness.turns.processProposal({
          envelope: proposalEnvelope(harness, harness.generationId, provider.name),
          problem: sixPeopleProblem,
          proposal,
          validator: harness.validator
        });
        expect(result.accepted).toBe(false);
      }
      expect(Object.keys(harness.writer.getState().deliveries)).toHaveLength(0);
      await session.close();
    } finally {
      harness.store.close();
    }
  });

  it("allows an application-controlled provider switch while late output from the first stays inert", async () => {
    const harness = await createCoreHarness();
    try {
      await harness.turns.supersedeGeneration(harness.generationId, "provider failover");
      const replacement = await harness.turns.startGeneration(harness.inputEpisodeId, harness.turnId, "mock-provider-b");
      const late = await harness.turns.processProposal({
        envelope: proposalEnvelope(harness, harness.generationId, "mock-provider-a"),
        problem: sixPeopleProblem,
        proposal: { realizedAction: "PROBE_JUSTIFICATION", claimedDisclosureLevel: 0, claimedDisclosureIds: [], speechText: harness.safeProbe },
        validator: harness.validator
      });
      const current = await harness.turns.processProposal({
        envelope: proposalEnvelope(harness, replacement.generationId, "mock-provider-b"),
        problem: sixPeopleProblem,
        proposal: { realizedAction: "PROBE_JUSTIFICATION", claimedDisclosureLevel: 0, claimedDisclosureIds: [], speechText: harness.safeProbe },
        validator: harness.validator
      });
      expect(late.accepted).toBe(false);
      expect(current.accepted).toBe(true);
      expect(current.deliveryAtoms).toHaveLength(1);
      expect(harness.writer.getState().generations[harness.generationId]?.status).toBe("SUPERSEDED");
    } finally {
      harness.store.close();
    }
  });
});
