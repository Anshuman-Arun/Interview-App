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

  it("rejects control characters in diagnostic-facing provider metadata", () => {
    for (const overrides of [
      { displayName: "Test\nProvider" },
      { displayName: "\tTest Provider" },
      { definitionVersion: "1\nforged" },
      { definitionVersion: "1\n" },
      { capabilityVersion: "1\u0000forged" },
      { capabilityVersion: "\r1" }
    ]) {
      expect(() => defineProvider(providerInput(overrides)))
        .toThrow(expect.objectContaining({ code: "MALFORMED_DEFINITION" }));
    }

    expect(() => defineProvider(providerInput({
      adapterVersion: "1\rforged",
      adapterFactory: {
        id: "test-factory",
        createAdapter() {
          throw new Error("Factory must not execute during registration");
        }
      }
    }))).toThrow(expect.objectContaining({ code: "MALFORMED_DEFINITION" }));

    expect(() => defineProvider(providerInput({
      models: [{
        id: "test-model",
        displayName: "Test\tModel",
        metadataVersion: "1",
        capabilities: capabilities()
      }]
    }))).toThrow(expect.objectContaining({ code: "MALFORMED_DEFINITION" }));

    expect(() => defineProvider(providerInput({
      models: [{
        id: "test-model",
        displayName: "Test Model",
        metadataVersion: "1\nforged",
        capabilities: capabilities()
      }]
    }))).toThrow(expect.objectContaining({ code: "MALFORMED_DEFINITION" }));
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

    expect(() => defineProvider(providerInput({
      kind: "REMOTE_API",
      models: [{
        id: "test-model",
        displayName: "Test Model",
        capabilities: capabilities({
          localExecution: "UNSUPPORTED",
          remoteExecution: "SUPPORTED",
          dataUse: "LOCAL_ONLY"
        })
      }]
    }))).toThrow(expect.objectContaining({ code: "MALFORMED_DEFINITION" }));

    expect(() => defineProvider(providerInput({
      kind: "LOCAL_PROCESS",
      models: [{
        id: "test-model",
        displayName: "Test Model",
        capabilities: capabilities({
          localExecution: "SUPPORTED",
          remoteExecution: "UNSUPPORTED",
          dataUse: "REMOTE_NO_TRAINING"
        })
      }]
    }))).toThrow(expect.objectContaining({ code: "MALFORMED_DEFINITION" }));

    expect(() => defineProvider(providerInput({
      kind: "REMOTE_API",
      models: [{
        id: "test-model",
        displayName: "Test Model",
        capabilities: capabilities({
          localExecution: "UNSUPPORTED",
          remoteExecution: "SUPPORTED",
          dataUse: "UNKNOWN"
        })
      }]
    }))).not.toThrow();
  });
});

