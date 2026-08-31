import { z } from "zod";
import {
  CancellationCapabilitySchema,
  DataUsePolicySchema,
  ModelCapabilitiesSchema,
  StructuredOutputCapabilitySchema,
  type ModelCapabilities,
  type ReasoningProvider
} from "../../domain/src/index.js";
import {
  SafeProviderConfigurationRecordSchema,
  containsSecretLikeConfigurationText,
  inspectPlainProviderConfigurationValue,
  type SafeProviderConfigurationRecord,
  type SafeProviderConfigurationValue
} from "./safe-configuration.js";
export {
  PROVIDER_CONFIGURATION_LIMITS,
  SafeProviderConfigurationRecordSchema,
  SafeProviderConfigurationValueSchema
} from "./safe-configuration.js";
export type {
  SafeProviderConfigurationPrimitive,
  SafeProviderConfigurationRecord,
  SafeProviderConfigurationValue
} from "./safe-configuration.js";

const MACHINE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u;

export type ProviderControlPlaneErrorCode =
  | "MALFORMED_DEFINITION"
  | "MALFORMED_CAPABILITIES"
  | "MALFORMED_REQUIREMENTS"
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
  | "CREDENTIAL_RESOLUTION_FAILED"
  | "INVALID_ADAPTER_FACTORY"
  | "ADAPTER_FACTORY_FAILED"
  | "ADAPTER_DEFINITION_MISMATCH"
  | "INVALID_FACTORY_INPUT";

export class ProviderControlPlaneError extends Error {
  public constructor(
    public readonly code: ProviderControlPlaneErrorCode,
    message: string
  ) {
    super(message);
    this.name = "ProviderControlPlaneError";
  }
}

function machineIdSchema<TBrand extends string>() {
  return z.string()
    .min(1)
    .max(64)
    .regex(MACHINE_ID_PATTERN)
    .refine((value) => !containsSecretLikeConfigurationText(value), {
      message: "SECRET_IN_CONFIGURATION"
    })
    .brand<TBrand>();
}

export const ProviderIdSchema = machineIdSchema<"ProviderId">();
export type ProviderId = z.infer<typeof ProviderIdSchema>;

export const ProviderModelIdSchema = machineIdSchema<"ProviderModelId">();
export type ProviderModelId = z.infer<typeof ProviderModelIdSchema>;

export const ProviderSecretReferenceIdSchema = machineIdSchema<"ProviderSecretReferenceId">();
export type ProviderSecretReferenceId = z.infer<typeof ProviderSecretReferenceIdSchema>;

export const ProviderAdapterFactoryIdSchema = machineIdSchema<"ProviderAdapterFactoryId">();
export type ProviderAdapterFactoryId = z.infer<typeof ProviderAdapterFactoryIdSchema>;

export const ProviderKindSchema = z.enum(["MOCK", "REMOTE_API", "LOCAL_PROCESS", "OTHER"]);
export type ProviderKind = z.infer<typeof ProviderKindSchema>;

export const CapabilitySupportSchema = z.enum(["SUPPORTED", "UNSUPPORTED", "UNKNOWN"]);
export type CapabilitySupport = z.infer<typeof CapabilitySupportSchema>;

const NonBlankTextSchema = z.string().trim().min(1);
function nonSecretTextSchema(maxLength: number) {
  return NonBlankTextSchema.max(maxLength).refine(
    (value) => !containsSecretLikeConfigurationText(value),
    { message: "SECRET_IN_CONFIGURATION" }
  );
}
const BoundedDisplayTextSchema = nonSecretTextSchema(160);
const BoundedVersionTextSchema = nonSecretTextSchema(64);
const ReasoningLevelSchema = NonBlankTextSchema
  .max(64)
  .refine((value) => !containsSecretLikeConfigurationText(value), {
    message: "SECRET_IN_CONFIGURATION"
  });
const PositiveSafeIntegerSchema = z.number().int().positive().refine(
  Number.isSafeInteger,
  "Expected a positive safe integer"
);

const ProviderModelCapabilitiesObjectSchema = z.object({
  textGeneration: CapabilitySupportSchema,
  imageInput: CapabilitySupportSchema,
  toolCalling: CapabilitySupportSchema,
  streaming: CapabilitySupportSchema,
  reasoningControls: CapabilitySupportSchema,
  reasoningLevels: z.union([
    z.literal("UNKNOWN"),
    z.array(ReasoningLevelSchema).max(64).readonly()
  ]),
  persistentSession: CapabilitySupportSchema,
  resumableSession: CapabilitySupportSchema,
  sessionSurvivesClientAbort: CapabilitySupportSchema,
  sessionSurvivesProviderCancel: CapabilitySupportSchema,
  usageReporting: CapabilitySupportSchema,
  localExecution: CapabilitySupportSchema,
  remoteExecution: CapabilitySupportSchema,
  meteredExecution: CapabilitySupportSchema,
  dataUse: z.union([DataUsePolicySchema, z.literal("UNKNOWN")]),
  structuredOutput: z.union([StructuredOutputCapabilitySchema, z.literal("UNKNOWN")]),
  cancellation: z.union([CancellationCapabilitySchema, z.literal("UNKNOWN")]),
  contextWindowTokens: z.union([PositiveSafeIntegerSchema, z.literal("UNKNOWN")]),
  outputLimitTokens: z.union([PositiveSafeIntegerSchema, z.literal("UNKNOWN")])
}).strict();
export type ProviderModelCapabilities = z.infer<typeof ProviderModelCapabilitiesObjectSchema>;

