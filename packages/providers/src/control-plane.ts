import { z } from "zod";
import {
  CancellationCapabilitySchema,
  DataUsePolicySchema,
  StructuredOutputCapabilitySchema,
  type ReasoningProvider
} from "../../domain/src/index.js";

const MACHINE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u;
const SECRET_KEY_PATTERN = /(?:api.?key|authorization|bearer|cookie|credential|password|secret|token)/iu;

export const ProviderIdSchema = z.string().min(1).max(64).regex(MACHINE_ID_PATTERN);
export type ProviderId = z.infer<typeof ProviderIdSchema>;

export const ProviderModelIdSchema = z.string().min(1).max(64).regex(MACHINE_ID_PATTERN);
export type ProviderModelId = z.infer<typeof ProviderModelIdSchema>;

export const ProviderKindSchema = z.enum(["MOCK", "REMOTE_API", "LOCAL_PROCESS", "OTHER"]);
export type ProviderKind = z.infer<typeof ProviderKindSchema>;

export const CapabilitySupportSchema = z.enum(["SUPPORTED", "UNSUPPORTED", "UNKNOWN"]);
export type CapabilitySupport = z.infer<typeof CapabilitySupportSchema>;

export const ProviderModelCapabilitiesSchema = z.object({
  textGeneration: CapabilitySupportSchema,
  imageInput: CapabilitySupportSchema,
  toolCalling: CapabilitySupportSchema,
  streaming: CapabilitySupportSchema,
  reasoningControls: CapabilitySupportSchema,
  localExecution: CapabilitySupportSchema,
  remoteExecution: CapabilitySupportSchema,
  meteredExecution: CapabilitySupportSchema,
  dataUse: z.union([DataUsePolicySchema, z.literal("UNKNOWN")]),
  structuredOutput: z.union([StructuredOutputCapabilitySchema, z.literal("UNKNOWN")]),
  cancellation: z.union([CancellationCapabilitySchema, z.literal("UNKNOWN")]),
  contextWindowTokens: z.number().int().positive().optional(),
  outputLimitTokens: z.number().int().positive().optional()
}).strict();
export type ProviderModelCapabilities = z.infer<typeof ProviderModelCapabilitiesSchema>;

export const ProviderCapabilityKeySchema = z.enum([
  "TEXT_GENERATION",
  "IMAGE_INPUT",
  "TOOL_CALLING",
  "STREAMING",
  "REASONING_CONTROLS",
  "LOCAL_EXECUTION",
  "REMOTE_EXECUTION",
  "METERED_EXECUTION",
  "STRUCTURED_OUTPUT",
  "CANCELLATION"
]);
export type ProviderCapabilityKey = z.infer<typeof ProviderCapabilityKeySchema>;

export const ProviderCredentialRequirementSchema = z.enum(["NONE", "OPTIONAL", "REQUIRED"]);
export type ProviderCredentialRequirement = z.infer<typeof ProviderCredentialRequirementSchema>;

export const ProviderSecretReferenceSchema = z.object({
  id: ProviderIdSchema,
  purpose: z.enum(["API_KEY", "TOKEN", "OTHER"])
}).strict();
export type ProviderSecretReference = z.infer<typeof ProviderSecretReferenceSchema>;

export type SafeProviderConfigurationPrimitive = string | number | boolean | null;
export type SafeProviderConfigurationValue =
  | SafeProviderConfigurationPrimitive
  | readonly SafeProviderConfigurationValue[]
  | SafeProviderConfigurationRecord;
export interface SafeProviderConfigurationRecord {
  readonly [key: string]: SafeProviderConfigurationValue;
}

export const SafeProviderConfigurationValueSchema: z.ZodType<SafeProviderConfigurationValue> = z.lazy(() =>
  z.union([
    z.string().max(4096),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(SafeProviderConfigurationValueSchema).max(128),
    z.record(z.string().min(1).max(128), SafeProviderConfigurationValueSchema)
  ])
);
export const SafeProviderConfigurationRecordSchema: z.ZodType<SafeProviderConfigurationRecord> =
  z.record(z.string().min(1).max(128), SafeProviderConfigurationValueSchema);

