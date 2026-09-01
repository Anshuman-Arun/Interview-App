import { describe, expect, it } from "vitest";
import type { InterviewerProposal } from "../packages/domain/src/index.js";
import {
  GEMINI_API_PROVIDER_DEFINITION,
  MOCK_PROVIDER_DEFINITION,
  ProviderConfigurationSchema,
  ProviderControlPlaneError,
  ProviderRegistry,
  createProviderConfigurationFingerprintMaterial,
  defineProvider,
  evaluateProviderReadiness,
  matchCapabilityRequirements,
  registerBuiltInProviders,
  resolveAdapterFactory,
  resolveProviderConfiguration,
  toPersistableProviderConfiguration,
  toProviderDiagnosticMetadata,
  type ProviderDefinition,
  type ProviderSecretResolver
} from "../packages/providers/src/index.js";

const PROPOSAL: InterviewerProposal = {
  realizedAction: "PROBE_JUSTIFICATION",
  claimedDisclosureLevel: 0,
  claimedDisclosureIds: [],
  speechText: "Why must that be true?"
};

const MOCK_CONFIGURATION = ProviderConfigurationSchema.parse({
  version: 1,
  providerId: "mock-model",
  modelId: "mock-default",
  enabled: true
});

const GEMINI_CONFIGURATION = ProviderConfigurationSchema.parse({
  version: 1,
  providerId: "gemini-api",
  modelId: "gemini-2.5-flash",
  enabled: true,
  credentialRef: {
    id: "gemini-primary",
    purpose: "API_KEY"
  }
});

function createUnknownCapabilityProvider(): ProviderDefinition {
  return defineProvider({
    id: "uncertain-provider",
    displayName: "Uncertain Provider",
    kind: "OTHER",
    definitionVersion: "1",
    capabilityVersion: "1",
    credentialRequirement: "NONE",
    credentialPurposes: [],
    models: [{
      id: "uncertain-model",
      displayName: "Uncertain Model",
      capabilities: {
        textGeneration: "SUPPORTED",
        imageInput: "UNKNOWN",
        toolCalling: "UNKNOWN",
        streaming: "UNSUPPORTED",
        reasoningControls: "UNKNOWN",
        reasoningLevels: "UNKNOWN",
        persistentSession: "UNKNOWN",
        resumableSession: "UNKNOWN",
        sessionSurvivesClientAbort: "UNKNOWN",
        sessionSurvivesProviderCancel: "UNKNOWN",
        usageReporting: "UNKNOWN",
        localExecution: "UNKNOWN",
        remoteExecution: "UNKNOWN",
        meteredExecution: "UNKNOWN",
        dataUse: "UNKNOWN",
        structuredOutput: "UNKNOWN",
        cancellation: "UNKNOWN",
        contextWindowTokens: "UNKNOWN",
        outputLimitTokens: "UNKNOWN"
      }
    }]
  });
}

function firstModel(definition: ProviderDefinition) {
  const model = definition.models[0];
  if (model === undefined) throw new Error("Test provider definition has no model");
  return model;
}

describe("provider control plane registry", () => {
  it("registers and enumerates providers/models deterministically", () => {
    const registry = new ProviderRegistry();
    registry.register(MOCK_PROVIDER_DEFINITION);
    registry.register(GEMINI_API_PROVIDER_DEFINITION);

    expect(registry.enumerateProviders().map((provider) => provider.id))
      .toEqual(["gemini-api", "mock-model"]);
    expect(registry.enumerateModels("gemini-api").map((model) => model.id))
      .toEqual(["gemini-2.5-flash"]);
    expect(registry.getModel("mock-model", "mock-default").displayName)
      .toBe("Deterministic Mock");
    expect(Object.isFrozen(registry.getProvider("mock-model"))).toBe(true);
    expect(Object.isFrozen(registry.getModel("mock-model", "mock-default").capabilities)).toBe(true);
  });

  it("rejects duplicate provider IDs", () => {
    const registry = new ProviderRegistry();
    registry.register(MOCK_PROVIDER_DEFINITION);
    expect(() => registry.register(MOCK_PROVIDER_DEFINITION)).toThrow(
      expect.objectContaining({ code: "DUPLICATE_PROVIDER" })
    );
  });

  it("rejects duplicate model IDs inside a provider definition", () => {
    const model = firstModel(MOCK_PROVIDER_DEFINITION);
    expect(() => defineProvider({
      id: "duplicate-model-provider",
      displayName: "Duplicate Model Provider",
      kind: "OTHER",
      definitionVersion: "1",
      capabilityVersion: "1",
      credentialRequirement: "NONE",
      credentialPurposes: [],
      models: [model, model]
    })).toThrow(expect.objectContaining({ code: "DUPLICATE_MODEL" }));
  });

  it("reports unknown providers and models without fallback", () => {
    const registry = registerBuiltInProviders();

    expect(() => registry.getProvider("missing-provider"))
      .toThrow(expect.objectContaining({ code: "UNKNOWN_PROVIDER" }));
    expect(() => resolveProviderConfiguration({
      registry,
      configuration: {
        ...MOCK_CONFIGURATION,
        modelId: "missing-model"
      }
    })).toThrow(expect.objectContaining({ code: "UNKNOWN_MODEL" }));
  });
});

