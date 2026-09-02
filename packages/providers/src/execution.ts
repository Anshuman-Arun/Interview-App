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
import { snapshotValidatedModelCapabilities } from "./runtime-capabilities.js";

const REFLECT_APPLY_INTRINSIC = Reflect.apply;

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
  const providerValue: unknown = input.provider;
  if (typeof providerValue !== "object" || providerValue === null) {
    throw new ProviderExecutionError("INVALID_PROVIDER_IDENTITY");
  }

  // Capture provider identity, capabilities, and session creation exactly once
  // before any asynchronous billing-verification boundary. A mutable provider
  // must not be able to pass admission and swap execution behavior afterward.
  const providerName = parseProviderIdentity(
    readProviderMember(providerValue, "name", "INVALID_PROVIDER_IDENTITY")
  );
  const adapterVersion = parseProviderIdentity(
    readProviderMember(providerValue, "adapterVersion", "INVALID_PROVIDER_IDENTITY")
  );
  const capabilitiesResult = ModelCapabilitiesSchema.safeParse(
    readProviderMember(providerValue, "capabilities", "INVALID_PROVIDER_CAPABILITIES")
  );
  if (!capabilitiesResult.success) {
    throw new ProviderExecutionError("INVALID_PROVIDER_CAPABILITIES");
  }
  const capabilities = snapshotValidatedModelCapabilities(capabilitiesResult.data);

  const createSessionCandidate = readProviderMember(
    providerValue,
    "createSession",
    "SESSION_CREATION_FAILED"
  );
  if (typeof createSessionCandidate !== "function") {
    throw new ProviderExecutionError("SESSION_CREATION_FAILED");
  }
  const createSession = createSessionCandidate as ReasoningProvider["createSession"];

  const preflight = preflightProviderPolicy({
    policy: input.policy,
    capabilities,
    adapterVersion,
    ...(input.now === undefined ? {} : { now: input.now })
  });
  // Never lend the authoritative admission clock to provider code. Date is
  // mutable, and the verifier is fallible/untrusted.
  const admissionNow = new Date(preflight.now.getTime());
  let billingVerification: unknown;

  if (preflight.requiresBillingVerification) {
    const verifyBillingSafetyCandidate = readProviderMember(
      providerValue,
      "verifyBillingSafety",
      "MISSING_BILLING_VERIFIER"
    );
    if (typeof verifyBillingSafetyCandidate !== "function") {
      throw new ProviderExecutionError("MISSING_BILLING_VERIFIER");
    }
    const verifyBillingSafety =
      verifyBillingSafetyCandidate as ReasoningProvider["verifyBillingSafety"];
    try {
      billingVerification = await REFLECT_APPLY_INTRINSIC(
        verifyBillingSafety,
        providerValue,
        [{ now: new Date(admissionNow.getTime()) }]
      );
    } catch {
      throw new ProviderExecutionError("BILLING_VERIFICATION_FAILED");
    }
  }

  // Reuse the already parsed policy and our private clock snapshot. Re-reading
  // mutable caller policy after the verifier await would reopen a TOCTOU gap.
  assertProviderPermitted({
    policy: preflight.policy,
    capabilities,
    adapterVersion,
    now: admissionNow,
    ...(billingVerification === undefined ? {} : { billingVerification })
  });

  let rawSession: ReasoningSession;
  try {
    rawSession = await REFLECT_APPLY_INTRINSIC(
      createSession,
      providerValue,
      []
    );
  } catch {
    throw new ProviderExecutionError("SESSION_CREATION_FAILED");
  }
  const sessionOperations = snapshotReasoningSessionOperations(rawSession);
  return new GuardedProviderExecutionSession(
    providerName,
    adapterVersion,
    capabilities,
    sessionOperations
  );
}

function readProviderMember(
  value: object,
  key: "name" | "adapterVersion" | "capabilities" | "verifyBillingSafety" | "createSession",
  errorCode:
    | "INVALID_PROVIDER_IDENTITY"
    | "INVALID_PROVIDER_CAPABILITIES"
    | "MISSING_BILLING_VERIFIER"
    | "SESSION_CREATION_FAILED"
): unknown {
  const seen = new Set<object>();
  let current: object | null = value;
  for (let depth = 0; depth < 16 && current !== null; depth += 1) {
    if (current === Object.prototype) break;
    if (seen.has(current)) {
      throw new ProviderExecutionError(errorCode);
    }
    seen.add(current);

    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(current, key);
    } catch {
      throw new ProviderExecutionError(errorCode);
    }
    if (descriptor !== undefined) {
      if (!("value" in descriptor)) {
        throw new ProviderExecutionError(errorCode);
      }
      return descriptor.value;
    }

    try {
      const prototypeCandidate: unknown = Object.getPrototypeOf(current);
      if (prototypeCandidate !== null && typeof prototypeCandidate !== "object") {
        throw new ProviderExecutionError(errorCode);
      }
      current = prototypeCandidate;
    } catch {
      throw new ProviderExecutionError(errorCode);
    }
  }
  throw new ProviderExecutionError(errorCode);
}