export const ProviderConfigurationSchema = z.object({
  version: z.literal(1),
  providerId: ProviderIdSchema,
  modelId: ProviderModelIdSchema,
  enabled: z.boolean(),
  reasoning: z.object({
    level: z.string().min(1).max(64)
  }).strict().optional(),
  settings: SafeProviderConfigurationRecordSchema.optional(),
  credentialRef: ProviderSecretReferenceSchema.optional()
}).strict();
export type ProviderConfiguration = z.infer<typeof ProviderConfigurationSchema>;

export interface PersistableProviderConfiguration {
  readonly version: 1;
  readonly providerId: ProviderId;
  readonly modelId: ProviderModelId;
  readonly enabled: boolean;
  readonly reasoning?: {
    readonly level: string;
  };
  readonly settings?: SafeProviderConfigurationRecord;
}

export const ProviderModelDefinitionSchema = z.object({
  id: ProviderModelIdSchema,
  displayName: z.string().min(1).max(160),
  adapterModelId: z.string().min(1).max(160).optional(),
  capabilities: ProviderModelCapabilitiesSchema,
  metadataVersion: z.string().min(1).max(64).optional()
}).strict();
export type ProviderModelDefinition = z.infer<typeof ProviderModelDefinitionSchema>;

const ProviderDefinitionMetadataSchema = z.object({
  id: ProviderIdSchema,
  displayName: z.string().min(1).max(160),
  kind: ProviderKindSchema,
  definitionVersion: z.string().min(1).max(64),
  capabilityVersion: z.string().min(1).max(64),
  credentialRequirement: ProviderCredentialRequirementSchema,
  models: z.array(ProviderModelDefinitionSchema).min(1)
}).strict();

export interface ProviderSecretResolver {
  readonly resolveSecret: (reference: ProviderSecretReference) => Promise<string | undefined>;
  readonly hasSecret?: (reference: ProviderSecretReference) => Promise<boolean>;
}

export interface ResolvedProviderConfiguration {
  readonly configuration: ProviderConfiguration;
  readonly provider: ProviderDefinition;
  readonly model: ProviderModelDefinition;
}

export interface ProviderAdapterFactoryInput {
  readonly resolved: ResolvedProviderConfiguration;
  readonly secretResolver?: ProviderSecretResolver;
  readonly runtime?: unknown;
}

export interface ProviderAdapterFactory {
  readonly id: string;
  readonly createAdapter: (
    input: ProviderAdapterFactoryInput
  ) => ReasoningProvider | Promise<ReasoningProvider>;
}

export type ProviderSettingsValidator = (
  settings: SafeProviderConfigurationRecord
) => SafeProviderConfigurationRecord;

export interface ProviderDefinition {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly kind: ProviderKind;
  readonly definitionVersion: string;
  readonly capabilityVersion: string;
  readonly credentialRequirement: ProviderCredentialRequirement;
  readonly models: readonly ProviderModelDefinition[];
  readonly adapterFactory?: ProviderAdapterFactory;
  readonly validateSettings?: ProviderSettingsValidator;
}

export type ProviderControlPlaneErrorCode =
  | "MALFORMED_DEFINITION"
  | "DUPLICATE_PROVIDER"
  | "DUPLICATE_MODEL"
  | "UNKNOWN_PROVIDER"
  | "UNKNOWN_MODEL"
  | "MALFORMED_CONFIGURATION"
  | "SECRET_IN_CONFIGURATION"
  | "DISABLED"
  | "INCOMPATIBLE_CAPABILITY"
  | "UNSUPPORTED_SETTINGS"
  | "ADAPTER_FACTORY_UNAVAILABLE"
  | "CREDENTIALS_REQUIRED"
  | "INVALID_ADAPTER_FACTORY";

