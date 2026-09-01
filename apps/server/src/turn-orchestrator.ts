import type {
  InputEpisodeId,
  InterviewProblem,
  InterviewerProposal,
  RealizationRequest,
  SessionId,
  TurnId
} from "../../../packages/domain/src/index.js";
import { MockModelAdapter } from "../../../packages/providers/src/index.js";
import {
  ClosedWorldDisclosureAnalyzer,
  DisclosureValidator,
  ProviderCoordinator,
  TurnCoordinator
} from "../../../packages/interview-engine/src/index.js";
import type { SessionRecoveryCoordinator } from "./session-recovery-coordinator.js";
import type { RendererStreamServer } from "./renderer-stream-server.js";
import { resolveSessionStateComposition } from "./interview-session-composition.js";

const GENERIC_REVIEWED_REALIZATIONS = [
  "Why must that step be true?",
  "Can you make that step more precise?",
  "What would you try next?"
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
    this.validator = validator ?? new DisclosureValidator(
      new ClosedWorldDisclosureAnalyzer(GENERIC_REVIEWED_REALIZATIONS)
    );
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

    const composition = resolveSessionStateComposition(state);
    if (composition.mode !== "OXFORD_MATHEMATICS") {
      return;
    }

    const turns = new TurnCoordinator(writer);

    for (const [turnId, turn] of Object.entries(state.turns)) {
      // Clean up stranded in-flight generations from pre-crash processes, including older turns.
      const strandedGenerations = Object.values(state.generations).filter(
        (g) => g.basis.turnId === turnId && (g.status === "ACTIVE" || g.status === "PROPOSAL_RECEIVED")
      );
      for (const stranded of strandedGenerations) {
        await turns.supersedeGeneration(stranded.generationId, "CRASH_RECOVERY_STRANDED");
      }

      if (
        turn.studentText.length === 0
        || state.lastCommittedInputSequence === undefined
        || turn.committedSequence !== state.lastCommittedInputSequence
      ) continue;

      const hasValidatedGeneration = Object.values(state.generations).some(
        (g) => g.basis.turnId === turnId && g.status === "VALIDATED"
      );
      const hasDeliveries = Object.values(state.deliveries).some(
        (delivery) =>
          delivery.status !== "CANCELLED"
          && Object.values(state.generations).some(
            (generation) =>
              generation.generationId === delivery.generationId
              && generation.basis.turnId === turnId
          )
      );

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

    // Resolve all orchestration inputs back to authoritative state before doing any provider work.
    const currentState = writer.getState();
    const authoritativeTurn = currentState.turns[input.turnId];
    if (
      authoritativeTurn === undefined
      || authoritativeTurn.turnId !== input.turnId
      || authoritativeTurn.inputEpisodeId !== input.inputEpisodeId
      || currentState.lastCommittedInputSequence === undefined
      || authoritativeTurn.committedSequence !== currentState.lastCommittedInputSequence
    ) {
      return;
    }

    const existingGeneration = Object.values(currentState.generations).find(
      (g) => g.basis.turnId === input.turnId && g.status === "VALIDATED"
    );
    if (existingGeneration !== undefined) {
      return;
    }

    const composition = resolveSessionStateComposition(currentState);
    if (composition.mode !== "OXFORD_MATHEMATICS") {
      return;
    }
    const problem = composition.problem;
    const turns = new TurnCoordinator(writer);

    // 1. Pedagogical policy selects (or refreshes) the required action
    const realizationRequest = await turns.selectAction(input.turnId, problem);
    if (realizationRequest.requiredAction === "WAIT") {
      return;
    }

    // 2. Realize only wording/content already authorized by application policy
    const proposal = this.createInterviewerProposal(problem, realizationRequest);

    // 3. MockModelAdapter with zero metered spend
    const provider = new MockModelAdapter({ proposal });

    // 4. ProviderCoordinator initiates generation, compiles context, and validates proposal
    const coordinator = new ProviderCoordinator(writer);
    const execution = await coordinator.start({
      inputEpisodeId: authoritativeTurn.inputEpisodeId,
      turnId: authoritativeTurn.turnId,
      provider,
      policy: {
        allowMeteredUsage: false,
        maximumDataUse: "LOCAL_ONLY",
        billingVerificationMaxAgeMs: 60_000
      },
      problem,
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
    problem: InterviewProblem,
    request: RealizationRequest
  ): InterviewerProposal {
    const allowedDisclosureIds = new Set(request.allowedDisclosureIds ?? []);
    const authorizedDisclosure = problem.interviewer.protectedDisclosures.find(
      (disclosure) =>
        allowedDisclosureIds.has(disclosure.id)
        && disclosure.minimumDisclosureLevel <= request.maximumDisclosure
    );

    if (authorizedDisclosure !== undefined) {
      return {
        realizedAction: request.requiredAction,
        claimedDisclosureLevel: authorizedDisclosure.minimumDisclosureLevel,
        claimedDisclosureIds: [authorizedDisclosure.id],
        speechText: authorizedDisclosure.fact
      };
    }

    return {
      realizedAction: request.requiredAction,
      claimedDisclosureLevel: 0,
      claimedDisclosureIds: [],
      speechText: "Why must that step be true?"
    };
  }

}
