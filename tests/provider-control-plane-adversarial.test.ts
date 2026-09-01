import { describe, expect, it } from "vitest";
import {
  PROVIDER_CONFIGURATION_LIMITS,
  ProviderConfigurationSchema,
  ProviderControlPlaneError,
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
  type ProviderCapabilityKey,
  type ProviderDefinitionInput,
  type ProviderModelCapabilities,
  type ProviderSettingsValidator
} from "../packages/providers/src/index.js";
import {
  ProviderConfigurationSafetyError,
  containsSecretLikeConfigurationText,
  inspectSafeProviderConfigurationValue
} from "../packages/providers/src/safe-configuration.js";

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

function fixture(...parts: readonly string[]): string {
  return parts.join("");
}

const LONG_SK_FIXTURE = fixture("sk", "-", "abcdefghijklmnopqrstuvwxyz");
const GOOGLE_API_KEY_FIXTURE = fixture(
  "AI",
  "za",
  "123456789012345678901234567890"
);
const GITHUB_TOKEN_FIXTURE = fixture(
  "gh",
  "p_",
  "abcdefghijklmnopqrstuvwxyz1234567890"
);
const GITHUB_SHORT_TOKEN_FIXTURE = fixture(
  "gh",
  "p_",
  "abcdefghijklmnopqrstuvwxyz"
);
const GITHUB_PAT_FIXTURE = fixture(
  "github_",
  "pat_",
  "abcdefghijklmnopqrstuvwxyz_1234567890"
);
const GITLAB_TOKEN_FIXTURE = fixture(
  "gl",
  "pat-",
  "abcdefghijklmnopqrstuvwxyz123456"
);
const HUGGING_FACE_TOKEN_FIXTURE = fixture(
  "hf",
  "_",
  "abcdefghijklmnopqrstuvwxyz123456"
);
const AWS_ACCESS_KEY_FIXTURE = fixture(
  "AK",
  "IA",
  "ABCDEFGHIJKLMNOP"
);
const AWS_TEMP_ACCESS_KEY_FIXTURE = fixture(
  "AS",
  "IA",
  "ABCDEFGHIJKLMNOP"
);
const SLACK_TOKEN_FIXTURE = fixture(
  "xox",
  "b-",
  "abcdefghij1234567890"
);
const CREDENTIAL_URL_FIXTURE = fixture(
  "postgres://",
  "user:",
  "p%40ssw0rd",
  "@",
  "example",
  ".com/database"
);
const PRIVATE_KEY_FIXTURE = fixture(
  "-----BEGIN ",
  "PRIVATE KEY-----",
  "\nprivate-material\n",
  "-----END ",
  "PRIVATE KEY-----"
);
const PGP_PRIVATE_KEY_FIXTURE = fixture(
  "-----BEGIN PGP ",
  "PRIVATE KEY BLOCK-----",
  "\nprivate-material\n",
  "-----END PGP ",
  "PRIVATE KEY BLOCK-----"
);

describe("provider secret-classifier intrinsic hardening", () => {
  it("does not let RegExp or String prototype overrides disable secret detection", () => {
    const originalRegExpExec = Object.getOwnPropertyDescriptor(RegExp.prototype, "exec");
    const originalRegExpTest = Object.getOwnPropertyDescriptor(RegExp.prototype, "test");
    const originalNormalize = Object.getOwnPropertyDescriptor(String.prototype, "normalize");
    const originalEndsWith = Object.getOwnPropertyDescriptor(String.prototype, "endsWith");
    const originalReplace = Object.getOwnPropertyDescriptor(String.prototype, "replace");
    const originalTrim = Object.getOwnPropertyDescriptor(String.prototype, "trim");
    const originalToLowerCase = Object.getOwnPropertyDescriptor(String.prototype, "toLowerCase");
    const originalIndexOf = Object.getOwnPropertyDescriptor(String.prototype, "indexOf");
    const originalCharCodeAt = Object.getOwnPropertyDescriptor(String.prototype, "charCodeAt");
    const originalIterator = Object.getOwnPropertyDescriptor(
      String.prototype,
      Symbol.iterator
    );

    let bearerDetected = false;
    let basicDetected = false;
    let assignmentDetected = false;
    let commonTokenDetected = false;
    let keyError: unknown;

    try {
      Object.defineProperty(RegExp.prototype, "exec", {
        configurable: true,
        writable: true,
        value() {
          return null;
        }
      });
      Object.defineProperty(RegExp.prototype, "test", {
        configurable: true,
        writable: true,
        value() {
          return false;
        }
      });
      Object.defineProperty(String.prototype, "normalize", {
        configurable: true,
        writable: true,
        value() {
          return "safe";
        }
      });
      Object.defineProperty(String.prototype, "endsWith", {
        configurable: true,
        writable: true,
        value() {
          return false;
        }
      });
      Object.defineProperty(String.prototype, "replace", {
        configurable: true,
        writable: true,
        value() {
          return "safe";
        }
      });
      Object.defineProperty(String.prototype, "trim", {
        configurable: true,
        writable: true,
        value() {
          return "none";
        }
      });
      Object.defineProperty(String.prototype, "toLowerCase", {
        configurable: true,
        writable: true,
        value() {
          return "safe";
        }
      });
      Object.defineProperty(String.prototype, "indexOf", {
        configurable: true,
        writable: true,
        value() {
          return -1;
        }
      });
      Object.defineProperty(String.prototype, "charCodeAt", {
        configurable: true,
        writable: true,
        value() {
          return -1;
        }
      });
      Object.defineProperty(String.prototype, Symbol.iterator, {
        configurable: true,
        writable: true,
        value() {
          throw new Error("String iteration must not be used by secret classification");
        }
      });

      bearerDetected = containsSecretLikeConfigurationText(
        "Bearer abcdefghijklmnop"
      );
      basicDetected = containsSecretLikeConfigurationText("Basic YTpi");
      assignmentDetected = containsSecretLikeConfigurationText("password=hunter2");
      commonTokenDetected = containsSecretLikeConfigurationText(
        GITHUB_SHORT_TOKEN_FIXTURE
      );
      try {
        inspectSafeProviderConfigurationValue({
          customAccessToken: "opaque-short-value"
        });
      } catch (error) {
        keyError = error;
      }
    } finally {
      const restorations: readonly [
        object,
        PropertyKey,
        PropertyDescriptor | undefined
      ][] = [
        [RegExp.prototype, "exec", originalRegExpExec],
        [RegExp.prototype, "test", originalRegExpTest],
        [String.prototype, "normalize", originalNormalize],
        [String.prototype, "endsWith", originalEndsWith],
        [String.prototype, "replace", originalReplace],
        [String.prototype, "trim", originalTrim],
        [String.prototype, "toLowerCase", originalToLowerCase],
        [String.prototype, "indexOf", originalIndexOf],
        [String.prototype, "charCodeAt", originalCharCodeAt],
        [String.prototype, Symbol.iterator, originalIterator]
      ];
      for (let index = 0; index < restorations.length; index += 1) {
        const restoration = restorations[index];
        if (restoration === undefined) continue;
        const [target, key, descriptor] = restoration;
        if (descriptor === undefined) {
          Reflect.deleteProperty(target, key);
        } else {
          Object.defineProperty(target, key, descriptor);
        }
      }
    }

    expect(bearerDetected).toBe(true);
    expect(basicDetected).toBe(true);
    expect(assignmentDetected).toBe(true);
    expect(commonTokenDetected).toBe(true);
    expect(keyError).toMatchObject({ code: "SECRET_IN_CONFIGURATION" });
  });
});