export class ProviderControlPlaneError extends Error {
  public constructor(
    public readonly code: ProviderControlPlaneErrorCode,
    message: string
  ) {
    super(message);
    this.name = "ProviderControlPlaneError";
  }
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isSafeProviderConfigurationArray(
  value: SafeProviderConfigurationValue
): value is readonly SafeProviderConfigurationValue[] {
  return Array.isArray(value);
}

function deepFreezeSafeValue(value: SafeProviderConfigurationValue): SafeProviderConfigurationValue {
  if (isSafeProviderConfigurationArray(value)) {
    const frozen = value.map((item) => deepFreezeSafeValue(item));
    return Object.freeze(frozen);
  }
  if (typeof value === "object" && value !== null) {
    const source = value as SafeProviderConfigurationRecord;
    const frozen: Record<string, SafeProviderConfigurationValue> = {};
    for (const key of Object.keys(source).sort(compareCodeUnits)) {
      const item = source[key];
      if (item !== undefined) frozen[key] = deepFreezeSafeValue(item);
    }
    return Object.freeze(frozen);
  }
  return value;
}

function assertNoSecretSettings(value: SafeProviderConfigurationValue, path = "settings"): void {
  if (isSafeProviderConfigurationArray(value)) {
    value.forEach((item, index) => assertNoSecretSettings(item, path + "[" + String(index) + "]"));
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      throw new ProviderControlPlaneError(
        "SECRET_IN_CONFIGURATION",
        "Provider configuration contains a secret-like key at " + path + "." + key
      );
    }
    assertNoSecretSettings(item, path + "." + key);
  }
}

function parseConfiguration(value: unknown): ProviderConfiguration {
  const parsed = ProviderConfigurationSchema.safeParse(value);
  if (!parsed.success) {
    throw new ProviderControlPlaneError(
      "MALFORMED_CONFIGURATION",
      "Provider configuration is malformed"
    );
  }
  if (parsed.data.settings !== undefined) assertNoSecretSettings(parsed.data.settings);
  const settings = parsed.data.settings === undefined
    ? undefined
    : deepFreezeSafeValue(parsed.data.settings) as SafeProviderConfigurationRecord;
  return Object.freeze({
    ...parsed.data,
    ...(settings === undefined ? {} : { settings }),
    ...(parsed.data.reasoning === undefined
      ? {}
      : { reasoning: Object.freeze({ ...parsed.data.reasoning }) }),
    ...(parsed.data.credentialRef === undefined
      ? {}
      : { credentialRef: Object.freeze({ ...parsed.data.credentialRef }) })
  });
}

export function validateProviderConfiguration(value: unknown): ProviderConfiguration {
  return parseConfiguration(value);
}

function freezeCapabilities(
  capabilities: ProviderModelCapabilities
): ProviderModelCapabilities {
  return Object.freeze({ ...capabilities });
}

function freezeModel(model: ProviderModelDefinition): ProviderModelDefinition {
  return Object.freeze({
    ...model,
    capabilities: freezeCapabilities(model.capabilities)
  });
}

function validateFactory(factory: ProviderAdapterFactory | undefined): void {
  if (factory === undefined) return;
  if (
    typeof factory.id !== "string"
    || factory.id.trim().length === 0
    || typeof factory.createAdapter !== "function"
  ) {
    throw new ProviderControlPlaneError(
      "INVALID_ADAPTER_FACTORY",
      "Provider adapter factory is malformed"
    );
  }
}

export function defineProvider(input: ProviderDefinition): ProviderDefinition {
  const metadataResult = ProviderDefinitionMetadataSchema.safeParse({
    id: input.id,
    displayName: input.displayName,
    kind: input.kind,
    definitionVersion: input.definitionVersion,
    capabilityVersion: input.capabilityVersion,
    credentialRequirement: input.credentialRequirement,
    models: input.models
  });
  if (!metadataResult.success) {
    throw new ProviderControlPlaneError(
      "MALFORMED_DEFINITION",
      "Provider definition is malformed"
    );
  }

  const seenModelIds = new Set<string>();
  for (const model of metadataResult.data.models) {
    if (seenModelIds.has(model.id)) {
      throw new ProviderControlPlaneError(
        "DUPLICATE_MODEL",
        "Provider definition contains duplicate model ID " + model.id
      );
    }
    seenModelIds.add(model.id);
  }
  validateFactory(input.adapterFactory);

  const models = metadataResult.data.models
    .map((model) => freezeModel(model))
    .sort((left, right) => compareCodeUnits(left.id, right.id));

  return Object.freeze({
    ...metadataResult.data,
    models: Object.freeze(models),
    ...(input.adapterFactory === undefined
      ? {}
      : { adapterFactory: Object.freeze(input.adapterFactory) }),
    ...(input.validateSettings === undefined
      ? {}
      : { validateSettings: input.validateSettings })
  });
}

