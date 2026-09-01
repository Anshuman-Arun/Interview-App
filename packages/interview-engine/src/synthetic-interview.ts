import { isDeepStrictEqual } from "node:util";
import {
  newSessionId
} from "../../domain/src/index.js";
import { replaySession, type SessionEvent, type SessionState } from "../../events/src/index.js";
import { DeliveryCoordinator, MockRenderer } from "../../delivery/src/index.js";
import { SqliteEventStore } from "../../persistence/src/index.js";
import { sixPeopleProblem } from "../../problems/src/index.js";
import { MockModelAdapter } from "../../providers/src/index.js";
import { ClosedWorldDisclosureAnalyzer, DisclosureValidator } from "./disclosure-validator.js";
import { ProviderCoordinator } from "./provider-coordinator.js";
import { SessionRuntimeRegistry } from "./session-writer.js";
import { TurnCoordinator } from "./turn-coordinator.js";

export interface SyntheticInterviewResult {
  readonly state: SessionState;
  readonly replayedState: SessionState;
  readonly events: readonly SessionEvent[];
  readonly visibleDeliveryCount: number;
  readonly replayMatches: boolean;
}

export async function runSyntheticInterview(databasePath = ":memory:"): Promise<SyntheticInterviewResult> {
  const store = new SqliteEventStore(databasePath);
  try {
    const sessionId = newSessionId();
    const writer = new SessionRuntimeRegistry(store).get(sessionId);
    const turns = new TurnCoordinator(writer);
    await turns.startSession(sixPeopleProblem);
    const { inputEpisodeId, turnId } = await turns.commitInput(
      "I represented people as vertices and relationships as two colours. I think one person must have three links of the same colour."
    );
    await turns.selectAction(turnId, sixPeopleProblem);
    const safeProbe = "Why must that step be true?";
    const provider = new MockModelAdapter({
      proposal: {
        realizedAction: "PROBE_JUSTIFICATION",
        claimedDisclosureLevel: 0,
        claimedDisclosureIds: [],
        speechText: safeProbe
      }
    });
    const validator = new DisclosureValidator(new ClosedWorldDisclosureAnalyzer([safeProbe]));
    const execution = await new ProviderCoordinator(writer).start({
      inputEpisodeId,
      turnId,
      provider,
      policy: { allowMeteredUsage: false, maximumDataUse: "LOCAL_ONLY", billingVerificationMaxAgeMs: 60_000 },
      problem: sixPeopleProblem,
      validator
    });
    const authorized = await execution.completion;
    if (authorized.status !== "ACCEPTED") {
      const detail = authorized.status === "FAILED" ? `${authorized.stage}:${authorized.code}` : authorized.status;
      throw new Error(`Synthetic proposal was not accepted: ${detail}`);
    }
    const renderer = new MockRenderer();
    const delivery = new DeliveryCoordinator(writer);
    for (const atom of authorized.deliveryAtoms) await delivery.deliver(atom.deliveryId, renderer);
    const events = store.load(sessionId);
    const state = writer.getState();
    const replayedState = replaySession(sessionId, events);
    return {
      state,
      replayedState,
      events,
      visibleDeliveryCount: renderer.visibleDeliveryIds.length,
      replayMatches: isDeepStrictEqual(state, replayedState)
    };
  } finally {
    store.close();
  }
}
