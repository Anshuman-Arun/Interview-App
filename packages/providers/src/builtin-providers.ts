import { z } from "zod";
import { InterviewerProposalSchema } from "../../domain/src/index.js";
import { GeminiApiAdapter } from "./gemini-api-adapter.js";
import { MockModelAdapter } from "./mock-model-adapter.js";
import {
  ProviderControlPlaneError,
  ProviderRegistry,
  defineProvider,
  type ProviderAdapterFactoryDefinition,
  type ProviderDefinition,
  type ProviderDefinitionInput
} from "./control-plane.js";

const REFLECT_APPLY_INTRINSIC = Reflect.apply;

/* eslint-disable @typescript-eslint/unbound-method -- Captured prototype method is invoked only via Reflect.apply. */
const registerProviderDefinitions = ProviderRegistry.prototype.registerMany;
/* eslint-enable @typescript-eslint/unbound-method */

// eslint-disable-next-line @typescript-eslint/unbound-method -- Capture prevents monkey-patching of the private-brand checker.
const isProviderControlPlaneError = ProviderControlPlaneError.isControlPlaneError;

const MOCK_RUNTIME_KEYS = new Set(["proposal"]);
const GEMINI_RUNTIME_KEYS = new Set(["fetchImpl", "billingVerificationFactory"]);
const PROPOSAL_KEYS = Object.freeze([
  "realizedAction",
  "claimedDisclosureLevel",
  "claimedDisclosureIds",
  "speechText",
  "boardActions"
] as const);
const PROPOSAL_KEY_SET = new Set<string>(PROPOSAL_KEYS);
const BOARD_ACTION_KEYS = Object.freeze([
  "operation",
  "layer",
  "content",
  "targetShapeId",
  "expectedShapeRevision",
  "annotationPurpose"
] as const);
const BOARD_ACTION_KEY_SET = new Set<string>(BOARD_ACTION_KEYS);

/* eslint-disable @typescript-eslint/unbound-method -- Captured intrinsics are invoked only via Reflect.apply. */
const SET_HAS_INTRINSIC = Set.prototype.has;
const SET_ADD_INTRINSIC = Set.prototype.add;
const STRING_TRIM_INTRINSIC = String.prototype.trim;
/* eslint-enable @typescript-eslint/unbound-method */

function setHas<T>(set: ReadonlySet<T>, value: T): boolean {
  const result: unknown = REFLECT_APPLY_INTRINSIC(SET_HAS_INTRINSIC, set, [value]);
  return result === true;
}

function setAdd<T>(set: Set<T>, value: T): void {
  REFLECT_APPLY_INTRINSIC(SET_ADD_INTRINSIC, set, [value]);
}

function trimBuiltInCredential(value: string): string {
  const result: unknown = REFLECT_APPLY_INTRINSIC(STRING_TRIM_INTRINSIC, value, []);
  if (typeof result !== "string") {
    throw new ProviderControlPlaneError(
      "CREDENTIAL_RESOLUTION_FAILED",
      "Provider credential normalization failed"
    );
  }
  return result;
}

function invalidMockRuntime(): never {
  throw new ProviderControlPlaneError(
    "INVALID_FACTORY_INPUT",
    "Mock provider factory runtime is malformed"
  );
}

function readMockRuntimeMemberWithoutAccessors(
  value: object,
  key: string
): unknown {
  const seen = new Set<object>();
  let current: object | null = value;
  for (let depth = 0; depth < 16 && current !== null; depth += 1) {
    if (current === Object.prototype) return undefined;
    if (setHas(seen, current)) return invalidMockRuntime();
    setAdd(seen, current);

    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(current, key);
    } catch {
      return invalidMockRuntime();
    }
    if (descriptor !== undefined) {
      if (!("value" in descriptor)) return invalidMockRuntime();
      const member: unknown = descriptor.value;
      return member;
    }
    try {
      const nextPrototype: unknown = Object.getPrototypeOf(current);
      if (nextPrototype !== null && typeof nextPrototype !== "object") {
        return invalidMockRuntime();
      }
      current = nextPrototype;
    } catch {
      return invalidMockRuntime();
    }
  }
  if (current !== null) return invalidMockRuntime();
  return undefined;
}

