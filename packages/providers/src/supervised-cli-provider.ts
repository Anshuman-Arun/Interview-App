import { types as utilTypes } from "node:util";
import {
  GenerationIdSchema,
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
  readonly snapshotTurnInput: (
    input: ReasoningTurnInput
  ) => ReasoningTurnInput;
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
  processActive: boolean;
  cancelled: boolean;
  completion?: Promise<unknown>;
}

export class SupervisedCliReasoningProvider implements ReasoningProvider {
  public readonly name: string;
  public readonly adapterVersion: string;
  public readonly capabilities: ModelCapabilities;
  private readonly billingVerifier: SupervisedCliProviderDefinition["verifyBillingSafety"];
  private readonly turnInputSnapshotter:
    SupervisedCliProviderDefinition["snapshotTurnInput"];
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
      || typeof definition.snapshotTurnInput !== "function"
      || typeof definition.executeTurn !== "function"
    ) {
      throw new Error("Supervised CLI provider definition is invalid");
    }
    this.name = definition.providerId;
    this.adapterVersion = definition.adapterVersion;
    this.capabilities = snapshotValidatedModelCapabilities(parsedCapabilities.data);
    this.billingVerifier = definition.verifyBillingSafety;
    this.turnInputSnapshotter = definition.snapshotTurnInput;
    this.turnExecutor = definition.executeTurn;
    Object.freeze(this);
  }

  public async verifyBillingSafety(
    input: { readonly now: Date }
  ): Promise<unknown> {
    return await this.billingVerifier(input);
  }

  public async createSession(): Promise<ReasoningSession> {
    return new SupervisedCliReasoningSession(
      this.turnExecutor,
      this.turnInputSnapshotter
    );
  }
}

class SupervisedCliReasoningSession implements ReasoningSession {
  private readonly active = new Map<GenerationId, ActiveExecution>();
  private closed = false;

  public constructor(
    private readonly executeTurn: SupervisedCliProviderDefinition["executeTurn"],
    private readonly snapshotTurnInput:
      SupervisedCliProviderDefinition["snapshotTurnInput"]
  ) {}

  public sendTurn(input: ReasoningTurnInput): AsyncIterable<InterviewerProposal> {
    if (this.closed) throw new Error("Supervised CLI session is closed");

    let snapshot: ReasoningTurnInput;
    try {
      const outerSnapshot = snapshotReasoningTurnInput(input);
      snapshot = snapshotReasoningTurnInput(
        this.snapshotTurnInput(outerSnapshot)
      );
    } catch (error) {
      return rejectedTurn(error);
    }

    if (this.active.has(snapshot.generationId)) {
      throw new Error("Generation already has an active supervised CLI execution");
    }
    const record: ActiveExecution = {
      controller: new AbortController(),
      processActive: false,
      cancelled: false
    };
    this.active.set(snapshot.generationId, record);
    return this.iterateTurn(snapshot, record);
  }

  public async cancelTurn(
    generationId: GenerationId
  ): Promise<ProviderCancellationResult> {
    const record = this.active.get(generationId);
    if (record === undefined) {
      return { semantics: "INTERRUPT_LOCAL_PROCESS", signalSent: false };
    }
    const signalSent = record.processActive;
    record.cancelled = true;
    record.controller.abort();
    return {
      semantics: "INTERRUPT_LOCAL_PROCESS",
      signalSent
    };
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const completions: Promise<unknown>[] = [];
    for (const record of this.active.values()) {
      record.cancelled = true;
      record.controller.abort();
      if (record.completion !== undefined) completions.push(record.completion);
    }
    await Promise.allSettled(completions);
    this.active.clear();
  }

  private async *iterateTurn(
    input: ReasoningTurnInput,
    record: ActiveExecution
  ): AsyncIterable<InterviewerProposal> {
    if (record.cancelled || this.closed) {
      if (this.active.get(input.generationId) === record) {
        this.active.delete(input.generationId);
      }
      return;
    }

    const execution = Promise.resolve().then(async () => {
      if (record.cancelled || this.closed) {
        throw new Error("Supervised CLI execution was cancelled before start");
      }
      return await this.executeTurn(input, {
        signal: record.controller.signal,
        onProcessStart: () => {
          record.processActive = true;
        }
      });
    });
    const completion = execution.then(
      (proposal) => {
        record.processActive = false;
        return proposal;
      },
      (error: unknown) => {
        record.processActive = false;
        throw error;
      }
    );
    record.completion = completion;

    try {
      const proposal = await completion;
      if (record.cancelled) return;
      yield proposal;
    } finally {
      if (this.active.get(input.generationId) === record) {
        this.active.delete(input.generationId);
      }
    }
  }
}
async function *rejectedTurn(
  error: unknown
): AsyncIterable<InterviewerProposal> {
  throw error;
}

function snapshotReasoningTurnInput(input: unknown): ReasoningTurnInput {
  if (
    typeof input !== "object"
    || input === null
    || utilTypes.isProxy(input)
    || Array.isArray(input)
  ) {
    throw new Error("Supervised CLI turn input is invalid");
  }
  const prototype: unknown = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("Supervised CLI turn input is invalid");
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const allowedKeys = new Set(["generationId", "context"]);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (
      !allowedKeys.has(key)
      || descriptor.enumerable !== true
      || !("value" in descriptor)
    ) {
      throw new Error("Supervised CLI turn input is invalid");
    }
  }
  const generationId = GenerationIdSchema.safeParse(
    descriptors.generationId?.value
  );
  const context = descriptors.context;
  if (
    !generationId.success
    || context === undefined
    || !("value" in context)
  ) {
    throw new Error("Supervised CLI turn input is invalid");
  }
  const contextValue: unknown = context.value;
  return Object.freeze({
    generationId: generationId.data,
    context: contextValue
  });
}

