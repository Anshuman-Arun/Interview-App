import { describe, expect, it } from "vitest";
import { runSyntheticInterview } from "../packages/interview-engine/src/index.js";

describe("synthetic Phase 0 vertical slice", () => {
  it("runs input through exposure and reconstructs identical state", async () => {
    const result = await runSyntheticInterview();
    expect(result.replayMatches).toBe(true);
    expect(result.visibleDeliveryCount).toBe(1);
    expect(Object.values(result.state.deliveries).map((item) => item.status)).toEqual(["COMPLETED"]);
    expect(result.events.map((event) => event.sequence)).toEqual(
      Array.from({ length: result.events.length }, (_, index) => index + 1)
    );
    expect(result.events.map((event) => event.type)).toEqual(expect.arrayContaining([
      "TURN_COMMITTED",
      "PEDAGOGICAL_ACTION_SELECTED",
      "MODEL_GENERATION_STARTED",
      "MODEL_PROPOSAL_RECEIVED",
      "PROPOSAL_VALIDATED",
      "DELIVERY_QUEUED",
      "DELIVERY_STARTED",
      "DELIVERY_EXPOSED",
      "DELIVERY_COMPLETED"
    ]));
  });
});