function assertNoUnknownEnumerableMockFields(
  value: object,
  allowedKeys: ReadonlySet<string>
): void {
  let descriptors: Readonly<Record<string, PropertyDescriptor>>;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return invalidMockRuntime();
  }
  const descriptorKeys = Object.keys(descriptors);
  for (let index = 0; index < descriptorKeys.length; index += 1) {
    const key = descriptorKeys[index];
    if (key === undefined) continue;
    const descriptor = descriptors[key];
    if (
      descriptor !== undefined
      && descriptor.enumerable === true
      && !setHas(allowedKeys, key)
    ) {
      invalidMockRuntime();
    }
  }
}

function snapshotMockArray(
  value: unknown,
  mapItem: (item: unknown) => unknown
): readonly unknown[] {
  if (!Array.isArray(value)) return invalidMockRuntime();
  let descriptors: Readonly<Record<string, PropertyDescriptor>>;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return invalidMockRuntime();
  }
  const rawLength: unknown = descriptors.length?.value;
  if (
    typeof rawLength !== "number"
    || !Number.isSafeInteger(rawLength)
    || rawLength < 0
  ) {
    return invalidMockRuntime();
  }

  const snapshot: unknown[] = [];
  for (let index = 0; index < rawLength; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !("value" in descriptor)) {
      return invalidMockRuntime();
    }
    const item: unknown = descriptor.value;
    snapshot[index] = mapItem(item);
  }
  return Object.freeze(snapshot);
}

function snapshotBoardAction(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalidMockRuntime();
  }
  assertNoUnknownEnumerableMockFields(value, BOARD_ACTION_KEY_SET);
  const snapshot: Record<string, unknown> = {};
  Object.setPrototypeOf(snapshot, null);
  for (let index = 0; index < BOARD_ACTION_KEYS.length; index += 1) {
    const key = BOARD_ACTION_KEYS[index];
    if (key === undefined) continue;
    const item = readMockRuntimeMemberWithoutAccessors(value, key);
    if (item !== undefined) snapshot[key] = item;
  }
  return Object.freeze(snapshot);
}

function snapshotInterviewerProposal(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalidMockRuntime();
  }
  assertNoUnknownEnumerableMockFields(value, PROPOSAL_KEY_SET);

  const snapshot: Record<string, unknown> = {};
  Object.setPrototypeOf(snapshot, null);
  for (let index = 0; index < PROPOSAL_KEYS.length; index += 1) {
    const key = PROPOSAL_KEYS[index];
    if (key === undefined) continue;
    const item = readMockRuntimeMemberWithoutAccessors(value, key);
    if (item === undefined) continue;
    if (key === "claimedDisclosureIds") {
      snapshot[key] = snapshotMockArray(item, (entry) => entry);
    } else if (key === "boardActions") {
      snapshot[key] = snapshotMockArray(item, snapshotBoardAction);
    } else {
      snapshot[key] = item;
    }
  }
  return Object.freeze(snapshot);
}

function snapshotMockFactoryRuntime(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalidMockRuntime();
  }
  assertNoUnknownEnumerableMockFields(value, MOCK_RUNTIME_KEYS);
  const proposal = readMockRuntimeMemberWithoutAccessors(value, "proposal");
  const snapshot: Record<string, unknown> = {};
  Object.setPrototypeOf(snapshot, null);
  if (proposal !== undefined) {
    snapshot.proposal = snapshotInterviewerProposal(proposal);
  }
  return Object.freeze(snapshot);
}

const MockProviderFactoryRuntimeSchema = z.object({
  proposal: InterviewerProposalSchema
}).strict();
export type MockProviderFactoryRuntime = z.infer<typeof MockProviderFactoryRuntimeSchema>;

export interface GeminiProviderFactoryRuntime {
  readonly fetchImpl?: typeof fetch;
  readonly billingVerificationFactory?: (now: Date) => unknown;
}