const ProviderModelCapabilitiesEnvelopeSchema = z.unknown().transform((value, context) => {
  try {
    return inspectPlainProviderConfigurationValue(value);
  } catch {
    context.addIssue({ code: "custom", message: "MALFORMED_CAPABILITIES" });
    return z.NEVER;
  }
});

export const ProviderModelCapabilitiesSchema = ProviderModelCapabilitiesEnvelopeSchema
  .pipe(ProviderModelCapabilitiesObjectSchema)
  .superRefine((capabilities, context) => {
    if (!isCapabilityDeclarationConsistent(capabilities)) {
      context.addIssue({ code: "custom", message: "MALFORMED_CAPABILITIES" });
    }
  });

export const ProviderCapabilityKeySchema = z.enum([
  "TEXT_GENERATION",
  "IMAGE_INPUT",
  "TOOL_CALLING",
  "STREAMING",
  "REASONING_CONTROLS",
  "PERSISTENT_SESSION",
  "RESUMABLE_SESSION",
  "SESSION_SURVIVES_CLIENT_ABORT",
  "SESSION_SURVIVES_PROVIDER_CANCEL",
  "USAGE_REPORTING",
  "LOCAL_EXECUTION",
  "REMOTE_EXECUTION",
  "METERED_EXECUTION",
  "STRUCTURED_OUTPUT",
  "CANCELLATION"
]);
export type ProviderCapabilityKey = z.infer<typeof ProviderCapabilityKeySchema>;

export const ProviderCredentialRequirementSchema = z.enum(["NONE", "OPTIONAL", "REQUIRED"]);
export type ProviderCredentialRequirement = z.infer<typeof ProviderCredentialRequirementSchema>;

export const ProviderCredentialPurposeSchema = z.enum(["API_KEY", "TOKEN", "OTHER"]);
export type ProviderCredentialPurpose = z.infer<typeof ProviderCredentialPurposeSchema>;

const ProviderSecretReferenceObjectSchema = z.object({
  id: ProviderSecretReferenceIdSchema,
  purpose: ProviderCredentialPurposeSchema
}).strict();

const ProviderSecretReferenceEnvelopeSchema = z.unknown().transform((value, context) => {
  try {
    return inspectPlainProviderConfigurationValue(value);
  } catch {
    context.addIssue({ code: "custom", message: "MALFORMED_CONFIGURATION" });
    return z.NEVER;
  }
});

export const ProviderSecretReferenceSchema = ProviderSecretReferenceEnvelopeSchema
  .pipe(ProviderSecretReferenceObjectSchema);
export type ProviderSecretReference = z.infer<typeof ProviderSecretReferenceSchema>;

const RawProviderConfigurationSchema = z.object({
  version: z.literal(1),
  providerId: ProviderIdSchema,
  modelId: ProviderModelIdSchema,
  enabled: z.boolean(),
  reasoning: z.object({
    level: ReasoningLevelSchema
  }).strict().optional(),
  settings: SafeProviderConfigurationRecordSchema.optional(),
  credentialRef: ProviderSecretReferenceSchema.optional()
}).strict();

const ProviderConfigurationEnvelopeSchema = z.unknown().transform((value, context) => {
  try {
    return inspectPlainProviderConfigurationValue(value);
  } catch {
    context.addIssue({ code: "custom", message: "MALFORMED_CONFIGURATION" });
    return z.NEVER;
  }
});

export const ProviderConfigurationSchema = ProviderConfigurationEnvelopeSchema
  .pipe(RawProviderConfigurationSchema)
  .transform((configuration) => Object.freeze({
    ...configuration,
    ...(configuration.reasoning === undefined
      ? {}
      : { reasoning: Object.freeze({ ...configuration.reasoning }) }),
    ...(configuration.credentialRef === undefined
      ? {}
      : { credentialRef: Object.freeze({ ...configuration.credentialRef }) })
  }));
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

const ProviderModelDefinitionObjectSchema = z.object({
  id: ProviderModelIdSchema,
  displayName: BoundedDisplayTextSchema,
  adapterModelId: BoundedDisplayTextSchema.optional(),
  capabilities: ProviderModelCapabilitiesSchema,
  metadataVersion: BoundedVersionTextSchema.optional()
}).strict();

const ProviderModelDefinitionEnvelopeSchema = z.unknown().transform((value, context) => {
  try {
    return inspectPlainProviderConfigurationValue(value);
  } catch {
    context.addIssue({ code: "custom", message: "MALFORMED_DEFINITION" });
    return z.NEVER;
  }
});

export const ProviderModelDefinitionSchema = ProviderModelDefinitionEnvelopeSchema
  .pipe(ProviderModelDefinitionObjectSchema);
export type ProviderModelDefinition = z.infer<typeof ProviderModelDefinitionSchema>;

export interface ProviderSecretResolverRequest {
  readonly providerId: ProviderId;
  readonly reference: ProviderSecretReference;
}

export interface ProviderSecretResolver {
  readonly resolveSecret: (
    request: ProviderSecretResolverRequest
  ) => Promise<string | undefined>;
  readonly hasSecret?: (
    request: ProviderSecretResolverRequest
  ) => Promise<boolean>;
}

