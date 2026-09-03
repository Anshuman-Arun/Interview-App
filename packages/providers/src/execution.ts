import { types as utilTypes } from "node:util";
import {
  GenerationIdSchema,
  InterviewerProposalSchema,
  ModelCapabilitiesSchema,
  ProviderCancellationReportSchema,
  ProviderCancellationResultSchema,
  ProviderRuntimeNameSchema,
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
import {
  isValidatedModelCapabilitiesSnapshot,
  snapshotValidatedModelCapabilities
} from "./runtime-capabilities.js";

const REFLECT_APPLY_INTRINSIC = Reflect.apply;
const MAX_PROVIDER_OUTPUT_DEPTH = 32;
const MAX_PROVIDER_OUTPUT_NODES = 10_000;
const MAX_PROVIDER_OUTPUT_TEXT_CHARACTERS = 1_000_000;
const REFLECT_GET_OWN_PROPERTY_DESCRIPTOR_INTRINSIC =
  Object.getOwnPropertyDescriptor;
const REFLECT_GET_OWN_PROPERTY_DESCRIPTORS_INTRINSIC =
  Object.getOwnPropertyDescriptors;
/* eslint-disable @typescript-eslint/unbound-method -- Captured intrinsics are invoked only through Reflect.apply. */
const SET_HAS_INTRINSIC = Set.prototype.has;
const SET_SIZE_GETTER_INTRINSIC =
  Object.getOwnPropertyDescriptor(Set.prototype, "size")?.get;
/* eslint-enable @typescript-eslint/unbound-method */

export type ProviderExecutionErrorCode =
  | "INVALID_PROVIDER_IDENTITY"
  | "INVALID_PROVIDER_CAPABILITIES"
  | "MISSING_BILLING_VERIFIER"
  | "BILLING_VERIFICATION_FAILED"
  | "SESSION_CREATION_FAILED"
  | "INVALID_TURN_INPUT"
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

export function snapshotReasoningProviderName(
  provider: ReasoningProvider
): string {
  const providerValue: unknown = provider;
  if (
    typeof providerValue !== "object"
    || providerValue === null
    || utilTypes.isProxy(providerValue)
  ) {
    throw new ProviderExecutionError("INVALID_PROVIDER_IDENTITY");
  }
  const parsed = ProviderRuntimeNameSchema.safeParse(
    readProviderMember(providerValue, "name", "INVALID_PROVIDER_IDENTITY")
  );
  if (!parsed.success) {
    throw new ProviderExecutionError("INVALID_PROVIDER_IDENTITY");
  }
  return parsed.data;
}

export async function openProviderExecutionSession(input: {
  readonly provider: ReasoningProvider;
  readonly policy: unknown;
  readonly now?: Date;
}): Promise<ProviderExecutionSession> {
  const providerValue: unknown = input.provider;
  if (
    typeof providerValue !== "object"
    || providerValue === null
    || utilTypes.isProxy(providerValue)
  ) {
    throw new ProviderExecutionError("INVALID_PROVIDER_IDENTITY");
  }

  // Capture provider identity, capabilities, and session creation exactly once
  // before any asynchronous billing-verification boundary. A mutable provider
  // must not be able to pass admission and swap execution behavior afterward.
  const providerName = snapshotReasoningProviderName(input.provider);
  const adapterVersion = parseProviderIdentity(
    readProviderMember(providerValue, "adapterVersion", "INVALID_PROVIDER_IDENTITY")
  );
  const rawCapabilities = readProviderMember(
    providerValue,
    "capabilities",
    "INVALID_PROVIDER_CAPABILITIES"
  );
  let capabilities: ModelCapabilities;
  if (isValidatedModelCapabilitiesSnapshot(rawCapabilities)) {
    capabilities = snapshotValidatedModelCapabilities(rawCapabilities);
  } else {
    let capabilitySnapshot: unknown;
    try {
      capabilitySnapshot = snapshotUntrustedModelCapabilities(rawCapabilities);
    } catch {
      throw new ProviderExecutionError("INVALID_PROVIDER_CAPABILITIES");
    }
    const capabilitiesResult = ModelCapabilitiesSchema.safeParse(
      capabilitySnapshot
    );
    if (!capabilitiesResult.success) {
      throw new ProviderExecutionError("INVALID_PROVIDER_CAPABILITIES");
    }
    capabilities = snapshotValidatedModelCapabilities(capabilitiesResult.data);
  }

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
    if (utilTypes.isProxy(current)) {
      throw new ProviderExecutionError(errorCode);
    }
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
  if (
    typeof sessionValue !== "object"
    || sessionValue === null
    || utilTypes.isProxy(sessionValue)
  ) {
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
    if (utilTypes.isProxy(current)) {
      throw new ProviderExecutionError("SESSION_CREATION_FAILED");
    }
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
    let snapshot: ReasoningTurnInput;
    try {
      snapshot = snapshotReasoningTurnInput(input);
    } catch {
      return rejectedProviderTurn("INVALID_TURN_INPUT");
    }
    return this.iterateTurn(snapshot);
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
      let cancellationSnapshot: unknown;
      try {
        cancellationSnapshot = snapshotUntrustedProviderData(rawResult);
      } catch {
        throw new ProviderExecutionError("INVALID_CANCELLATION_RESULT");
      }
      const parsed = ProviderCancellationResultSchema.safeParse(
        cancellationSnapshot
      );
      if (!parsed.success) {
        throw new ProviderExecutionError("INVALID_CANCELLATION_RESULT");
      }
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
        let candidateSnapshot: unknown;
        try {
          candidateSnapshot = snapshotUntrustedProviderData(candidate);
        } catch {
          throw new ProviderExecutionError("INVALID_PROVIDER_OUTPUT");
        }
        const parsed = InterviewerProposalSchema.safeParse(candidateSnapshot);
        if (!parsed.success) {
          throw new ProviderExecutionError("INVALID_PROVIDER_OUTPUT");
        }
        yield parsed.data;
      }
    } catch (error) {
      if (error instanceof ProviderExecutionError) throw error;
      throw new ProviderExecutionError("PROVIDER_STREAM_FAILED");
    }
  }
}

