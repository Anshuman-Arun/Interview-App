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

const DEFAULT_INDEPENDENT_SAFE_PROBES = [
  "What relations exist between vertex A and the other five people?",
  "Why must that step be true?",
  "Why must that claim hold?",
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
  private readonly inFlight = new Map<string, Promise<void>>();

  public constructor(
    private readonly sessions: SessionRecoveryCoordinator,
    private readonly getRendererStreamServer: () => RendererStreamServer | undefined,
    validator?: DisclosureValidator
  ) {
    this.validator = validator ?? new DisclosureValidator(new ClosedWorldDisclosureAnalyzer(DEFAULT_INDEPENDENT_SAFE_PROBES));
  }

  public async orchestrateTurn(input: TurnOrchestrationInput): Promise<void> {
    const key = `${input.sessionId}:${input.turnId}`;
    const existing = this.inFlight.get(key);
    if (existing !== undefined) {
      return existing;
    }

    const orchestration = this.executeOrchestration(input).finally(() => {
      this.inFlight.delete(key);
    });

    this.inFlight.set(key, orchestration);
    return orchestration;
  }

  public async waitForAll(): Promise<void> {
    await Promise.all(Array.from(this.inFlight.values()));
  }

  public async recoverPendingTurns(sessionId: SessionId): Promise<void> {
    const writer = this.sessions.getWriter(sessionId);
    const state = writer.getState();
    if (!state.started || state.status !== "ACTIVE") {
      return;
    }

    const turns = new TurnCoordinator(writer);

    for (const [turnId, turn] of Object.entries(state.turns)) {
      if (turn.studentText.length === 0) continue;

      const hasValidatedGeneration = Object.values(state.generations).some(
        (g) => g.basis.turnId === turnId && g.status === "VALIDATED"
      );
      const hasDeliveries = Object.values(state.deliveries).some(
        (d) => Object.values(state.generations).some((g) => g.generationId === d.generationId && g.basis.turnId === turnId)
      );

      // Clean up stranded in-flight generations from pre-crash processes
      const strandedGenerations = Object.values(state.generations).filter(
        (g) => g.basis.turnId === turnId && (g.status === "ACTIVE" || g.status === "PROPOSAL_RECEIVED")
      );
      for (const stranded of strandedGenerations) {
        await turns.supersedeGeneration(stranded.generationId, "CRASH_RECOVERY_STRANDED");
      }

      if (!hasValidatedGeneration && !hasDeliveries) {
        await this.orchestrateTurn({
          sessionId,
          turnId: turnId as TurnId,
          inputEpisodeId: turn.inputEpisodeId,
          studentText: turn.studentText
        });
      }
    }
  }

  private async executeOrchestration(input: TurnOrchestrationInput): Promise<void> {
    const writer = this.sessions.getWriter(input.sessionId);

    // Check if turn already has validated generation or deliveries to ensure strict idempotency
    const currentState = writer.getState();
    const existingGeneration = Object.values(currentState.generations).find(
      (g) => g.basis.turnId === input.turnId && g.status === "VALIDATED"
    );
    if (existingGeneration !== undefined) {
      return;
    }

    const turns = new TurnCoordinator(writer);

    // 1. Pedagogical policy selects the required action
    const realizationRequest = await turns.selectAction(input.turnId);

    // 2. Select contextual Oxford Socratic probe based on maximumDisclosure authorized
    const proposal = this.createInterviewerProposal(
      input.studentText,
      realizationRequest.requiredAction,
      realizationRequest.maximumDisclosure
    );

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
      // Safe semantic outcome handling - never print raw exception strings
    }
  }

  private createInterviewerProposal(
    studentText: string,
    requiredAction: InterviewerProposal["realizedAction"],
    maximumDisclosure: number
  ): InterviewerProposal {
    const text = studentText.toLowerCase();

    // If policy authorizes level 4 disclosure and student reached PHP milestone
    if (
      maximumDisclosure >= 4 &&
      (text.includes("pigeonhole") || text.includes("3") || text.includes("three") || text.includes("same color") || text.includes("same colour"))
    ) {
      const completeTriangle = sixPeopleProblem.interviewer.protectedDisclosures[1];
      return {
        realizedAction: requiredAction,
        claimedDisclosureLevel: 4,
        claimedDisclosureIds: completeTriangle !== undefined ? [completeTriangle.id] : [],
        speechText: "Consider the three endpoints connected to vertex A by edges of the same color. What happens if any edge between them shares that color, and what happens if none of them do?"
      };
    }

    // If policy authorizes level 2 disclosure
    if (maximumDisclosure >= 2) {
      const choosePerson = sixPeopleProblem.interviewer.protectedDisclosures[0];
      return {
        realizedAction: requiredAction,
        claimedDisclosureLevel: 2,
        claimedDisclosureIds: choosePerson !== undefined ? [choosePerson.id] : [],
        speechText: "Why must at least three edges share the same color from vertex A?"
      };
    }

    // Default zero-disclosure probe
    return {
      realizedAction: requiredAction,
      claimedDisclosureLevel: 0,
      claimedDisclosureIds: [],
      speechText: "What relations exist between vertex A and the other five people?"
    };
  }
}