function invalidGeminiRuntime(): never {
  throw new ProviderControlPlaneError(
    "INVALID_FACTORY_INPUT",
    "Gemini provider factory runtime is malformed"
  );
}

function snapshotGeminiFactoryRuntime(value: unknown): GeminiProviderFactoryRuntime {
  if (value === undefined) return Object.freeze({});
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalidGeminiRuntime();
  }

  let descriptors: Readonly<Record<string, PropertyDescriptor>>;
  let symbols: readonly symbol[];
  let prototype: object | null;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
    symbols = Object.getOwnPropertySymbols(value);
    prototype = Object.getPrototypeOf(value);
  } catch {
    return invalidGeminiRuntime();
  }
  if (
    symbols.length !== 0
    || (prototype !== Object.prototype && prototype !== null)
  ) {
    return invalidGeminiRuntime();
  }

  const output: {
    fetchImpl?: typeof fetch;
    billingVerificationFactory?: (now: Date) => unknown;
  } = {};
  for (const key of Object.keys(descriptors)) {
    if (!setHas(GEMINI_RUNTIME_KEYS, key)) return invalidGeminiRuntime();
    const descriptor = descriptors[key];
    if (
      descriptor === undefined
      || descriptor.enumerable !== true
      || !("value" in descriptor)
      || typeof descriptor.value !== "function"
    ) {
      return invalidGeminiRuntime();
    }
    if (key === "fetchImpl") {
      output.fetchImpl = descriptor.value as typeof fetch;
    } else if (key === "billingVerificationFactory") {
      output.billingVerificationFactory =
        descriptor.value as (now: Date) => unknown;
    }
  }
  return Object.freeze(output);
}

const mockFactory: ProviderAdapterFactoryDefinition = {
  id: "mock-model-adapter-factory",
  createAdapter(input) {
    let runtimeCandidate: unknown;
    try {
      runtimeCandidate = snapshotMockFactoryRuntime(input.runtime);
    } catch {
      return invalidMockRuntime();
    }
    const runtime = MockProviderFactoryRuntimeSchema.safeParse(runtimeCandidate);
    if (!runtime.success) return invalidMockRuntime();
    return new MockModelAdapter({ proposal: runtime.data.proposal });
  }
};

const geminiFactory: ProviderAdapterFactoryDefinition = {
  id: "gemini-api-adapter-factory",
  async createAdapter(input) {
    const runtime = snapshotGeminiFactoryRuntime(input.runtime);
    const reference = input.resolved.configuration.credentialRef;
    if (reference === undefined || input.secretResolver === undefined) {
      throw new ProviderControlPlaneError(
        "CREDENTIALS_REQUIRED",
        "Gemini API adapter requires a runtime credential resolver"
      );
    }

    let resolvedSecret: unknown;
    try {
      resolvedSecret = await input.secretResolver.resolveSecret({
        providerId: input.resolved.provider.id,
        reference
      });
    } catch {
      throw new ProviderControlPlaneError(
        "CREDENTIAL_RESOLUTION_FAILED",
        "Gemini API credential resolution failed"
      );
    }
    if (resolvedSecret === undefined) {
      throw new ProviderControlPlaneError(
        "CREDENTIALS_REQUIRED",
        "Gemini API credential could not be resolved"
      );
    }
    if (typeof resolvedSecret !== "string") {
      throw new ProviderControlPlaneError(
        "CREDENTIAL_RESOLUTION_FAILED",
        "Gemini API credential resolver returned an invalid value"
      );
    }
    if (trimBuiltInCredential(resolvedSecret).length === 0) {
      throw new ProviderControlPlaneError(
        "CREDENTIALS_REQUIRED",
        "Gemini API credential could not be resolved"
      );
    }

    return new GeminiApiAdapter({
      apiKey: resolvedSecret,
      model: input.resolved.model.adapterModelId ?? input.resolved.model.id,
      ...(runtime.fetchImpl === undefined ? {} : { fetchImpl: runtime.fetchImpl }),
      ...(runtime.billingVerificationFactory === undefined
        ? {}
        : { billingVerificationFactory: runtime.billingVerificationFactory })
    });
  }
};