function snapshotReasoningTurnInput(
  value: unknown
): ReasoningTurnInput {
  if (
    typeof value !== "object"
    || value === null
    || utilTypes.isProxy(value)
    || Array.isArray(value)
  ) {
    throw new Error("Reasoning turn input is invalid");
  }

  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("Reasoning turn input is invalid");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const allowed = new Set(["generationId", "context"]);
  if (Object.keys(descriptors).some((key) => !allowed.has(key))) {
    throw new Error("Reasoning turn input has unknown fields");
  }

  const generationDescriptor = descriptors["generationId"];
  const contextDescriptor = descriptors["context"];
  if (
    generationDescriptor === undefined
    || generationDescriptor.enumerable !== true
    || !("value" in generationDescriptor)
    || contextDescriptor === undefined
    || contextDescriptor.enumerable !== true
    || !("value" in contextDescriptor)
  ) {
    throw new Error("Reasoning turn input must contain own data properties");
  }
  const generationValue: unknown = generationDescriptor.value;
  const contextValue: unknown = contextDescriptor.value;
  const generationId = GenerationIdSchema.safeParse(generationValue);
  if (!generationId.success) throw new Error("Reasoning generation ID is invalid");

  return Object.freeze({
    generationId: generationId.data,
    context: contextValue
  });
}

function rejectedProviderTurn(
  code: ProviderExecutionErrorCode
): AsyncIterable<InterviewerProposal> {
  const error = new ProviderExecutionError(code);
  return Object.freeze({
    [Symbol.asyncIterator](): AsyncIterator<InterviewerProposal> {
      return Object.freeze({
        next(): Promise<IteratorResult<InterviewerProposal>> {
          return Promise.reject(error);
        }
      });
    }
  });
}

