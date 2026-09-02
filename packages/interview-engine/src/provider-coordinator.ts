import { z } from "zod";
import {
  DeliveryAtomSchema,
  GenerationBasisSchema,
  GenerationIdSchema,
  ProviderCancellationReportSchema,
  RequestIdSchema,
  newRequestId,
  type GenerationBasis,
  type GenerationId,
  type InputEpisodeId,
  type InterviewProblem,
  type ProviderCancellationReport,
  type ProviderPolicy,
  type ReasoningProvider,
  type RequestId,
  type TurnId
} from "../../domain/src/index.js";
import { DeliveryCoordinator } from "../../delivery/src/index.js";
import {
  ProviderExecutionError,
  ProviderPolicyError,
  openProviderExecutionSession,
  type ProviderExecutionSession
} from "../../providers/src/index.js";
import { ContextCoordinator } from "./context-coordinator.js";
import type { DisclosureValidator } from "./disclosure-validator.js";
import { createCommandEnvelope } from "./envelopes.js";
import type { SessionWriter } from "./session-writer.js";
import { TurnCoordinator } from "./turn-coordinator.js";

const ProviderNameSchema = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u);

export const ProviderGenerationOutcomeSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ACCEPTED"),
    generationId: GenerationIdSchema,
    deliveryAtoms: z.array(DeliveryAtomSchema)
  }).strict(),
  z.object({
    status: z.literal("REJECTED"),
    generationId: GenerationIdSchema,
    reason: z.string().min(1)
  }).strict(),
  z.object({
    status: z.literal("CANCELLED"),
    generationId: GenerationIdSchema,
    cancellationReport: ProviderCancellationReportSchema.optional()
  }).strict(),
  z.object({
    status: z.literal("FAILED"),
    generationId: GenerationIdSchema,
    stage: z.enum(["CONTEXT", "PROVIDER_ADMISSION", "PROVIDER_STREAM", "PROPOSAL_ADMISSION", "NO_PROPOSAL"]),
    code: z.string().min(1)
  }).strict()
]);
export type ProviderGenerationOutcome = z.infer<typeof ProviderGenerationOutcomeSchema>;

export interface ProviderGenerationExecution {
  readonly generationId: GenerationId;
  readonly basis: GenerationBasis;
  readonly proposalRequestId: RequestId;
  readonly completion: Promise<ProviderGenerationOutcome>;
}

interface ExecutionRecord {
  readonly generationId: GenerationId;
  readonly proposalRequestId: RequestId;
  readonly cancellationSignal: Promise<void>;
  readonly signalCancellation: () => void;
  session?: ProviderExecutionSession;
  cancellation?: Promise<ProviderCancellationReport | undefined>;
}

export class ProviderCoordinator {
  private readonly turns: TurnCoordinator;
  private readonly contexts: ContextCoordinator;
  private readonly deliveries: DeliveryCoordinator;
  private readonly executions = new Map<GenerationId, ExecutionRecord>();
  private readonly cancellationRequests = new Set<GenerationId>();

  public constructor(private readonly writer: SessionWriter) {
    this.turns = new TurnCoordinator(writer);
    this.contexts = new ContextCoordinator(writer);
    this.deliveries = new DeliveryCoordinator(writer);
  }

  public async start(input: {
    readonly inputEpisodeId: InputEpisodeId;
    readonly turnId: TurnId;
    readonly provider: ReasoningProvider;
    readonly policy: ProviderPolicy;
    readonly problem: InterviewProblem;
    readonly validator: DisclosureValidator;
    readonly proposalRequestId?: RequestId;
    readonly now?: Date;
  }): Promise<ProviderGenerationExecution> {
    const providerName = ProviderNameSchema.parse(input.provider.name);
    const proposalRequestId = RequestIdSchema.parse(input.proposalRequestId ?? newRequestId());
    const started = await this.turns.startGeneration(input.inputEpisodeId, input.turnId, providerName);
    let signalCancellation: (() => void) | undefined;
    const cancellationSignal = new Promise<void>((resolve) => {
      signalCancellation = resolve;
    });
    if (signalCancellation === undefined) {
      throw new Error("Cancellation signal initialization failed");
    }
    const record: ExecutionRecord = {
      generationId: started.generationId,
      proposalRequestId,
      cancellationSignal,
      signalCancellation
    };
    this.executions.set(started.generationId, record);
    const completion = this.run(record, input).finally(() => {
      this.executions.delete(started.generationId);
      this.cancellationRequests.delete(started.generationId);
    });
    return {
      generationId: started.generationId,
      basis: GenerationBasisSchema.parse(started.basis),
      proposalRequestId,
      completion
    };
  }