const MOCK_PROVIDER_INPUT: ProviderDefinitionInput = {
  id: "mock-model",
  displayName: "Deterministic Mock Model",
  kind: "MOCK",
  definitionVersion: "1",
  capabilityVersion: "1",
  adapterVersion: "1.0.0",
  credentialRequirement: "NONE",
  credentialPurposes: [],
  models: [{
    id: "mock-default",
    displayName: "Deterministic Mock",
    metadataVersion: "1",
    capabilities: {
      textGeneration: "SUPPORTED",
      imageInput: "UNSUPPORTED",
      toolCalling: "UNSUPPORTED",
      streaming: "UNSUPPORTED",
      reasoningControls: "UNSUPPORTED",
      reasoningLevels: [],
      persistentSession: "UNSUPPORTED",
      resumableSession: "UNSUPPORTED",
      sessionSurvivesClientAbort: "UNSUPPORTED",
      sessionSurvivesProviderCancel: "UNSUPPORTED",
      usageReporting: "UNSUPPORTED",
      localExecution: "SUPPORTED",
      remoteExecution: "UNSUPPORTED",
      meteredExecution: "UNSUPPORTED",
      dataUse: "LOCAL_ONLY",
      structuredOutput: "FINAL_ONLY",
      cancellation: "DROP_OUTPUT",
      contextWindowTokens: "UNKNOWN",
      outputLimitTokens: "UNKNOWN"
    }
  }],
  adapterFactory: mockFactory
};

const GEMINI_API_PROVIDER_INPUT: ProviderDefinitionInput = {
  id: "gemini-api",
  displayName: "Gemini API",
  kind: "REMOTE_API",
  definitionVersion: "1",
  capabilityVersion: "1",
  adapterVersion: "1.0.0",
  credentialRequirement: "REQUIRED",
  credentialPurposes: ["API_KEY"],
  models: [{
    id: "gemini-2.5-flash",
    displayName: "Gemini 2.5 Flash",
    adapterModelId: "gemini-2.5-flash",
    metadataVersion: "1",
    capabilities: {
      textGeneration: "SUPPORTED",
      imageInput: "UNSUPPORTED",
      toolCalling: "UNSUPPORTED",
      streaming: "UNSUPPORTED",
      reasoningControls: "UNSUPPORTED",
      reasoningLevels: [],
      persistentSession: "UNSUPPORTED",
      resumableSession: "UNSUPPORTED",
      sessionSurvivesClientAbort: "UNSUPPORTED",
      sessionSurvivesProviderCancel: "UNSUPPORTED",
      usageReporting: "UNSUPPORTED",
      localExecution: "UNSUPPORTED",
      remoteExecution: "SUPPORTED",
      meteredExecution: "UNKNOWN",
      dataUse: "REMOTE_MAY_BE_USED_FOR_IMPROVEMENT",
      structuredOutput: "FINAL_ONLY",
      cancellation: "CLOSE_CLIENT_STREAM",
      contextWindowTokens: "UNKNOWN",
      outputLimitTokens: "UNKNOWN"
    }
  }],
  adapterFactory: geminiFactory
};

export const MOCK_PROVIDER_DEFINITION: ProviderDefinition = defineProvider(MOCK_PROVIDER_INPUT);
export const GEMINI_API_PROVIDER_DEFINITION: ProviderDefinition = defineProvider(GEMINI_API_PROVIDER_INPUT);

export function registerBuiltInProviders(
  registry: ProviderRegistry = new ProviderRegistry()
): ProviderRegistry {
  try {
    REFLECT_APPLY_INTRINSIC(
      registerProviderDefinitions,
      registry,
      [[MOCK_PROVIDER_INPUT, GEMINI_API_PROVIDER_INPUT]]
    );
  } catch (error) {
    if (isProviderControlPlaneError(error)) throw error;
    throw new ProviderControlPlaneError(
      "INVALID_REGISTRY",
      "Provider registry is invalid"
    );
  }
  return registry;
}