export interface ResolvedProviderConfiguration {
  readonly configuration: ProviderConfiguration;
  readonly provider: ProviderDefinition;
  readonly model: ProviderModelDefinition;
}

class ResolvedProviderConfigurationValue implements ResolvedProviderConfiguration {
  public constructor(
    public readonly configuration: ProviderConfiguration,
    public readonly provider: ProviderDefinition,
    public readonly model: ProviderModelDefinition
  ) {
    Object.freeze(this);
  }
}

export interface ProviderAdapterFactoryInput {
  readonly resolved: ResolvedProviderConfiguration;
  readonly secretResolver?: ProviderSecretResolver;
  readonly runtime?: unknown;
}

export interface ProviderAdapterFactory {
  readonly id: ProviderAdapterFactoryId;
  readonly createAdapter: (
    input: ProviderAdapterFactoryInput
  ) => ReasoningProvider | Promise<ReasoningProvider>;
}

export interface ProviderAdapterFactoryDefinition {
  readonly id: string;
  readonly createAdapter: (
    input: ProviderAdapterFactoryInput
  ) => ReasoningProvider | Promise<ReasoningProvider>;
}

export type ProviderSettingsValidator = (
  settings: SafeProviderConfigurationRecord
) => unknown;

export interface ProviderModelDefinitionInput {
  readonly id: string;
  readonly displayName: string;
  readonly adapterModelId?: string;
  readonly capabilities: ProviderModelCapabilities;
  readonly metadataVersion?: string;
}

export interface ProviderDefinitionInput {
  readonly id: string;
  readonly displayName: string;
  readonly kind: ProviderKind;
  readonly definitionVersion: string;
  readonly capabilityVersion: string;
  readonly adapterVersion?: string;
  readonly credentialRequirement: ProviderCredentialRequirement;
  readonly credentialPurposes: readonly ProviderCredentialPurpose[];
  readonly models: readonly ProviderModelDefinitionInput[];
  readonly adapterFactory?: ProviderAdapterFactoryDefinition;
  readonly validateSettings?: ProviderSettingsValidator;
}

export interface ProviderDefinition {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly kind: ProviderKind;
  readonly definitionVersion: string;
  readonly capabilityVersion: string;
  readonly adapterVersion?: string;
  readonly credentialRequirement: ProviderCredentialRequirement;
  readonly credentialPurposes: readonly ProviderCredentialPurpose[];
  readonly models: readonly ProviderModelDefinition[];
  readonly adapterFactory?: ProviderAdapterFactory;
  readonly validateSettings?: ProviderSettingsValidator;
}

const ProviderDefinitionMetadataSchema = z.object({
  id: ProviderIdSchema,
  displayName: BoundedDisplayTextSchema,
  kind: ProviderKindSchema,
  definitionVersion: BoundedVersionTextSchema,
  capabilityVersion: BoundedVersionTextSchema,
  adapterVersion: BoundedVersionTextSchema.optional(),
  credentialRequirement: ProviderCredentialRequirementSchema,
  credentialPurposes: z.array(ProviderCredentialPurposeSchema).max(3),
  models: z.array(ProviderModelDefinitionSchema).min(1).max(128)
}).strict();

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

const PROVIDER_DEFINITION_INPUT_KEYS = new Set([
  "id",
  "displayName",
  "kind",
  "definitionVersion",
  "capabilityVersion",
  "adapterVersion",
  "credentialRequirement",
  "credentialPurposes",
  "models",
  "adapterFactory",
  "validateSettings"
]);
const PROVIDER_FACTORY_INPUT_KEYS = new Set(["id", "createAdapter"]);

function inspectPlainDataObjectProperties(
  value: object,
  allowedKeys: ReadonlySet<string>,
  errorCode: "MALFORMED_DEFINITION" | "INVALID_ADAPTER_FACTORY",
  message: string
): Readonly<Record<string, unknown>> {
  let prototype: unknown;
  let descriptors: Readonly<Record<string, PropertyDescriptor>>;
  let symbols: readonly symbol[];
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
    symbols = Object.getOwnPropertySymbols(value);
  } catch {
    throw new ProviderControlPlaneError(errorCode, message);
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ProviderControlPlaneError(errorCode, message);
  }
  if (symbols.length > 0) throw new ProviderControlPlaneError(errorCode, message);
  const inspected: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (
      !allowedKeys.has(key)
      || descriptor.enumerable !== true
      || !("value" in descriptor)
    ) {
      throw new ProviderControlPlaneError(errorCode, message);
    }
    inspected[key] = descriptor.value;
  }
  return Object.freeze(inspected);
}

class RegisteredProviderAdapterFactory implements ProviderAdapterFactory {
  public constructor(
    public readonly id: ProviderAdapterFactoryId,
    private readonly createAdapterImpl: ProviderAdapterFactoryDefinition["createAdapter"]
  ) {
    Object.freeze(this);
  }

