import type { SessionId } from "../../domain/src/index.js";
import type { SessionEvent } from "../../events/src/index.js";
import { validateKnownReplayPrefix } from "./validation.js";

/**
 * Recovery-only admission seam.
 *
 * Validates the complete persisted current-version prefix that recovery is about
 * to act on, while deliberately allowing crash-pending follow-ups at the end of
 * an otherwise valid prefix. It exposes no replay projection/state internals.
 */
export function assertReplayPrefixValidForRecovery(
  sessionId: SessionId,
  events: readonly SessionEvent[]
): void {
  validateKnownReplayPrefix(sessionId, events);
}