export class ProviderRegistry {
  private readonly providers = new Map<ProviderId, ProviderDefinition>();

  public register(input: ProviderDefinition): ProviderDefinition {
    const definition = defineProvider(input);
    if (this.providers.has(definition.id)) {
      throw new ProviderControlPlaneError(
        "DUPLICATE_PROVIDER",
        "Provider ID is already registered: " + definition.id
      );
    }
    this.providers.set(definition.id, definition);
    return definition;
  }

  public enumerateProviders(): readonly ProviderDefinition[] {
    return Object.freeze(
      [...this.providers.values()].sort((left, right) => compareCodeUnits(left.id, right.id))
    );
  }

  public enumerateModels(providerId: ProviderId): readonly ProviderModelDefinition[] {
    return this.getProvider(providerId).models;
  }

  public getProvider(providerId: ProviderId): ProviderDefinition {
    const parsedId = ProviderIdSchema.safeParse(providerId);
    if (!parsedId.success) {
      throw new ProviderControlPlaneError("UNKNOWN_PROVIDER", "Provider is not registered");
    }
    const provider = this.providers.get(parsedId.data);
    if (provider === undefined) {
      throw new ProviderControlPlaneError(
        "UNKNOWN_PROVIDER",
        "Provider is not registered: " + parsedId.data
      );
    }
    return provider;
  }

  public getModel(providerId: ProviderId, modelId: ProviderModelId): ProviderModelDefinition {
    const provider = this.getProvider(providerId);
    const parsedModelId = ProviderModelIdSchema.safeParse(modelId);
    if (!parsedModelId.success) {
      throw new ProviderControlPlaneError("UNKNOWN_MODEL", "Model is not registered");
    }
    const model = provider.models.find((candidate) => candidate.id === parsedModelId.data);
    if (model === undefined) {
      throw new ProviderControlPlaneError(
        "UNKNOWN_MODEL",
        "Model is not registered for provider " + provider.id + ": " + parsedModelId.data
      );
    }
    return model;
  }
}

function supportForCapability(
  capabilities: ProviderModelCapabilities,
  key: ProviderCapabilityKey
): CapabilitySupport {
  switch (key) {
    case "TEXT_GENERATION": return capabilities.textGeneration;
    case "IMAGE_INPUT": return capabilities.imageInput;
    case "TOOL_CALLING": return capabilities.toolCalling;
    case "STREAMING": return capabilities.streaming;
    case "REASONING_CONTROLS": return capabilities.reasoningControls;
    case "LOCAL_EXECUTION": return capabilities.localExecution;
    case "REMOTE_EXECUTION": return capabilities.remoteExecution;
    case "METERED_EXECUTION": return capabilities.meteredExecution;
    case "STRUCTURED_OUTPUT":
      return capabilities.structuredOutput === "UNKNOWN"
        ? "UNKNOWN"
        : capabilities.structuredOutput === "NONE" ? "UNSUPPORTED" : "SUPPORTED";
    case "CANCELLATION":
      return capabilities.cancellation === "UNKNOWN"
        ? "UNKNOWN"
        : capabilities.cancellation === "NONE" ? "UNSUPPORTED" : "SUPPORTED";
  }
}

export interface CapabilityMatchResult {
  readonly compatible: boolean;
  readonly unsupported: readonly ProviderCapabilityKey[];
  readonly unknown: readonly ProviderCapabilityKey[];
}