describe("provider capability declarations and matching", () => {
  it("matches supported requirements and separates unsupported from unknown", () => {
    const mockCapabilities = firstModel(MOCK_PROVIDER_DEFINITION).capabilities;
    expect(matchCapabilityRequirements(
      mockCapabilities,
      ["TEXT_GENERATION", "LOCAL_EXECUTION", "STRUCTURED_OUTPUT"]
    )).toEqual({
      compatible: true,
      unsupported: [],
      unknown: []
    });

    expect(matchCapabilityRequirements(
      mockCapabilities,
      ["IMAGE_INPUT", "TOOL_CALLING"]
    )).toEqual({
      compatible: false,
      unsupported: ["IMAGE_INPUT", "TOOL_CALLING"],
      unknown: []
    });

    const uncertain = firstModel(createUnknownCapabilityProvider()).capabilities;
    expect(matchCapabilityRequirements(uncertain, ["IMAGE_INPUT"])).toEqual({
      compatible: false,
      unsupported: [],
      unknown: ["IMAGE_INPUT"]
    });
  });

  it("keeps unknown capability status distinct from known incompatibility", async () => {
    const registry = new ProviderRegistry();
    registry.register(createUnknownCapabilityProvider());
    const configuration = {
      version: 1,
      providerId: "uncertain-provider",
      modelId: "uncertain-model",
      enabled: true
    };

    expect(() => resolveProviderConfiguration({
      registry,
      configuration,
      requirements: ["IMAGE_INPUT"]
    })).toThrow(expect.objectContaining({ code: "CAPABILITY_STATUS_UNKNOWN" }));

    await expect(evaluateProviderReadiness({
      registry,
      configuration,
      requirements: ["IMAGE_INPUT"]
    })).resolves.toEqual({
      state: "UNKNOWN",
      providerId: "uncertain-provider",
      modelId: "uncertain-model",
      reason: "CAPABILITY_STATUS_UNKNOWN"
    });
  });

  it("reports unknown reasoning support as UNKNOWN readiness while still failing closed", async () => {
    const registry = new ProviderRegistry();
    registry.register(createUnknownCapabilityProvider());
    const configuration = {
      version: 1,
      providerId: "uncertain-provider",
      modelId: "uncertain-model",
      enabled: true,
      reasoning: { level: "high" }
    };

    expect(() => resolveProviderConfiguration({
      registry,
      configuration
    })).toThrow(expect.objectContaining({ code: "CAPABILITY_STATUS_UNKNOWN" }));

    await expect(evaluateProviderReadiness({
      registry,
      configuration
    })).resolves.toEqual({
      state: "UNKNOWN",
      providerId: "uncertain-provider",
      modelId: "uncertain-model",
      reason: "CAPABILITY_STATUS_UNKNOWN"
    });
  });

  it("rejects incompatible requested capabilities before adapter execution", () => {
    const registry = registerBuiltInProviders();
    expect(() => resolveProviderConfiguration({
      registry,
      configuration: MOCK_CONFIGURATION,
      requirements: ["IMAGE_INPUT"]
    })).toThrow(expect.objectContaining({ code: "INCOMPATIBLE_CAPABILITY" }));
  });

  it("treats configured reasoning as requiring established reasoning controls", () => {
    const registry = registerBuiltInProviders();
    expect(() => resolveProviderConfiguration({
      registry,
      configuration: {
        ...GEMINI_CONFIGURATION,
        reasoning: { level: "high" }
      }
    })).toThrow(expect.objectContaining({ code: "INCOMPATIBLE_CAPABILITY" }));
  });
});