  public async createAdapter(
    input: ProviderAdapterFactoryInput
  ): Promise<ReasoningProvider> {
    let resolved: ResolvedProviderConfiguration;
    try {
      resolved = input.resolved;
    } catch {
      throw new ProviderControlPlaneError(
        "INVALID_FACTORY_INPUT",
        "Provider adapter factory requires a control-plane resolution"
      );
    }
    assertTrustedResolvedConfiguration(resolved);

    let adapter: ReasoningProvider;
    try {
      adapter = await this.createAdapterImpl(input);
    } catch (error) {
      if (
        error instanceof ProviderControlPlaneError
        && (
          error.code === "CREDENTIALS_REQUIRED"
          || error.code === "CREDENTIAL_RESOLUTION_FAILED"
          || error.code === "INVALID_FACTORY_INPUT"
        )
      ) {
        throw new ProviderControlPlaneError(
          error.code,
          "Provider adapter factory rejected its input"
        );
      }
      throw new ProviderControlPlaneError(
        "ADAPTER_FACTORY_FAILED",
        "Provider adapter factory failed"
      );
    }

    assertAdapterMatchesResolvedDefinition(resolved, adapter);
    return adapter;
  }
}

function normalizeFactory(factory: unknown): ProviderAdapterFactory | undefined {
  if (factory === undefined) return undefined;
  if (factory instanceof RegisteredProviderAdapterFactory) return factory;
  if (typeof factory !== "object" || factory === null) {
    throw new ProviderControlPlaneError(
      "INVALID_ADAPTER_FACTORY",
      "Provider adapter factory is malformed"
    );
  }
  const inspected = inspectPlainDataObjectProperties(
    factory,
    PROVIDER_FACTORY_INPUT_KEYS,
    "INVALID_ADAPTER_FACTORY",
    "Provider adapter factory is malformed"
  );
  const id = ProviderAdapterFactoryIdSchema.safeParse(inspected.id);
  const createAdapter = inspected.createAdapter;
  if (!id.success || typeof createAdapter !== "function") {
    throw new ProviderControlPlaneError(
      "INVALID_ADAPTER_FACTORY",
      "Provider adapter factory is malformed"
    );
  }
  return new RegisteredProviderAdapterFactory(id.data, createAdapter);
}

function supportMatchesBoolean(
  declared: CapabilitySupport,
  actual: boolean
): boolean {
  return declared === "UNKNOWN"
    || declared === (actual ? "SUPPORTED" : "UNSUPPORTED");
}

function sortedReasoningLevels(capabilities: ModelCapabilities): readonly string[] {
  return [...(capabilities.reasoningLevels ?? [])].sort(compareCodeUnits);
}

function adapterDefinitionMismatch(): ProviderControlPlaneError {
  return new ProviderControlPlaneError(
    "ADAPTER_DEFINITION_MISMATCH",
    "Provider adapter does not match its registered definition"
  );
}

function assertAdapterMatchesResolvedDefinition(
  resolved: ResolvedProviderConfiguration,
  adapter: ReasoningProvider
): void {
  try {
    if (
      typeof adapter !== "object"
      || adapter === null
      || adapter.name !== resolved.provider.id
      || adapter.adapterVersion !== resolved.provider.adapterVersion
    ) {
      throw adapterDefinitionMismatch();
    }

    const parsed = ModelCapabilitiesSchema.safeParse(adapter.capabilities);
    if (!parsed.success) throw adapterDefinitionMismatch();
    const execution = parsed.data;
    const declared = resolved.model.capabilities;
    const executionReasoningLevels = sortedReasoningLevels(execution);
    let reasoningMatches: boolean;
    if (declared.reasoningControls === "UNKNOWN") {
      reasoningMatches = true;
    } else if (declared.reasoningControls === "UNSUPPORTED") {
      reasoningMatches = executionReasoningLevels.length === 0;
    } else {
      const declaredLevels = declared.reasoningLevels;
      reasoningMatches = declaredLevels !== "UNKNOWN"
        && executionReasoningLevels.length > 0
        && executionReasoningLevels.length === declaredLevels.length
        && executionReasoningLevels.every(
          (level, index) => level === declaredLevels[index]
        );
    }

    if (
      !supportMatchesBoolean(declared.imageInput, execution.inputModalities.has("image"))
      || !supportMatchesBoolean(declared.streaming, execution.textStreaming)
      || !supportMatchesBoolean(declared.persistentSession, execution.persistentSession)
      || !supportMatchesBoolean(declared.resumableSession, execution.resumableSession)
      || !supportMatchesBoolean(
        declared.sessionSurvivesClientAbort,
        execution.sessionSurvivesClientAbort
      )
      || !supportMatchesBoolean(
        declared.sessionSurvivesProviderCancel,
        execution.sessionSurvivesProviderCancel
      )
      || !supportMatchesBoolean(declared.usageReporting, execution.usageReporting)
      || !reasoningMatches
      || (declared.structuredOutput !== "UNKNOWN"
        && declared.structuredOutput !== execution.structuredOutput)
      || (declared.cancellation !== "UNKNOWN"
        && declared.cancellation !== execution.cancellation)
      || (declared.dataUse !== "UNKNOWN" && declared.dataUse !== execution.dataUse)
    ) {
      throw adapterDefinitionMismatch();
    }
  } catch (error) {
    if (error instanceof ProviderControlPlaneError) throw error;
    throw adapterDefinitionMismatch();
  }
}

