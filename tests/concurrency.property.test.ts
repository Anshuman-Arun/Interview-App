import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createCoreHarness, providerEnvelope } from "./harness.js";
import { sixPeopleProblem } from "../packages/problems/src/index.js";

describe("randomized callback ordering invariants", () => {
  it("never delivers a generation after any basis-changing revision", async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(fc.constantFrom("BOARD", "TRANSCRIPT"), { minLength: 1, maxLength: 8 }),
      async (operations) => {
        const harness = await createCoreHarness();
        try {
          await Promise.all(operations.map(async (operation, index) => {
            if (operation === "BOARD") await harness.turns.commitBoardPatch(`random patch ${String(index)}`);
            else await harness.turns.correctTranscript(`random correction ${String(index)}`);
          }));
          const result = await harness.turns.processProposal({
            envelope: providerEnvelope(harness),
            problem: sixPeopleProblem,
            proposal: { realizedAction: "PROBE_JUSTIFICATION", claimedDisclosureLevel: 0, claimedDisclosureIds: [], speechText: harness.safeProbe },
            validator: harness.validator
          });
          expect(result.accepted).toBe(false);
          expect(Object.keys(harness.writer.getState().deliveries)).toHaveLength(0);
          const events = harness.store.load(harness.sessionId);
          expect(events.every((event, index) => event.sequence === index + 1)).toBe(true);
        } finally {
          harness.store.close();
        }
      }
    ), { numRuns: 30, seed: 20260828 });
  });
});
