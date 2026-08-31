import {
  InterviewerProposalSchema,
  type InterviewerProposal
} from "../../domain/src/index.js";
import { GeminiApiAdapter } from "./gemini-api-adapter.js";
import { MockModelAdapter } from "./mock-model-adapter.js";
import {
  ProviderControlPlaneError,
  ProviderRegistry,
  defineProvider,
  type ProviderAdapterFactory,
  type ProviderDefinition,
  type SafeProviderConfigurationRecord
} from "./control-plane.js";

export interface MockProviderFactoryRuntime {
  readonly proposal: InterviewerProposal;
}

function parseMockRuntime(value: unknown): MockProviderFactoryRuntime {
  if (typeof value !== "object" || value === null) {
    throw new ProviderControlPlaneError(
      "MALFORMED_CONFIGURATION",
      "Mock provider factory requires a runtime proposal"
    );
  }
  const proposal = InterviewerProposalSchema.safeParse(
    (value as Record<string, unknown>).proposal
  );
  if (!proposal.success) {
    throw new ProviderControlPlaneError(
      "MALFORMED_CONFIGURATION",
      "Mock provider factory runtime proposal is malformed"
    );
  }
  return Object.freeze({ proposal: proposal.data });
}

const mockFactory: ProviderAdapterFactory = {
  id: "mock-model-adapter-factory",
  createAdapter(input) {
    const runtime = parseMockRuntime(input.runtime);
    return new MockModelAdapter({ proposal: runtime.proposal });
  }
};

const geminiFactory: ProviderAdapterFactory = {
  id: "gemini-api-adapter-factory",
  async createAdapter(input) {
    const reference = input.resolved.configuration.credentialRef;
    if (reference === undefined || input.secretResolver === undefined) {
      throw new ProviderControlPlaneError(
        "CREDENTIALS_REQUIRED",
        "Gemini API adapter requires a runtime credential resolver"
      );
    }
    const apiKey = await input.secretResolver.resolveSecret(reference);
    if (apiKey === undefined || apiKey.length === 0) {
      throw new ProviderControlPlaneError(
        "CREDENTIALS_REQUIRED",
        "Gemini API credential could not be resolved"
      );
    }
    return new GeminiApiAdapter({
      apiKey,
      model: input.resolved.model.adapterModelId ?? input.resolved.model.id
    });
  }
};

export const MOCK_PROVIDER_DEFINITION: ProviderDefinition = defineProvider({
  id: "mock-model",
  displayName: "Deterministic Mock Model",
  kind: "MOCK",
  definitionVersion: "1",
  capabilityVersion: "1",
  credentialRequirement: "NONE",
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
      localExecution: "SUPPORTED",
      remoteExecution: "UNSUPPORTED",
      meteredExecution: "UNSUPPORTED",
      dataUse: "LOCAL_ONLY",
      structuredOutput: "FINAL_ONLY",
      cancellation: "DROP_OUTPUT"
    }
  }],
  adapterFactory: mockFactory
});

export const GEMINI_API_PROVIDER_DEFINITION: ProviderDefinition = defineProvider({
  id: "gemini-api",
  displayName: "Gemini API",
  kind: "REMOTE_API",
  definitionVersion: "1",
  capabilityVersion: "1",
  credentialRequirement: "REQUIRED",
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
      reasoningControls: "UNKNOWN",
      localExecution: "UNSUPPORTED",
      remoteExecution: "SUPPORTED",
      meteredExecution: "UNKNOWN",
      dataUse: "REMOTE_MAY_BE_USED_FOR_IMPROVEMENT",
      structuredOutput: "FINAL_ONLY",
      cancellation: "CLOSE_CLIENT_STREAM"
    }
  }],
  adapterFactory: geminiFactory
});

export function registerBuiltInProviders(
  registry: ProviderRegistry = new ProviderRegistry()
): ProviderRegistry {
  registry.register(MOCK_PROVIDER_DEFINITION);
  registry.register(GEMINI_API_PROVIDER_DEFINITION);
  return registry;
}

export function rejectAllProviderSpecificSettings(
  settings: SafeProviderConfigurationRecord
): SafeProviderConfigurationRecord {
  if (Object.keys(settings).length > 0) {
    throw new ProviderControlPlaneError(
      "UNSUPPORTED_SETTINGS",
      "This provider does not accept provider-specific settings"
    );
  }
  return Object.freeze({});
}