describe("provider definition bound consistency", () => {
  function modelDefinitions(count: number) {
    return Array.from({ length: count }, (_, index) => ({
      id: "model-" + String(index).padStart(3, "0"),
      displayName: "Model " + String(index),
      capabilities: capabilities()
    }));
  }

  it("accepts the schema's declared 128-model boundary", () => {
    const definition = defineProvider(providerInput({
      models: modelDefinitions(128)
    }));
    expect(definition.models).toHaveLength(128);
  });

  it("rejects definitions beyond the declared model boundary", () => {
    expect(() => defineProvider(providerInput({
      models: modelDefinitions(129)
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

describe("registry provenance and batch input hardening", () => {
  it("ignores hostile registry method overrides and uses the registry's private storage", () => {
    class HostileRegistry extends ProviderRegistry {
      public override getProvider(): ProviderDefinition {
        return MOCK_PROVIDER_DEFINITION;
      }

      public override getModel(): ReturnType<typeof firstModel> {
        return firstModel(MOCK_PROVIDER_DEFINITION);
      }
    }

    const registry = new HostileRegistry();
    expect(() => resolveProviderConfiguration({
      registry,
      configuration: MOCK_CONFIGURATION
    })).toThrow(expect.objectContaining({ code: "UNKNOWN_PROVIDER" }));
    expect(() => registry.enumerateModels("mock-model"))
      .toThrow(expect.objectContaining({ code: "UNKNOWN_PROVIDER" }));
  });

  it("ignores instance shadowing of the internal duplicate check", () => {
    const registry = new ProviderRegistry();
    registry.register(providerInput({ id: "duplicate-provider" }));
    Reflect.set(registry, "assertProviderIdAvailable", () => undefined);

    expect(() => registry.register(providerInput({ id: "duplicate-provider" })))
      .toThrow(expect.objectContaining({ code: "DUPLICATE_PROVIDER" }));
  });

  it("normalizes non-registry built-in registration failures", () => {
    expect(() => Reflect.apply(registerBuiltInProviders, undefined, [{}]))
      .toThrow(expect.objectContaining({ code: "INVALID_REGISTRY" }));
  });

  it("registers built-ins with the captured base method even when a subclass overrides registerMany", () => {
    class HostileRegistry extends ProviderRegistry {
      public override registerMany(): readonly ProviderDefinition[] {
        return [];
      }
    }

    const registry = registerBuiltInProviders(new HostileRegistry());
    expect(registry.enumerateProviders().map((provider) => provider.id))
      .toEqual(["gemini-api", "mock-model"]);
  });

  it("rejects accessor-backed registration batches without invoking accessors", () => {
    const registry = new ProviderRegistry();
    let getterCalls = 0;
    const inputs = [providerInput()];
    Object.defineProperty(inputs, "0", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return providerInput();
      }
    });

    expect(() => registry.registerMany(inputs))
      .toThrow(expect.objectContaining({ code: "MALFORMED_DEFINITION" }));
    expect(getterCalls).toBe(0);
    expect(registry.enumerateProviders()).toEqual([]);
  });

  it("rejects oversized or side-property registration batches atomically", () => {
    const registry = new ProviderRegistry();
    const oversized = Array.from(
      { length: 129 },
      (_, index) => providerInput({ id: "provider-" + String(index) })
    );
    expect(() => registry.registerMany(oversized))
      .toThrow(expect.objectContaining({ code: "MALFORMED_DEFINITION" }));
    expect(registry.enumerateProviders()).toEqual([]);

    const withSideProperty = [providerInput()];
    Object.defineProperty(withSideProperty, "extra", {
      enumerable: true,
      value: providerInput({ id: "extra-provider" })
    });
    expect(() => registry.registerMany(withSideProperty))
      .toThrow(expect.objectContaining({ code: "MALFORMED_DEFINITION" }));
    expect(registry.enumerateProviders()).toEqual([]);
  });
});

describe("credential readiness edge cases", () => {
  it("does not inherit a polluted readiness reason on AVAILABLE results", async () => {
    Object.defineProperty(Object.prototype, "reason", {
      configurable: true,
      enumerable: false,
      value: "INCOMPATIBLE_CAPABILITY"
    });
    try {
      const result = await evaluateProviderReadiness({
        registry: registerBuiltInProviders(),
        configuration: MOCK_CONFIGURATION
      });
      expect(result.state).toBe("AVAILABLE");
      expect(Object.getPrototypeOf(result)).toBeNull();
      expect(result.reason).toBeUndefined();
    } finally {
      Reflect.deleteProperty(Object.prototype, "reason");
    }
  });

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

  it("treats accessor-backed resolver methods as UNKNOWN without invoking them", async () => {
    let getterCalls = 0;
    const resolver = Object.defineProperty({
      async resolveSecret() {
        return "runtime-only-key";
      }
    }, "hasSecret", {
      enumerable: true,
      get() {
        getterCalls += 1;
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
    expect(getterCalls).toBe(0);
  });

  it("ignores an inherited secretResolver operation field", async () => {
    Object.defineProperty(Object.prototype, "secretResolver", {
      configurable: true,
      enumerable: false,
      value: {
        async resolveSecret() {
          return "polluted-secret";
        },
        async hasSecret() {
          return true;
        }
      }
    });
    try {
      await expect(evaluateProviderReadiness({
        registry: registerBuiltInProviders(),
        configuration: GEMINI_CONFIGURATION
      })).resolves.toEqual({
        state: "UNKNOWN",
        providerId: "gemini-api",
        modelId: "gemini-2.5-flash",
        reason: "CREDENTIAL_STATUS_UNKNOWN"
      });
    } finally {
      Reflect.deleteProperty(Object.prototype, "secretResolver");
    }
  });

  it("does not accept credential resolver methods inherited only from Object.prototype", async () => {
    Object.defineProperties(Object.prototype, {
      resolveSecret: {
        configurable: true,
        enumerable: false,
        value: async () => "polluted-secret"
      },
      hasSecret: {
        configurable: true,
        enumerable: false,
        value: async () => true
      }
    });
    const resolver: ProviderSecretResolver = {
      async resolveSecret() {
        return "own-secret";
      },
      async hasSecret() {
        return false;
      }
    };
    Reflect.deleteProperty(resolver, "resolveSecret");
    Reflect.deleteProperty(resolver, "hasSecret");

    try {
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

      const resolved = resolveProviderConfiguration({
        registry: registerBuiltInProviders(),
        configuration: GEMINI_CONFIGURATION
      });
      await expect(resolveAdapterFactory(resolved).createAdapter({
        resolved,
        secretResolver: resolver
      })).rejects.toMatchObject({ code: "INVALID_FACTORY_INPUT" });
    } finally {
      Reflect.deleteProperty(Object.prototype, "resolveSecret");
      Reflect.deleteProperty(Object.prototype, "hasSecret");
    }
  });

  it("accepts class-based resolver methods without invoking property accessors", async () => {
    class ClassResolver implements ProviderSecretResolver {
      public async resolveSecret(): Promise<string | undefined> {
        return "runtime-only-key";
      }

      public async hasSecret(): Promise<boolean> {
        return true;
      }
    }

    await expect(evaluateProviderReadiness({
      registry: registerBuiltInProviders(),
      configuration: GEMINI_CONFIGURATION,
      secretResolver: new ClassResolver()
    })).resolves.toEqual({
      state: "AVAILABLE",
      providerId: "gemini-api",
      modelId: "gemini-2.5-flash"
    });
  });

  it("does not report AVAILABLE when the runtime resolver cannot resolve secrets", async () => {
    const resolver: ProviderSecretResolver = {
      async resolveSecret() {
        return "runtime-only-key";
      },
      async hasSecret() {
        return true;
      }
    };
    Reflect.deleteProperty(resolver, "resolveSecret");

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
  it("rejects accessor-backed factory inputs without invoking accessors", async () => {
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
    let getterCalls = 0;
    Object.defineProperty(input, "resolved", {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error("Authorization: Bearer input-secret");
      }
    });

    await expect(factory.createAdapter(input))
      .rejects.toMatchObject({ code: "INVALID_FACTORY_INPUT" });
    expect(getterCalls).toBe(0);
  });

  it("rejects accessor-backed mock runtime proposal fields without invoking them", async () => {
    const registry = registerBuiltInProviders();
    const resolved = resolveProviderConfiguration({
      registry,
      configuration: MOCK_CONFIGURATION
    });
    const factory = resolveAdapterFactory(resolved);
    let getterCalls = 0;
    const runtime = Object.defineProperty({}, "proposal", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return PROPOSAL;
      }
    });

    await expect(factory.createAdapter({ resolved, runtime }))
      .rejects.toMatchObject({ code: "INVALID_FACTORY_INPUT" });
    expect(getterCalls).toBe(0);
  });

  it("rejects nested accessor-backed mock proposal fields without invoking them", async () => {
    const registry = registerBuiltInProviders();
    const resolved = resolveProviderConfiguration({
      registry,
      configuration: MOCK_CONFIGURATION
    });
    const factory = resolveAdapterFactory(resolved);
    let getterCalls = 0;
    const proposal = { ...PROPOSAL };
    Object.defineProperty(proposal, "speechText", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return PROPOSAL.speechText;
      }
    });

    await expect(factory.createAdapter({
      resolved,
      runtime: { proposal }
    })).rejects.toMatchObject({ code: "INVALID_FACTORY_INPUT" });
    expect(getterCalls).toBe(0);
  });

  it("rejects accessor-backed mock board-action array entries without invoking them", async () => {
    const registry = registerBuiltInProviders();
    const resolved = resolveProviderConfiguration({
      registry,
      configuration: MOCK_CONFIGURATION
    });
    const factory = resolveAdapterFactory(resolved);
    let getterCalls = 0;
    const boardAction = {
      operation: "write_text",
      layer: "AI_ANNOTATION",
      content: "x",
      annotationPurpose: "test"
    };
    const boardActions = [boardAction];
    Object.defineProperty(boardActions, "0", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return boardAction;
      }
    });

    await expect(factory.createAdapter({
      resolved,
      runtime: {
        proposal: {
          realizedAction: "PROBE_JUSTIFICATION",
          claimedDisclosureLevel: 0,
          claimedDisclosureIds: [],
          boardActions
        }
      }
    })).rejects.toMatchObject({ code: "INVALID_FACTORY_INPUT" });
    expect(getterCalls).toBe(0);
  });

  it("rejects extra factory-input fields rather than silently ignoring them", async () => {
    const registry = registerBuiltInProviders();
    const resolved = resolveProviderConfiguration({
      registry,
      configuration: MOCK_CONFIGURATION
    });
    const factory = resolveAdapterFactory(resolved);
    const input = {
      resolved,
      runtime: { proposal: PROPOSAL },
      extra: true
    };

    await expect(factory.createAdapter(input))
      .rejects.toMatchObject({ code: "INVALID_FACTORY_INPUT" });
  });

  it("rejects cross-provider factory use before raw factory or credential resolution", async () => {
    let rawFactoryCalls = 0;
    let secretResolverCalls = 0;
    const registry = new ProviderRegistry();

    registry.register(providerInput({
      id: "factory-owner-a",
      adapterVersion: "1.0.0",
      models: [{
        id: "a-model",
        displayName: "A Model",
        capabilities: firstModel(MOCK_PROVIDER_DEFINITION).capabilities
      }],
      adapterFactory: {
        id: "factory-a",
        async createAdapter(input) {
          rawFactoryCalls += 1;
          if (input.secretResolver !== undefined) {
            await input.secretResolver.resolveSecret({
              providerId: input.resolved.provider.id,
              reference: input.resolved.configuration.credentialRef ?? ProviderSecretReferenceSchema.parse({
                id: "unexpected",
                purpose: "API_KEY"
              })
            });
          }
          return new MockModelAdapter({ proposal: PROPOSAL });
        }
      }
    }));

    registry.register(providerInput({
      id: "factory-owner-b",
      adapterVersion: "1.0.0",
      credentialRequirement: "REQUIRED",
      credentialPurposes: ["API_KEY"],
      models: [{
        id: "b-model",
        displayName: "B Model",
        capabilities: firstModel(MOCK_PROVIDER_DEFINITION).capabilities
      }],
      adapterFactory: {
        id: "factory-b",
        createAdapter() {
          return new MockModelAdapter({ proposal: PROPOSAL });
        }
      }
    }));

    const resolvedA = resolveProviderConfiguration({
      registry,
      configuration: {
        version: 1,
        providerId: "factory-owner-a",
        modelId: "a-model",
        enabled: true
      }
    });
    const resolvedB = resolveProviderConfiguration({
      registry,
      configuration: {
        version: 1,
        providerId: "factory-owner-b",
        modelId: "b-model",
        enabled: true,
        credentialRef: {
          id: "provider-b-credential",
          purpose: "API_KEY"
        }
      }
    });
    const factoryA = resolveAdapterFactory(resolvedA);
    const secretResolver: ProviderSecretResolver = {
      async resolveSecret() {
        secretResolverCalls += 1;
        return "provider-b-secret";
      }
    };

    await expect(factoryA.createAdapter({
      resolved: resolvedB,
      secretResolver
    })).rejects.toMatchObject({ code: "INVALID_FACTORY_INPUT" });
    expect(rawFactoryCalls).toBe(0);
    expect(secretResolverCalls).toBe(0);
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

  it("rejects direct construction through the reachable resolution constructor", () => {
    const resolved = resolveProviderConfiguration({
      registry: registerBuiltInProviders(),
      configuration: MOCK_CONFIGURATION
    });
    const prototype: unknown = Object.getPrototypeOf(resolved);
    if (typeof prototype !== "object" || prototype === null) {
      throw new Error("Resolved configuration prototype is unavailable");
    }
    const constructorValue: unknown = Reflect.get(prototype, "constructor");
    if (typeof constructorValue !== "function") {
      throw new Error("Resolved configuration constructor is unavailable");
    }

    expect(() => Reflect.construct(constructorValue, [
      undefined,
      resolved.configuration,
      resolved.provider,
      resolved.model
    ])).toThrow(expect.objectContaining({ code: "INVALID_FACTORY_INPUT" }));
  });

  it("rejects direct construction through the reachable registered-factory constructor", () => {
    const factory = MOCK_PROVIDER_DEFINITION.adapterFactory;
    if (factory === undefined) {
      throw new Error("Mock provider factory is unavailable");
    }
    const prototype: unknown = Object.getPrototypeOf(factory);
    if (typeof prototype !== "object" || prototype === null) {
      throw new Error("Registered factory prototype is unavailable");
    }
    const constructorValue: unknown = Reflect.get(prototype, "constructor");
    if (typeof constructorValue !== "function") {
      throw new Error("Registered factory constructor is unavailable");
    }

    expect(() => Reflect.construct(constructorValue, [
      undefined,
      "forged-factory",
      () => new MockModelAdapter({ proposal: PROPOSAL })
    ])).toThrow(expect.objectContaining({ code: "INVALID_ADAPTER_FACTORY" }));
  });

  it("rejects prototype-forged resolutions that would pass plain instanceof checks", () => {
    const registry = registerBuiltInProviders();
    const resolved = resolveProviderConfiguration({
      registry,
      configuration: MOCK_CONFIGURATION
    });
    const forged = { ...resolved };
    Object.setPrototypeOf(forged, Object.getPrototypeOf(resolved));

    expect(() => resolveAdapterFactory(forged))
      .toThrow(expect.objectContaining({ code: "INVALID_FACTORY_INPUT" }));
  });

  it("keeps resolution provenance checks stable if the reachable constructor is monkey-patched", () => {
    const resolved = resolveProviderConfiguration({
      registry: registerBuiltInProviders(),
      configuration: MOCK_CONFIGURATION
    });
    const prototype: unknown = Object.getPrototypeOf(resolved);
    if (typeof prototype !== "object" || prototype === null) {
      throw new Error("Resolved configuration prototype is unavailable");
    }
    const constructorValue: unknown = Reflect.get(prototype, "constructor");
    if (typeof constructorValue !== "function") {
      throw new Error("Resolved configuration constructor is unavailable");
    }
    const originalChecker: unknown = Reflect.get(constructorValue, "isResolved");
    const forged = { ...resolved };
    Object.setPrototypeOf(forged, prototype);

    try {
      Reflect.set(constructorValue, "isResolved", () => true);
      expect(() => resolveAdapterFactory(forged))
        .toThrow(expect.objectContaining({ code: "INVALID_FACTORY_INPUT" }));
    } finally {
      Reflect.set(constructorValue, "isResolved", originalChecker);
    }
  });

  it("keeps registered-factory brand checks stable if the reachable constructor is monkey-patched", () => {
    const registeredFactory = MOCK_PROVIDER_DEFINITION.adapterFactory;
    if (registeredFactory === undefined) {
      throw new Error("Mock provider factory is unavailable");
    }
    const prototype: unknown = Object.getPrototypeOf(registeredFactory);
    if (typeof prototype !== "object" || prototype === null) {
      throw new Error("Registered factory prototype is unavailable");
    }
    const constructorValue: unknown = Reflect.get(prototype, "constructor");
    if (typeof constructorValue !== "function") {
      throw new Error("Registered factory constructor is unavailable");
    }
    const originalChecker: unknown = Reflect.get(constructorValue, "isRegistered");
    const malformedFactory = {
      id: "malformed-factory",
      createAdapter() {
        return new MockModelAdapter({ proposal: PROPOSAL });
      }
    };
    Reflect.set(malformedFactory, "createAdapter", "not-a-function");

    try {
      Reflect.set(constructorValue, "isRegistered", () => true);
      expect(() => defineProvider(providerInput({
        adapterVersion: "1.0.0",
        adapterFactory: malformedFactory
      }))).toThrow(expect.objectContaining({ code: "INVALID_ADAPTER_FACTORY" }));
    } finally {
      Reflect.set(constructorValue, "isRegistered", originalChecker);
    }
  });

  it("does not expose inherited runtime fields to the registered factory", async () => {
    let observedRuntime: unknown = "not-called";
    const registry = new ProviderRegistry();
    registry.register(providerInput({
      id: "mock-model",
      adapterVersion: "1.0.0",
      models: [{
        id: "runtime-model",
        displayName: "Runtime Model",
        capabilities: firstModel(MOCK_PROVIDER_DEFINITION).capabilities
      }],
      adapterFactory: {
        id: "runtime-observer-factory",
        createAdapter(input) {
          observedRuntime = input.runtime;
          return new MockModelAdapter({ proposal: PROPOSAL });
        }
      }
    }));
    const resolved = resolveProviderConfiguration({
      registry,
      configuration: {
        version: 1,
        providerId: "mock-model",
        modelId: "runtime-model",
        enabled: true
      }
    });

    Object.defineProperty(Object.prototype, "runtime", {
      configurable: true,
      enumerable: false,
      value: { polluted: true }
    });
    try {
      const adapter = await resolveAdapterFactory(resolved).createAdapter({ resolved });
      expect(adapter.name).toBe("mock-model");
      expect(observedRuntime).toBeUndefined();
    } finally {
      Reflect.deleteProperty(Object.prototype, "runtime");
    }
  });

  it("keeps the factory gate as a frozen own function even if its prototype is mutated", async () => {
    const resolved = resolveProviderConfiguration({
      registry: registerBuiltInProviders(),
      configuration: MOCK_CONFIGURATION
    });
    const factory = resolveAdapterFactory(resolved);
    expect(Object.hasOwn(factory, "createAdapter")).toBe(true);
    expect(Object.isFrozen(factory)).toBe(true);

    const prototype: unknown = Object.getPrototypeOf(factory);
    if (typeof prototype !== "object" || prototype === null) {
      throw new Error("Registered factory prototype is unavailable");
    }
    const originalMethod: unknown = Reflect.get(prototype, "createAdapter");
    try {
      Reflect.set(prototype, "createAdapter", async () => {
        throw new Error("prototype bypass must not execute");
      });
      const adapter = await factory.createAdapter({
        resolved,
        runtime: { proposal: PROPOSAL }
      });
      expect(adapter.name).toBe("mock-model");
    } finally {
      if (originalMethod === undefined) {
        Reflect.deleteProperty(prototype, "createAdapter");
      } else {
        Reflect.set(prototype, "createAdapter", originalMethod);
      }
    }
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

  it("reads valid adapter identity accessors once without narrowing ReasoningProvider", async () => {
    let getterCalls = 0;
    const registry = new ProviderRegistry();
    registry.register(providerInput({
      id: "mock-model",
      adapterVersion: "1.0.0",
      models: [{
        id: "accessor-model",
        displayName: "Accessor Model",
        capabilities: firstModel(MOCK_PROVIDER_DEFINITION).capabilities
      }],
      adapterFactory: {
        id: "accessor-adapter-factory",
        createAdapter() {
          const adapter = new MockModelAdapter({ proposal: PROPOSAL });
          Object.defineProperty(adapter, "name", {
            configurable: true,
            enumerable: true,
            get() {
              getterCalls += 1;
              return "mock-model";
            }
          });
          return adapter;
        }
      }
    }));
    const resolved = resolveProviderConfiguration({
      registry,
      configuration: {
        version: 1,
        providerId: "mock-model",
        modelId: "accessor-model",
        enabled: true
      }
    });

    const adapter = await resolveAdapterFactory(resolved).createAdapter({ resolved });
    expect(getterCalls).toBe(1);
    expect(adapter.adapterVersion).toBe("1.0.0");
  });

  it("snapshots top-level capability accessors before domain-schema validation", async () => {
    let getterCalls = 0;
    const registry = new ProviderRegistry();
    registry.register(providerInput({
      id: "mock-model",
      adapterVersion: "1.0.0",
      models: [{
        id: "capability-accessor-model",
        displayName: "Capability Accessor Model",
        capabilities: firstModel(MOCK_PROVIDER_DEFINITION).capabilities
      }],
      adapterFactory: {
        id: "capability-accessor-factory",
        createAdapter() {
          const adapter = new MockModelAdapter({ proposal: PROPOSAL });
          const capabilityRecord = { ...adapter.capabilities };
          Object.defineProperty(capabilityRecord, "textStreaming", {
            configurable: true,
            enumerable: true,
            get() {
              getterCalls += 1;
              return false;
            }
          });
          Reflect.set(adapter, "capabilities", capabilityRecord);
          return adapter;
        }
      }
    }));
    const resolved = resolveProviderConfiguration({
      registry,
      configuration: {
        version: 1,
        providerId: "mock-model",
        modelId: "capability-accessor-model",
        enabled: true
      }
    });

    const adapter = await resolveAdapterFactory(resolved).createAdapter({ resolved });
    expect(adapter.name).toBe("mock-model");
    expect(getterCalls).toBe(1);
  });

  it("normalizes throwing adapter metadata accessors to a fixed mismatch", async () => {
    const registry = new ProviderRegistry();
    registry.register(providerInput({
      id: "mock-model",
      adapterVersion: "1.0.0",
      models: [{
        id: "throwing-accessor-model",
        displayName: "Throwing Accessor Model",
        capabilities: firstModel(MOCK_PROVIDER_DEFINITION).capabilities
      }],
      adapterFactory: {
        id: "throwing-accessor-factory",
        createAdapter() {
          const adapter = new MockModelAdapter({ proposal: PROPOSAL });
          Object.defineProperty(adapter, "name", {
            configurable: true,
            enumerable: true,
            get() {
              throw new Error("Authorization: Bearer private-adapter-secret");
            }
          });
          return adapter;
        }
      }
    }));
    const resolved = resolveProviderConfiguration({
      registry,
      configuration: {
        version: 1,
        providerId: "mock-model",
        modelId: "throwing-accessor-model",
        enabled: true
      }
    });

    let caught: unknown;
    try {
      await resolveAdapterFactory(resolved).createAdapter({ resolved });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: "ADAPTER_DEFINITION_MISMATCH" });
    expect(caught instanceof Error ? caught.message : "")
      .not.toContain("private-adapter-secret");
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

  it("rejects adapters missing required ReasoningProvider methods", async () => {
    for (const methodName of ["createSession", "verifyBillingSafety"] as const) {
      const registry = new ProviderRegistry();
      registry.register(providerInput({
        id: "broken-provider",
        adapterVersion: "1.0.0",
        models: [{
          id: "test-model",
          displayName: "Test Model",
          capabilities: firstModel(MOCK_PROVIDER_DEFINITION).capabilities
        }],
        adapterFactory: {
          id: "broken-factory",
          createAdapter() {
            const adapter = new MockModelAdapter({ proposal: PROPOSAL });
            Reflect.set(adapter, methodName, undefined);
            return adapter;
          }
        }
      }));
      const resolved = resolveProviderConfiguration({
        registry,
        configuration: {
          version: 1,
          providerId: "broken-provider",
          modelId: "test-model",
          enabled: true
        }
      });

      await expect(resolveAdapterFactory(resolved).createAdapter({ resolved }))
        .rejects.toMatchObject({ code: "ADAPTER_DEFINITION_MISMATCH" });
    }
  });

  it("scopes provider factories to the exact configured credential reference", async () => {
    let underlyingResolverCalls = 0;
    const registry = new ProviderRegistry();
    registry.register(providerInput({
      id: "scoped-provider",
      adapterVersion: "1.0.0",
      credentialRequirement: "REQUIRED",
      credentialPurposes: ["API_KEY"],
      adapterFactory: {
        id: "scoped-factory",
        async createAdapter(input) {
          if (input.secretResolver === undefined) {
            throw new ProviderControlPlaneError(
              "CREDENTIALS_REQUIRED",
              "Test resolver is required"
            );
          }
          await input.secretResolver.resolveSecret({
            providerId: input.resolved.provider.id,
            reference: ProviderSecretReferenceSchema.parse({
              id: "other-credential",
              purpose: "API_KEY"
            })
          });
          throw new Error("credential request should have failed");
        }
      }
    }));
    const resolved = resolveProviderConfiguration({
      registry,
      configuration: {
        version: 1,
        providerId: "scoped-provider",
        modelId: "test-model",
        enabled: true,
        credentialRef: {
          id: "configured-credential",
          purpose: "API_KEY"
        }
      }
    });
    const resolver: ProviderSecretResolver = {
      async resolveSecret() {
        underlyingResolverCalls += 1;
        return "must-not-be-returned";
      }
    };

    await expect(resolveAdapterFactory(resolved).createAdapter({
      resolved,
      secretResolver: resolver
    })).rejects.toMatchObject({ code: "CREDENTIAL_RESOLUTION_FAILED" });
    expect(underlyingResolverCalls).toBe(0);
  });

  it("does not expose a resolver capability when no credential reference is configured", async () => {
    let resolverVisibleToFactory = true;
    const registry = new ProviderRegistry();
    registry.register(providerInput({
      id: "mock-model",
      adapterVersion: "1.0.0",
      credentialRequirement: "OPTIONAL",
      credentialPurposes: ["API_KEY"],
      models: [{
        id: "test-model",
        displayName: "Test Model",
        capabilities: firstModel(MOCK_PROVIDER_DEFINITION).capabilities
      }],
      adapterFactory: {
        id: "optional-resolver-factory",
        createAdapter(input) {
          resolverVisibleToFactory = input.secretResolver !== undefined;
          return new MockModelAdapter({ proposal: PROPOSAL });
        }
      }
    }));
    const resolved = resolveProviderConfiguration({
      registry,
      configuration: {
        version: 1,
        providerId: "mock-model",
        modelId: "test-model",
        enabled: true
      }
    });
    const resolver: ProviderSecretResolver = {
      async resolveSecret() {
        return "unused-secret";
      }
    };

    const adapter = await resolveAdapterFactory(resolved).createAdapter({
      resolved,
      secretResolver: resolver
    });
    expect(adapter.name).toBe("mock-model");
    expect(resolverVisibleToFactory).toBe(false);
  });

  it("rejects accessor-backed resolveSecret methods before provider factory execution", async () => {
    const registry = registerBuiltInProviders();
    const resolved = resolveProviderConfiguration({
      registry,
      configuration: GEMINI_CONFIGURATION
    });
    const factory = resolveAdapterFactory(resolved);
    let getterCalls = 0;
    const resolver = Object.defineProperty({}, "resolveSecret", {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error("must not execute");
      }
    });

    await expect(factory.createAdapter({
      resolved,
      secretResolver: resolver
    })).rejects.toMatchObject({ code: "INVALID_FACTORY_INPUT" });
    expect(getterCalls).toBe(0);
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

  it("snapshots resolver methods before provider factory execution", async () => {
    const registry = registerBuiltInProviders();
    const resolved = resolveProviderConfiguration({
      registry,
      configuration: GEMINI_CONFIGURATION
    });
    const factory = resolveAdapterFactory(resolved);
    let originalCalls = 0;
    let replacementCalls = 0;
    const resolver: ProviderSecretResolver = {
      async resolveSecret() {
        originalCalls += 1;
        return "runtime-only-key";
      }
    };
    const input: Parameters<typeof factory.createAdapter>[0] = {
      resolved,
      secretResolver: resolver
    };
    const original = resolver.resolveSecret;
    Object.defineProperty(resolver, "resolveSecret", {
      configurable: true,
      enumerable: true,
      get() {
        Object.defineProperty(resolver, "resolveSecret", {
          configurable: true,
          enumerable: true,
          value: async () => {
            replacementCalls += 1;
            return "replacement-key";
          }
        });
        return original;
      }
    });

    const adapter = await factory.createAdapter(input);
    expect(adapter.name).toBe("gemini-api");
    expect(originalCalls).toBe(1);
    expect(replacementCalls).toBe(0);
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
  it("allows supported reasoning controls when the exact level set is not yet established", async () => {
    const registry = new ProviderRegistry();
    registry.register(providerInput({
      models: [{
        id: "test-model",
        displayName: "Test Model",
        capabilities: capabilities({
          reasoningControls: "SUPPORTED",
          reasoningLevels: "UNKNOWN"
        })
      }]
    }));

    expect(() => resolveProviderConfiguration({
      registry,
      configuration: {
        version: 1,
        providerId: "test-provider",
        modelId: "test-model",
        enabled: true
      },
      requirements: ["REASONING_CONTROLS"]
    })).not.toThrow();

    expect(() => resolveProviderConfiguration({
      registry,
      configuration: {
        version: 1,
        providerId: "test-provider",
        modelId: "test-model",
        enabled: true,
        reasoning: { level: "high" }
      }
    })).toThrow(expect.objectContaining({ code: "CAPABILITY_STATUS_UNKNOWN" }));

    await expect(evaluateProviderReadiness({
      registry,
      configuration: {
        version: 1,
        providerId: "test-provider",
        modelId: "test-model",
        enabled: true,
        reasoning: { level: "high" }
      }
    })).resolves.toMatchObject({
      state: "UNKNOWN",
      reason: "CAPABILITY_STATUS_UNKNOWN"
    });
  });


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
