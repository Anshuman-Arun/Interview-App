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
  readonly billingVerificationFactory?: (now: Date) => unknown;
}

export class MockModelAdapter implements ReasoningProvider {
  public readonly name = "mock-model";
  public readonly adapterVersion = "1.0.0";
  public readonly capabilities: ModelCapabilities;

  public constructor(private readonly options: MockModelAdapterOptions) {
    this.capabilities = {
      inputModalities: new Set(["text"]),
      textStreaming: false,
      structuredOutput: "FINAL_ONLY",
      persistentSession: false,
      resumableSession: false,
      cancellation: options.cancellationBehavior === "IGNORE" ? "NONE" : "DROP_OUTPUT",
      sessionSurvivesClientAbort: false,
      sessionSurvivesProviderCancel: false,
      usageReporting: false,
      dataUse: "LOCAL_ONLY"
    };
  }

  public async verifyBillingSafety(input: { readonly now: Date }): Promise<unknown> {
    return this.options.billingVerificationFactory?.(input.now) ?? {
      billingClass: "VERIFIED_FREE_ONLY",
      enforcementMechanism: "In-process deterministic mock contains no network or billing path",
      verifiedAt: input.now.toISOString(),
      adapterVersion: this.adapterVersion,
      spendImpossible: true
    };
  }

  public async createSession(): Promise<ReasoningSession> {
    const cancelled = new Set<GenerationId>();
    const options = this.options;
    return {
      async *sendTurn(input: ReasoningTurnInput) {
        if (cancelled.has(input.generationId) && options.cancellationBehavior !== "IGNORE") return;
        yield options.proposal;
      },
      async cancelTurn(generationId: GenerationId) {
        if (options.cancellationBehavior === "IGNORE") return { semantics: "NONE" as const };
        cancelled.add(generationId);
        return { semantics: "DROP_OUTPUT" as const };
      },
      async close() {}
    };
  }
}
