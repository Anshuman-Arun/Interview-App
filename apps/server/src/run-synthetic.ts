import { runSyntheticInterview } from "../../../packages/interview-engine/src/index.js";

const result = await runSyntheticInterview();
const deliveryStatuses = Object.values(result.state.deliveries).map((atom) => atom.status);
const eventSequences = result.events.map((event) => event.sequence);
const expectedSequences = Array.from(
  { length: result.events.length },
  (_, index) => index + 1
);
const eventTypes = new Set(result.events.map((event) => event.type));
const requiredEventTypes = [
  "TURN_COMMITTED",
  "PEDAGOGICAL_ACTION_SELECTED",
  "MODEL_GENERATION_STARTED",
  "GENERATION_CONTEXT_COMPILED",
  "MODEL_PROPOSAL_RECEIVED",
  "PROPOSAL_VALIDATED",
  "DELIVERY_QUEUED",
  "DELIVERY_STARTED",
  "DELIVERY_EXPOSED",
  "DELIVERY_COMPLETED"
] as const;

if (!result.replayMatches) {
  throw new Error("Synthetic interview replay did not reconstruct identical state");
}
if (result.visibleDeliveryCount !== 1) {
  throw new Error(
    `Synthetic interview expected exactly one visible delivery, received ${String(result.visibleDeliveryCount)}`
  );
}
if (deliveryStatuses.length !== 1 || deliveryStatuses[0] !== "COMPLETED") {
  throw new Error(
    `Synthetic interview delivery did not complete: ${deliveryStatuses.join(",") || "none"}`
  );
}
if (
  eventSequences.length !== expectedSequences.length
  || eventSequences.some((sequence, index) => sequence !== expectedSequences[index])
) {
  throw new Error("Synthetic interview event sequence is not contiguous");
}
for (const eventType of requiredEventTypes) {
  if (!eventTypes.has(eventType)) {
    throw new Error(`Synthetic interview is missing required event ${eventType}`);
  }
}

console.log(JSON.stringify({
  sessionId: result.state.sessionId,
  eventCount: result.events.length,
  finalSequence: result.state.sequence,
  deliveryStatuses,
  visibleDeliveryCount: result.visibleDeliveryCount,
  replayMatches: result.replayMatches
}, null, 2));