interface ReasoningSessionOperations {
  readonly receiver: object;
  readonly sendTurn: ReasoningSession["sendTurn"];
  readonly cancelTurn?: ReasoningSession["cancelTurn"];
  readonly close: ReasoningSession["close"];
}

function snapshotReasoningSessionOperations(
  session: ReasoningSession
): ReasoningSessionOperations {
  const sessionValue: unknown = session;
  if (typeof sessionValue !== "object" || sessionValue === null) {
    throw new ProviderExecutionError("SESSION_CREATION_FAILED");
  }
  const sendTurn = readReasoningSessionOperation(sessionValue, "sendTurn", true);
  const cancelTurn = readReasoningSessionOperation(sessionValue, "cancelTurn", false);
  const close = readReasoningSessionOperation(sessionValue, "close", true);
  if (sendTurn === undefined || close === undefined) {
    throw new ProviderExecutionError("SESSION_CREATION_FAILED");
  }
  return Object.freeze({
    receiver: sessionValue,
    sendTurn: sendTurn as ReasoningSession["sendTurn"],
    ...(cancelTurn === undefined
      ? {}
      : { cancelTurn: cancelTurn as NonNullable<ReasoningSession["cancelTurn"]> }),
    close: close as ReasoningSession["close"]
  });
}

function readReasoningSessionOperation(
  value: object,
  key: "sendTurn" | "cancelTurn" | "close",
  required: boolean
): unknown {
  const seen = new Set<object>();
  let current: object | null = value;
  for (let depth = 0; depth < 16 && current !== null; depth += 1) {
    if (current === Object.prototype) break;
    if (seen.has(current)) {
      throw new ProviderExecutionError("SESSION_CREATION_FAILED");
    }
    seen.add(current);

    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(current, key);
    } catch {
      throw new ProviderExecutionError("SESSION_CREATION_FAILED");
    }
    if (descriptor !== undefined) {
      if (!("value" in descriptor) || typeof descriptor.value !== "function") {
        throw new ProviderExecutionError("SESSION_CREATION_FAILED");
      }
      return descriptor.value;
    }

    try {
      const prototypeCandidate: unknown = Object.getPrototypeOf(current);
      if (prototypeCandidate !== null && typeof prototypeCandidate !== "object") {
        throw new ProviderExecutionError("SESSION_CREATION_FAILED");
      }
      current = prototypeCandidate;
    } catch {
      throw new ProviderExecutionError("SESSION_CREATION_FAILED");
    }
  }
  if (required) {
    throw new ProviderExecutionError("SESSION_CREATION_FAILED");
  }
  return undefined;
}

class GuardedProviderExecutionSession implements ProviderExecutionSession {
  private readonly cancelled = new Set<GenerationId>();
  private closed = false;

  public constructor(
    public readonly providerName: string,
    public readonly adapterVersion: string,
    public readonly capabilities: ModelCapabilities,
    private readonly operations: ReasoningSessionOperations
  ) {}

  public sendTurn(input: ReasoningTurnInput): AsyncIterable<InterviewerProposal> {
    return this.iterateTurn(input);
  }

  public async cancelTurn(generationId: GenerationId): Promise<ProviderCancellationReport> {
    this.assertOpen();
    this.cancelled.add(generationId);
    let adapterResult: ProviderCancellationResult = { semantics: "NONE" };
    if (this.operations.cancelTurn !== undefined) {
      let rawResult: unknown;
      try {
        rawResult = await REFLECT_APPLY_INTRINSIC(
          this.operations.cancelTurn,
          this.operations.receiver,
          [generationId]
        );
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
      await REFLECT_APPLY_INTRINSIC(
        this.operations.close,
        this.operations.receiver,
        []
      );
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
      const stream = REFLECT_APPLY_INTRINSIC(
        this.operations.sendTurn,
        this.operations.receiver,
        [input]
      );
      for await (const candidate of stream) {
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
