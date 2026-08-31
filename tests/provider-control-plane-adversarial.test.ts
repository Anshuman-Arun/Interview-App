import { describe, expect, it } from "vitest";
import {
  PROVIDER_CONFIGURATION_LIMITS,
  ProviderConfigurationSchema,
  ProviderModelCapabilitiesSchema,
  ProviderModelDefinitionSchema,
  ProviderRegistry,
  SafeProviderConfigurationRecordSchema,
  createProviderConfigurationFingerprintMaterial,
  defineProvider,
  evaluateProviderReadiness,
  matchCapabilityRequirements,
  resolveProviderConfiguration,
  validateProviderConfiguration,
  type ProviderDefinitionInput,
  type ProviderModelCapabilities,
  type ProviderSettingsValidator
} from "../packages/providers/src/index.js";

function createCapabilities(
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

function createSettingsProviderInput(
  validateSettings: ProviderSettingsValidator = (settings) => settings
): ProviderDefinitionInput {
  return {
    id: "settings-provider",
    displayName: "Settings Provider",
    kind: "OTHER",
    definitionVersion: "1",
    capabilityVersion: "1",
    credentialRequirement: "NONE",
    credentialPurposes: [],
    models: [{
      id: "settings-model",
      displayName: "Settings Model",
      capabilities: createCapabilities()
    }],
    validateSettings
  };
}

function settingsConfiguration(settings: unknown) {
  return {
    version: 1,
    providerId: "settings-provider",
    modelId: "settings-model",
    enabled: true,
    settings
  };
}

describe("provider configuration secret exclusion", () => {
  it("enforces secret exclusion through the exported configuration schema itself", () => {
    const result = ProviderConfigurationSchema.safeParse(settingsConfiguration({
      nested: { apiKey: "private-value" }
    }));

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.message === "SECRET_IN_CONFIGURATION"))
        .toBe(true);
    }
  });

  it("does not inherit polluted optional configuration fields after validation", () => {
    Object.defineProperties(Object.prototype, {
      settings: {
        configurable: true,
        enumerable: false,
        value: { injected: true }
      },
      reasoning: {
        configurable: true,
        enumerable: false,
        value: { level: "polluted" }
      },
      credentialRef: {
        configurable: true,
        enumerable: false,
        value: { id: "polluted", purpose: "API_KEY" }
      }
    });

    try {
      const parsed = ProviderConfigurationSchema.parse({
        version: 1,
        providerId: "settings-provider",
        modelId: "settings-model",
        enabled: true
      });
      expect(Object.getPrototypeOf(parsed)).toBeNull();
      expect(parsed.settings).toBeUndefined();
      expect(parsed.reasoning).toBeUndefined();
      expect(parsed.credentialRef).toBeUndefined();
    } finally {
      Reflect.deleteProperty(Object.prototype, "settings");
      Reflect.deleteProperty(Object.prototype, "reasoning");
      Reflect.deleteProperty(Object.prototype, "credentialRef");
    }
  });

  it("returns an immutable validated object from the exported configuration schema", () => {
    const parsed = ProviderConfigurationSchema.parse(settingsConfiguration({
      nested: { retries: 2 }
    }));

    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.settings)).toBe(true);
    expect(Object.isFrozen(parsed.settings?.nested)).toBe(true);
  });

  it("rejects common raw secret payloads even when hidden under innocuous keys", () => {
    for (const value of [
      "Bearer abcdefghijklmnop.12345678",
      "Bearer abcdefghijklmnop",
      "Basic Zm9vOmJhcg==",
      "Basic dXNlcjpwYXNz",
      "Basic dXNlcjpww6Rzcw==",
      "Basic w7xzZXI6cMOkc3M="
      "AIza123456789012345678901234567890",
      "sk_abcdefghijklmnopqrstuvwxyz",
      "token=raw-private-token",
      "token=abcdefghijklmnopqrst",
      "secret=P@ssword-123456",
      "postgres://user:p%40ssw0rd@example.com/database",
      "-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----"
    ]) {
      expect(() => validateProviderConfiguration(settingsConfiguration({ endpoint: value })))
        .toThrow(expect.objectContaining({ code: "SECRET_IN_CONFIGURATION" }));
    }
  });

  it("detects Basic credentials deterministically even when global atob is unavailable", () => {
    const originalAtob = globalThis.atob;
    try {
      Reflect.set(globalThis, "atob", undefined);
      expect(() => validateProviderConfiguration(settingsConfiguration({
        endpoint: "Basic dXNlcjpwYXNz"
      }))).toThrow(expect.objectContaining({ code: "SECRET_IN_CONFIGURATION" }));
    } finally {
      Reflect.set(globalThis, "atob", originalAtob);
    }
  });

  it("does not classify ordinary descriptive text as a raw authorization credential", () => {
    const registry = new ProviderRegistry();
    registry.register(createSettingsProviderInput());

    for (const mode of [
      "Basic mode",
      "Basic configuration",
      "Basic Configuration",
      "Basic Mathematics",
      "Basic abcdefgh",
      "Bearer strategy",
      "Use basic defaults",
      "token: bucket",
      "secret: sauce",
      "authorization: required",
      "api_key = placeholder",
      "https://api.example.com/v1/models"
    ]) {
      expect(() => resolveProviderConfiguration({
        registry,
        configuration: settingsConfiguration({ mode })
      })).not.toThrow();
    }
  });

  it("allows short sk-prefixed opaque reference aliases without treating them as raw keys", () => {
    expect(() => validateProviderConfiguration({
      version: 1,
      providerId: "settings-provider",
      modelId: "settings-model",
      enabled: true,
      credentialRef: {
        id: "sk-prod-primary",
        purpose: "API_KEY"
      }
    })).not.toThrow();
  });

  it("rejects plural and header-shaped credential fields at any settings depth", () => {
    const registry = new ProviderRegistry();
    registry.register(createSettingsProviderInput());

    for (const settings of [
      { apiKeys: ["value-one"] },
      { nested: { tokens: ["value-one"] } },
      { nested: { passwords: ["value-one"] } },
      { privateKeys: ["value-one"] },
      { authorizationHeader: "placeholder" },
      { authHeader: "placeholder" }
    ]) {
      expect(() => resolveProviderConfiguration({
        registry,
        configuration: settingsConfiguration(settings)
      })).toThrow(expect.objectContaining({ code: "SECRET_IN_CONFIGURATION" }));
    }

    expect(() => resolveProviderConfiguration({
      registry,
      configuration: settingsConfiguration({
        authMode: "none",
        keyRotationInterval: 30,
        maxTokens: 2_048,
        outputTokens: 512
      })
    })).not.toThrow();
  });

  it("rejects alternate credential-reference channels inside provider settings", () => {
    const registry = new ProviderRegistry();
    registry.register(createSettingsProviderInput());

    for (const settings of [
      { credentialRef: "credential-two" },
      { nested: { apiKeyRef: "credential-two" } },
      { secretRef: "credential-two" },
      { accessTokenRefs: ["credential-two"] }
    ]) {
      expect(() => resolveProviderConfiguration({
        registry,
        configuration: settingsConfiguration(settings)
      })).toThrow(expect.objectContaining({ code: "SECRET_IN_CONFIGURATION" }));
    }
  });

  it("rejects credential-reference channels introduced by provider-specific normalization", () => {
    const registry = new ProviderRegistry();
    registry.register(createSettingsProviderInput(() => ({
      mode: "safe",
      credentialRef: "credential-two"
    })));

    expect(() => resolveProviderConfiguration({
      registry,
      configuration: settingsConfiguration({ mode: "safe" })
    })).toThrow(expect.objectContaining({ code: "SECRET_IN_CONFIGURATION" }));
  });

  it("rejects raw secret-looking values in persistable identity and reasoning fields", () => {
    for (const configuration of [
      {
        version: 1,
        providerId: "sk-abcdefghijklmnopqrstuvwxyz",
        modelId: "settings-model",
        enabled: true
      },
      {
        version: 1,
        providerId: "settings-provider",
        modelId: "sk-abcdefghijklmnopqrstuvwxyz",
        enabled: true
      },
      {
        version: 1,
        providerId: "settings-provider",
        modelId: "settings-model",
        enabled: true,
        reasoning: { level: "token=private-value" }
      },
      {
        version: 1,
        providerId: "settings-provider",
        modelId: "settings-model",
        enabled: true,
        credentialRef: {
          id: "sk-abcdefghijklmnopqrstuvwxyz",
          purpose: "API_KEY"
        }
      }
    ]) {
      expect(() => validateProviderConfiguration(configuration))
        .toThrow(expect.objectContaining({ code: "SECRET_IN_CONFIGURATION" }));
    }
  });

  it("revalidates provider-specific validator output before accepting it", () => {
    const registry = new ProviderRegistry();
    registry.register(createSettingsProviderInput(() => ({
      safeName: "value",
      nested: { authorization: "Bearer private" }
    })));

    expect(() => resolveProviderConfiguration({
      registry,
      configuration: settingsConfiguration({ safeName: "input" })
    })).toThrow(expect.objectContaining({ code: "SECRET_IN_CONFIGURATION" }));
  });

  it("never places credential references into deterministic fingerprint material", () => {
    const first = {
      version: 1,
      providerId: "settings-provider",
      modelId: "settings-model",
      enabled: true,
      credentialRef: { id: "credential-one", purpose: "API_KEY" as const }
    };
    const second = {
      ...first,
      credentialRef: { id: "credential-two", purpose: "API_KEY" as const }
    };

    const firstMaterial = createProviderConfigurationFingerprintMaterial(first);
    expect(firstMaterial).toBe(createProviderConfigurationFingerprintMaterial(second));
    expect(firstMaterial).not.toContain("credential-one");
    expect(firstMaterial).not.toContain("credential-two");
  });
});