  public async cancelGeneration(
    generationId: GenerationId,
    reason: string
  ): Promise<ProviderCancellationReport | undefined> {
    const parsedGenerationId = GenerationIdSchema.parse(generationId);
    const record = this.executions.get(parsedGenerationId);
    if (record !== undefined) {
      this.cancellationRequests.add(parsedGenerationId);
      record.signalCancellation();
    }
    const normalizedReason = normalizeReason(reason);
    await this.supersedeIfPossible(parsedGenerationId, normalizedReason);
    await this.cancelQueuedDeliveries(parsedGenerationId, normalizedReason);
    if (record?.session === undefined) return undefined;
    return this.cancelProvider(record);
  }

  private async run(record: ExecutionRecord, input: {
    readonly provider: ReasoningProvider;
    readonly policy: ProviderPolicy;
    readonly problem: InterviewProblem;
    readonly validator: DisclosureValidator;
    readonly now?: Date;
  }): Promise<ProviderGenerationOutcome> {
    let compilation: Awaited<ReturnType<ContextCoordinator["compileForGeneration"]>>;
    try {
      compilation = await this.contexts.compileForGeneration({
        generationId: record.generationId,
        problem: input.problem
      });
    } catch {
      await this.supersedeIfPossible(record.generationId, "Provider context compilation failed");
      return failed(record.generationId, "CONTEXT", "CONTEXT_COMPILATION_FAILED");
    }
    if (!compilation.value.compiled) {
      if (this.cancellationRequested(record.generationId)) return this.finishCancellation(record);
      await this.supersedeIfPossible(record.generationId, "Provider context could not be compiled");
      return failed(record.generationId, "CONTEXT", compilation.value.reason);
    }
    if (this.cancellationRequested(record.generationId)) return this.finishCancellation(record);

    let session: ProviderExecutionSession;
    try {
      session = await openProviderExecutionSession({
        provider: input.provider,
        policy: input.policy,
        ...(input.now === undefined ? {} : { now: input.now })
      });
    } catch (error) {
      if (this.cancellationRequested(record.generationId)) return this.finishCancellation(record);
      await this.supersedeIfPossible(record.generationId, "Provider admission failed");
      return failed(record.generationId, "PROVIDER_ADMISSION", safeProviderFailureCode(error));
    }
    record.session = session;

    let outcome: ProviderGenerationOutcome;
    try {
      if (this.cancellationRequested(record.generationId)) {
        outcome = await this.finishCancellation(record);
      } else {
        outcome = await this.consumeOneProposal(record, input, compilation.value.context);
      }
    } finally {
      if (this.cancellationRequested(record.generationId)) {
        // Authoritative cancellation must not wait for a provider that ignores
        // or hangs during close. The guarded session still receives a best-effort
        // close request, but application progress is independent of acknowledgement.
        void session.close().catch(() => undefined);
      } else {
        await session.close().catch(() => undefined);
      }
    }
    if (this.cancellationRequested(record.generationId)) {
      outcome = await this.finishCancellation(record);
    }
    return ProviderGenerationOutcomeSchema.parse(outcome);
  }

