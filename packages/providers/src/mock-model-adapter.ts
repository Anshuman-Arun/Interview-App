import type {
  GenerationId,
  InterviewerProposal,
  ModelCapabilities,
  ReasoningProvider,
  ReasoningSession,
  ReasoningTurnInput
} from "../../domain/src/index.js";

export interface MockModelAdapterOptions {
  readonly proposal: InterviewerProposal;
  readonly cancellationBehavior?: "HONOR" | "IGNORE";
}

export class MockModelAdapter implements ReasoningProvider {
  public readonly name = "mock-model";
  public readonly adapterVersion = "1.0.0";
  public readonly capabilities: ModelCapabilities = {
    inputModalities: new Set(["text"]),
    textStreaming: false,
    structuredOutput: "FINAL_ONLY",
    persistentSession: false,
    resumableSession: false,
    cancellation: "DROP_OUTPUT",
    sessionSurvivesClientAbort: false,
    sessionSurvivesProviderCancel: false,
    usageReporting: false,
    dataUse: "LOCAL_ONLY"
  };

  public constructor(private readonly options: MockModelAdapterOptions) {}

  public async createSession(): Promise<ReasoningSession> {
    const cancelled = new Set<GenerationId>();
    const options = this.options;
    return {
      async *sendTurn(input: ReasoningTurnInput) {
        if (cancelled.has(input.generationId) && options.cancellationBehavior !== "IGNORE") return;
        yield options.proposal;
      },
      async cancelTurn(generationId: GenerationId) {
        cancelled.add(generationId);
      },
      async close() {}
    };
  }
}