describe("provider configuration safety-error provenance", () => {
  it("keeps secret issue classification stable under Symbol.hasInstance tampering", () => {
    const originalHasInstance = Object.getOwnPropertyDescriptor(
      ProviderConfigurationSafetyError,
      Symbol.hasInstance
    );

    let result:
      | ReturnType<typeof SafeProviderConfigurationRecordSchema.safeParse>
      | undefined;
    try {
      Object.defineProperty(ProviderConfigurationSafetyError, Symbol.hasInstance, {
        configurable: true,
        value: () => false
      });
      result = SafeProviderConfigurationRecordSchema.safeParse({
        apiKey: "private-value"
      });
    } finally {
      if (originalHasInstance === undefined) {
        Reflect.deleteProperty(
          ProviderConfigurationSafetyError,
          Symbol.hasInstance
        );
      } else {
        Object.defineProperty(
          ProviderConfigurationSafetyError,
          Symbol.hasInstance,
          originalHasInstance
        );
      }
    }

    if (result === undefined) {
      throw new Error("Safety-error provenance test did not produce a schema result");
    }
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(
        (issue) => issue.message === "SECRET_IN_CONFIGURATION"
      )).toBe(true);
    }
  });
});

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
      "Basic w7xzZXI6cMOkc3M=",
      "Basic YTpi",
      "Basic YTo",
      "Basic Og",
      GOOGLE_API_KEY_FIXTURE,
      "sk_abcdefghijklmnopqrstuvwxyz",
      GITHUB_TOKEN_FIXTURE,
      GITHUB_PAT_FIXTURE,
      GITLAB_TOKEN_FIXTURE,
      HUGGING_FACE_TOKEN_FIXTURE,
      AWS_ACCESS_KEY_FIXTURE,
      AWS_TEMP_ACCESS_KEY_FIXTURE,
      SLACK_TOKEN_FIXTURE,
      "token=raw-private-token",
      "token=abcdefghijklmnopqrst",
      "secret=P@ssword-123456",
      "password=hunter2",
      "password=bearer",
      "password=required",
      "password=\"correct horse battery staple\"",
      "api_key=abc123",
      "api_key=basic",
      "access_token=short",
      "access_token=required",
      "credential=abc",
      "auth=abc123",
      "credentials=abc",
      "passwords=abc",
      "apiKeys=abc",
      "tokens=abcdefghijkl",
      "secrets=abc",
      "credentialRef=credential-two",
      "secretRef=credential-two",
      "{\"credentials\":\"abc\"}",
      "{\"credentialRef\":\"credential-two\"}",
      "clientSecret=abc",
      "provider_secret=abc",
      "secretKey=abc",
      "aws_secret_access_key=abc",
      "API key: abc123",
      "access token = short",
      "client secret: abc",
      "secret access key = abc",
      "AWS Secret Access Key: abc",
      "GEMINI_API_KEY=abc123",
      "DATABASE_PASSWORD=hunter2",
      "GITHUB_TOKEN=short-private-token",
      "MY_CLIENT_SECRET=abc",
      "MY_AUTH_HEADER=Bearer x",
      "DefaultEndpointsProtocol=https;AccountName=demo;AccountKey=abc123;EndpointSuffix=core.windows.net",
      "Ocp-Apim-Subscription-Key: abc123",
      "Shared Access Signature: abc123",
      "SAS Token=abc123",
      "{\"client_secret\":\"abc\"}",
      "{\"api_key\":\"abc123\"}",
      "{\"access_token\":\"short\"}",
      "{\"password\":\"hunter2\"}",
      "{\"token\":\"abcdefghijklmnopqrst\"}",
      "{\"secret\":\"abcdefghijklmnopqrst\"}",
      "{\"authorization\":\"Bearer x\"}",
      "authorization=Bearer x",
      "Authorization Header: Bearer x",
      "Auth Header = Basic YTpi",
      "authorizationHeader=Basic YTpi",
      "http_authorization: Bearer abc",
      "auth_header=Basic YTpi",
      "Basic dXNlcjpwYXNz)",
      CREDENTIAL_URL_FIXTURE,
      PRIVATE_KEY_FIXTURE,
      PGP_PRIVATE_KEY_FIXTURE
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
      "authorization=Bearer",
      "authorizationHeader=required",
      "auth=none",
      "credentials=none",
      "tokens=none",
      "secrets=none",
      "credentialRef=none",
      "password=none",
      "api_key = placeholder",
      "access_token=disabled",
      "API key required",
      "client secret placeholder",
      "Authorization Header required",
      "GEMINI_API_KEY required",
      "DATABASE_PASSWORD policy",
      "GITHUB_TOKEN documentation",
      "{\"authorization\":\"required\"}",
      "{\"api_key\":\"placeholder\"}",
      "{\"access_token\":\"disabled\"}",
      "Basic Configuration)",
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
      { authHeader: "placeholder" },
      { secretAccessKey: "value-one" },
      { awsSecretAccessKey: "value-one" },
      { accountKey: "value-one" },
      { storageAccountKey: "value-one" },
      { subscriptionKey: "value-one" },
      { sasToken: "value-one" },
      { sharedAccessSignature: "value-one" }
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
        outputTokens: 512,
        inputTokens: 256,
        tokenCount: 42,
        accountKeyRotationInterval: 30,
        subscriptionKeyMode: "named",
        sasTokenBudget: 1_024,
        stopToken: "<END>",
        eosToken: "</s>",
        specialTokens: ["<s>", "</s>"]
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
        providerId: LONG_SK_FIXTURE,
        modelId: "settings-model",
        enabled: true
      },
      {
        version: 1,
        providerId: "settings-provider",
        modelId: LONG_SK_FIXTURE,
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
          id: LONG_SK_FIXTURE,
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

  it("normalizes negative zero for JSON-safe persistence and fingerprinting", () => {
    const positive = settingsConfiguration({ threshold: 0 });
    const negative = settingsConfiguration({ threshold: -0 });
    const parsedNegative = validateProviderConfiguration(negative);

    expect(Object.is(parsedNegative.settings?.threshold, -0)).toBe(false);
    expect(parsedNegative.settings?.threshold).toBe(0);
    expect(JSON.parse(JSON.stringify(parsedNegative.settings))).toEqual({ threshold: 0 });
    expect(createProviderConfigurationFingerprintMaterial(positive))
      .toBe(createProviderConfigurationFingerprintMaterial(negative));
  });
});

