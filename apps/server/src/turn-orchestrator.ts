import type {
  InputEpisodeId,
  SessionId,
  TurnId
} from "../../../packages/domain/src/index.js";
import {
  ClosedWorldDisclosureAnalyzer,
  DisclosureValidator,
  ProviderCoordinator,
  TurnCoordinator
} from "../../../packages/interview-engine/src/index.js";
import type { SessionRecoveryCoordinator } from "./session-recovery-coordinator.js";
import type { RendererStreamServer } from "./renderer-stream-server.js";
import { resolveSessionStateComposition } from "./interview-session-composition.js";
import { ProviderRuntimeResolver } from "./provider-runtime.js";
import {
  getReviewedProblemRealizationTexts,
  realizeProblemInterviewerProposal
} from "./problem-realization.js";

export interface TurnOrchestrationInput {
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly inputEpisodeId: InputEpisodeId;
  readonly studentText: string;
}

function usesDeterministicMockRealization(
  configuration: {
    readonly providerSelection?: {
      readonly providerId: string;
      readonly modelId: string;
    } | undefined;
  }
): boolean {
  const selection = configuration.providerSelection;
  return selection === undefined
    || (selection.providerId === "mock-model" && selection.modelId === "mock-default");
}

export class ServerTurnOrchestrator {
  private readonly validator: DisclosureValidator;
  private readonly inFlight = new Map<string, Promise<void>>();

  public constructor(
    private readonly sessions: SessionRecoveryCoordinator,
    private readonly getRendererStreamServer: () => RendererStreamServer | undefined,
    validator?: DisclosureValidator,
    private readonly providerRuntime: ProviderRuntimeResolver = new ProviderRuntimeResolver()
  ) {
    this.validator = validator ?? new DisclosureValidator(
      new ClosedWorldDisclosureAnalyzer(getReviewedProblemRealizationTexts())
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

    // 2. Keep deterministic problem-specific realization only for the mock provider.
    // Real providers receive the application-selected action through compiled context
    // and remain fallible realization engines.
    const mockProposal = usesDeterministicMockRealization(composition.configuration)
      ? realizeProblemInterviewerProposal(
          problem,
          authoritativeTurn.studentText,
          realizationRequest
        )
      : undefined;

    // 3. Resolve the authoritative provider/model through the application-owned
    // runtime boundary and the existing provider control plane. Runtime resolution
    // failures are intentionally silent here: no raw provider/configuration errors
    // are persisted, exposed, or replaced with mock execution.
    let runtimeResolution: Awaited<ReturnType<ProviderRuntimeResolver["resolve"]>>;
    try {
      runtimeResolution = await this.providerRuntime.resolve({
        ...(composition.configuration.providerSelection === undefined
          ? {}
          : { selection: composition.configuration.providerSelection }),
        ...(mockProposal === undefined ? {} : { mockProposal })
      });
    } catch {
      return;
    }

    // 4. ProviderCoordinator owns policy/billing admission, context compilation,
    // provider execution, proposal admission, and delivery validation.
    const coordinator = new ProviderCoordinator(writer);
    const execution = await coordinator.start({
      inputEpisodeId: authoritativeTurn.inputEpisodeId,
      turnId: authoritativeTurn.turnId,
      provider: runtimeResolution.provider,
      policy: runtimeResolution.policy,
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


}
