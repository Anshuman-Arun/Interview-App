import type {
  GenerationId,
  InputEpisodeId,
  SessionId,
  TurnId
} from "../../../packages/domain/src/index.js";
import {
  ClosedWorldDisclosureAnalyzer,
  DisclosureValidator,
  ProviderCoordinator,
  TurnCoordinator,
  type FormalInterpretationProvider
} from "../../../packages/interview-engine/src/index.js";
import type {
  SessionRecoveryCoordinator,
  TurnRecoveryDisposition
} from "./session-recovery-coordinator.js";
import type { RendererStreamServer } from "./renderer-stream-server.js";
import { resolveSessionStateComposition } from "./interview-session-composition.js";
import { ProviderRuntimeResolver } from "./provider-runtime.js";
import { StudentReasoningAnalysisCoordinator } from "./student-reasoning-analysis-coordinator.js";
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

type TurnOrchestrationDisposition =
  | "COMPLETE"
  | "RETRYABLE_PROVIDER_RUNTIME";

interface ActiveProviderExecution {
  readonly sessionId: SessionId;
  readonly generationId: GenerationId;
  readonly coordinator: ProviderCoordinator;
}

interface InFlightOrchestration {
  readonly input: TurnOrchestrationInput;
  readonly completion: Promise<TurnOrchestrationDisposition>;
  readonly signalCancellation: () => void;
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
  private readonly inFlight = new Map<string, InFlightOrchestration>();
  private readonly activeProviderExecutions = new Map<GenerationId, ActiveProviderExecution>();
  private readonly reasoningAnalysis: StudentReasoningAnalysisCoordinator;
  private acceptingWork = true;

  public constructor(
    private readonly sessions: SessionRecoveryCoordinator,
    private readonly getRendererStreamServer: () => RendererStreamServer | undefined,
    validator?: DisclosureValidator,
    private readonly providerRuntime: ProviderRuntimeResolver = new ProviderRuntimeResolver(),
    formalInterpretationProvider?: FormalInterpretationProvider
  ) {
    this.validator = validator ?? new DisclosureValidator(
      new ClosedWorldDisclosureAnalyzer(getReviewedProblemRealizationTexts())
    );
    this.reasoningAnalysis = new StudentReasoningAnalysisCoordinator(
      sessions,
      formalInterpretationProvider
    );
  }

  public getProviderRuntimeResolver(): ProviderRuntimeResolver {
    return this.providerRuntime;
  }

  public async orchestrateTurn(input: TurnOrchestrationInput): Promise<void> {
    await this.orchestrateTurnWithDisposition(input);
  }

  /**
   * Requests physical provider cancellation after authoritative invalidation.
   * This never waits for a fallible provider to acknowledge cancellation, so
   * new authoritative work cannot be blocked by an uncooperative remote.
   */
  public requestCancellationForSupersededWork(
    sessionId: SessionId
  ): void {
    this.reasoningAnalysis.supersedeStaleRequests(sessionId);
    for (const orchestration of this.inFlight.values()) {
      if (orchestration.input.sessionId === sessionId) {
        orchestration.signalCancellation();
      }
    }

    const writer = this.sessions.getWriter(sessionId);
    const state = writer.getState();
    const records = Array.from(this.activeProviderExecutions.values())
      .filter((record) => record.sessionId === sessionId);

    for (const record of records) {
      const status = state.generations[record.generationId]?.status;
      if (
        status === "ACTIVE"
        || status === "PROPOSAL_RECEIVED"
        || status === "VALIDATED"
      ) {
        continue;
      }
      void record.coordinator.cancelGeneration(
        record.generationId,
        "Authoritative state superseded provider execution"
      ).catch(() => undefined);
    }
  }

  /**
   * Requests cancellation of every orchestration admitted before graceful
   * shutdown. Command admission must already be closed by the caller.
   * Provider acknowledgement is best effort and never gates process progress.
   */
  public requestCancellationForShutdown(): void {
    this.acceptingWork = false;
    this.reasoningAnalysis.shutdown();
    for (const orchestration of this.inFlight.values()) {
      orchestration.signalCancellation();
    }
    for (const record of this.activeProviderExecutions.values()) {
      void record.coordinator.cancelGeneration(
        record.generationId,
        "Application shutdown cancelled provider execution"
      ).catch(() => undefined);
    }
  }

  public resumeAfterShutdown(): void {
    if (this.acceptingWork) return;
    if (this.inFlight.size !== 0 || this.activeProviderExecutions.size !== 0) {
      throw new Error("Cannot resume provider orchestration while prior work is still active");
    }
    this.reasoningAnalysis.resume();
    this.acceptingWork = true;
  }

