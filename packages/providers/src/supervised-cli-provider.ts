import { types as utilTypes } from "node:util";
import {
  GenerationIdSchema,
  ModelCapabilitiesSchema,
  ProviderRuntimeNameSchema,
  type GenerationId,
  type InterviewerProposal,
  type ModelCapabilities,
  type ProviderCancellationResult,
  type ReasoningProvider,
  type ReasoningSession,
  type ReasoningTurnInput
} from "../../domain/src/index.js";
import { snapshotValidatedModelCapabilities } from "./runtime-capabilities.js";
import { snapshotUntrustedModelCapabilities } from "./execution.js";

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
  readonly executeFormalInterpretation?: (
    input: ReasoningTurnInput,
    runtime: {
      readonly signal: AbortSignal;
      readonly onProcessStart: () => void;
    }
  ) => Promise<unknown>;
}

interface ActiveExecution {
  readonly controller: AbortController;
  processActive: boolean;
  cancelled: boolean;
  completion?: Promise<unknown>;
}

type ExecutionRuntime = {
  readonly signal: AbortSignal;
  readonly onProcessStart: () => void;
};

export class SupervisedCliReasoningProvider implements ReasoningProvider {
  public readonly name: string;
  public readonly adapterVersion: string;
  public readonly capabilities: ModelCapabilities;
  private readonly billingVerifier: SupervisedCliProviderDefinition["verifyBillingSafety"];
  private readonly turnInputSnapshotter:
    SupervisedCliProviderDefinition["snapshotTurnInput"];
  private readonly turnExecutor:
    SupervisedCliProviderDefinition["executeTurn"];
  private readonly formalInterpretationExecutor:
    SupervisedCliProviderDefinition["executeFormalInterpretation"];

  public constructor(definition: SupervisedCliProviderDefinition) {
    const snapshot = snapshotProviderDefinition(definition);
    let safeCapabilities: unknown;
    try {
      safeCapabilities = snapshotUntrustedModelCapabilities(
        snapshot.capabilities
      );
    } catch {
      throw new Error("Supervised CLI provider definition is invalid");
    }
    const parsedCapabilities = ModelCapabilitiesSchema.safeParse(
      safeCapabilities
    );
    const parsedProviderId = ProviderRuntimeNameSchema.safeParse(
      snapshot.providerId
    );
    if (
      !parsedProviderId.success
      || typeof snapshot.adapterVersion !== "string"
      || snapshot.adapterVersion.trim().length === 0
      || !parsedCapabilities.success
      || typeof snapshot.verifyBillingSafety !== "function"
      || typeof snapshot.snapshotTurnInput !== "function"
      || typeof snapshot.executeTurn !== "function"
      || (
        snapshot.executeFormalInterpretation !== undefined
        && typeof snapshot.executeFormalInterpretation !== "function"
      )
    ) {
      throw new Error("Supervised CLI provider definition is invalid");
    }
    this.name = parsedProviderId.data;
    this.adapterVersion = snapshot.adapterVersion;
    this.capabilities = snapshotValidatedModelCapabilities(parsedCapabilities.data);
    this.billingVerifier =
      snapshot.verifyBillingSafety as SupervisedCliProviderDefinition["verifyBillingSafety"];
    this.turnInputSnapshotter =
      snapshot.snapshotTurnInput as SupervisedCliProviderDefinition["snapshotTurnInput"];
    this.turnExecutor =
      snapshot.executeTurn as SupervisedCliProviderDefinition["executeTurn"];
    this.formalInterpretationExecutor =
      snapshot.executeFormalInterpretation as SupervisedCliProviderDefinition["executeFormalInterpretation"];
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
      this.turnInputSnapshotter,
      this.formalInterpretationExecutor
    );
  }
}

function snapshotProviderDefinition(
  definition: unknown
): Readonly<Record<string, unknown>> {
  if (
    typeof definition !== "object"
    || definition === null
    || utilTypes.isProxy(definition)
    || Array.isArray(definition)
  ) {
    throw new Error("Supervised CLI provider definition is invalid");
  }
  let prototype: object | null;
  let descriptors: Readonly<Record<string, PropertyDescriptor>>;
  let symbols: readonly symbol[];
  try {
    prototype = Object.getPrototypeOf(definition) as object | null;
    descriptors = Object.getOwnPropertyDescriptors(definition);
    symbols = Object.getOwnPropertySymbols(definition);
  } catch {
    throw new Error("Supervised CLI provider definition is invalid");
  }
  const required = new Set([
    "providerId",
    "adapterVersion",
    "capabilities",
    "verifyBillingSafety",
    "snapshotTurnInput",
    "executeTurn"
  ]);
  const allowed = new Set([
    ...required,
    "executeFormalInterpretation"
  ]);
  if (
    (prototype !== Object.prototype && prototype !== null)
    || symbols.length !== 0
    || Object.keys(descriptors).some((key) => !allowed.has(key))
    || [...required].some((key) => descriptors[key] === undefined)
  ) {
    throw new Error("Supervised CLI provider definition is invalid");
  }
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of allowed) {
    const descriptor = descriptors[key];
    if (descriptor === undefined) continue;
    if (
      descriptor.enumerable !== true
      || !("value" in descriptor)
    ) {
      throw new Error("Supervised CLI provider definition is invalid");
    }
    output[key] = descriptor.value;
  }
  return Object.freeze(output);
}