function isCapabilityDeclarationConsistent(
  capabilities: ProviderModelCapabilities
): boolean {
  const levels = capabilities.reasoningLevels;
  if (capabilities.reasoningControls === "SUPPORTED") {
    if (levels === "UNKNOWN" || levels.length === 0 || new Set(levels).size !== levels.length) {
      return false;
    }
  } else if (capabilities.reasoningControls === "UNSUPPORTED") {
    if (levels === "UNKNOWN" || levels.length !== 0) return false;
  } else if (levels !== "UNKNOWN") {
    return false;
  }

  if (capabilities.streaming === "SUPPORTED" && capabilities.textGeneration !== "SUPPORTED") {
    return false;
  }
  if (
    capabilities.structuredOutput !== "NONE"
    && capabilities.structuredOutput !== "UNKNOWN"
    && capabilities.textGeneration !== "SUPPORTED"
  ) {
    return false;
  }
  if (
    capabilities.structuredOutput === "STREAMING"
    && capabilities.streaming !== "SUPPORTED"
  ) {
    return false;
  }
  return true;
}

function assertDefinitionCapabilitiesConsistent(
  capabilities: ProviderModelCapabilities
): void {
  if (!isCapabilityDeclarationConsistent(capabilities)) {
    throw new ProviderControlPlaneError(
      "MALFORMED_DEFINITION",
      "Provider capability declaration is inconsistent"
    );
  }
}

function freezeCapabilities(
  capabilities: ProviderModelCapabilities
): ProviderModelCapabilities {
  const reasoningLevels: ProviderModelCapabilities["reasoningLevels"] =
    capabilities.reasoningLevels === "UNKNOWN"
      ? "UNKNOWN"
      : Object.freeze([...capabilities.reasoningLevels].sort(compareCodeUnits));
  return Object.freeze({ ...capabilities, reasoningLevels });
}

function freezeModel(model: ProviderModelDefinition): ProviderModelDefinition {
  return Object.freeze({
    ...model,
    capabilities: freezeCapabilities(model.capabilities)
  });
}

export function defineProvider(input: ProviderDefinitionInput): ProviderDefinition {
  if (typeof input !== "object" || input === null) {
    throw new ProviderControlPlaneError(
      "MALFORMED_DEFINITION",
      "Provider definition is malformed"
    );
  }
  const inspected = inspectPlainDataObjectProperties(
    input,
    PROVIDER_DEFINITION_INPUT_KEYS,
    "MALFORMED_DEFINITION",
    "Provider definition is malformed"
  );
  const adapterFactory = normalizeFactory(inspected.adapterFactory);
  const validateSettings = inspected.validateSettings;
  if (validateSettings !== undefined && typeof validateSettings !== "function") {
    throw new ProviderControlPlaneError(
      "MALFORMED_DEFINITION",
      "Provider definition is malformed"
    );
  }

  let metadataInput: SafeProviderConfigurationValue;
  try {
    metadataInput = inspectPlainProviderConfigurationValue({
      id: inspected.id,
      displayName: inspected.displayName,
      kind: inspected.kind,
      definitionVersion: inspected.definitionVersion,
      capabilityVersion: inspected.capabilityVersion,
      ...(inspected.adapterVersion === undefined ? {} : { adapterVersion: inspected.adapterVersion }),
      credentialRequirement: inspected.credentialRequirement,
      credentialPurposes: inspected.credentialPurposes,
      models: inspected.models
    });
  } catch {
    throw new ProviderControlPlaneError(
      "MALFORMED_DEFINITION",
      "Provider definition is malformed"
    );
  }
  const metadataResult = ProviderDefinitionMetadataSchema.safeParse(metadataInput);
  if (!metadataResult.success) {
    throw new ProviderControlPlaneError(
      "MALFORMED_DEFINITION",
      "Provider definition is malformed"
    );
  }

  if ((adapterFactory === undefined) !== (metadataResult.data.adapterVersion === undefined)) {
    throw new ProviderControlPlaneError(
      "MALFORMED_DEFINITION",
      "Executable provider definitions must pair an adapter factory with an adapter version"
    );
  }

  const credentialPurposes = metadataResult.data.credentialPurposes;
  if (
    new Set(credentialPurposes).size !== credentialPurposes.length
    || (metadataResult.data.credentialRequirement === "NONE" && credentialPurposes.length !== 0)
    || (metadataResult.data.credentialRequirement !== "NONE" && credentialPurposes.length === 0)
  ) {
    throw new ProviderControlPlaneError(
      "MALFORMED_DEFINITION",
      "Provider credential declaration is inconsistent"
    );
  }

  const seenModelIds = new Set<ProviderModelId>();
  for (const model of metadataResult.data.models) {
    if (seenModelIds.has(model.id)) {
      throw new ProviderControlPlaneError(
        "DUPLICATE_MODEL",
        "Provider definition contains a duplicate model ID"
      );
    }
    seenModelIds.add(model.id);
    assertDefinitionCapabilitiesConsistent(model.capabilities);
    if (
      (metadataResult.data.kind === "REMOTE_API"
        && (
          model.capabilities.remoteExecution !== "SUPPORTED"
          || model.capabilities.localExecution !== "UNSUPPORTED"
        ))
      || (metadataResult.data.kind === "LOCAL_PROCESS"
        && (
          model.capabilities.localExecution !== "SUPPORTED"
          || model.capabilities.remoteExecution !== "UNSUPPORTED"
        ))
    ) {
      throw new ProviderControlPlaneError(
        "MALFORMED_DEFINITION",
        "Provider kind contradicts model execution capabilities"
      );
    }
  }

  const models = metadataResult.data.models
    .map((model) => freezeModel(model))
    .sort((left, right) => compareCodeUnits(left.id, right.id));

  return Object.freeze({
    ...metadataResult.data,
    credentialPurposes: Object.freeze([...credentialPurposes].sort(compareCodeUnits)),
    models: Object.freeze(models),
    ...(adapterFactory === undefined ? {} : { adapterFactory }),
    ...(validateSettings === undefined
      ? {}
      : { validateSettings })
  });
}