  public async waitForAll(): Promise<void> {
    await Promise.all(
      Array.from(this.inFlight.values()).map((record) => record.completion)
    );
  }

  public async drainProviderRuntime(): Promise<void> {
    await this.providerRuntime.drain();
  }

  public async recoverPendingTurns(
    sessionId: SessionId
  ): Promise<TurnRecoveryDisposition> {
    const writer = this.sessions.getWriter(sessionId);
    const state = writer.getState();
    if (!state.started || state.status !== "ACTIVE") {
      return "COMPLETE";
    }

    const composition = resolveSessionStateComposition(state);
    if (composition.mode !== "OXFORD_MATHEMATICS") {
      return "COMPLETE";
    }
    const turns = new TurnCoordinator(writer);
    let disposition: TurnRecoveryDisposition = "COMPLETE";

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
        // A recovery attempt cancelled by application shutdown is not a
        // successful recovery. Report it separately so the recovery cache does
        // not strand this authoritative pending turn across a stop/start cycle.
        const turnDisposition = await this.orchestrateTurnWithDisposition({
          sessionId,
          turnId: turnId as TurnId,
          inputEpisodeId: turn.inputEpisodeId,
          studentText: turn.studentText
        });
        if (!this.acceptingWork) return "DEFERRED";
        if (turnDisposition === "RETRYABLE_PROVIDER_RUNTIME") {
          disposition = "RETRYABLE";
        }
      }
    }
    return disposition;
  }

  private async orchestrateTurnWithDisposition(
    input: TurnOrchestrationInput
  ): Promise<TurnOrchestrationDisposition> {
    if (!this.acceptingWork) {
      return "COMPLETE";
    }
    const key = `${input.sessionId}:${input.turnId}`;
    const existing = this.inFlight.get(key);
    if (existing !== undefined) {
      return existing.completion;
    }

    // A new authoritative turn normally arrives after commitInput has already
    // superseded old generations. Cancel older resolver/provider work locally
    // before beginning this turn, but never wait for remote acknowledgement.
    this.requestCancellationForSupersededWork(input.sessionId);

    let requested = false;
    let signalCancellation: (() => void) | undefined;
    const cancellationSignal = new Promise<void>((resolve) => {
      signalCancellation = () => {
        if (requested) return;
        requested = true;
        resolve();
      };
    });
    if (signalCancellation === undefined) {
      throw new Error("Orchestration cancellation signal initialization failed");
    }

    const completion = this.executeOrchestration(
      input,
      cancellationSignal,
      () => requested
    ).finally(() => {
      this.inFlight.delete(key);
    });
    const record: InFlightOrchestration = {
      input,
      completion,
      signalCancellation
    };

    this.inFlight.set(key, record);
    return completion;
  }

  private async executeOrchestration(
    input: TurnOrchestrationInput,
    cancellationSignal: Promise<void>,
    cancellationRequested: () => boolean
  ): Promise<TurnOrchestrationDisposition> {
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
      return "COMPLETE";
    }

    const existingGeneration = Object.values(currentState.generations).find(
      (g) => g.basis.turnId === input.turnId && g.status === "VALIDATED"
    );
    if (existingGeneration !== undefined) {
      return "COMPLETE";
    }

    const composition = resolveSessionStateComposition(currentState);
    if (composition.mode !== "OXFORD_MATHEMATICS") {
      return "COMPLETE";
    }
    const problem = composition.problem;
    const turns = new TurnCoordinator(writer);

    // 1. Analyze the exact committed student turn. Interpretation remains
    // fallible; only application-routed deterministic verification can change
    // authoritative evidence. Any abstention/unavailability is non-blocking.
    await this.reasoningAnalysis.analyze({
      sessionId: input.sessionId,
      turnId: input.turnId,
      inputEpisodeId: input.inputEpisodeId
    });
    const postAnalysisState = writer.getState();
    if (
      cancellationRequested()
      || postAnalysisState.status !== "ACTIVE"
      || postAnalysisState.contextEpoch !== currentState.contextEpoch
      || !this.isTurnStillLatest(input)
    ) {
      return "COMPLETE";
    }

    // 2. Pedagogical policy reads the post-verification authoritative state.
    const realizationRequest = await turns.selectAction(input.turnId, problem);
    if (realizationRequest.requiredAction === "WAIT") {
      return "COMPLETE";
    }

    // 3. Keep deterministic problem-specific realization only for the mock provider.
    // Real providers receive the application-selected action through compiled context
    // and remain fallible realization engines.
    const mockProposal = usesDeterministicMockRealization(composition.configuration)
      ? realizeProblemInterviewerProposal(
          problem,
          authoritativeTurn.studentText,
          realizationRequest
        )
      : undefined;

    // 4. Resolve the authoritative provider/model through the application-owned
    // runtime boundary and the existing provider control plane. Raw runtime
    // errors never escape; recovery receives only a stable retry disposition.
    const runtimeOpening = this.providerRuntime.resolve({
      ...(composition.configuration.providerSelection === undefined
        ? {}
        : { selection: composition.configuration.providerSelection }),
      ...(mockProposal === undefined ? {} : { mockProposal }),
      cancellationRequested
    }).then(
      (resolution) => ({ kind: "RESOLVED" as const, resolution }),
      () => ({ kind: "FAILED" as const })
    );

    const runtimeResult = await Promise.race([
      runtimeOpening,
      cancellationSignal.then(() => ({ kind: "CANCELLED" as const }))
    ]);
    if (runtimeResult.kind === "CANCELLED" || cancellationRequested()) {
      return "COMPLETE";
    }
    if (runtimeResult.kind === "FAILED") {
      return "RETRYABLE_PROVIDER_RUNTIME";
    }
    const runtimeResolution = runtimeResult.resolution;

    // 5. ProviderCoordinator owns policy/billing admission, context compilation,
    // provider execution, proposal admission, and delivery validation.
    const coordinator = new ProviderCoordinator(writer);
    let execution: Awaited<ReturnType<ProviderCoordinator["start"]>>;
    try {
      execution = await coordinator.start({
        inputEpisodeId: authoritativeTurn.inputEpisodeId,
        turnId: authoritativeTurn.turnId,
        provider: runtimeResolution.provider,
        policy: runtimeResolution.policy,
        problem,
        validator: this.validator
      });
    } catch {
      // The authoritative turn may have changed while runtime credentials or
      // dependencies were resolving. Never surface raw setup/state errors.
      return "COMPLETE";
    }

    const activeRecord: ActiveProviderExecution = {
      sessionId: input.sessionId,
      generationId: execution.generationId,
      coordinator
    };
    this.activeProviderExecutions.set(execution.generationId, activeRecord);

    try {
      // Close the race where authoritative invalidation happens between
      // startGeneration and registration in activeProviderExecutions.
      this.requestCancellationIfSuperseded(activeRecord);
      if (cancellationRequested()) {
        void coordinator.cancelGeneration(
          execution.generationId,
          "Authoritative state superseded provider execution"
        ).catch(() => undefined);
      }

      const outcome = await execution.completion;
      if (outcome.status === "FAILED") {
        if (
          this.isTurnStillLatest(input)
          && (
            outcome.stage === "PROVIDER_ADMISSION"
            || outcome.stage === "PROVIDER_STREAM"
            || outcome.stage === "NO_PROPOSAL"
          )
        ) {
          return "RETRYABLE_PROVIDER_RUNTIME";
        }
        return "COMPLETE";
      }
      if (outcome.status !== "ACCEPTED") {
        return "COMPLETE";
      }

      // 6. Publish delivery atoms to active renderer stream (SSE)
      const streamServer = this.getRendererStreamServer();
      if (streamServer !== undefined) {
        for (const atom of outcome.deliveryAtoms) {
          await streamServer.publishDelivery(input.sessionId, atom.deliveryId);
        }
      }
      return "COMPLETE";
    } catch {
      return this.isTurnStillLatest(input)
        ? "RETRYABLE_PROVIDER_RUNTIME"
        : "COMPLETE";
    } finally {
      if (this.activeProviderExecutions.get(execution.generationId) === activeRecord) {
        this.activeProviderExecutions.delete(execution.generationId);
      }
    }
  }

  private requestCancellationIfSuperseded(
    record: ActiveProviderExecution
  ): void {
    const writer = this.sessions.getWriter(record.sessionId);
    const status = writer.getState().generations[record.generationId]?.status;
    if (
      status === "ACTIVE"
      || status === "PROPOSAL_RECEIVED"
      || status === "VALIDATED"
    ) {
      return;
    }
    void record.coordinator.cancelGeneration(
      record.generationId,
      "Authoritative state superseded provider execution"
    ).catch(() => undefined);
  }

  private isTurnStillLatest(input: TurnOrchestrationInput): boolean {
    const state = this.sessions.getWriter(input.sessionId).getState();
    const turn = state.turns[input.turnId];
    return turn !== undefined
      && turn.inputEpisodeId === input.inputEpisodeId
      && state.lastCommittedInputSequence !== undefined
      && turn.committedSequence === state.lastCommittedInputSequence;
  }
}