  private async consumeOneProposal(
    record: ExecutionRecord,
    input: {
      readonly problem: InterviewProblem;
      readonly validator: DisclosureValidator;
    },
    context: unknown
  ): Promise<ProviderGenerationOutcome> {
    let iterator: AsyncIterator<InterviewerProposal> | undefined;
    let nextOperation: (() => Promise<IteratorResult<InterviewerProposal>>) | undefined;
    let returnOperation:
      ((value?: unknown) => Promise<IteratorResult<InterviewerProposal>>) | undefined;

    try {
      const stream = record.session?.sendTurn({
        context,
        generationId: record.generationId
      });
      if (stream === undefined) {
        await this.supersedeIfPossible(record.generationId, "Provider returned no proposal");
        return failed(record.generationId, "NO_PROPOSAL", "NO_PROPOSAL");
      }

      const iteratorCandidate = stream[Symbol.asyncIterator]();
      if (typeof iteratorCandidate !== "object" || iteratorCandidate === null) {
        throw new Error("Provider stream iterator is malformed");
      }
      iterator = iteratorCandidate;

      const rawNext: unknown = iterator.next;
      const rawReturn: unknown = iterator.return;
      if (typeof rawNext !== "function") {
        throw new Error("Provider stream iterator next operation is malformed");
      }
      nextOperation = () => Reflect.apply(rawNext, iterator, []) as Promise<IteratorResult<InterviewerProposal>>;
      if (rawReturn !== undefined) {
        if (typeof rawReturn !== "function") {
          throw new Error("Provider stream iterator return operation is malformed");
        }
        returnOperation = (value?: unknown) =>
          Reflect.apply(rawReturn, iterator, [value]) as Promise<IteratorResult<InterviewerProposal>>;
      }

      while (true) {
        const next = Promise.resolve(nextOperation()).then(
          (result) => ({ kind: "NEXT" as const, result }),
          (error: unknown) => ({ kind: "ERROR" as const, error })
        );
        const raced = await Promise.race([
          next,
          record.cancellationSignal.then(() => ({ kind: "CANCELLED" as const }))
        ]);

        if (raced.kind === "CANCELLED") {
          this.requestIteratorReturn(returnOperation);
          return this.finishCancellation(record);
        }
        if (raced.kind === "ERROR") {
          if (this.cancellationRequested(record.generationId)) {
            return this.finishCancellation(record);
          }
          await this.supersedeIfPossible(record.generationId, "Provider stream failed");
          return failed(
            record.generationId,
            "PROVIDER_STREAM",
            safeProviderFailureCode(raced.error)
          );
        }
        if (raced.result.done === true) break;

        if (this.cancellationRequested(record.generationId)) {
          this.requestIteratorReturn(returnOperation);
          return this.finishCancellation(record);
        }

        const proposal = raced.result.value;
        const state = this.writer.getState();
        const generation = state.generations[record.generationId];
        if (generation === undefined) {
          return {
            status: "REJECTED",
            generationId: record.generationId,
            reason: "Unknown generation"
          };
        }

        let result;
        try {
          result = await this.turns.processProposal({
            envelope: createCommandEnvelope({
              sessionId: this.writer.sessionId,
              producer: generation.provider,
              requestId: record.proposalRequestId,
              generationId: record.generationId,
              ...(generation.basis.inputEpisodeId === undefined
                ? {}
                : { inputEpisodeId: generation.basis.inputEpisodeId }),
              turnId: generation.basis.turnId,
              contextEpoch: generation.basis.contextEpoch,
              sourceRevision: generation.basis.committedInputSequence
            }),
            problem: input.problem,
            proposal,
            validator: input.validator
          });
        } catch {
          if (this.cancellationRequested(record.generationId)) {
            return this.finishCancellation(record);
          }
          await this.supersedeIfPossible(
            record.generationId,
            "Provider proposal admission failed"
          );
          return failed(
            record.generationId,
            "PROPOSAL_ADMISSION",
            "PROPOSAL_ADMISSION_FAILED"
          );
        }

        if (this.cancellationRequested(record.generationId)) {
          return this.finishCancellation(record);
        }
        if (!result.accepted) {
          return {
            status: "REJECTED",
            generationId: record.generationId,
            reason: result.reason ?? "Provider proposal was rejected"
          };
        }
        return {
          status: "ACCEPTED",
          generationId: record.generationId,
          deliveryAtoms: result.deliveryAtoms
        };
      }
    } catch (error) {
      if (this.cancellationRequested(record.generationId)) {
        return this.finishCancellation(record);
      }
      await this.supersedeIfPossible(record.generationId, "Provider stream failed");
      return failed(record.generationId, "PROVIDER_STREAM", safeProviderFailureCode(error));
    }

    if (this.cancellationRequested(record.generationId)) {
      return this.finishCancellation(record);
    }
    await this.supersedeIfPossible(record.generationId, "Provider returned no proposal");
    return failed(record.generationId, "NO_PROPOSAL", "NO_PROPOSAL");
  }