export class ProviderRegistry {
  private readonly providers = new Map<ProviderId, ProviderDefinition>();

  public register(input: ProviderDefinitionInput): ProviderDefinition {
    const definition = defineProvider(input);
    this.assertProviderIdAvailable(definition.id);
    this.providers.set(definition.id, definition);
    return definition;
  }

  public registerMany(inputs: readonly ProviderDefinitionInput[]): readonly ProviderDefinition[] {
    const definitions = inputs.map((input) => defineProvider(input));
    const candidateIds = new Set<ProviderId>();
    for (const definition of definitions) {
      if (candidateIds.has(definition.id)) {
        throw new ProviderControlPlaneError(
          "DUPLICATE_PROVIDER",
          "Provider ID is duplicated in the registration batch"
        );
      }
      candidateIds.add(definition.id);
      this.assertProviderIdAvailable(definition.id);
    }
    for (const definition of definitions) this.providers.set(definition.id, definition);
    return Object.freeze(definitions);
  }

  public enumerateProviders(): readonly ProviderDefinition[] {
    return Object.freeze(
      [...this.providers.values()].sort((left, right) => compareCodeUnits(left.id, right.id))
    );
  }

  public enumerateModels(providerId: string): readonly ProviderModelDefinition[] {
    return this.getProvider(providerId).models;
  }

  public getProvider(providerId: string): ProviderDefinition {
    const parsedId = ProviderIdSchema.safeParse(providerId);
    if (!parsedId.success) {
      throw new ProviderControlPlaneError("UNKNOWN_PROVIDER", "Provider is not registered");
    }
    const provider = this.providers.get(parsedId.data);
    if (provider === undefined) {
      throw new ProviderControlPlaneError("UNKNOWN_PROVIDER", "Provider is not registered");
    }
    return provider;
  }

  public getModel(providerId: string, modelId: string): ProviderModelDefinition {
    const provider = this.getProvider(providerId);
    const parsedModelId = ProviderModelIdSchema.safeParse(modelId);
    if (!parsedModelId.success) {
      throw new ProviderControlPlaneError("UNKNOWN_MODEL", "Model is not registered");
    }
    const model = provider.models.find((candidate) => candidate.id === parsedModelId.data);
    if (model === undefined) {
      throw new ProviderControlPlaneError("UNKNOWN_MODEL", "Model is not registered for provider");
    }
    return model;
  }