describe("control-plane own-property intrinsic hardening", () => {
  it("preserves deep freezing and adapter-version pairing when Object.hasOwn is overridden", () => {
    const originalHasOwn = Object.getOwnPropertyDescriptor(Object, "hasOwn");
    if (originalHasOwn === undefined) {
      throw new Error("Object.hasOwn intrinsic is unavailable");
    }

    try {
      Object.defineProperty(Object, "hasOwn", {
        configurable: true,
        writable: true,
        value() {
          return false;
        }
      });

      const parsed = ProviderConfigurationSchema.parse({
        version: 1,
        providerId: "settings-provider",
        modelId: "settings-model",
        enabled: true,
        reasoning: { level: "high" }
      });
      expect(Object.isFrozen(parsed.reasoning)).toBe(true);
      expect(Object.getPrototypeOf(parsed.reasoning)).toBeNull();

      expect(() => defineProvider({
        ...createSettingsProviderInput(),
        adapterVersion: "1.0.0"
      })).toThrow(expect.objectContaining({ code: "MALFORMED_DEFINITION" }));
    } finally {
      Object.defineProperty(Object, "hasOwn", originalHasOwn);
    }
  });
});

describe("provider error intrinsic hardening", () => {
  it("keeps branded error codes immutable when Object.defineProperty is overridden", () => {
    const originalDefineProperty = Object.defineProperty;
    let controlError: ProviderControlPlaneError | undefined;
    let safetyError: ProviderConfigurationSafetyError | undefined;
    let controlMutation = true;
    let safetyMutation = true;

    try {
      Reflect.set(Object, "defineProperty", () => {
        throw new Error("Live Object.defineProperty must not be used");
      });

      controlError = new ProviderControlPlaneError(
        "CREDENTIALS_REQUIRED",
        "fixed control-plane error"
      );
      safetyError = new ProviderConfigurationSafetyError(
        "SECRET_IN_CONFIGURATION"
      );
      controlMutation = Reflect.set(
        controlError,
        "code",
        "ADAPTER_FACTORY_FAILED"
      );
      safetyMutation = Reflect.set(
        safetyError,
        "code",
        "MALFORMED_CONFIGURATION"
      );
    } finally {
      Reflect.set(Object, "defineProperty", originalDefineProperty);
    }

    expect(controlMutation).toBe(false);
    expect(safetyMutation).toBe(false);
    expect(controlError?.code).toBe("CREDENTIALS_REQUIRED");
    expect(safetyError?.code).toBe("SECRET_IN_CONFIGURATION");
  });
});