describe("provider configuration hostile object handling", () => {
  it("rejects prototype-bearing and special-key objects without prototype pollution", () => {
    const polluted: unknown = JSON.parse('{"__proto__":{"polluted":true}}');
    expect(SafeProviderConfigurationRecordSchema.safeParse(polluted).success).toBe(false);
    expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);

    expect(SafeProviderConfigurationRecordSchema.safeParse({ constructor: { value: 1 } }).success)
      .toBe(false);
    expect(SafeProviderConfigurationRecordSchema.safeParse(new Date()).success).toBe(false);
    expect(SafeProviderConfigurationRecordSchema.safeParse(new Map([["a", 1]])).success).toBe(false);
  });

  it("does not invoke accessors in the configuration envelope or nested settings", () => {
    let topLevelGetterCalls = 0;
    const configuration = Object.defineProperty({
      version: 1,
      providerId: "settings-provider",
      modelId: "settings-model",
      enabled: true
    }, "settings", {
      enumerable: true,
      get() {
        topLevelGetterCalls += 1;
        return { mode: "unsafe" };
      }
    });
    expect(ProviderConfigurationSchema.safeParse(configuration).success).toBe(false);
    expect(topLevelGetterCalls).toBe(0);

    let nestedGetterCalls = 0;
    const settings = Object.defineProperty({}, "mode", {
      enumerable: true,
      get() {
        nestedGetterCalls += 1;
        return "unsafe";
      }
    });
    expect(ProviderConfigurationSchema.safeParse(settingsConfiguration(settings)).success).toBe(false);
    expect(nestedGetterCalls).toBe(0);
  });

  it("rejects symbol keys, non-enumerable hidden fields, sparse arrays, and array side properties", () => {
    const symbolRecord: Record<string, unknown> = { mode: "safe" };
    Object.defineProperty(symbolRecord, Symbol("hidden"), {
      enumerable: true,
      value: "hidden"
    });
    expect(SafeProviderConfigurationRecordSchema.safeParse(symbolRecord).success).toBe(false);

    const hiddenRecord = Object.defineProperty({}, "hidden", {
      enumerable: false,
      value: "hidden"
    });
    expect(SafeProviderConfigurationRecordSchema.safeParse(hiddenRecord).success).toBe(false);

    const sparse = new Array<unknown>(2);
    sparse[1] = "value";
    expect(SafeProviderConfigurationRecordSchema.safeParse({ sparse }).success).toBe(false);

    const arrayWithProperty: unknown[] = [1, 2];
    Object.defineProperty(arrayWithProperty, "extra", {
      enumerable: true,
      value: 3
    });
    expect(SafeProviderConfigurationRecordSchema.safeParse({ arrayWithProperty }).success)
      .toBe(false);
  });

  it("rejects cyclic, excessively deep, overly wide, oversized, and non-JSON values", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(SafeProviderConfigurationRecordSchema.safeParse(cyclic).success).toBe(false);

    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let index = 0; index <= PROVIDER_CONFIGURATION_LIMITS.maxDepth; index += 1) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }
    expect(SafeProviderConfigurationRecordSchema.safeParse(deep).success).toBe(false);

    const wide = Object.fromEntries(Array.from(
      { length: PROVIDER_CONFIGURATION_LIMITS.maxObjectEntries + 1 },
      (_, index) => ["key-" + String(index), index]
    ));
    expect(SafeProviderConfigurationRecordSchema.safeParse(wide).success).toBe(false);

    expect(SafeProviderConfigurationRecordSchema.safeParse({
      values: Array.from(
        { length: PROVIDER_CONFIGURATION_LIMITS.maxArrayItems + 1 },
        (_, index) => index
      )
    }).success).toBe(false);

    expect(SafeProviderConfigurationRecordSchema.safeParse({
      value: "x".repeat(PROVIDER_CONFIGURATION_LIMITS.maxStringLength + 1)
    }).success).toBe(false);

    for (const value of [
      { value: Number.NaN },
      { value: Number.POSITIVE_INFINITY },
      { value: undefined },
      { value: 1n },
      { value: (): void => undefined }
    ]) {
      expect(SafeProviderConfigurationRecordSchema.safeParse(value).success).toBe(false);
    }
  });

  it("bounds total configuration nodes independently of per-container limits", () => {
    const values = Array.from({ length: 100 }, () =>
      Array.from({ length: 25 }, (_, index) => index)
    );
    expect(100 * 25).toBeGreaterThan(PROVIDER_CONFIGURATION_LIMITS.maxNodes);
    expect(SafeProviderConfigurationRecordSchema.safeParse({ values }).success).toBe(false);
  });

  it("returns deeply frozen plain copies rather than caller-owned objects", () => {
    const source = {
      nested: { count: 2 },
      values: [1, { mode: "safe" }]
    };
    const parsed = SafeProviderConfigurationRecordSchema.parse(source);

    expect(parsed).not.toBe(source);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.nested)).toBe(true);
    expect(Object.isFrozen(parsed.values)).toBe(true);
    source.nested.count = 99;
    expect(parsed).toEqual({
      nested: { count: 2 },
      values: [1, { mode: "safe" }]
    });
  });

  it("isolates sanitized settings from polluted Object.prototype values", () => {
    const registry = new ProviderRegistry();
    let inheritedValue: unknown = "not-observed";
    registry.register(createSettingsProviderInput((settings) => {
      inheritedValue = settings.injectedSetting;
      return settings;
    }));

    Object.defineProperty(Object.prototype, "injectedSetting", {
      configurable: true,
      enumerable: false,
      value: "polluted-value"
    });
    try {
      const resolved = resolveProviderConfiguration({
        registry,
        configuration: settingsConfiguration({ mode: "safe" })
      });
      expect(inheritedValue).toBeUndefined();
      expect(Object.getPrototypeOf(resolved.configuration.settings)).toBeNull();
      expect(resolved.configuration.settings).toEqual({ mode: "safe" });
    } finally {
      Reflect.deleteProperty(Object.prototype, "injectedSetting");
    }
  });

  it("rejects revoked proxies without throwing non-control-plane errors", () => {
    const revocable = Proxy.revocable({ mode: "safe" }, {});
    revocable.revoke();
    expect(() => validateProviderConfiguration(settingsConfiguration(revocable.proxy)))
      .toThrow(expect.objectContaining({ code: "MALFORMED_CONFIGURATION" }));
  });
});

