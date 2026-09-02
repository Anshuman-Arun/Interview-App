import {
  BoardRevisionSchema,
  InputEpisodeIdSchema,
  SessionIdSchema,
  type BoardRevision,
  type InputEpisodeId,
  type SessionId
} from "../../../packages/domain/src/index.js";
import { TurnCoordinator } from "../../../packages/interview-engine/src/index.js";
import type { SessionRecoveryCoordinator } from "./session-recovery-coordinator.js";

export interface WhiteboardActivityEpisodeInput {
  readonly sessionId: SessionId;
  readonly inputEpisodeId: InputEpisodeId;
  readonly boardRevision: BoardRevision;
  readonly summary: string;
}

/**
 * Narrow multimodal join seam. This bridge deliberately does not create,
 * select, finalize, or commit InputEpisodes; a higher-level owner (including
 * the post-wave speech+board integration) decides which active episode receives
 * the already-authoritative whiteboard activity.
 */
export interface WhiteboardActivityEpisodeSink {
  readonly append: (input: WhiteboardActivityEpisodeInput) => Promise<void>;
}

export class TurnCoordinatorWhiteboardActivityEpisodeSink
implements WhiteboardActivityEpisodeSink {
  public constructor(private readonly sessions: SessionRecoveryCoordinator) {}

  public async append(input: WhiteboardActivityEpisodeInput): Promise<void> {
    const sessionId = SessionIdSchema.parse(input.sessionId);
    const inputEpisodeId = InputEpisodeIdSchema.parse(input.inputEpisodeId);
    const boardRevision = BoardRevisionSchema.parse(input.boardRevision);
    const summary = boundedSummary(input.summary);

    if (!this.sessions.hasSession(sessionId)) {
      throw new Error("Whiteboard activity session is not authoritative");
    }
    await this.sessions.ensureRecovered(sessionId);
    const writer = this.sessions.getWriter(sessionId);
    await new TurnCoordinator(writer).appendBoardInput(
      inputEpisodeId,
      summary,
      { alreadyCommittedBoardRevision: boardRevision }
    );
  }
}

function boundedSummary(value: string): string {
  if (typeof value !== "string") throw new TypeError("Whiteboard activity summary must be a string");
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 8_000) {
    throw new RangeError("Whiteboard activity summary must contain between 1 and 8000 characters");
  }
  return trimmed;
}