export function matchCapabilityRequirements(
  capabilities: ProviderModelCapabilities,
  requirements: readonly ProviderCapabilityKey[]
): CapabilityMatchResult {
  const parsedCapabilities = ProviderModelCapabilitiesSchema.parse(capabilities);
  const normalized = [...new Set(requirements.map((value) => ProviderCapabilityKeySchema.parse(value)))]
    .sort(compareCodeUnits);
  const unsupported: ProviderCapabilityKey[] = [];
  const unknown: ProviderCapabilityKey[] = [];
  for (const requirement of normalized) {
    const support = supportForCapability(parsedCapabilities, requirement);
    if (support === "UNSUPPORTED") unsupported.push(requirement);
    if (support === "UNKNOWN") unknown.push(requirement);
  }
  return Object.freeze({
    compatible: unsupported.length === 0 && unknown.length === 0,
    unsupported: Object.freeze(unsupported),
    unknown: Object.freeze(unknown)
  });
}

function validateProviderSettings(
  provider: ProviderDefinition,
  settings: SafeProviderConfigurationRecord | undefined
): SafeProviderConfigurationRecord | undefined {
  if (settings === undefined) return undefined;
  if (provider.validateSettings === undefined) {
    throw new ProviderControlPlaneError(
      "UNSUPPORTED_SETTINGS",
      "Provider does not declare a settings extension"
    );
  }
  let validated: SafeProviderConfigurationRecord;
  try {
    validated = SafeProviderConfigurationRecordSchema.parse(provider.validateSettings(settings));
    assertNoSecretSettings(validated);
  } catch (error) {
    if (error instanceof ProviderControlPlaneError) throw error;
    throw new ProviderControlPlaneError(
      "MALFORMED_CONFIGURATION",
      "Provider-specific settings are malformed"
    );
  }
  return deepFreezeSafeValue(validated) as SafeProviderConfigurationRecord;
}

export function resolveProviderConfiguration(input: {
  readonly registry: ProviderRegistry;
  readonly configuration: unknown;
  readonly requirements?: readonly ProviderCapabilityKey[];
}): ResolvedProviderConfiguration {
  const parsed = parseConfiguration(input.configuration);
  if (!parsed.enabled) {
    throw new ProviderControlPlaneError("DISABLED", "Configured provider is disabled");
  }
  const provider = input.registry.getProvider(parsed.providerId);
  const model = input.registry.getModel(parsed.providerId, parsed.modelId);
  const settings = validateProviderSettings(provider, parsed.settings);
  const configuration = settings === parsed.settings
    ? parsed
    : Object.freeze({ ...parsed, ...(settings === undefined ? {} : { settings }) });

  const implicitRequirements: ProviderCapabilityKey[] = parsed.reasoning === undefined
    ? []
    : ["REASONING_CONTROLS"];
  const match = matchCapabilityRequirements(
    model.capabilities,
    [...(input.requirements ?? []), ...implicitRequirements]
  );
  if (!match.compatible) {
    const failed = [...match.unsupported, ...match.unknown].sort(compareCodeUnits);
    throw new ProviderControlPlaneError(
      "INCOMPATIBLE_CAPABILITY",
      "Configured model does not establish required capabilities: " + failed.join(", ")
    );
  }
  return Object.freeze({ configuration, provider, model });
}

export function resolveAdapterFactory(
  resolved: ResolvedProviderConfiguration
): ProviderAdapterFactory {
  if (resolved.provider.adapterFactory === undefined) {
    throw new ProviderControlPlaneError(
      "ADAPTER_FACTORY_UNAVAILABLE",
      "Registered provider has no adapter factory"
    );
  }
  return resolved.provider.adapterFactory;
}

export const ProviderReadinessStateSchema = z.enum([
  "AVAILABLE",
  "UNAVAILABLE",
  "MISCONFIGURED",
  "CREDENTIALS_REQUIRED",
  "DISABLED",
  "UNKNOWN"
]);
export type ProviderReadinessState = z.infer<typeof ProviderReadinessStateSchema>;

export interface ProviderReadiness {
  readonly state: ProviderReadinessState;
  readonly providerId?: ProviderId;
  readonly modelId?: ProviderModelId;
}

