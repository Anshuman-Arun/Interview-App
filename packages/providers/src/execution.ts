import {
  InterviewerProposalSchema,
  ModelCapabilitiesSchema,
  ProviderCancellationReportSchema,
  ProviderCancellationResultSchema,
  type GenerationId,
  type InterviewerProposal,
  type ModelCapabilities,
  type ProviderCancellationReport,
  type ProviderCancellationResult,
  type ReasoningProvider,
  type ReasoningSession,
  type ReasoningTurnInput
} from "../../domain/src/index.js";
import { assertProviderPermitted, preflightProviderPolicy } from "./policy.js";

export type ProviderExecutionErrorCode =
  | "INVALID_PROVIDER_IDENTITY"
  | "INVALID_PROVIDER_CAPABILITIES"
  | "MISSING_BILLING_VERIFIER"
  | "BILLING_VERIFICATION_FAILED"
  | "SESSION_CREATION_FAILED"
  | "PROVIDER_STREAM_FAILED"
  | "INVALID_PROVIDER_OUTPUT"
  | "INVALID_CANCELLATION_RESULT"
  | "CANCELLATION_OVERCLAIMED"
  | "SESSION_CLOSE_FAILED"
  | "SESSION_CLOSED";

export class ProviderExecutionError extends Error {
  public constructor(public readonly code: ProviderExecutionErrorCode) {
    super(providerExecutionErrorMessage(code));
    this.name = "ProviderExecutionError";
  }
}

export interface ProviderExecutionSession {
  readonly providerName: string;
  readonly adapterVersion: string;
  readonly capabilities: ModelCapabilities;
  readonly sendTurn: (input: ReasoningTurnInput) => AsyncIterable<InterviewerProposal>;
  readonly cancelTurn: (generationId: GenerationId) => Promise<ProviderCancellationReport>;
  readonly close: () => Promise<void>;
}

export async function openProviderExecutionSession(input: {
  readonly provider: ReasoningProvider;
  readonly policy: unknown;
  readonly now?: Date;
}): Promise<ProviderExecutionSession> {
  const providerName = parseProviderIdentity(input.provider.name);
  const adapterVersion = parseProviderIdentity(input.provider.adapterVersion);
  const capabilitiesResult = ModelCapabilitiesSchema.safeParse(input.provider.capabilities);
  if (!capabilitiesResult.success) throw new ProviderExecutionError("INVALID_PROVIDER_CAPABILITIES");
  const capabilities = capabilitiesResult.data;
  const preflight = preflightProviderPolicy({
    policy: input.policy,
    capabilities,
    adapterVersion,
    ...(input.now === undefined ? {} : { now: input.now })
  });
  const now = preflight.now;
  let billingVerification: unknown;

  if (preflight.requiresBillingVerification) {
    if (typeof input.provider.verifyBillingSafety !== "function") {
      throw new ProviderExecutionError("MISSING_BILLING_VERIFIER");
    }
    try {
      billingVerification = await input.provider.verifyBillingSafety({ now });
    } catch {
      throw new ProviderExecutionError("BILLING_VERIFICATION_FAILED");
    }
  }

  assertProviderPermitted({
    policy: input.policy,
    capabilities,
    adapterVersion,
    now,
    ...(billingVerification === undefined ? {} : { billingVerification })
  });

  let rawSession: ReasoningSession;
  try {
    rawSession = await input.provider.createSession();
  } catch {
    throw new ProviderExecutionError("SESSION_CREATION_FAILED");
  }
  return new GuardedProviderExecutionSession(providerName, adapterVersion, capabilities, rawSession);
}

class GuardedProviderExecutionSession implements ProviderExecutionSession {
  private readonly cancelled = new Set<GenerationId>();
  private closed = false;

  public constructor(
    public readonly providerName: string,
    public readonly adapterVersion: string,
    public readonly capabilities: ModelCapabilities,
    private readonly rawSession: ReasoningSession
  ) {}

  public sendTurn(input: ReasoningTurnInput): AsyncIterable<InterviewerProposal> {
    return this.iterateTurn(input);
  }