export function snapshotUntrustedModelCapabilities(
  value: unknown
): unknown {
  if (
    typeof value !== "object"
    || value === null
    || utilTypes.isProxy(value)
    || Array.isArray(value)
  ) {
    throw new Error("Provider capabilities are not plain data");
  }

  let prototype: object | null;
  let descriptors: Readonly<Record<string, PropertyDescriptor>>;
  let symbols: readonly symbol[];
  try {
    const rawPrototype: unknown = Object.getPrototypeOf(value);
    if (rawPrototype !== null && typeof rawPrototype !== "object") {
      throw new Error("Invalid capabilities prototype");
    }
    prototype = rawPrototype;
    descriptors = REFLECT_APPLY_INTRINSIC(
      REFLECT_GET_OWN_PROPERTY_DESCRIPTORS_INTRINSIC,
      Object,
      [value]
    );
    symbols = Object.getOwnPropertySymbols(value);
  } catch {
    throw new Error("Provider capabilities inspection failed");
  }
  if (
    (prototype !== Object.prototype && prototype !== null)
    || symbols.length !== 0
  ) {
    throw new Error("Provider capabilities are not plain data");
  }

  const required = [
    "inputModalities",
    "textStreaming",
    "structuredOutput",
    "persistentSession",
    "resumableSession",
    "cancellation",
    "sessionSurvivesClientAbort",
    "sessionSurvivesProviderCancel",
    "usageReporting",
    "dataUse"
  ] as const;
  const allowed = new Set<string>([...required, "reasoningLevels"]);
  if (Object.keys(descriptors).some((key) => !allowed.has(key))) {
    throw new Error("Provider capabilities have unknown fields");
  }

  const readData = (key: string, optional = false): unknown => {
    const descriptor = descriptors[key];
    if (descriptor === undefined) {
      if (optional) return undefined;
      throw new Error("Provider capability field is missing");
    }
    if (descriptor.enumerable !== true || !("value" in descriptor)) {
      throw new Error("Provider capability field is accessor-backed");
    }
    return descriptor.value;
  };

  const rawModalities = readData("inputModalities");
  if (
    typeof rawModalities !== "object"
    || rawModalities === null
    || utilTypes.isProxy(rawModalities)
    || Object.getPrototypeOf(rawModalities) !== Set.prototype
    || SET_SIZE_GETTER_INTRINSIC === undefined
  ) {
    throw new Error("Provider input modalities are invalid");
  }
  const modalitySize: unknown = REFLECT_APPLY_INTRINSIC(
    SET_SIZE_GETTER_INTRINSIC,
    rawModalities,
    []
  );
  const hasText = REFLECT_APPLY_INTRINSIC(
    SET_HAS_INTRINSIC,
    rawModalities,
    ["text"]
  );
  const hasImage = REFLECT_APPLY_INTRINSIC(
    SET_HAS_INTRINSIC,
    rawModalities,
    ["image"]
  );
  const knownSize = Number(hasText) + Number(hasImage);
  if (
    typeof modalitySize !== "number"
    || !Number.isSafeInteger(modalitySize)
    || modalitySize !== knownSize
  ) {
    throw new Error("Provider input modalities contain unknown values");
  }

  const reasoningLevelsRaw = readData("reasoningLevels", true);
  let reasoningLevels: unknown = undefined;
  if (reasoningLevelsRaw !== undefined) {
    if (
      typeof reasoningLevelsRaw !== "object"
      || reasoningLevelsRaw === null
      || utilTypes.isProxy(reasoningLevelsRaw)
      || !Array.isArray(reasoningLevelsRaw)
      || Object.getPrototypeOf(reasoningLevelsRaw) !== Array.prototype
    ) {
      throw new Error("Provider reasoning levels are invalid");
    }
    const levelDescriptors = REFLECT_APPLY_INTRINSIC(
      REFLECT_GET_OWN_PROPERTY_DESCRIPTORS_INTRINSIC,
      Object,
      [reasoningLevelsRaw]
    ) as Readonly<Record<string, PropertyDescriptor>>;
    const length = REFLECT_APPLY_INTRINSIC(
      REFLECT_GET_OWN_PROPERTY_DESCRIPTOR_INTRINSIC,
      Object,
      [reasoningLevelsRaw, "length"]
    )?.value as unknown;
    if (
      typeof length !== "number"
      || !Number.isSafeInteger(length)
      || length < 0
      || length > 128
    ) {
      throw new Error("Provider reasoning levels are invalid");
    }
    const levels: string[] = [];
    const levelKeys = new Set<string>(["length"]);
    for (let index = 0; index < length; index += 1) {
      const key = String(index);
      levelKeys.add(key);
      const descriptor = levelDescriptors[key];
      if (
        descriptor === undefined
        || descriptor.enumerable !== true
        || !("value" in descriptor)
        || typeof descriptor.value !== "string"
      ) {
        throw new Error("Provider reasoning levels are invalid");
      }
      levels.push(descriptor.value);
    }
    if (Object.keys(levelDescriptors).some((key) => !levelKeys.has(key))) {
      throw new Error("Provider reasoning levels have side properties");
    }
    reasoningLevels = levels;
  }

  return {
    inputModalities: new Set([
      ...(hasText ? ["text" as const] : []),
      ...(hasImage ? ["image" as const] : [])
    ]),
    textStreaming: readData("textStreaming"),
    structuredOutput: readData("structuredOutput"),
    persistentSession: readData("persistentSession"),
    resumableSession: readData("resumableSession"),
    cancellation: readData("cancellation"),
    sessionSurvivesClientAbort: readData("sessionSurvivesClientAbort"),
    sessionSurvivesProviderCancel: readData("sessionSurvivesProviderCancel"),
    usageReporting: readData("usageReporting"),
    ...(reasoningLevels === undefined ? {} : { reasoningLevels }),
    dataUse: readData("dataUse")
  };
}