describe("provider configuration and secret boundary", () => {
  it("validates provider-specific settings through the registered extension seam", () => {
    const registry = new ProviderRegistry();
    registry.register(defineProvider({
      ...createUnknownCapabilityProvider(),
      id: "settings-provider",
      models: [{
        ...firstModel(createUnknownCapabilityProvider()),
        id: "settings-model"
      }],
      validateSettings(settings) {
        if (settings.mode !== "strict") {
          throw new Error("invalid mode");
        }
        return { mode: "strict" };
      }
    }));

    const resolved = resolveProviderConfiguration({
      registry,
      configuration: {
        version: 1,
        providerId: "settings-provider",
        modelId: "settings-model",
        enabled: true,
        settings: { mode: "strict" }
      }
    });

    expect(resolved.configuration.settings).toEqual({ mode: "strict" });
    expect(() => resolveProviderConfiguration({
      registry,
      configuration: {
        version: 1,
        providerId: "settings-provider",
        modelId: "settings-model",
        enabled: true,
        settings: { mode: "loose" }
      }
    })).toThrow(expect.objectContaining({ code: "MALFORMED_CONFIGURATION" }));
  });

  it("rejects raw secret-like fields from generic provider settings", () => {
    const registry = new ProviderRegistry();
    registry.register(defineProvider({
      ...createUnknownCapabilityProvider(),
      id: "settings-provider",
      models: [{
        ...firstModel(createUnknownCapabilityProvider()),
        id: "settings-model"
      }],
      validateSettings(settings) {
        return settings;
      }
    }));

    expect(() => resolveProviderConfiguration({
      registry,
      configuration: {
        version: 1,
        providerId: "settings-provider",
        modelId: "settings-model",
        enabled: true,
        settings: {
          apiKey: "raw-private-value"
        }
      }
    })).toThrow(expect.objectContaining({ code: "SECRET_IN_CONFIGURATION" }));
  });

  it("excludes credential references from persistable configuration and fingerprint material", () => {
    const first = {
      ...GEMINI_CONFIGURATION,
      credentialRef: { id: "gemini-primary", purpose: "API_KEY" as const }
    };
    const second = {
      ...GEMINI_CONFIGURATION,
      credentialRef: { id: "gemini-secondary", purpose: "API_KEY" as const }
    };

    const persistable = toPersistableProviderConfiguration(first);
    expect(persistable).not.toHaveProperty("credentialRef");
    expect(persistable).not.toHaveProperty("credentialPurpose");
    expect(JSON.stringify(persistable)).not.toContain("gemini-primary");
    expect(ProviderConfigurationSchema.parse(persistable)).toEqual(persistable);
    expect(createProviderConfigurationFingerprintMaterial(first))
      .toBe(createProviderConfigurationFingerprintMaterial(second));
    expect(createProviderConfigurationFingerprintMaterial(first))
      .not.toContain("gemini-primary");

    const tokenCredential = {
      ...GEMINI_CONFIGURATION,
      credentialRef: { id: "gemini-token", purpose: "TOKEN" as const }
    };
    expect(toPersistableProviderConfiguration(tokenCredential))
      .not.toHaveProperty("credentialPurpose");
    expect(createProviderConfigurationFingerprintMaterial(first))
      .not.toBe(createProviderConfigurationFingerprintMaterial(tokenCredential));
  });

  it("rejects disabled configurations deterministically", () => {
    const registry = registerBuiltInProviders();
    expect(() => resolveProviderConfiguration({
      registry,
      configuration: {
        ...MOCK_CONFIGURATION,
        enabled: false
      }
    })).toThrow(expect.objectContaining({ code: "DISABLED" }));
  });
});

describe("provider readiness", () => {
  it("represents available, disabled, missing-credential, and unknown credential states", async () => {
    const registry = registerBuiltInProviders();

    await expect(evaluateProviderReadiness({
      registry,
      configuration: MOCK_CONFIGURATION
    })).resolves.toEqual({
      state: "AVAILABLE",
      providerId: "mock-model",
      modelId: "mock-default"
    });

    await expect(evaluateProviderReadiness({
      registry,
      configuration: { ...MOCK_CONFIGURATION, enabled: false }
    })).resolves.toEqual({
      state: "DISABLED",
      providerId: "mock-model",
      modelId: "mock-default"
    });

    await expect(evaluateProviderReadiness({
      registry,
      configuration: {
        version: 1,
        providerId: "gemini-api",
        modelId: "gemini-2.5-flash",
        enabled: true
      }
    })).resolves.toEqual({
      state: "CREDENTIALS_REQUIRED",
      providerId: "gemini-api",
      modelId: "gemini-2.5-flash"
    });

    await expect(evaluateProviderReadiness({
      registry,
      configuration: GEMINI_CONFIGURATION
    })).resolves.toEqual({
      state: "UNKNOWN",
      providerId: "gemini-api",
      modelId: "gemini-2.5-flash",
      reason: "CREDENTIAL_STATUS_UNKNOWN"
    });
  });

  it("uses a runtime resolver only to establish credential presence", async () => {
    const registry = registerBuiltInProviders();
    const missingResolver: ProviderSecretResolver = {
      async resolveSecret() {
        return undefined;
      },
      async hasSecret() {
        return false;
      }
    };
    const presentResolver: ProviderSecretResolver = {
      async resolveSecret() {
        return "runtime-only-key";
      },
      async hasSecret() {
        return true;
      }
    };

    await expect(evaluateProviderReadiness({
      registry,
      configuration: GEMINI_CONFIGURATION,
      secretResolver: missingResolver
    })).resolves.toMatchObject({ state: "CREDENTIALS_REQUIRED" });

    await expect(evaluateProviderReadiness({
      registry,
      configuration: GEMINI_CONFIGURATION,
      secretResolver: presentResolver
    })).resolves.toMatchObject({ state: "AVAILABLE" });
  });
});

