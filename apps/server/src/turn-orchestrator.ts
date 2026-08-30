import type {
  InputEpisodeId,
  InterviewerProposal,
  SessionId,
  TurnId
} from "../../../packages/domain/src/index.js";
import { sixPeopleProblem } from "../../../packages/problems/src/index.js";
import { MockModelAdapter } from "../../../packages/providers/src/index.js";
import {
  ClosedWorldDisclosureAnalyzer,
  DisclosureValidator,
  ProviderCoordinator,
  TurnCoordinator
} from "../../../packages/interview-engine/src/index.js";
import type { SessionRecoveryCoordinator } from "./session-recovery-coordinator.js";
import type { RendererStreamServer } from "./renderer-stream-server.js";

const DEFAULT_SAFE_PROBES = [
  "Why must at least three edges share the same color from vertex A?",
  "Consider vertex A with 5 incident edges. By the Pigeonhole Principle, what can we say about the colors of those 5 edges?",
  "Consider the three endpoints connected to vertex A by edges of the same color. What happens if any edge between them shares that color, and what happens if none of them do?",
  "Why must that step be true?",
  "Can you formalize the two cases for the edges among those three vertices?"
] as const;

export interface TurnOrchestrationInput {
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly inputEpisodeId: InputEpisodeId;
  readonly studentText: string;
}

export class ServerTurnOrchestrator {
  private readonly validator: DisclosureValidator;

  public constructor(
    private readonly sessions: SessionRecoveryCoordinator,
    private readonly getRendererStreamServer: () => RendererStreamServer | undefined,
    safeProbes: readonly string[] = DEFAULT_SAFE_PROBES
  ) {
    this.validator = new DisclosureValidator(new ClosedWorldDisclosureAnalyzer(safeProbes));
  }

  public async orchestrateTurn(input: TurnOrchestrationInput): Promise<void> {
    const writer = this.sessions.getWriter(input.sessionId);
    await this.sessions.ensureRecovered(input.sessionId);

    const turns = new TurnCoordinator(writer);

    // 1. Pedagogical policy selects the required action
    const realizationRequest = await turns.selectAction(input.turnId);

    // 2. Select contextual Oxford Socratic probe for Ramsey R(3,3)
    const probeText = this.selectSocraticProbe(input.studentText);

    const proposal: InterviewerProposal = {
      realizedAction: realizationRequest.requiredAction,
      claimedDisclosureLevel: 0,
      claimedDisclosureIds: [],
      speechText: probeText
    };

    // 3. MockModelAdapter with zero metered spend
    const provider = new MockModelAdapter({ proposal });

    // 4. ProviderCoordinator initiates generation, compiles context, and validates proposal
    const coordinator = new ProviderCoordinator(writer);
    const execution = await coordinator.start({
      inputEpisodeId: input.inputEpisodeId,
      turnId: input.turnId,
      provider,
      policy: {
        allowMeteredUsage: false,
        maximumDataUse: "LOCAL_ONLY",
        billingVerificationMaxAgeMs: 60_000
      },
      problem: sixPeopleProblem,
      validator: this.validator
    });

    try {
      const outcome = await execution.completion;
      if (outcome.status !== "ACCEPTED") {
        return;
      }

      // 5. Publish delivery atoms to active renderer stream (SSE)
      const streamServer = this.getRendererStreamServer();
      if (streamServer !== undefined) {
        for (const atom of outcome.deliveryAtoms) {
          await streamServer.publishDelivery(input.sessionId, atom.deliveryId);
        }
      }
    } catch {
      // Teardown / session close during test or shutdown is handled gracefully
    }
  }

  private selectSocraticProbe(studentText: string): string {
    const text = studentText.toLowerCase();
    if (
      text.includes("pigeonhole") ||
      text.includes("3") ||
      text.includes("three") ||
      text.includes("same color") ||
      text.includes("same colour")
    ) {
      return "Consider the three endpoints connected to vertex A by edges of the same color. What happens if any edge between them shares that color, and what happens if none of them do?";
    }
    return "Why must at least three edges share the same color from vertex A?";
  }
}
