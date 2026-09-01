import {
  newSessionId,
  type GenerationId,
  type InputEpisodeId,
  type SessionId,
  type TurnId
} from "../packages/domain/src/index.js";
import { SqliteEventStore } from "../packages/persistence/src/index.js";
import { sixPeopleProblem } from "../packages/problems/src/six-people.js";
import {
  SessionRuntimeRegistry,
  TurnCoordinator,
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
}

export async function createCoreHarness(
  store = new SqliteEventStore(":memory:")
): Promise<CoreHarness> {
  const sessionId = newSessionId();
  const writer = new SessionRuntimeRegistry(store).get(sessionId);
  const turns = new TurnCoordinator(writer);
  await turns.startSession(sixPeopleProblem);
  const { inputEpisodeId, turnId } = await turns.commitInput(
    "I have a claim, but I have not justified it yet."
  );
  await turns.selectAction(turnId);
  const { generationId } = await turns.startGeneration(
    inputEpisodeId,
    turnId,
    "mock-model"
  );
  return { store, sessionId, writer, turns, inputEpisodeId, turnId, generationId };
}