  private assertProviderIdAvailable(providerId: ProviderId): void {
    if (this.providers.has(providerId)) {
      throw new ProviderControlPlaneError(
        "DUPLICATE_PROVIDER",
        "Provider ID is already registered"
      );
    }
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
    case "PERSISTENT_SESSION": return capabilities.persistentSession;
    case "RESUMABLE_SESSION": return capabilities.resumableSession;
    case "SESSION_SURVIVES_CLIENT_ABORT": return capabilities.sessionSurvivesClientAbort;
    case "SESSION_SURVIVES_PROVIDER_CANCEL": return capabilities.sessionSurvivesProviderCancel;
    case "USAGE_REPORTING": return capabilities.usageReporting;
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
  capabilities: unknown,
  requirements: unknown
): CapabilityMatchResult {
  const parsedCapabilities = ProviderModelCapabilitiesSchema.safeParse(capabilities);
  if (!parsedCapabilities.success) {
    throw new ProviderControlPlaneError(
      "MALFORMED_CAPABILITIES",
      "Provider capability declaration is malformed"
    );
  }

  let inspectedRequirements: SafeProviderConfigurationValue;
  try {
    inspectedRequirements = inspectPlainProviderConfigurationValue(requirements);
  } catch {
    throw new ProviderControlPlaneError(
      "MALFORMED_REQUIREMENTS",
      "Provider capability requirements are malformed"
    );
  }
  if (!isSafeProviderConfigurationArray(inspectedRequirements) || inspectedRequirements.length > 64) {
    throw new ProviderControlPlaneError(
      "MALFORMED_REQUIREMENTS",
      "Provider capability requirements are malformed"
    );
  }

  const normalizedRequirements: ProviderCapabilityKey[] = [];
  for (const requirement of inspectedRequirements) {
    const parsedRequirement = ProviderCapabilityKeySchema.safeParse(requirement);
    if (!parsedRequirement.success) {
      throw new ProviderControlPlaneError(
        "MALFORMED_REQUIREMENTS",
        "Provider capability requirements are malformed"
      );
    }
    normalizedRequirements.push(parsedRequirement.data);
  }

  const normalized = [...new Set(normalizedRequirements)].sort(compareCodeUnits);
  const unsupported: ProviderCapabilityKey[] = [];
  const unknown: ProviderCapabilityKey[] = [];
  for (const requirement of normalized) {
    const support = supportForCapability(parsedCapabilities.data, requirement);
    if (support === "UNSUPPORTED") unsupported.push(requirement);
    if (support === "UNKNOWN") unknown.push(requirement);
  }
  return Object.freeze({
    compatible: unsupported.length === 0 && unknown.length === 0,
    unsupported: Object.freeze(unsupported),
    unknown: Object.freeze(unknown)
  });
}

function parseConfiguration(value: unknown): ProviderConfiguration {
  const parsed = ProviderConfigurationSchema.safeParse(value);
  if (!parsed.success) {
    const containsSecret = parsed.error.issues.some(
      (issue) => issue.message === "SECRET_IN_CONFIGURATION"
    );
    throw new ProviderControlPlaneError(
      containsSecret ? "SECRET_IN_CONFIGURATION" : "MALFORMED_CONFIGURATION",
      containsSecret
        ? "Provider configuration contains credential-like material"
        : "Provider configuration is malformed"
    );
  }
  return parsed.data;
}

export function validateProviderConfiguration(value: unknown): ProviderConfiguration {
  return parseConfiguration(value);
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
  let candidate: unknown;
  try {
    candidate = provider.validateSettings(settings);
  } catch {
    throw new ProviderControlPlaneError(
      "MALFORMED_CONFIGURATION",
      "Provider-specific settings are malformed"
    );
  }
  const parsed = SafeProviderConfigurationRecordSchema.safeParse(candidate);
  if (!parsed.success) {
    const containsSecret = parsed.error.issues.some(
      (issue) => issue.message === "SECRET_IN_CONFIGURATION"
    );
    throw new ProviderControlPlaneError(
      containsSecret ? "SECRET_IN_CONFIGURATION" : "MALFORMED_CONFIGURATION",
      containsSecret
        ? "Provider configuration contains credential-like material"
        : "Provider-specific settings are malformed"
    );
  }
  return parsed.data;
}

function validateCredentialReference(
  provider: ProviderDefinition,
  reference: ProviderSecretReference | undefined
): void {
  if (provider.credentialRequirement === "NONE") {
    if (reference !== undefined) {
      throw new ProviderControlPlaneError(
        "MALFORMED_CONFIGURATION",
        "Provider configuration includes an unsupported credential reference"
      );
    }
    return;
  }
  if (reference !== undefined && !provider.credentialPurposes.includes(reference.purpose)) {
    throw new ProviderControlPlaneError(
      "MALFORMED_CONFIGURATION",
      "Provider configuration uses an unsupported credential purpose"
    );
  }
}

function validateReasoningConfiguration(
  model: ProviderModelDefinition,
  reasoning: ProviderConfiguration["reasoning"]
): void {
  if (reasoning === undefined) return;
  if (model.capabilities.reasoningControls !== "SUPPORTED") {
    throw new ProviderControlPlaneError(
      "INCOMPATIBLE_CAPABILITY",
      "Configured model does not establish reasoning-control support"
    );
  }
  const levels = model.capabilities.reasoningLevels;
  if (levels === "UNKNOWN" || !levels.includes(reasoning.level)) {
    throw new ProviderControlPlaneError(
      "INCOMPATIBLE_CAPABILITY",
      "Configured model does not establish the requested reasoning level"
    );
  }
}

function assertTrustedResolvedConfiguration(
  resolved: ResolvedProviderConfiguration
): void {
  let trusted = false;
  try {
    trusted = resolved instanceof ResolvedProviderConfigurationValue;
  } catch {
    trusted = false;
  }
  if (!trusted) {
    throw new ProviderControlPlaneError(
      "INVALID_FACTORY_INPUT",
      "Provider adapter factory requires a control-plane resolution"
    );
  }
}

function resolveParsedProviderConfiguration(input: {
  readonly registry: ProviderRegistry;
  readonly configuration: ProviderConfiguration;
  readonly requirements?: readonly ProviderCapabilityKey[];
}): ResolvedProviderConfiguration {
  const provider = input.registry.getProvider(input.configuration.providerId);
  const model = input.registry.getModel(input.configuration.providerId, input.configuration.modelId);
  const settings = validateProviderSettings(provider, input.configuration.settings);
  const configuration = settings === input.configuration.settings
    ? input.configuration
    : Object.freeze({ ...input.configuration, ...(settings === undefined ? {} : { settings }) });

  validateCredentialReference(provider, configuration.credentialRef);
  validateReasoningConfiguration(model, configuration.reasoning);
  const match = matchCapabilityRequirements(model.capabilities, input.requirements ?? []);
  if (!match.compatible) {
    throw new ProviderControlPlaneError(
      "INCOMPATIBLE_CAPABILITY",
      "Configured model does not establish required capabilities"
    );
  }
  return new ResolvedProviderConfigurationValue(configuration, provider, model);
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
  return resolveParsedProviderConfiguration({
    registry: input.registry,
    configuration: parsed,
    ...(input.requirements === undefined ? {} : { requirements: input.requirements })
  });
}

export function resolveAdapterFactory(
  resolved: ResolvedProviderConfiguration
): ProviderAdapterFactory {
  assertTrustedResolvedConfiguration(resolved);
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
export type ProviderReadinessReason = ProviderControlPlaneErrorCode | "CREDENTIAL_STATUS_UNKNOWN";

export interface ProviderReadiness {
  readonly state: ProviderReadinessState;
  readonly providerId?: ProviderId;
  readonly modelId?: ProviderModelId;
  readonly reason?: ProviderReadinessReason;
}

export async function evaluateProviderReadiness(input: {
  readonly registry: ProviderRegistry;
  readonly configuration: unknown;
  readonly secretResolver?: ProviderSecretResolver;
  readonly requirements?: readonly ProviderCapabilityKey[];
}): Promise<ProviderReadiness> {
  let parsed: ProviderConfiguration;
  try {
    parsed = parseConfiguration(input.configuration);
  } catch (error) {
    return Object.freeze({
      state: "MISCONFIGURED",
      reason: error instanceof ProviderControlPlaneError
        ? error.code
        : "MALFORMED_CONFIGURATION"
    });
  }

  let resolved: ResolvedProviderConfiguration;
  try {
    resolved = resolveParsedProviderConfiguration({
      registry: input.registry,
      configuration: parsed
    });
  } catch (error) {
    return Object.freeze({
      state: "MISCONFIGURED",
      providerId: parsed.providerId,
      modelId: parsed.modelId,
      reason: error instanceof ProviderControlPlaneError
        ? error.code
        : "MALFORMED_CONFIGURATION"
    });
  }

  if (input.requirements !== undefined) {
    let match: CapabilityMatchResult;
    try {
      match = matchCapabilityRequirements(resolved.model.capabilities, input.requirements);
    } catch (error) {
      return Object.freeze({
        state: "MISCONFIGURED",
        providerId: resolved.provider.id,
        modelId: resolved.model.id,
        reason: error instanceof ProviderControlPlaneError
          ? error.code
          : "MALFORMED_REQUIREMENTS"
      });
    }
    if (!match.compatible) {
      return Object.freeze({
        state: "MISCONFIGURED",
        providerId: resolved.provider.id,
        modelId: resolved.model.id,
        reason: "INCOMPATIBLE_CAPABILITY"
      });
    }
  }

  if (!resolved.configuration.enabled) {
    return Object.freeze({
      state: "DISABLED",
      providerId: resolved.provider.id,
      modelId: resolved.model.id
    });
  }

  if (resolved.provider.adapterFactory === undefined) {
    return Object.freeze({
      state: "UNAVAILABLE",
      providerId: resolved.provider.id,
      modelId: resolved.model.id,
      reason: "ADAPTER_FACTORY_UNAVAILABLE"
    });
  }

  const reference = resolved.configuration.credentialRef;
  if (reference === undefined) {
    if (resolved.provider.credentialRequirement === "REQUIRED") {
      return Object.freeze({
        state: "CREDENTIALS_REQUIRED",
        providerId: resolved.provider.id,
        modelId: resolved.model.id
      });
    }
  } else {
    const resolver = input.secretResolver;
    let hasSecret: ProviderSecretResolver["hasSecret"];
    try {
      hasSecret = resolver?.hasSecret;
    } catch {
      return Object.freeze({
        state: "UNKNOWN",
        providerId: resolved.provider.id,
        modelId: resolved.model.id,
        reason: "CREDENTIAL_STATUS_UNKNOWN"
      });
    }
    if (typeof hasSecret !== "function" || resolver === undefined) {
      return Object.freeze({
        state: "UNKNOWN",
        providerId: resolved.provider.id,
        modelId: resolved.model.id,
        reason: "CREDENTIAL_STATUS_UNKNOWN"
      });
    }
    let available: unknown;
    try {
      available = await hasSecret.call(resolver, Object.freeze({
        providerId: resolved.provider.id,
        reference
      }));
    } catch {
      return Object.freeze({
        state: "UNKNOWN",
        providerId: resolved.provider.id,
        modelId: resolved.model.id,
        reason: "CREDENTIAL_STATUS_UNKNOWN"
      });
    }
    if (typeof available !== "boolean") {
      return Object.freeze({
        state: "UNKNOWN",
        providerId: resolved.provider.id,
        modelId: resolved.model.id,
        reason: "CREDENTIAL_STATUS_UNKNOWN"
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

function isSafeProviderConfigurationArray(
  value: SafeProviderConfigurationValue
): value is readonly SafeProviderConfigurationValue[] {
  return Array.isArray(value);
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
  const material: SafeProviderConfigurationRecord = {
    version: persistable.version,
    providerId: persistable.providerId,
    modelId: persistable.modelId,
    enabled: persistable.enabled,
    ...(persistable.reasoning === undefined ? {} : { reasoning: persistable.reasoning }),
    ...(persistable.settings === undefined ? {} : { settings: persistable.settings })
  };
  return canonicalizeSafeValue(material);
}

export interface ProviderDiagnosticMetadata {
  readonly providerId: ProviderId;
  readonly modelId: ProviderModelId;
  readonly providerDefinitionVersion: string;
  readonly capabilityVersion: string;
  readonly adapterVersion?: string;
  readonly modelMetadataVersion?: string;
  readonly capabilities: ProviderModelCapabilities;
  readonly configurationFingerprintMaterial: string;
}

export function toProviderDiagnosticMetadata(
  resolved: ResolvedProviderConfiguration
): ProviderDiagnosticMetadata {
  assertTrustedResolvedConfiguration(resolved);
  return Object.freeze({
    providerId: resolved.provider.id,
    modelId: resolved.model.id,
    providerDefinitionVersion: resolved.provider.definitionVersion,
    capabilityVersion: resolved.provider.capabilityVersion,
    ...(resolved.provider.adapterVersion === undefined
      ? {}
      : { adapterVersion: resolved.provider.adapterVersion }),
    ...(resolved.model.metadataVersion === undefined
      ? {}
      : { modelMetadataVersion: resolved.model.metadataVersion }),
    capabilities: resolved.model.capabilities,
    configurationFingerprintMaterial: createProviderConfigurationFingerprintMaterial(
      resolved.configuration
    )
  });
}
