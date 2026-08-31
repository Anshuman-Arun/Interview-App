import { describe, expect, it } from "vitest";
import type {
  InterviewerProposal,
  ModelCapabilities
} from "../packages/domain/src/index.js";
import {
  GEMINI_API_PROVIDER_DEFINITION,
  MOCK_PROVIDER_DEFINITION,
  GeminiApiAdapter,
  MockModelAdapter,
  ProviderConfigurationSchema,
  ProviderControlPlaneError,
  ProviderModelDefinitionSchema,
  ProviderRegistry,
  ProviderSecretReferenceSchema,
  defineProvider,
  evaluateProviderReadiness,
  registerBuiltInProviders,
  resolveAdapterFactory,
  resolveProviderConfiguration,
  type ProviderDefinition,
  type ProviderDefinitionInput,
  type ProviderModelCapabilities,
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

function capabilities(
  overrides: Partial<ProviderModelCapabilities> = {}
): ProviderModelCapabilities {
  return {
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
    localExecution: "UNKNOWN",
    remoteExecution: "UNKNOWN",
    meteredExecution: "UNKNOWN",
    dataUse: "UNKNOWN",
    structuredOutput: "FINAL_ONLY",
    cancellation: "NONE",
    contextWindowTokens: "UNKNOWN",
    outputLimitTokens: "UNKNOWN",
    ...overrides
  };
}

function providerInput(
  overrides: Partial<ProviderDefinitionInput> = {}
): ProviderDefinitionInput {
  return {
    id: "test-provider",
    displayName: "Test Provider",
    kind: "OTHER",
    definitionVersion: "1",
    capabilityVersion: "1",
    credentialRequirement: "NONE",
    credentialPurposes: [],
    models: [{
      id: "test-model",
      displayName: "Test Model",
      capabilities: capabilities()
    }],
    ...overrides
  };
}

function firstModel(definition: ProviderDefinition) {
  const model = definition.models[0];
  if (model === undefined) throw new Error("Test provider has no model");
  return model;
}

function expectExecutionMetadataAligned(
  declared: ProviderModelCapabilities,
  actual: ModelCapabilities
): void {
  expect(declared.imageInput).toBe(
    actual.inputModalities.has("image") ? "SUPPORTED" : "UNSUPPORTED"
  );
  expect(declared.streaming).toBe(actual.textStreaming ? "SUPPORTED" : "UNSUPPORTED");
  expect(declared.structuredOutput).toBe(actual.structuredOutput);
  expect(declared.persistentSession).toBe(
    actual.persistentSession ? "SUPPORTED" : "UNSUPPORTED"
  );
  expect(declared.resumableSession).toBe(
    actual.resumableSession ? "SUPPORTED" : "UNSUPPORTED"
  );
  expect(declared.cancellation).toBe(actual.cancellation);
  expect(declared.sessionSurvivesClientAbort).toBe(
    actual.sessionSurvivesClientAbort ? "SUPPORTED" : "UNSUPPORTED"
  );
  expect(declared.sessionSurvivesProviderCancel).toBe(
    actual.sessionSurvivesProviderCancel ? "SUPPORTED" : "UNSUPPORTED"
  );
  expect(declared.usageReporting).toBe(actual.usageReporting ? "SUPPORTED" : "UNSUPPORTED");
  expect(declared.dataUse).toBe(actual.dataUse);
}

describe("provider registration snapshot semantics", () => {
  it("does not re-read provider definitions through Proxy get traps after descriptor inspection", () => {
    let getCalls = 0;
    const input = new Proxy(providerInput(), {
      get() {
        getCalls += 1;
        throw new Error("ordinary property access must not occur");
      }
    });

    const definition = defineProvider(input);
    expect(definition.id).toBe("test-provider");
    expect(getCalls).toBe(0);
  });

  it("does not re-read adapter factories through Proxy get traps", () => {
    let getCalls = 0;
    const rawFactory = {
      id: "test-factory",
      createAdapter() {
        return new MockModelAdapter({ proposal: PROPOSAL });
      }
    };
    const factory = new Proxy(rawFactory, {
      get() {
        getCalls += 1;
        throw new Error("ordinary property access must not occur");
      }
    });

    const definition = defineProvider(providerInput({
      id: "mock-model",
      adapterVersion: "1.0.0",
      models: [{
        id: "test-model",
        displayName: "Test Model",
        capabilities: firstModel(MOCK_PROVIDER_DEFINITION).capabilities
      }],
      adapterFactory: factory
    }));
    expect(definition.adapterFactory?.id).toBe("test-factory");
    expect(getCalls).toBe(0);
  });

  it("keeps registerMany atomic when a later definition is invalid or duplicated", () => {
    const registry = new ProviderRegistry();
    const valid = providerInput({ id: "first-provider" });
    const malformed = providerInput({
      id: "second-provider",
      credentialRequirement: "REQUIRED",
      credentialPurposes: []
    });

    expect(() => registry.registerMany([valid, malformed]))
      .toThrow(expect.objectContaining({ code: "MALFORMED_DEFINITION" }));
    expect(registry.enumerateProviders()).toEqual([]);

    expect(() => registry.registerMany([
      providerInput({ id: "duplicate-provider" }),
      providerInput({ id: "duplicate-provider" })
    ])).toThrow(expect.objectContaining({ code: "DUPLICATE_PROVIDER" }));
    expect(registry.enumerateProviders()).toEqual([]);
  });

  it("rejects execution-kind contradictions instead of publishing ambiguous metadata", () => {
    expect(() => defineProvider(providerInput({
      kind: "REMOTE_API",
      models: [{
        id: "test-model",
        displayName: "Test Model",
        capabilities: capabilities({
          localExecution: "SUPPORTED",
          remoteExecution: "SUPPORTED"
        })
      }]
    }))).toThrow(expect.objectContaining({ code: "MALFORMED_DEFINITION" }));

    expect(() => defineProvider(providerInput({
      kind: "LOCAL_PROCESS",
      models: [{
        id: "test-model",
        displayName: "Test Model",
        capabilities: capabilities({
          localExecution: "UNSUPPORTED",
          remoteExecution: "UNSUPPORTED"
        })
      }]
    }))).toThrow(expect.objectContaining({ code: "MALFORMED_DEFINITION" }));

    expect(() => defineProvider(providerInput({
      kind: "REMOTE_API",
      models: [{
        id: "test-model",
        displayName: "Test Model",
        capabilities: capabilities({
          localExecution: "UNKNOWN",
          remoteExecution: "SUPPORTED"
        })
      }]
    }))).toThrow(expect.objectContaining({ code: "MALFORMED_DEFINITION" }));
  });
});

describe("direct exported schema hardening", () => {
  it("does not invoke model-definition accessors", () => {
    let calls = 0;
    const model = Object.defineProperty({
      id: "test-model",
      displayName: "Test Model",
      capabilities: capabilities()
    }, "metadataVersion", {
      enumerable: true,
      get() {
        calls += 1;
        return "1";
      }
    });

    expect(ProviderModelDefinitionSchema.safeParse(model).success).toBe(false);
    expect(calls).toBe(0);
  });

  it("does not invoke secret-reference accessors", () => {
    let calls = 0;
    const reference = Object.defineProperty({
      id: "credential-id"
    }, "purpose", {
      enumerable: true,
      get() {
        calls += 1;
        return "API_KEY";
      }
    });

    expect(ProviderSecretReferenceSchema.safeParse(reference).success).toBe(false);
    expect(calls).toBe(0);
  });
});

describe("credential readiness edge cases", () => {
  it("checks an optional credential reference when one is configured", async () => {
    const registry = new ProviderRegistry();
    registry.register(providerInput({
      id: "optional-provider",
      adapterVersion: "1.0.0",
      credentialRequirement: "OPTIONAL",
      credentialPurposes: ["TOKEN"],
      adapterFactory: {
        id: "optional-factory",
        createAdapter() {
          throw new Error("readiness must not create adapters");
        }
      }
    }));
    const configuration = {
      version: 1,
      providerId: "optional-provider",
      modelId: "test-model",
      enabled: true,
      credentialRef: {
        id: "optional-token",
        purpose: "TOKEN"
      }
    };

    await expect(evaluateProviderReadiness({ registry, configuration }))
      .resolves.toMatchObject({
        state: "UNKNOWN",
        reason: "CREDENTIAL_STATUS_UNKNOWN"
      });

    const missing: ProviderSecretResolver = {
      async resolveSecret() {
        return undefined;
      },
      async hasSecret() {
        return false;
      }
    };
    await expect(evaluateProviderReadiness({
      registry,
      configuration,
      secretResolver: missing
    })).resolves.toMatchObject({ state: "CREDENTIALS_REQUIRED" });
  });

  it("fails closed when hasSecret returns a non-boolean runtime value", async () => {
    const resolver: ProviderSecretResolver = {
      async resolveSecret() {
        return "runtime-only-key";
      },
      async hasSecret() {
        return true;
      }
    };
    Reflect.set(resolver, "hasSecret", async () => "yes");

    await expect(evaluateProviderReadiness({
      registry: registerBuiltInProviders(),
      configuration: GEMINI_CONFIGURATION,
      secretResolver: resolver
    })).resolves.toEqual({
      state: "UNKNOWN",
      providerId: "gemini-api",
      modelId: "gemini-2.5-flash",
      reason: "CREDENTIAL_STATUS_UNKNOWN"
    });
  });

  it("treats a throwing hasSecret accessor as UNKNOWN instead of escaping readiness", async () => {
    const resolver = Object.defineProperty({
      async resolveSecret() {
        return "runtime-only-key";
      }
    }, "hasSecret", {
      enumerable: true,
      get() {
        throw new Error("Authorization: Bearer accessor-secret");
      }
    });

    await expect(evaluateProviderReadiness({
      registry: registerBuiltInProviders(),
      configuration: GEMINI_CONFIGURATION,
      secretResolver: resolver
    })).resolves.toEqual({
      state: "UNKNOWN",
      providerId: "gemini-api",
      modelId: "gemini-2.5-flash",
      reason: "CREDENTIAL_STATUS_UNKNOWN"
    });
  });

  it("converts credential-probe exceptions to UNKNOWN without exposing error text", async () => {
    const resolver: ProviderSecretResolver = {
      async resolveSecret() {
        return "unused";
      },
      async hasSecret() {
        throw new Error("Authorization: Bearer private-readiness-secret");
      }
    };

    const result = await evaluateProviderReadiness({
      registry: registerBuiltInProviders(),
      configuration: GEMINI_CONFIGURATION,
      secretResolver: resolver
    });
    expect(result).toEqual({
      state: "UNKNOWN",
      providerId: "gemini-api",
      modelId: "gemini-2.5-flash",
      reason: "CREDENTIAL_STATUS_UNKNOWN"
    });
    expect(JSON.stringify(result)).not.toContain("private-readiness-secret");
  });
});

describe("adapter factory adversarial boundary", () => {
  it("converts a throwing resolved accessor into INVALID_FACTORY_INPUT", async () => {
    const registry = registerBuiltInProviders();
    const resolved = resolveProviderConfiguration({
      registry,
      configuration: MOCK_CONFIGURATION
    });
    const factory = resolveAdapterFactory(resolved);
    const input: Parameters<typeof factory.createAdapter>[0] = {
      resolved,
      runtime: { proposal: PROPOSAL }
    };
    Object.defineProperty(input, "resolved", {
      enumerable: true,
      get() {
        throw new Error("Authorization: Bearer input-secret");
      }
    });

    await expect(factory.createAdapter(input))
      .rejects.toMatchObject({ code: "INVALID_FACTORY_INPUT" });
  });

  it("rejects fabricated resolved objects", async () => {
    const registry = registerBuiltInProviders();
    const resolved = resolveProviderConfiguration({
      registry,
      configuration: MOCK_CONFIGURATION
    });
    const factory = resolveAdapterFactory(resolved);
    const fabricated: typeof resolved = Object.freeze({ ...resolved });

    await expect(factory.createAdapter({
      resolved: fabricated,
      runtime: { proposal: PROPOSAL }
    })).rejects.toMatchObject({ code: "INVALID_FACTORY_INPUT" });
  });

  it("does not stack validation wrappers when registering an already-defined provider", async () => {
    const definition = defineProvider(providerInput({
      id: "different-provider",
      adapterVersion: "1.0.0",
      models: [{
        id: "test-model",
        displayName: "Test Model",
        capabilities: firstModel(MOCK_PROVIDER_DEFINITION).capabilities
      }],
      adapterFactory: {
        id: "single-wrapper-factory",
        createAdapter() {
          return new MockModelAdapter({ proposal: PROPOSAL });
        }
      }
    }));
    const registry = new ProviderRegistry();
    registry.register(definition);
    const resolved = resolveProviderConfiguration({
      registry,
      configuration: {
        version: 1,
        providerId: "different-provider",
        modelId: "test-model",
        enabled: true
      }
    });

    await expect(resolveAdapterFactory(resolved).createAdapter({ resolved }))
      .rejects.toMatchObject({ code: "ADAPTER_DEFINITION_MISMATCH" });
  });

  it("captures factory behavior at registration rather than following later object mutation", async () => {
    let originalCalls = 0;
    let replacementCalls = 0;
    const mutableFactory = {
      id: "mutable-factory",
      createAdapter() {
        originalCalls += 1;
        return new MockModelAdapter({ proposal: PROPOSAL });
      }
    };
    const registry = new ProviderRegistry();
    registry.register(providerInput({
      id: "mock-model",
      adapterVersion: "1.0.0",
      models: [{
        id: "mutable-model",
        displayName: "Mutable Model",
        capabilities: firstModel(MOCK_PROVIDER_DEFINITION).capabilities
      }],
      adapterFactory: mutableFactory
    }));
    mutableFactory.createAdapter = () => {
      replacementCalls += 1;
      throw new Error("replacement must not run");
    };

    const resolved = resolveProviderConfiguration({
      registry,
      configuration: {
        version: 1,
        providerId: "mock-model",
        modelId: "mutable-model",
        enabled: true
      }
    });
    const adapter = await resolveAdapterFactory(resolved).createAdapter({ resolved });
    expect(adapter.name).toBe("mock-model");
    expect(originalCalls).toBe(1);
    expect(replacementCalls).toBe(0);
  });

  it("rejects returned adapters whose identity contradicts registry metadata", async () => {
    const registry = new ProviderRegistry();
    registry.register(providerInput({
      id: "different-provider",
      adapterVersion: "1.0.0",
      models: [{
        id: "test-model",
        displayName: "Test Model",
        capabilities: firstModel(MOCK_PROVIDER_DEFINITION).capabilities
      }],
      adapterFactory: {
        id: "mismatch-factory",
        createAdapter() {
          return new MockModelAdapter({ proposal: PROPOSAL });
        }
      }
    }));
    const resolved = resolveProviderConfiguration({
      registry,
      configuration: {
        version: 1,
        providerId: "different-provider",
        modelId: "test-model",
        enabled: true
      }
    });

    await expect(resolveAdapterFactory(resolved).createAdapter({ resolved }))
      .rejects.toMatchObject({ code: "ADAPTER_DEFINITION_MISMATCH" });
  });

  it("maps arbitrary factory failures, including spoofed control-plane codes, to a fixed error", async () => {
    for (const createAdapter of [
      () => {
        throw new Error("Authorization: Bearer private-factory-secret");
      },
      () => {
        throw new ProviderControlPlaneError(
          "UNKNOWN_PROVIDER",
          "Authorization: Bearer spoofed-private-secret"
        );
      }
    ]) {
      const registry = new ProviderRegistry();
      registry.register(providerInput({
        id: "throw-provider",
        adapterVersion: "1.0.0",
        models: [{
          id: "test-model",
          displayName: "Test Model",
          capabilities: firstModel(MOCK_PROVIDER_DEFINITION).capabilities
        }],
        adapterFactory: {
          id: "throw-factory",
          createAdapter
        }
      }));
      const resolved = resolveProviderConfiguration({
        registry,
        configuration: {
          version: 1,
          providerId: "throw-provider",
          modelId: "test-model",
          enabled: true
        }
      });

      let caught: unknown;
      try {
        await resolveAdapterFactory(resolved).createAdapter({ resolved });
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({ code: "ADAPTER_FACTORY_FAILED" });
      expect(caught instanceof Error ? caught.message : "")
        .not.toContain("private");
    }
  });

  it("normalizes Gemini resolver failures and rejects non-string resolver results", async () => {
    const registry = registerBuiltInProviders();
    const resolved = resolveProviderConfiguration({
      registry,
      configuration: GEMINI_CONFIGURATION
    });
    const factory = resolveAdapterFactory(resolved);

    const throwingResolver: ProviderSecretResolver = {
      async resolveSecret() {
        throw new Error("Authorization: Bearer private-resolver-secret");
      }
    };
    let thrown: unknown;
    try {
      await factory.createAdapter({
        resolved,
        secretResolver: throwingResolver
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: "CREDENTIAL_RESOLUTION_FAILED" });
    expect(thrown instanceof Error ? thrown.message : "")
      .not.toContain("private-resolver-secret");

    const wrongTypeResolver: ProviderSecretResolver = {
      async resolveSecret() {
        return "placeholder";
      }
    };
    Reflect.set(wrongTypeResolver, "resolveSecret", async () => 42);
    await expect(factory.createAdapter({
      resolved,
      secretResolver: wrongTypeResolver
    })).rejects.toMatchObject({ code: "CREDENTIAL_RESOLUTION_FAILED" });
  });

  it("keeps built-in declarations synchronized with the execution metadata they expose", () => {
    const mock = new MockModelAdapter({ proposal: PROPOSAL });
    const gemini = new GeminiApiAdapter();

    expectExecutionMetadataAligned(
      firstModel(MOCK_PROVIDER_DEFINITION).capabilities,
      mock.capabilities
    );
    expectExecutionMetadataAligned(
      firstModel(GEMINI_API_PROVIDER_DEFINITION).capabilities,
      gemini.capabilities
    );
    expect(MOCK_PROVIDER_DEFINITION.adapterVersion).toBe(mock.adapterVersion);
    expect(GEMINI_API_PROVIDER_DEFINITION.adapterVersion).toBe(gemini.adapterVersion);
  });
});

describe("reasoning configuration exactness", () => {
  it("accepts only an explicitly declared reasoning level", () => {
    const registry = new ProviderRegistry();
    registry.register(providerInput({
      models: [{
        id: "test-model",
        displayName: "Test Model",
        capabilities: capabilities({
          reasoningControls: "SUPPORTED",
          reasoningLevels: ["low", "high"]
        })
      }]
    }));

    expect(resolveProviderConfiguration({
      registry,
      configuration: {
        version: 1,
        providerId: "test-provider",
        modelId: "test-model",
        enabled: true,
        reasoning: { level: "high" }
      }
    }).configuration.reasoning?.level).toBe("high");

    expect(() => resolveProviderConfiguration({
      registry,
      configuration: {
        version: 1,
        providerId: "test-provider",
        modelId: "test-model",
        enabled: true,
        reasoning: { level: "medium" }
      }
    })).toThrow(expect.objectContaining({ code: "INCOMPATIBLE_CAPABILITY" }));
  });
});