describe("control-plane immutability intrinsic hardening", () => {
  it("keeps frozen null-prototype outputs when Object mutation helpers are overridden", () => {
    const originalFreeze = Object.getOwnPropertyDescriptor(Object, "freeze");
    const originalSetPrototypeOf = Object.getOwnPropertyDescriptor(Object, "setPrototypeOf");
    if (originalFreeze === undefined || originalSetPrototypeOf === undefined) {
      throw new Error("Object mutation intrinsics are unavailable");
    }

    const configurationInput = settingsConfiguration({ mode: "safe" });
    const definitionInput = createSettingsProviderInput();

    try {
      Object.defineProperty(Object, "freeze", {
        configurable: true,
        writable: true,
        value<T>(value: T): T {
          return value;
        }
      });
      Object.defineProperty(Object, "setPrototypeOf", {
        configurable: true,
        writable: true,
        value<T extends object>(value: T): T {
          return value;
        }
      });

      const configuration = validateProviderConfiguration(configurationInput);
      const definition = defineProvider(definitionInput);

      expect(Object.getPrototypeOf(configuration)).toBeNull();
      expect(Object.isFrozen(configuration)).toBe(true);
      expect(Object.getPrototypeOf(configuration.settings)).toBeNull();
      expect(Object.isFrozen(configuration.settings)).toBe(true);
      expect(Object.getPrototypeOf(definition)).toBeNull();
      expect(Object.isFrozen(definition)).toBe(true);
      expect(Object.isFrozen(definition.models)).toBe(true);
      expect(Object.getPrototypeOf(definition.models[0]?.capabilities)).toBeNull();
      expect(Object.isFrozen(definition.models[0]?.capabilities)).toBe(true);
    } finally {
      Object.defineProperty(Object, "freeze", originalFreeze);
      Object.defineProperty(Object, "setPrototypeOf", originalSetPrototypeOf);
    }
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

describe("provider operation input envelopes", () => {
  it("rejects misspelled resolution controls instead of silently dropping capability checks", () => {
    const registry = new ProviderRegistry();
    registry.register(createSettingsProviderInput());
    const input = {
      registry,
      configuration: settingsConfiguration({ mode: "safe" }),
      requirement: ["IMAGE_INPUT"]
    };

    expect(() => resolveProviderConfiguration(input))
      .toThrow(expect.objectContaining({ code: "MALFORMED_CONFIGURATION" }));
  });

  it("reports unknown readiness operation fields as malformed configuration", async () => {
    const registry = new ProviderRegistry();
    registry.register(createSettingsProviderInput());
    const input = {
      registry,
      configuration: settingsConfiguration({ mode: "safe" }),
      requirement: ["IMAGE_INPUT"]
    };

    await expect(evaluateProviderReadiness(input)).resolves.toMatchObject({
      state: "MISCONFIGURED",
      reason: "MALFORMED_CONFIGURATION"
    });
  });

  it("rejects symbol operation fields without invoking unrelated values", async () => {
    const registry = new ProviderRegistry();
    registry.register(createSettingsProviderInput());
    const resolutionInput = {
      registry,
      configuration: settingsConfiguration({ mode: "safe" })
    };
    Object.defineProperty(resolutionInput, Symbol("hidden"), {
      enumerable: true,
      value: "hidden"
    });
    expect(() => resolveProviderConfiguration(resolutionInput))
      .toThrow(expect.objectContaining({ code: "MALFORMED_CONFIGURATION" }));

    const readinessInput = {
      registry,
      configuration: settingsConfiguration({ mode: "safe" })
    };
    Object.defineProperty(readinessInput, Symbol("hidden"), {
      enumerable: false,
      value: "hidden"
    });
    await expect(evaluateProviderReadiness(readinessInput)).resolves.toMatchObject({
      state: "MISCONFIGURED",
      reason: "MALFORMED_CONFIGURATION"
    });
  });

  it("continues to ignore inherited operation fields", async () => {
    const registry = new ProviderRegistry();
    registry.register(createSettingsProviderInput());
    const inherited = {
      requirement: ["IMAGE_INPUT"],
      secretResolver: "polluted"
    };

    const resolutionInput = {
      registry,
      configuration: settingsConfiguration({ mode: "safe" })
    };
    Object.setPrototypeOf(resolutionInput, inherited);
    expect(() => resolveProviderConfiguration(resolutionInput)).not.toThrow();

    const readinessInput = {
      registry,
      configuration: settingsConfiguration({ mode: "safe" })
    };
    Object.setPrototypeOf(readinessInput, inherited);
    await expect(evaluateProviderReadiness(readinessInput)).resolves.toMatchObject({
      state: "UNAVAILABLE",
      reason: "ADAPTER_FACTORY_UNAVAILABLE"
    });
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

  it("captures capability requirements before provider settings validators can mutate them", async () => {
    const resolutionRequirements: ProviderCapabilityKey[] = ["IMAGE_INPUT"];
    const resolutionRegistry = new ProviderRegistry();
    resolutionRegistry.register(createSettingsProviderInput((settings) => {
      resolutionRequirements.length = 0;
      return settings;
    }));

    expect(() => resolveProviderConfiguration({
      registry: resolutionRegistry,
      configuration: settingsConfiguration({ mode: "safe" }),
      requirements: resolutionRequirements
    })).toThrow(expect.objectContaining({ code: "INCOMPATIBLE_CAPABILITY" }));
    expect(resolutionRequirements).toEqual([]);

    const readinessRequirements: ProviderCapabilityKey[] = ["IMAGE_INPUT"];
    const readinessRegistry = new ProviderRegistry();
    readinessRegistry.register(createSettingsProviderInput((settings) => {
      readinessRequirements.length = 0;
      return settings;
    }));

    await expect(evaluateProviderReadiness({
      registry: readinessRegistry,
      configuration: settingsConfiguration({ mode: "safe" }),
      requirements: readinessRequirements
    })).resolves.toMatchObject({
      state: "MISCONFIGURED",
      reason: "INCOMPATIBLE_CAPABILITY"
    });
    expect(readinessRequirements).toEqual([]);
  });

  it("defers malformed requirement errors until after provider settings validation", async () => {
    const registry = new ProviderRegistry();
    registry.register(createSettingsProviderInput(() => {
      throw new Error("settings validator failed");
    }));
    const configuration = settingsConfiguration({ mode: "safe" });
    const malformedRequirements = ["NOT_A_CAPABILITY"];

    expect(() => resolveProviderConfiguration({
      registry,
      configuration,
      requirements: malformedRequirements
    })).toThrow(expect.objectContaining({ code: "MALFORMED_CONFIGURATION" }));

    await expect(evaluateProviderReadiness({
      registry,
      configuration,
      requirements: malformedRequirements
    })).resolves.toMatchObject({
      state: "MISCONFIGURED",
      reason: "MALFORMED_CONFIGURATION"
    });
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

  it("does not let Map prototype overrides corrupt registry storage semantics", () => {
    const registry = new ProviderRegistry();
    registry.register(createSettingsProviderInput());
    const storedProvider = registry.getProvider("settings-provider");

    const originalHas = Map.prototype.has;
    let duplicateError: unknown;
    try {
      Object.defineProperty(Map.prototype, "has", {
        configurable: true,
        writable: true,
        value(this: Map<unknown, unknown>, key: unknown) {
          if (
            key === "settings-provider"
            && Reflect.apply(originalHas, this, [key]) === true
          ) {
            return false;
          }
          return Reflect.apply(originalHas, this, [key]);
        }
      });
      try {
        registry.register(createSettingsProviderInput());
      } catch (error) {
        duplicateError = error;
      }
    } finally {
      Object.defineProperty(Map.prototype, "has", {
        configurable: true,
        writable: true,
        value: originalHas
      });
    }

    const originalGet = Map.prototype.get;
    let unknownLookupError: unknown;
    try {
      Object.defineProperty(Map.prototype, "get", {
        configurable: true,
        writable: true,
        value(this: Map<unknown, unknown>, key: unknown) {
          if (key === "missing-provider") return storedProvider;
          return Reflect.apply(originalGet, this, [key]);
        }
      });
      try {
        registry.getProvider("missing-provider");
      } catch (error) {
        unknownLookupError = error;
      }
    } finally {
      Object.defineProperty(Map.prototype, "get", {
        configurable: true,
        writable: true,
        value: originalGet
      });
    }

    const setRegistry = new ProviderRegistry();
    const originalSet = Map.prototype.set;
    try {
      Object.defineProperty(Map.prototype, "set", {
        configurable: true,
        writable: true,
        value(this: Map<unknown, unknown>, key: unknown, value: unknown) {
          if (key === "set-provider") return this;
          return Reflect.apply(originalSet, this, [key, value]);
        }
      });
      setRegistry.register({
        ...createSettingsProviderInput(),
        id: "set-provider"
      });
    } finally {
      Object.defineProperty(Map.prototype, "set", {
        configurable: true,
        writable: true,
        value: originalSet
      });
    }

    expect(duplicateError).toMatchObject({ code: "DUPLICATE_PROVIDER" });
    expect(unknownLookupError).toMatchObject({ code: "UNKNOWN_PROVIDER" });
    expect(setRegistry.getProvider("set-provider").id).toBe("set-provider");
  });

  it("does not let monkey-patched WeakSet.delete corrupt shared-object validation", () => {
    const originalDelete = WeakSet.prototype.delete;
    const shared = { value: 1 };
    let parsed: ReturnType<typeof validateProviderConfiguration> | undefined;

    try {
      Object.defineProperty(WeakSet.prototype, "delete", {
        configurable: true,
        writable: true,
        value() {
          return false;
        }
      });

      parsed = validateProviderConfiguration(settingsConfiguration({
        left: shared,
        right: shared
      }));
    } finally {
      Object.defineProperty(WeakSet.prototype, "delete", {
        configurable: true,
        writable: true,
        value: originalDelete
      });
    }

    expect(parsed?.settings).toEqual({
      left: { value: 1 },
      right: { value: 1 }
    });
  });

  it("does not let a targeted Set.has override hide duplicate identities", () => {
    const originalHas = Set.prototype.has;
    let duplicateModelError: unknown;
    let duplicateBatchError: unknown;

    try {
      Object.defineProperty(Set.prototype, "has", {
        configurable: true,
        writable: true,
        value(this: Set<unknown>, target: unknown) {
          if (
            target === "duplicate-model"
            || target === "duplicate-batch-provider"
          ) {
            return false;
          }
          return Reflect.apply(originalHas, this, [target]);
        }
      });

      try {
        defineProvider({
          ...createSettingsProviderInput(),
          models: [{
            id: "duplicate-model",
            displayName: "Duplicate Model One",
            capabilities: createCapabilities()
          }, {
            id: "duplicate-model",
            displayName: "Duplicate Model Two",
            capabilities: createCapabilities()
          }]
        });
      } catch (error) {
        duplicateModelError = error;
      }

      const registry = new ProviderRegistry();
      try {
        registry.registerMany([{
          ...createSettingsProviderInput(),
          id: "duplicate-batch-provider"
        }, {
          ...createSettingsProviderInput(),
          id: "duplicate-batch-provider"
        }]);
      } catch (error) {
        duplicateBatchError = error;
      }
    } finally {
      Object.defineProperty(Set.prototype, "has", {
        configurable: true,
        writable: true,
        value: originalHas
      });
    }

    expect(duplicateModelError).toMatchObject({ code: "DUPLICATE_MODEL" });
    expect(duplicateBatchError).toMatchObject({ code: "DUPLICATE_PROVIDER" });
  });

  it("does not let targeted Set.has overrides bypass configuration admission", () => {
    const originalHas = Set.prototype.has;
    let tokenError: unknown;
    let assignmentError: unknown;
    let blockedKeyError: unknown;
    let operationError: unknown;

    try {
      Object.defineProperty(Set.prototype, "has", {
        configurable: true,
        writable: true,
        value(this: Set<unknown>, target: unknown) {
          if (target === "token" || target === "constructor") return false;
          if (target === "hunter2" || target === "requirement") return true;
          return Reflect.apply(originalHas, this, [target]);
        }
      });

      try {
        validateProviderConfiguration(settingsConfiguration({
          token: "opaque-short-value"
        }));
      } catch (error) {
        tokenError = error;
      }

      try {
        validateProviderConfiguration(settingsConfiguration({
          note: "password=hunter2"
        }));
      } catch (error) {
        assignmentError = error;
      }

      try {
        validateProviderConfiguration(settingsConfiguration({
          constructor: "blocked"
        }));
      } catch (error) {
        blockedKeyError = error;
      }

      const registry = new ProviderRegistry();
      registry.register(createSettingsProviderInput());
      const misspelledInput = {
        registry,
        configuration: settingsConfiguration({ mode: "safe" }),
        requirement: ["IMAGE_INPUT"]
      };
      try {
        resolveProviderConfiguration(misspelledInput);
      } catch (error) {
        operationError = error;
      }
    } finally {
      Object.defineProperty(Set.prototype, "has", {
        configurable: true,
        writable: true,
        value: originalHas
      });
    }

    expect(tokenError).toMatchObject({ code: "SECRET_IN_CONFIGURATION" });
    expect(assignmentError).toMatchObject({ code: "SECRET_IN_CONFIGURATION" });
    expect(blockedKeyError).toMatchObject({ code: "MALFORMED_CONFIGURATION" });
    expect(operationError).toMatchObject({ code: "MALFORMED_CONFIGURATION" });
  });

  it("does not let monkey-patched Array.find or Array.sort bypass lookup and requirements", () => {
    const registry = new ProviderRegistry();
    registry.register({
      ...createSettingsProviderInput(),
      models: [{
        id: "first-model",
        displayName: "First Model",
        capabilities: createCapabilities()
      }, {
        id: "second-model",
        displayName: "Second Model",
        capabilities: createCapabilities()
      }]
    });

    const originalFind = Object.getOwnPropertyDescriptor(Array.prototype, "find");
    const originalSort = Object.getOwnPropertyDescriptor(Array.prototype, "sort");
    let missingModelError: unknown;
    let capabilityResult: unknown;
    try {
      Object.defineProperty(Array.prototype, "find", {
        configurable: true,
        writable: true,
        value(this: unknown[]) {
          return this[0];
        }
      });
      Object.defineProperty(Array.prototype, "sort", {
        configurable: true,
        writable: true,
        value() {
          return [];
        }
      });

      try {
        resolveProviderConfiguration({
          registry,
          configuration: {
            version: 1,
            providerId: "settings-provider",
            modelId: "missing-model",
            enabled: true
          }
        });
      } catch (error) {
        missingModelError = error;
      }

      capabilityResult = matchCapabilityRequirements(
        createCapabilities(),
        ["IMAGE_INPUT"]
      );
    } finally {
      if (originalFind === undefined) {
        Reflect.deleteProperty(Array.prototype, "find");
      } else {
        Object.defineProperty(Array.prototype, "find", originalFind);
      }
      if (originalSort === undefined) {
        Reflect.deleteProperty(Array.prototype, "sort");
      } else {
        Object.defineProperty(Array.prototype, "sort", originalSort);
      }
    }

    expect(missingModelError).toMatchObject({ code: "UNKNOWN_MODEL" });
    expect(capabilityResult).toEqual({
      compatible: false,
      unsupported: ["IMAGE_INPUT"],
      unknown: []
    });
  });

  it("does not let monkey-patched Array.some or Array.push bypass validation", () => {
    const registry = new ProviderRegistry();
    registry.register(createSettingsProviderInput());

    const originalSome = Object.getOwnPropertyDescriptor(Array.prototype, "some");
    const originalPush = Object.getOwnPropertyDescriptor(Array.prototype, "push");
    if (
      originalSome === undefined
      || !("value" in originalSome)
      || typeof originalSome.value !== "function"
      || originalPush === undefined
      || !("value" in originalPush)
      || typeof originalPush.value !== "function"
    ) {
      throw new Error("Array prototype methods are unavailable");
    }
    const someCandidate: unknown = originalSome.value;
    const pushCandidate: unknown = originalPush.value;
    if (typeof someCandidate !== "function" || typeof pushCandidate !== "function") {
      throw new Error("Array prototype methods are unavailable");
    }

    let typoError: unknown;
    let capabilityResult: unknown;
    try {
      Object.defineProperty(Array.prototype, "some", {
        configurable: true,
        writable: true,
        value(this: unknown[], callback: unknown, thisArg?: unknown) {
          for (let index = 0; index < this.length; index += 1) {
            if (this[index] === "requirement") return false;
          }
          const result: unknown = Reflect.apply(
            someCandidate,
            this,
            [callback, thisArg]
          );
          return result === true;
        }
      });
      Object.defineProperty(Array.prototype, "push", {
        configurable: true,
        writable: true,
        value(this: unknown[], ...items: unknown[]) {
          if (items[0] === "IMAGE_INPUT") return this.length;
          const result: unknown = Reflect.apply(
            pushCandidate,
            this,
            items
          );
          if (typeof result !== "number") {
            throw new Error("Array.push returned an invalid result");
          }
          return result;
        }
      });

      const misspelledInput = {
        registry,
        configuration: settingsConfiguration({ mode: "safe" }),
        requirement: ["IMAGE_INPUT"]
      };
      try {
        resolveProviderConfiguration(misspelledInput);
      } catch (error) {
        typoError = error;
      }

      capabilityResult = matchCapabilityRequirements(
        createCapabilities(),
        ["IMAGE_INPUT"]
      );
    } finally {
      Object.defineProperty(Array.prototype, "some", originalSome);
      Object.defineProperty(Array.prototype, "push", originalPush);
    }

    expect(typoError).toMatchObject({ code: "MALFORMED_CONFIGURATION" });
    expect(capabilityResult).toEqual({
      compatible: false,
      unsupported: ["IMAGE_INPUT"],
      unknown: []
    });
  });

  it("does not let monkey-patched Array.map or Array.sort corrupt normalized provider state", () => {
    const originalMap = Object.getOwnPropertyDescriptor(Array.prototype, "map");
    const originalSort = Object.getOwnPropertyDescriptor(Array.prototype, "sort");
    if (
      originalMap === undefined
      || !("value" in originalMap)
      || typeof originalMap.value !== "function"
      || originalSort === undefined
      || !("value" in originalSort)
      || typeof originalSort.value !== "function"
    ) {
      throw new Error("Array prototype methods are unavailable");
    }
    const mapCandidate: unknown = originalMap.value;
    const sortCandidate: unknown = originalSort.value;
    if (typeof mapCandidate !== "function" || typeof sortCandidate !== "function") {
      throw new Error("Array prototype methods are unavailable");
    }

    let secretError: unknown;
    let definition: ReturnType<typeof defineProvider> | undefined;
    let enumerated: readonly ReturnType<typeof defineProvider>[] | undefined;
    let mapRegistrationCount = -1;

    try {
      Object.defineProperty(Array.prototype, "map", {
        configurable: true,
        writable: true,
        value(this: unknown[], callback: unknown, thisArg?: unknown) {
          const first = this[0];
          if (typeof first === "object" && first !== null) {
            const firstId: unknown = Reflect.get(first, "id");
            if (firstId === "map-register-provider") return [];
          }
          const result: unknown = Reflect.apply(
            mapCandidate,
            this,
            [callback, thisArg]
          );
          if (!Array.isArray(result)) {
            throw new Error("Array.map returned an invalid result");
          }
          return result;
        }
      });
      Object.defineProperty(Array.prototype, "sort", {
        configurable: true,
        writable: true,
        value(this: unknown[], compareFn?: unknown) {
          const first = this[0];
          if (
            Array.isArray(first)
            && first[0] === "authorization"
          ) {
            return [];
          }
          if (typeof first === "object" && first !== null) {
            const id: unknown = Reflect.get(first, "id");
            if (
              id === "sort-model-b"
              || id === "enum-z"
              || id === "enum-a"
            ) {
              return [];
            }
          }
          const result: unknown = Reflect.apply(
            sortCandidate,
            this,
            compareFn === undefined ? [] : [compareFn]
          );
          if (!Array.isArray(result)) {
            throw new Error("Array.sort returned an invalid result");
          }
          return result;
        }
      });

      try {
        validateProviderConfiguration(settingsConfiguration({
          authorization: "Bearer abcdefghijklmnop"
        }));
      } catch (error) {
        secretError = error;
      }

      definition = defineProvider({
        ...createSettingsProviderInput(),
        models: [{
          id: "sort-model-b",
          displayName: "Model B",
          capabilities: createCapabilities()
        }, {
          id: "sort-model-a",
          displayName: "Model A",
          capabilities: createCapabilities()
        }]
      });

      const mapRegistry = new ProviderRegistry();
      mapRegistrationCount = mapRegistry.registerMany([{
        ...createSettingsProviderInput(),
        id: "map-register-provider",
        models: [{
          id: "map-register-model",
          displayName: "Map Register Model",
          capabilities: createCapabilities()
        }]
      }]).length;

      const enumerationRegistry = new ProviderRegistry();
      enumerationRegistry.register({
        ...createSettingsProviderInput(),
        id: "enum-z",
        models: [{
          id: "enum-z-model",
          displayName: "Enum Z Model",
          capabilities: createCapabilities()
        }]
      });
      enumerationRegistry.register({
        ...createSettingsProviderInput(),
        id: "enum-a",
        models: [{
          id: "enum-a-model",
          displayName: "Enum A Model",
          capabilities: createCapabilities()
        }]
      });
      enumerated = enumerationRegistry.enumerateProviders();

    } finally {
      Object.defineProperty(Array.prototype, "map", originalMap);
      Object.defineProperty(Array.prototype, "sort", originalSort);
    }

    expect(secretError).toMatchObject({ code: "SECRET_IN_CONFIGURATION" });
    expect(definition?.models.map((model) => model.id))
      .toEqual(["sort-model-a", "sort-model-b"]);
    expect(enumerated?.map((provider) => provider.id))
      .toEqual(["enum-a", "enum-z"]);
    expect(mapRegistrationCount).toBe(1);
  });

  it("does not let a monkey-patched Map.values hide registered providers", () => {
    const registry = new ProviderRegistry();
    registry.register(createSettingsProviderInput());

    const originalValues = Object.getOwnPropertyDescriptor(Map.prototype, "values");
    if (
      originalValues === undefined
      || !("value" in originalValues)
      || typeof originalValues.value !== "function"
    ) {
      throw new Error("Map.values is unavailable");
    }
    const valuesCandidate: unknown = originalValues.value;
    if (typeof valuesCandidate !== "function") {
      throw new Error("Map.values is unavailable");
    }
    let providers: readonly ReturnType<typeof defineProvider>[] | undefined;

    try {
      Object.defineProperty(Map.prototype, "values", {
        configurable: true,
        writable: true,
        value(this: Map<unknown, unknown>) {
          const hasTarget = this.has("settings-provider");
          const result: unknown = hasTarget
            ? Reflect.apply(
                valuesCandidate,
                new Map<unknown, unknown>(),
                []
              )
            : Reflect.apply(
                valuesCandidate,
                this,
                []
              );
          if (typeof result !== "object" || result === null) {
            throw new Error("Map.values returned an invalid result");
          }
          return result;
        }
      });

      providers = registry.enumerateProviders();
    } finally {
      Object.defineProperty(Map.prototype, "values", originalValues);
    }

    expect(providers?.map((provider) => provider.id))
      .toEqual(["settings-provider"]);
  });

  it("does not let a monkey-patched Array.includes bypass admission checks", () => {
    const credentialRegistry = new ProviderRegistry();
    credentialRegistry.register({
      ...createSettingsProviderInput(),
      id: "credential-provider",
      credentialRequirement: "REQUIRED",
      credentialPurposes: ["API_KEY"],
      models: [{
        id: "credential-model",
        displayName: "Credential Model",
        capabilities: createCapabilities()
      }]
    });

    const reasoningRegistry = new ProviderRegistry();
    reasoningRegistry.register({
      ...createSettingsProviderInput(),
      id: "reasoning-provider",
      models: [{
        id: "reasoning-model",
        displayName: "Reasoning Model",
        capabilities: createCapabilities({
          reasoningControls: "SUPPORTED",
          reasoningLevels: ["high"]
        })
      }]
    });

    const originalIncludes = Object.getOwnPropertyDescriptor(Array.prototype, "includes");
    let credentialError: unknown;
    let reasoningError: unknown;
    try {
      Object.defineProperty(Array.prototype, "includes", {
        configurable: true,
        writable: true,
        value: () => true
      });
      try {
        resolveProviderConfiguration({
          registry: credentialRegistry,
          configuration: {
            version: 1,
            providerId: "credential-provider",
            modelId: "credential-model",
            enabled: true,
            credentialRef: {
              id: "credential-token",
              purpose: "TOKEN"
            }
          }
        });
      } catch (error) {
        credentialError = error;
      }

      try {
        resolveProviderConfiguration({
          registry: reasoningRegistry,
          configuration: {
            version: 1,
            providerId: "reasoning-provider",
            modelId: "reasoning-model",
            enabled: true,
            reasoning: { level: "medium" }
          }
        });
      } catch (error) {
        reasoningError = error;
      }
    } finally {
      if (originalIncludes === undefined) {
        Reflect.deleteProperty(Array.prototype, "includes");
      } else {
        Object.defineProperty(Array.prototype, "includes", originalIncludes);
      }
    }

    expect(credentialError).toMatchObject({ code: "MALFORMED_CONFIGURATION" });
    expect(reasoningError).toMatchObject({ code: "INCOMPATIBLE_CAPABILITY" });
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
