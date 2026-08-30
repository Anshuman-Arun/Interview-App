import { isDeepStrictEqual } from "node:util";
import {
  newSessionId
} from "../../domain/src/index.js";
import { replaySession, type SessionEvent, type SessionState } from "../../events/src/index.js";
import { DeliveryCoordinator, MockRenderer } from "../../delivery/src/index.js";
import { SqliteEventStore } from "../../persistence/src/index.js";
import { sixPeopleProblem } from "../../problems/src/index.js";
import { MockModelAdapter, assertProviderPermitted } from "../../providers/src/index.js";
import { ContextCoordinator } from "./context-coordinator.js";
import { ClosedWorldDisclosureAnalyzer, DisclosureValidator } from "./disclosure-validator.js";
import { createCommandEnvelope } from "./envelopes.js";
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
    await turns.selectAction(turnId);
    const { generationId } = await turns.startGeneration(inputEpisodeId, turnId, "mock-model");
    const compilation = await new ContextCoordinator(writer).compileForGeneration({ generationId, problem: sixPeopleProblem });
    if (!compilation.value.compiled) {
      throw new Error(`Context compilation failed: ${compilation.value.reason}`);
    }
    const context = compilation.value.context;

    const safeProbe = "Why must that step be true?";
    const provider = new MockModelAdapter({
      proposal: {
        realizedAction: "PROBE_JUSTIFICATION",
        claimedDisclosureLevel: 0,
        claimedDisclosureIds: [],
        speechText: safeProbe
      }
    });
    assertProviderPermitted({
      policy: { allowMeteredUsage: false, maximumDataUse: "LOCAL_ONLY", billingVerificationMaxAgeMs: 60_000 },
      capabilities: provider.capabilities,
      adapterVersion: provider.adapterVersion,
      billingVerification: {
        billingClass: "VERIFIED_FREE_ONLY",
        enforcementMechanism: "In-process deterministic mock contains no network or billing path",
        verifiedAt: new Date().toISOString(),
        adapterVersion: provider.adapterVersion,
        spendImpossible: true
      }
    });
    const providerSession = await provider.createSession();
    const validator = new DisclosureValidator(new ClosedWorldDisclosureAnalyzer([safeProbe]));
    for await (const proposal of providerSession.sendTurn({ context, generationId })) {
      const envelope = createCommandEnvelope({ sessionId, producer: "mock-model", generationId, inputEpisodeId, turnId });
      const authorized = await turns.processProposal({ envelope, problem: sixPeopleProblem, proposal, validator });
      if (!authorized.accepted) throw new Error(`Synthetic proposal was rejected: ${authorized.reason ?? "unknown reason"}`);
      const renderer = new MockRenderer();
      const delivery = new DeliveryCoordinator(writer);
      for (const atom of authorized.deliveryAtoms) await delivery.deliver(atom.deliveryId, renderer);
      await providerSession.close();
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
    }
    throw new Error("Mock provider returned no proposal");
  } finally {
    store.close();
  }
}
