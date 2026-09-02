import {
  ModelCapabilitiesSchema,
  type GenerationId,
  type InterviewerProposal,
  type ModelCapabilities,
  type ProviderCancellationResult,
  type ReasoningProvider,
  type ReasoningSession,
  type ReasoningTurnInput
} from "../../domain/src/index.js";
import { snapshotValidatedModelCapabilities } from "./runtime-capabilities.js";

export interface SupervisedCliExecutionRequest {
  readonly args: readonly string[];
  readonly stdin: string;
  readonly timeoutMs: number;
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
  readonly signal: AbortSignal;
  readonly onProcessStart: () => void;
}

export interface SupervisedCliExecutionResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
}

export interface SupervisedCliExecutor {
  readonly execute: (
    request: SupervisedCliExecutionRequest
  ) => Promise<SupervisedCliExecutionResult>;
}

export interface SupervisedCliProviderDefinition {
  readonly providerId: string;
  readonly adapterVersion: string;
  readonly capabilities: ModelCapabilities;
  readonly verifyBillingSafety: (
    input: { readonly now: Date }
  ) => Promise<unknown>;
  readonly executeTurn: (
    input: ReasoningTurnInput,
    runtime: {
      readonly signal: AbortSignal;
      readonly onProcessStart: () => void;
    }
  ) => Promise<InterviewerProposal>;
}

interface ActiveExecution {
  readonly controller: AbortController;
  processStarted: boolean;
  completion?: Promise<unknown>;
}

export class SupervisedCliReasoningProvider implements ReasoningProvider {
  public readonly name: string;
  public readonly adapterVersion: string;
  public readonly capabilities: ModelCapabilities;
  private readonly billingVerifier: SupervisedCliProviderDefinition["verifyBillingSafety"];
  private readonly turnExecutor: SupervisedCliProviderDefinition["executeTurn"];

  public constructor(definition: SupervisedCliProviderDefinition) {
    const parsedCapabilities = ModelCapabilitiesSchema.safeParse(definition.capabilities);
    if (
      typeof definition.providerId !== "string"
      || definition.providerId.trim().length === 0
      || typeof definition.adapterVersion !== "string"
      || definition.adapterVersion.trim().length === 0
      || !parsedCapabilities.success
      || typeof definition.verifyBillingSafety !== "function"
      || typeof definition.executeTurn !== "function"
    ) {
      throw new Error("Supervised CLI provider definition is invalid");
    }
    this.name = definition.providerId;
    this.adapterVersion = definition.adapterVersion;
    this.capabilities = snapshotValidatedModelCapabilities(parsedCapabilities.data);
    this.billingVerifier = definition.verifyBillingSafety;
    this.turnExecutor = definition.executeTurn;
    Object.freeze(this);
  }

  public async verifyBillingSafety(
    input: { readonly now: Date }
  ): Promise<unknown> {
    return await this.billingVerifier(input);
  }

  public async createSession(): Promise<ReasoningSession> {
    return new SupervisedCliReasoningSession(this.turnExecutor);
  }
}

class SupervisedCliReasoningSession implements ReasoningSession {
  private readonly active = new Map<GenerationId, ActiveExecution>();
  private closed = false;

  public constructor(
    private readonly executeTurn: SupervisedCliProviderDefinition["executeTurn"]
  ) {}

  public sendTurn(input: ReasoningTurnInput): AsyncIterable<InterviewerProposal> {
    return this.iterateTurn(input);
  }

  public async cancelTurn(
    generationId: GenerationId
  ): Promise<ProviderCancellationResult> {
    const record = this.active.get(generationId);
    if (record === undefined) {
      return { semantics: "INTERRUPT_LOCAL_PROCESS", signalSent: false };
    }
    record.controller.abort();
    if (record.completion !== undefined) {
      await record.completion.catch(() => undefined);
    }
    return {
      semantics: "INTERRUPT_LOCAL_PROCESS",
      signalSent: record.processStarted
    };
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const completions: Promise<unknown>[] = [];
    for (const record of this.active.values()) {
      record.controller.abort();
      if (record.completion !== undefined) completions.push(record.completion);
    }
    await Promise.allSettled(completions);
  }

  private async *iterateTurn(
    input: ReasoningTurnInput
  ): AsyncIterable<InterviewerProposal> {
    if (this.closed) throw new Error("Supervised CLI session is closed");
    if (this.active.has(input.generationId)) {
      throw new Error("Generation already has an active supervised CLI execution");
    }

    const controller = new AbortController();
    const record: ActiveExecution = {
      controller,
      processStarted: false
    };
    this.active.set(input.generationId, record);

    const completion = this.executeTurn(input, {
      signal: controller.signal,
      onProcessStart: () => {
        record.processStarted = true;
      }
    });
    record.completion = completion;

    try {
      const proposal = await completion;
      if (controller.signal.aborted || this.closed) return;
      yield proposal;
    } finally {
      this.active.delete(input.generationId);
    }
  }
}