describe("provider readiness hostile configurations", () => {
  it("does not let DISABLED short-circuit secret or settings validation", async () => {
    const registry = new ProviderRegistry();
    registry.register(createSettingsProviderInput());

    await expect(evaluateProviderReadiness({
      registry,
      configuration: {
        ...settingsConfiguration({ apiKey: "private" }),
        enabled: false
      }
    })).resolves.toMatchObject({
      state: "MISCONFIGURED",
      reason: "SECRET_IN_CONFIGURATION"
    });
  });

  it("does not let DISABLED hide an invalid model selection", async () => {
    const registry = new ProviderRegistry();
    registry.register(createSettingsProviderInput());

    await expect(evaluateProviderReadiness({
      registry,
      configuration: {
        version: 1,
        providerId: "settings-provider",
        modelId: "missing-model",
        enabled: false
      }
    })).resolves.toMatchObject({
      state: "MISCONFIGURED",
      reason: "UNKNOWN_MODEL"
    });
  });

  it("revalidates provider-normalized settings before reporting readiness", async () => {
    const registry = new ProviderRegistry();
    registry.register(createSettingsProviderInput(() => ({
      nested: JSON.parse('{"__proto__":{"polluted":true}}') as unknown
    })));

    await expect(evaluateProviderReadiness({
      registry,
      configuration: settingsConfiguration({ mode: "safe" })
    })).resolves.toMatchObject({
      state: "MISCONFIGURED",
      reason: "MALFORMED_CONFIGURATION"
    });
    expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
  });
});