export async function evaluateProviderReadiness(input: {
  readonly registry: ProviderRegistry;
  readonly configuration: unknown;
  readonly secretResolver?: ProviderSecretResolver;
  readonly requirements?: readonly ProviderCapabilityKey[];
}): Promise<ProviderReadiness> {
  const parsed = ProviderConfigurationSchema.safeParse(input.configuration);
  if (!parsed.success) return Object.freeze({ state: "MISCONFIGURED" });
  if (!parsed.data.enabled) {
    return Object.freeze({
      state: "DISABLED",
      providerId: parsed.data.providerId,
      modelId: parsed.data.modelId
    });
  }

  let resolved: ResolvedProviderConfiguration;
  try {
    resolved = resolveProviderConfiguration({
      registry: input.registry,
      configuration: parsed.data,
      ...(input.requirements === undefined ? {} : { requirements: input.requirements })
    });
  } catch {
    return Object.freeze({
      state: "MISCONFIGURED",
      providerId: parsed.data.providerId,
      modelId: parsed.data.modelId
    });
  }

  if (resolved.provider.adapterFactory === undefined) {
    return Object.freeze({
      state: "UNAVAILABLE",
      providerId: resolved.provider.id,
      modelId: resolved.model.id
    });
  }

  if (resolved.provider.credentialRequirement === "REQUIRED") {
    const reference = resolved.configuration.credentialRef;
    if (reference === undefined) {
      return Object.freeze({
        state: "CREDENTIALS_REQUIRED",
        providerId: resolved.provider.id,
        modelId: resolved.model.id
      });
    }
    if (input.secretResolver?.hasSecret === undefined) {
      return Object.freeze({
        state: "UNKNOWN",
        providerId: resolved.provider.id,
        modelId: resolved.model.id
      });
    }
    let available: boolean;
    try {
      available = await input.secretResolver.hasSecret(reference);
    } catch {
      return Object.freeze({
        state: "UNKNOWN",
        providerId: resolved.provider.id,
        modelId: resolved.model.id
      });
    }
    if (!available) {
      return Object.freeze({
        state: "CREDENTIALS_REQUIRED",
        providerId: resolved.provider.id,
        modelId: resolved.model.id
      });
    }
  }

  return Object.freeze({
    state: "AVAILABLE",
    providerId: resolved.provider.id,
    modelId: resolved.model.id
  });
}

export function toPersistableProviderConfiguration(
  value: unknown
): PersistableProviderConfiguration {
  const parsed = parseConfiguration(value);
  return Object.freeze({
    version: 1,
    providerId: parsed.providerId,
    modelId: parsed.modelId,
    enabled: parsed.enabled,
    ...(parsed.reasoning === undefined
      ? {}
      : { reasoning: Object.freeze({ ...parsed.reasoning }) }),
    ...(parsed.settings === undefined ? {} : { settings: parsed.settings })
  });
}

function canonicalizeSafeValue(value: SafeProviderConfigurationValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (isSafeProviderConfigurationArray(value)) {
    return "[" + value.map((item) => canonicalizeSafeValue(item)).join(",") + "]";
  }
  const entries = Object.entries(value)
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([key, item]) => JSON.stringify(key) + ":" + canonicalizeSafeValue(item));
  return "{" + entries.join(",") + "}";
}

export function createProviderConfigurationFingerprintMaterial(value: unknown): string {
  const persistable = toPersistableProviderConfiguration(value);
  return canonicalizeSafeValue(persistable as unknown as SafeProviderConfigurationValue);
}

export interface ProviderDiagnosticMetadata {
  readonly providerId: ProviderId;
  readonly modelId: ProviderModelId;
  readonly providerDefinitionVersion: string;
  readonly capabilityVersion: string;
  readonly modelMetadataVersion?: string;
  readonly capabilities: ProviderModelCapabilities;
  readonly configurationFingerprintMaterial: string;
}

export function toProviderDiagnosticMetadata(
  resolved: ResolvedProviderConfiguration
): ProviderDiagnosticMetadata {
  return Object.freeze({
    providerId: resolved.provider.id,
    modelId: resolved.model.id,
    providerDefinitionVersion: resolved.provider.definitionVersion,
    capabilityVersion: resolved.provider.capabilityVersion,
    ...(resolved.model.metadataVersion === undefined
      ? {}
      : { modelMetadataVersion: resolved.model.metadataVersion }),
    capabilities: resolved.model.capabilities,
    configurationFingerprintMaterial: createProviderConfigurationFingerprintMaterial(
      resolved.configuration
    )
  });
}