class SupervisedCliReasoningSession implements ReasoningSession {
  private readonly active = new Map<GenerationId, ActiveExecution>();
  private closed = false;

  public constructor(
    private readonly executeTurn: SupervisedCliProviderDefinition["executeTurn"],
    private readonly snapshotTurnInput:
      SupervisedCliProviderDefinition["snapshotTurnInput"],
    private readonly executeFormalInterpretation?:
      SupervisedCliProviderDefinition["executeFormalInterpretation"]
  ) {}

  public sendTurn(input: ReasoningTurnInput): AsyncIterable<InterviewerProposal> {
    if (this.closed) throw new Error("Supervised CLI session is closed");

    let snapshot: ReasoningTurnInput;
    try {
      snapshot = this.snapshotInput(input);
    } catch (error) {
      return rejectedTurn(error);
    }

    if (this.active.has(snapshot.generationId)) {
      throw new Error("Generation already has an active supervised CLI execution");
    }
    const record = this.startRecord(snapshot.generationId);
    return this.iterateTurn(snapshot, record);
  }

  public async interpretFormal(input: ReasoningTurnInput): Promise<unknown> {
    if (this.closed) throw new Error("Supervised CLI session is closed");
    if (this.executeFormalInterpretation === undefined) {
      throw new Error("Supervised CLI provider does not support formal interpretation");
    }
    const snapshot = this.snapshotInput(input);
    if (this.active.has(snapshot.generationId)) {
      throw new Error("Generation already has an active supervised CLI execution");
    }
    const record = this.startRecord(snapshot.generationId);
    const execution = this.executeOne(
      snapshot,
      record,
      this.executeFormalInterpretation
    );
    record.completion = execution;
    try {
      const result = await execution;
      if (executionWasCancelled(record)) {
        throw new Error("Supervised CLI formal interpretation was cancelled");
      }
      return result;
    } finally {
      if (this.active.get(snapshot.generationId) === record) {
        this.active.delete(snapshot.generationId);
      }
    }
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

  private snapshotInput(input: ReasoningTurnInput): ReasoningTurnInput {
    const outerSnapshot = snapshotReasoningTurnInput(input);
    return snapshotReasoningTurnInput(
      this.snapshotTurnInput(outerSnapshot)
    );
  }

  private startRecord(generationId: GenerationId): ActiveExecution {
    const record: ActiveExecution = {
      controller: new AbortController(),
      processActive: false,
      cancelled: false
    };
    this.active.set(generationId, record);
    return record;
  }

  private executeOne<T>(
    input: ReasoningTurnInput,
    record: ActiveExecution,
    executor: (input: ReasoningTurnInput, runtime: ExecutionRuntime) => Promise<T>
  ): Promise<T> {
    return Promise.resolve().then(async () => {
      if (record.cancelled || this.closed) {
        throw new Error("Supervised CLI execution was cancelled before start");
      }
      try {
        return await executor(input, {
          signal: record.controller.signal,
          onProcessStart: () => {
            record.processActive = true;
          }
        });
      } finally {
        record.processActive = false;
      }
    });
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

    const completion = this.executeOne(input, record, this.executeTurn);
    record.completion = completion;

    try {
      const proposal = await completion;
      if (executionWasCancelled(record)) return;
      yield proposal;
    } finally {
      if (this.active.get(input.generationId) === record) {
        this.active.delete(input.generationId);
      }
    }
  }
}
function executionWasCancelled(record: ActiveExecution): boolean {
  return record.cancelled;
}

function rejectedTurn(
  error: unknown
): AsyncIterable<InterviewerProposal> {
  const rejection = error instanceof Error
    ? error
    : new Error("Supervised CLI turn input is invalid");
  return Object.freeze({
    [Symbol.asyncIterator](): AsyncIterator<InterviewerProposal> {
      return Object.freeze({
        next(): Promise<IteratorResult<InterviewerProposal>> {
          return Promise.reject(rejection);
        }
      });
    }
  });
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