function snapshotUntrustedProviderData(value: unknown): unknown {
  const seen = new WeakSet<object>();
  const budget = { nodes: 0, textCharacters: 0 };

  const visit = (candidate: unknown, depth: number): unknown => {
    if (depth > MAX_PROVIDER_OUTPUT_DEPTH) {
      throw new Error("Provider output depth exceeded");
    }
    budget.nodes += 1;
    if (budget.nodes > MAX_PROVIDER_OUTPUT_NODES) {
      throw new Error("Provider output node budget exceeded");
    }

    if (candidate === null) return null;
    if (typeof candidate === "boolean") return candidate;
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) {
        throw new Error("Provider output number is non-finite");
      }
      return candidate;
    }
    if (typeof candidate === "string") {
      budget.textCharacters += candidate.length;
      if (budget.textCharacters > MAX_PROVIDER_OUTPUT_TEXT_CHARACTERS) {
        throw new Error("Provider output text budget exceeded");
      }
      return candidate;
    }
    if (
      typeof candidate !== "object"
      || utilTypes.isProxy(candidate)
      || seen.has(candidate)
    ) {
      throw new Error("Provider output is not plain bounded data");
    }

    seen.add(candidate);
    try {
      let prototype: object | null;
      let descriptors: Readonly<Record<string, PropertyDescriptor>>;
      let symbols: readonly symbol[];
      try {
        const rawPrototype: unknown = Object.getPrototypeOf(candidate);
        if (rawPrototype !== null && typeof rawPrototype !== "object") {
          throw new Error("Invalid prototype");
        }
        prototype = rawPrototype;
        descriptors = Object.getOwnPropertyDescriptors(candidate);
        symbols = Object.getOwnPropertySymbols(candidate);
      } catch {
        throw new Error("Provider output inspection failed");
      }
      if (symbols.length !== 0) {
        throw new Error("Provider output symbols are forbidden");
      }

      if (Array.isArray(candidate)) {
        if (prototype !== Array.prototype) {
          throw new Error("Provider output array prototype is invalid");
        }
        const length = Object.getOwnPropertyDescriptor(
          candidate,
          "length"
        )?.value as unknown;
        if (
          typeof length !== "number"
          || !Number.isSafeInteger(length)
          || length < 0
          || length > MAX_PROVIDER_OUTPUT_NODES
        ) {
          throw new Error("Provider output array length is invalid");
        }
        const output: unknown[] = [];
        const allowed = new Set<string>(["length"]);
        for (let index = 0; index < length; index += 1) {
          const key = String(index);
          allowed.add(key);
          const descriptor = descriptors[key];
          if (
            descriptor === undefined
            || descriptor.enumerable !== true
            || !("value" in descriptor)
          ) {
            throw new Error("Provider output arrays must be dense data");
          }
          output.push(visit(descriptor.value, depth + 1));
        }
        if (Object.keys(descriptors).some((key) => !allowed.has(key))) {
          throw new Error("Provider output array has side properties");
        }
        return output;
      }

      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error("Provider output object prototype is invalid");
      }
      const output: Record<string, unknown> =
        Object.create(null) as Record<string, unknown>;
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (
          descriptor.enumerable !== true
          || !("value" in descriptor)
          || descriptor.value === undefined
          || key === "__proto__"
          || key === "prototype"
          || key === "constructor"
        ) {
          throw new Error("Provider output object is not plain data");
        }
        budget.textCharacters += key.length;
        if (budget.textCharacters > MAX_PROVIDER_OUTPUT_TEXT_CHARACTERS) {
          throw new Error("Provider output text budget exceeded");
        }
        output[key] = visit(descriptor.value, depth + 1);
      }
      return output;
    } finally {
      seen.delete(candidate);
    }
  };

  return visit(value, 0);
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
    case "INVALID_TURN_INPUT": return "Provider turn input failed validation";
    case "PROVIDER_STREAM_FAILED": return "Provider stream failed";
    case "INVALID_PROVIDER_OUTPUT": return "Provider output failed validation";
    case "INVALID_CANCELLATION_RESULT": return "Provider cancellation result failed validation";
    case "CANCELLATION_OVERCLAIMED": return "Provider cancellation result exceeds declared capability";
    case "SESSION_CLOSE_FAILED": return "Provider session close failed";
    case "SESSION_CLOSED": return "Provider execution session is closed";
  }
}