  public async cancelTurn(generationId: GenerationId): Promise<ProviderCancellationReport> {
    this.assertOpen();
    this.cancelled.add(generationId);
    let adapterResult: ProviderCancellationResult = { semantics: "NONE" };
    if (this.rawSession.cancelTurn !== undefined) {
      let rawResult: unknown;
      try {
        rawResult = await this.rawSession.cancelTurn(generationId);
      } catch {
        rawResult = { semantics: "NONE" };
      }
      const parsed = ProviderCancellationResultSchema.safeParse(rawResult);
      if (!parsed.success) throw new ProviderExecutionError("INVALID_CANCELLATION_RESULT");
      adapterResult = parsed.data;
      if (!cancellationResultAllowed(this.capabilities.cancellation, adapterResult.semantics)) {
        throw new ProviderExecutionError("CANCELLATION_OVERCLAIMED");
      }
    }
    return ProviderCancellationReportSchema.parse({
      generationId,
      outputDisposition: "DROP_OUTPUT",
      adapterResult
    });
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.rawSession.close();
    } catch {
      throw new ProviderExecutionError("SESSION_CLOSE_FAILED");
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new ProviderExecutionError("SESSION_CLOSED");
  }

  private async *iterateTurn(input: ReasoningTurnInput): AsyncIterable<InterviewerProposal> {
    this.assertOpen();
    if (this.cancelled.has(input.generationId)) return;
    try {
      for await (const candidate of this.rawSession.sendTurn(input)) {
        if (this.cancelled.has(input.generationId) || this.closed) return;
        const parsed = InterviewerProposalSchema.safeParse(candidate);
        if (!parsed.success) throw new ProviderExecutionError("INVALID_PROVIDER_OUTPUT");
        yield parsed.data;
      }
    } catch (error) {
      if (error instanceof ProviderExecutionError) throw error;
      throw new ProviderExecutionError("PROVIDER_STREAM_FAILED");
    }
  }
}

function parseProviderIdentity(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ProviderExecutionError("INVALID_PROVIDER_IDENTITY");
  }
  return value;
}

function cancellationResultAllowed(
  capability: ModelCapabilities["cancellation"],
  result: ProviderCancellationResult["semantics"]
): boolean {
  const permitted: Record<ModelCapabilities["cancellation"], readonly ProviderCancellationResult["semantics"][]> = {
    NONE: ["NONE"],
    DROP_OUTPUT: ["NONE", "DROP_OUTPUT"],
    CLOSE_CLIENT_STREAM: ["NONE", "DROP_OUTPUT", "CLOSE_CLIENT_STREAM"],
    CANCEL_PROVIDER_COMPUTE: ["NONE", "DROP_OUTPUT", "CLOSE_CLIENT_STREAM", "CANCEL_PROVIDER_COMPUTE"],
    INTERRUPT_LOCAL_PROCESS: ["NONE", "DROP_OUTPUT", "CLOSE_CLIENT_STREAM", "INTERRUPT_LOCAL_PROCESS"]
  };
  return permitted[capability].includes(result);
}

function providerExecutionErrorMessage(code: ProviderExecutionErrorCode): string {
  switch (code) {
    case "INVALID_PROVIDER_IDENTITY": return "Provider identity is invalid";
    case "INVALID_PROVIDER_CAPABILITIES": return "Provider capabilities are invalid";
    case "MISSING_BILLING_VERIFIER": return "Provider billing verifier is unavailable";
    case "BILLING_VERIFICATION_FAILED": return "Provider billing verification failed";
    case "SESSION_CREATION_FAILED": return "Provider session creation failed";
    case "PROVIDER_STREAM_FAILED": return "Provider stream failed";
    case "INVALID_PROVIDER_OUTPUT": return "Provider output failed validation";
    case "INVALID_CANCELLATION_RESULT": return "Provider cancellation result failed validation";
    case "CANCELLATION_OVERCLAIMED": return "Provider cancellation result exceeds declared capability";
    case "SESSION_CLOSE_FAILED": return "Provider session close failed";
    case "SESSION_CLOSED": return "Provider execution session is closed";
  }
}