describe("adapter factory boundary and built-in registrations", () => {
  it("resolves the existing mock adapter without executing interview runtime logic", async () => {
    const registry = registerBuiltInProviders();
    const resolved = resolveProviderConfiguration({
      registry,
      configuration: MOCK_CONFIGURATION,
      requirements: ["TEXT_GENERATION"]
    });
    const factory = resolveAdapterFactory(resolved);
    const adapter = await factory.createAdapter({
      resolved,
      runtime: { proposal: PROPOSAL }
    });

    expect(factory.id).toBe("mock-model-adapter-factory");
    expect(adapter.name).toBe("mock-model");
    expect(adapter.capabilities.dataUse).toBe("LOCAL_ONLY");
  });

  it("resolves Gemini metadata/factory without making a live provider call", async () => {
    const registry = registerBuiltInProviders();
    const resolved = resolveProviderConfiguration({
      registry,
      configuration: GEMINI_CONFIGURATION,
      requirements: ["TEXT_GENERATION", "REMOTE_EXECUTION"]
    });
    const factory = resolveAdapterFactory(resolved);
    const secretResolver: ProviderSecretResolver = {
      async resolveSecret(reference) {
        expect(reference).toEqual({
          providerId: "gemini-api",
          reference: {
            id: "gemini-primary",
            purpose: "API_KEY"
          }
        });
        return "runtime-only-key";
      },
      async hasSecret() {
        return true;
      }
    };

    const adapter = await factory.createAdapter({ resolved, secretResolver });
    expect(factory.id).toBe("gemini-api-adapter-factory");
    expect(adapter.name).toBe("gemini-api");
    expect(adapter.capabilities.dataUse).toBe("REMOTE_MAY_BE_USED_FOR_IMPROVEMENT");
    expect(resolved.model.capabilities.meteredExecution).toBe("UNKNOWN");
  });

  it("keeps built-in Gemini registration descriptive rather than policy approval", () => {
    expect(GEMINI_API_PROVIDER_DEFINITION.kind).toBe("REMOTE_API");
    expect(GEMINI_API_PROVIDER_DEFINITION.credentialRequirement).toBe("REQUIRED");
    expect(firstModel(GEMINI_API_PROVIDER_DEFINITION).capabilities.dataUse)
      .toBe("REMOTE_MAY_BE_USED_FOR_IMPROVEMENT");
  });

  it("produces plain diagnostics metadata without depending on diagnostics package", () => {
    const registry = registerBuiltInProviders();
    const resolved = resolveProviderConfiguration({
      registry,
      configuration: MOCK_CONFIGURATION
    });
    const metadata = toProviderDiagnosticMetadata(resolved);

    expect(metadata).toMatchObject({
      providerId: "mock-model",
      modelId: "mock-default",
      providerDefinitionVersion: "1",
      capabilityVersion: "1",
      modelMetadataVersion: "1"
    });
    expect(metadata.capabilities.textGeneration).toBe("SUPPORTED");
    expect(metadata.configurationFingerprintMaterial)
      .toBe(createProviderConfigurationFingerprintMaterial(MOCK_CONFIGURATION));
  });

  it("throws a typed error when a registered provider has no adapter factory", () => {
    const registry = new ProviderRegistry();
    registry.register(createUnknownCapabilityProvider());
    const resolved = resolveProviderConfiguration({
      registry,
      configuration: {
        version: 1,
        providerId: "uncertain-provider",
        modelId: "uncertain-model",
        enabled: true
      }
    });

    expect(() => resolveAdapterFactory(resolved)).toThrow(ProviderControlPlaneError);
    expect(() => resolveAdapterFactory(resolved))
      .toThrow(expect.objectContaining({ code: "ADAPTER_FACTORY_UNAVAILABLE" }));
  });
});
