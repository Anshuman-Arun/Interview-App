import { runSyntheticInterview } from "../../../packages/interview-engine/src/index.js";

const result = await runSyntheticInterview();
console.log(JSON.stringify({
  sessionId: result.state.sessionId,
  eventCount: result.events.length,
  finalSequence: result.state.sequence,
  deliveryStatuses: Object.values(result.state.deliveries).map((atom) => atom.status),
  visibleDeliveryCount: result.visibleDeliveryCount,
  replayMatches: result.replayMatches
}, null, 2));

