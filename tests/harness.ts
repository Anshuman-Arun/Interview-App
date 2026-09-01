import {
  newSessionId,
  type CommandEnvelope,
  type DeliveryAtom,
  type GenerationId,
  type InputEpisodeId,
  type SessionId,
  type TurnId
} from "../packages/domain/src/index.js";
import { SqliteEventStore } from "../packages/persistence/src/index.js";
import { sixPeopleProblem } from "../packages/problems/src/index.js";
import {
  ClosedWorldDisclosureAnalyzer,
  DisclosureValidator,
  isGenerationBasisStillCompatible,
  SessionRuntimeRegistry,
  TurnCoordinator,
  createCommandEnvelope,
  type SessionWriter
} from "../packages/interview-engine/src/index.js";

export interface CoreHarness {
  readonly store: SqliteEventStore;
  readonly sessionId: SessionId;
  readonly writer: SessionWriter;
  readonly turns: TurnCoordinator;
  readonly inputEpisodeId: InputEpisodeId;
  readonly turnId: TurnId;
  readonly generationId: GenerationId;
  readonly safeProbe: string;
  readonly validator: DisclosureValidator;
}

export async function createCoreHarness(store = new SqliteEventStore(":memory:")): Promise<CoreHarness> {
  const sessionId = newSessionId();
  const writer = new SessionRuntimeRegistry(store).get(sessionId);
  const turns = new TurnCoordinator(writer);
  await turns.startSession(sixPeopleProblem);
  const { inputEpisodeId, turnId } = await turns.commitInput("I have a claim, but I have not justified it yet.");
  await turns.selectAction(turnId, sixPeopleProblem);
  const { generationId } = await turns.startGeneration(inputEpisodeId, turnId, "mock-model");
  const safeProbe = "Why must that step be true?";
  const validator = new DisclosureValidator(new ClosedWorldDisclosureAnalyzer([safeProbe]));
  return { store, sessionId, writer, turns, inputEpisodeId, turnId, generationId, safeProbe, validator };
}

export function providerEnvelope(harness: CoreHarness): CommandEnvelope {
  const basis = harness.writer.getState().generations[harness.generationId]?.basis;
  if (basis === undefined) throw new Error("Missing generation basis");
  return createCommandEnvelope({
    sessionId: harness.sessionId,
    producer: "mock-model",
    inputEpisodeId: harness.inputEpisodeId,
    turnId: harness.turnId,
    generationId: harness.generationId,
    contextEpoch: basis.contextEpoch,
    sourceRevision: basis.committedInputSequence
  });
}

export async function authorizeSafeProbe(harness: CoreHarness, envelope = providerEnvelope(harness)): Promise<DeliveryAtom> {
  const result = await harness.turns.processProposal({
    envelope,
    problem: sixPeopleProblem,
    proposal: {
      realizedAction: "PROBE_JUSTIFICATION",
      claimedDisclosureLevel: 0,
      claimedDisclosureIds: [],
      speechText: harness.safeProbe
    },
    validator: harness.validator
  });
  if (!result.accepted || result.deliveryAtoms[0] === undefined) throw new Error(`Safe proposal rejected: ${result.reason ?? "unknown"}`);
  return result.deliveryAtoms[0];
}

export async function ensureCompatibleGeneration(writer: SessionWriter): Promise<GenerationId> {
  const existing = Object.values(writer.getState().generations).find((generation) =>
    generation.status !== "SUPERSEDED"
    && generation.status !== "REJECTED"
    && isGenerationBasisStillCompatible(generation.basis, writer.getState()) === "COMPATIBLE"
  );
  if (existing !== undefined) return existing.generationId;
  const turns = new TurnCoordinator(writer);
  if (!writer.getState().started) {
    await turns.startSession(sixPeopleProblem);
  }
  const { inputEpisodeId, turnId } = await turns.commitInput("Renderer transport fixture input");
  await turns.selectAction(turnId, sixPeopleProblem);
  return (await turns.startGeneration(inputEpisodeId, turnId, "mock-renderer-fixture")).generationId;
}
