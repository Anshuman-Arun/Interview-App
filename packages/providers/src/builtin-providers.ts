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

const MockProviderFactoryRuntimeSchema = z.object({
  proposal: InterviewerProposalSchema
}).strict();
export type MockProviderFactoryRuntime = z.infer<typeof MockProviderFactoryRuntimeSchema>;

const mockFactory: ProviderAdapterFactoryDefinition = {
  id: "mock-model-adapter-factory",
  createAdapter(input) {
    const runtime = MockProviderFactoryRuntimeSchema.safeParse(input.runtime);
    if (!runtime.success) {
      throw new ProviderControlPlaneError(
        "INVALID_FACTORY_INPUT",
        "Mock provider factory runtime is malformed"
      );
    }
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
  registry.registerMany([MOCK_PROVIDER_INPUT, GEMINI_API_PROVIDER_INPUT]);
  return registry;
}