  private requestIteratorReturn(
    returnOperation:
      ((value?: unknown) => Promise<IteratorResult<InterviewerProposal>>) | undefined
  ): void {
    if (returnOperation === undefined) return;
    try {
      void Promise.resolve(returnOperation()).catch(() => undefined);
    } catch {
      // Iterator cleanup is best effort after authoritative cancellation.
    }
  }

  private async cancelProvider(record: ExecutionRecord): Promise<ProviderCancellationReport | undefined> {
    if (record.session === undefined) return undefined;
    record.cancellation ??= record.session.cancelTurn(record.generationId).catch(() => undefined);
    return record.cancellation;
  }

  private async finishCancellation(record: ExecutionRecord): Promise<ProviderGenerationOutcome> {
    await this.supersedeIfPossible(record.generationId, "Generation execution was cancelled");
    await this.cancelQueuedDeliveries(record.generationId, "Generation cancelled before exposure");
    // Provider acknowledgement is optional evidence, never an authority gate.
    // cancelGeneration() callers may await the report separately; generation
    // completion does not wait for an uncooperative provider.
    void this.cancelProvider(record);
    return cancelled(record.generationId);
  }

  private cancellationRequested(generationId: GenerationId): boolean {
    return this.cancellationRequests.has(generationId);
  }

  private async supersedeIfPossible(generationId: GenerationId, reason: string): Promise<void> {
    const status = this.writer.getState().generations[generationId]?.status;
    if (status !== "ACTIVE" && status !== "PROPOSAL_RECEIVED" && status !== "VALIDATED") return;
    try {
      await this.turns.supersedeGeneration(generationId, reason);
    } catch {
      const current = this.writer.getState().generations[generationId]?.status;
      if (current !== "SUPERSEDED" && current !== "REJECTED") throw new Error("Generation supersession failed");
    }
  }

  private async cancelQueuedDeliveries(generationId: GenerationId, reason: string): Promise<void> {
    const deliveryIds = Object.values(this.writer.getState().deliveries)
      .filter((atom) => atom.generationId === generationId && atom.status === "QUEUED")
      .map((atom) => atom.deliveryId);
    for (const deliveryId of deliveryIds) {
      try {
        await this.deliveries.cancelBeforeExposure(deliveryId, reason);
      } catch {
        const status = this.writer.getState().deliveries[deliveryId]?.status;
        if (status === "QUEUED") throw new Error("Queued delivery cancellation failed");
      }
    }
  }
}

function failed(
  generationId: GenerationId,
  stage: "CONTEXT" | "PROVIDER_ADMISSION" | "PROVIDER_STREAM" | "PROPOSAL_ADMISSION" | "NO_PROPOSAL",
  code: string
): ProviderGenerationOutcome {
  return { status: "FAILED", generationId, stage, code };
}

function cancelled(
  generationId: GenerationId,
  cancellationReport?: ProviderCancellationReport
): ProviderGenerationOutcome {
  return {
    status: "CANCELLED",
    generationId,
    ...(cancellationReport === undefined ? {} : { cancellationReport })
  };
}

function safeProviderFailureCode(error: unknown): string {
  if (error instanceof ProviderExecutionError || error instanceof ProviderPolicyError) return error.code;
  return "PROVIDER_FAILURE";
}

function normalizeReason(reason: string): string {
  const normalized = reason.trim();
  return normalized.length === 0 ? "Generation cancelled" : normalized.slice(0, 512);
}
