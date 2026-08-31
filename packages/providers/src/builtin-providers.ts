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

const registerProviderDefinitions = ProviderRegistry.prototype.registerMany;

const MOCK_RUNTIME_KEYS = new Set(["proposal"]);
const PROPOSAL_KEYS = new Set([
  "realizedAction",
  "claimedDisclosureLevel",
  "claimedDisclosureIds",
  "speechText",
  "boardActions"
]);
const BOARD_ACTION_KEYS = new Set([
  "operation",
  "layer",
  "content",
  "targetShapeId",
  "expectedShapeRevision",
  "annotationPurpose"
]);

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
    if (seen.has(current)) return invalidMockRuntime();
    seen.add(current);

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
      current = Object.getPrototypeOf(current);
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
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (descriptor.enumerable === true && !allowedKeys.has(key)) {
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
    snapshot.push(mapItem(item));
  }
  return Object.freeze(snapshot);
}

function snapshotBoardAction(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalidMockRuntime();
  }
  assertNoUnknownEnumerableMockFields(value, BOARD_ACTION_KEYS);
  const snapshot: Record<string, unknown> = {};
  Object.setPrototypeOf(snapshot, null);
  for (const key of BOARD_ACTION_KEYS) {
    const item = readMockRuntimeMemberWithoutAccessors(value, key);
    if (item !== undefined) snapshot[key] = item;
  }
  return Object.freeze(snapshot);
}

function snapshotInterviewerProposal(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalidMockRuntime();
  }
  assertNoUnknownEnumerableMockFields(value, PROPOSAL_KEYS);

  const snapshot: Record<string, unknown> = {};
  Object.setPrototypeOf(snapshot, null);
  for (const key of PROPOSAL_KEYS) {
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
    if (resolvedSecret.trim().length === 0) {
      throw new ProviderControlPlaneError(
        "CREDENTIALS_REQUIRED",
        "Gemini API credential could not be resolved"
      );
    }

    return new GeminiApiAdapter({
      apiKey: resolvedSecret,
      model: input.resolved.model.adapterModelId ?? input.resolved.model.id
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
    registerProviderDefinitions.call(
      registry,
      [MOCK_PROVIDER_INPUT, GEMINI_API_PROVIDER_INPUT]
    );
  } catch (error) {
    if (error instanceof ProviderControlPlaneError) throw error;
    throw new ProviderControlPlaneError(
      "INVALID_REGISTRY",
      "Provider registry is invalid"
    );
  }
  return registry;
}