describe("exported provider schema output isolation", () => {
  it("returns null-prototype capability and model-definition records", () => {
    const capabilities = ProviderModelCapabilitiesSchema.parse(createCapabilities());
    expect(Object.getPrototypeOf(capabilities)).toBeNull();
    expect(Object.isFrozen(capabilities)).toBe(true);

    Object.defineProperty(Object.prototype, "metadataVersion", {
      configurable: true,
      enumerable: false,
      value: "polluted-version"
    });
    try {
      const model = ProviderModelDefinitionSchema.parse({
        id: "test-model",
        displayName: "Test Model",
        capabilities: createCapabilities()
      });
      expect(Object.getPrototypeOf(model)).toBeNull();
      expect(model.metadataVersion).toBeUndefined();
      expect(Object.isFrozen(model)).toBe(true);
    } finally {
      Reflect.deleteProperty(Object.prototype, "metadataVersion");
    }
  });

  it("does not let polluted adapterFactory appear on a definition that registered none", async () => {
    Object.defineProperty(Object.prototype, "adapterFactory", {
      configurable: true,
      enumerable: false,
      value: {
        id: "polluted-factory",
        createAdapter() {
          throw new Error("polluted factory must never be reachable");
        }
      }
    });
    try {
      const registry = new ProviderRegistry();
      registry.register(createSettingsProviderInput());
      const definition = registry.getProvider("settings-provider");
      expect(Object.getPrototypeOf(definition)).toBeNull();
      expect(definition.adapterFactory).toBeUndefined();

      await expect(evaluateProviderReadiness({
        registry,
        configuration: {
          version: 1,
          providerId: "settings-provider",
          modelId: "settings-model",
          enabled: true
        }
      })).resolves.toMatchObject({
        state: "UNAVAILABLE",
        reason: "ADAPTER_FACTORY_UNAVAILABLE"
      });
    } finally {
      Reflect.deleteProperty(Object.prototype, "adapterFactory");
    }
  });
});

describe("provider definition and capability hostile values", () => {
  it("rejects unknown and accessor-backed provider-definition fields without invoking accessors", () => {
    const withExtraField = {
      ...createSettingsProviderInput(),
      rawApiKey: "should-not-be-part-of-a-definition"
    };
    expect(() => defineProvider(withExtraField))
      .toThrow(expect.objectContaining({ code: "MALFORMED_DEFINITION" }));

    let getterCalls = 0;
    const accessorDefinition = Object.defineProperty(
      { ...createSettingsProviderInput() },
      "displayName",
      {
        enumerable: true,
        get() {
          getterCalls += 1;
          return "Unsafe";
        }
      }
    );
    expect(() => defineProvider(accessorDefinition))
      .toThrow(expect.objectContaining({ code: "MALFORMED_DEFINITION" }));
    expect(getterCalls).toBe(0);
  });

  it("rejects accessor-backed adapter factories without invoking them", () => {
    let getterCalls = 0;
    const factory = Object.defineProperty({ id: "unsafe-factory" }, "createAdapter", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return (): never => {
          throw new Error("must not run");
        };
      }
    });
    const definition = {
      ...createSettingsProviderInput(),
      adapterVersion: "1.0.0",
      adapterFactory: factory
    };

    expect(() => defineProvider(definition))
      .toThrow(expect.objectContaining({ code: "INVALID_ADAPTER_FACTORY" }));
    expect(getterCalls).toBe(0);
  });

  it("enforces capability consistency through the exported capability schema itself", () => {
    expect(ProviderModelCapabilitiesSchema.safeParse(createCapabilities({
      reasoningControls: "SUPPORTED",
      reasoningLevels: []
    })).success).toBe(false);
    expect(ProviderModelCapabilitiesSchema.safeParse(createCapabilities({
      textGeneration: "UNSUPPORTED",
      streaming: "SUPPORTED",
      structuredOutput: "NONE"
    })).success).toBe(false);
  });

  it("does not invoke capability accessors while validating declarations", () => {
    let getterCalls = 0;
    const capabilities = Object.defineProperty(createCapabilities(), "streaming", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "SUPPORTED";
      }
    });

    expect(ProviderModelCapabilitiesSchema.safeParse(capabilities).success).toBe(false);
    expect(getterCalls).toBe(0);
  });

  it("rejects accessor-backed capability requirement arrays without invoking accessors", () => {
    let getterCalls = 0;
    const requirements = new Array<unknown>(1);
    Object.defineProperty(requirements, "0", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "TEXT_GENERATION";
      }
    });

    expect(() => matchCapabilityRequirements(createCapabilities(), requirements))
      .toThrow(expect.objectContaining({ code: "MALFORMED_REQUIREMENTS" }));
    expect(getterCalls).toBe(0);
  });

  it("rejects streaming structured output when general streaming support is not established", () => {
    const malformed = createCapabilities({
      streaming: "UNSUPPORTED",
      structuredOutput: "STREAMING"
    });

    expect(() => matchCapabilityRequirements(malformed, []))
      .toThrow(expect.objectContaining({ code: "MALFORMED_CAPABILITIES" }));
  });

  it("rejects capability-requirement accessors without invoking them", async () => {
    const registry = new ProviderRegistry();
    registry.register(createSettingsProviderInput());
    const configuration = settingsConfiguration({ mode: "safe" });

    let resolutionReads = 0;
    const resolutionInput = { registry, configuration };
    Object.defineProperty(resolutionInput, "requirements", {
      enumerable: true,
      get() {
        resolutionReads += 1;
        return ["IMAGE_INPUT"];
      }
    });
    expect(() => resolveProviderConfiguration(resolutionInput))
      .toThrow(expect.objectContaining({ code: "MALFORMED_REQUIREMENTS" }));
    expect(resolutionReads).toBe(0);

    let readinessReads = 0;
    const readinessInput = { registry, configuration };
    Object.defineProperty(readinessInput, "requirements", {
      enumerable: true,
      get() {
        readinessReads += 1;
        return ["IMAGE_INPUT"];
      }
    });
    await expect(evaluateProviderReadiness(readinessInput)).resolves.toMatchObject({
      state: "MISCONFIGURED",
      reason: "MALFORMED_REQUIREMENTS"
    });
    expect(readinessReads).toBe(0);
  });

  it("does not invoke throwing configuration or registry accessors on operation envelopes", async () => {
    const registry = new ProviderRegistry();
    registry.register(createSettingsProviderInput());
    const configuration = settingsConfiguration({ mode: "safe" });
    let configurationReads = 0;
    const badConfigurationInput = { registry, configuration };
    Object.defineProperty(badConfigurationInput, "configuration", {
      enumerable: true,
      get() {
        configurationReads += 1;
        throw new Error("configuration getter must not run");
      }
    });
    expect(() => resolveProviderConfiguration(badConfigurationInput))
      .toThrow(expect.objectContaining({ code: "MALFORMED_CONFIGURATION" }));
    expect(configurationReads).toBe(0);

    let registryReads = 0;
    const badRegistryInput = { registry, configuration };
    Object.defineProperty(badRegistryInput, "registry", {
      enumerable: true,
      get() {
        registryReads += 1;
        throw new Error("registry getter must not run");
      }
    });
    await expect(evaluateProviderReadiness(badRegistryInput)).resolves.toMatchObject({
      state: "MISCONFIGURED",
      reason: "INVALID_REGISTRY"
    });
    expect(registryReads).toBe(0);
  });

  it("ignores inherited optional operation fields", async () => {
    const registry = new ProviderRegistry();
    registry.register(createSettingsProviderInput());
    const configuration = settingsConfiguration({ mode: "safe" });

    Object.defineProperties(Object.prototype, {
      requirements: {
        configurable: true,
        enumerable: false,
        value: ["IMAGE_INPUT"]
      },
      secretResolver: {
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
      }
    });
    try {
      expect(() => resolveProviderConfiguration({ registry, configuration })).not.toThrow();
      await expect(evaluateProviderReadiness({ registry, configuration })).resolves.toMatchObject({
        state: "UNAVAILABLE",
        reason: "ADAPTER_FACTORY_UNAVAILABLE"
      });
    } finally {
      Reflect.deleteProperty(Object.prototype, "requirements");
      Reflect.deleteProperty(Object.prototype, "secretResolver");
    }
  });

  it("rejects null capability requirements instead of treating them as an empty set", async () => {
    const registry = new ProviderRegistry();
    registry.register(createSettingsProviderInput());
    const configuration = settingsConfiguration({ mode: "safe" });

    const resolutionInput = { registry, configuration };
    Reflect.set(resolutionInput, "requirements", null);
    expect(() => resolveProviderConfiguration(resolutionInput))
      .toThrow(expect.objectContaining({ code: "MALFORMED_REQUIREMENTS" }));

    const readinessInput = { registry, configuration };
    Reflect.set(readinessInput, "requirements", null);
    await expect(evaluateProviderReadiness(readinessInput)).resolves.toMatchObject({
      state: "MISCONFIGURED",
      reason: "MALFORMED_REQUIREMENTS"
    });
  });

  it("does not let DISABLED hide malformed capability requirements", async () => {
    const registry = new ProviderRegistry();
    registry.register(createSettingsProviderInput());
    const input = {
      registry,
      configuration: {
        version: 1 as const,
        providerId: "settings-provider",
        modelId: "settings-model",
        enabled: false
      },
      requirements: ["TEXT_GENERATION"] as const
    };
    Reflect.set(input, "requirements", ["NOT_A_CAPABILITY"]);

    await expect(evaluateProviderReadiness(input)).resolves.toMatchObject({
      state: "MISCONFIGURED",
      reason: "MALFORMED_REQUIREMENTS"
    });
  });

  it("rejects credential-like provider definition metadata", () => {
    expect(() => defineProvider({
      ...createSettingsProviderInput(),
      displayName: "Authorization: Bearer private-definition-secret"
    })).toThrow(expect.objectContaining({ code: "MALFORMED_DEFINITION" }));
  });

  it("rejects unsafe numeric capability limits instead of accepting lossy integers", () => {
    const provider = createSettingsProviderInput();
    const model = provider.models[0];
    if (model === undefined) throw new Error("Test provider definition has no model");
    expect(() => defineProvider({
      ...provider,
      models: [{
        ...model,
        capabilities: {
          ...model.capabilities,
          contextWindowTokens: Number.MAX_VALUE
        }
      }]
    })).toThrow(expect.objectContaining({ code: "MALFORMED_DEFINITION" }));
  });

  it("rejects duplicate and contradictory reasoning-level declarations", () => {
    expect(() => defineProvider({
      ...createSettingsProviderInput(),
      models: [{
        id: "settings-model",
        displayName: "Settings Model",
        capabilities: createCapabilities({
          reasoningControls: "SUPPORTED",
          reasoningLevels: ["high", "high"]
        })
      }]
    })).toThrow(expect.objectContaining({ code: "MALFORMED_DEFINITION" }));

    expect(() => defineProvider({
      ...createSettingsProviderInput(),
      models: [{
        id: "settings-model",
        displayName: "Settings Model",
        capabilities: createCapabilities({
          reasoningControls: "UNKNOWN",
          reasoningLevels: []
        })
      }]
    })).toThrow(expect.objectContaining({ code: "MALFORMED_DEFINITION" }));
  });
});
