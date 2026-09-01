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
  inspectPlainProviderDefinitionValue,
  type SafeProviderConfigurationRecord,
  type SafeProviderConfigurationValue
} from "./safe-configuration.js";

const OBJECT_FREEZE_INTRINSIC = Object.freeze;
const OBJECT_SET_PROTOTYPE_OF_INTRINSIC = Object.setPrototypeOf;
const OBJECT_HAS_OWN_INTRINSIC = Object.hasOwn;

function objectFreeze<T extends object>(value: T): Readonly<T> {
  return OBJECT_FREEZE_INTRINSIC(value);
}

function objectSetPrototypeOf(value: object, prototype: object | null): void {
  OBJECT_SET_PROTOTYPE_OF_INTRINSIC(value, prototype);
}

function objectHasOwn(value: object, key: PropertyKey): boolean {
  return OBJECT_HAS_OWN_INTRINSIC(value, key);
}
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
  | "INVALID_FACTORY_INPUT"
  | "INVALID_REGISTRY"
  | "CAPABILITY_STATUS_UNKNOWN";

export class ProviderControlPlaneError extends Error {
  readonly #controlPlaneErrorBrand = true;

  public constructor(
    public readonly code: ProviderControlPlaneErrorCode,
    message: string
  ) {
    super(message);
    Object.defineProperty(this, "code", {
      configurable: false,
      enumerable: true,
      writable: false,
      value: code
    });
    this.name = "ProviderControlPlaneError";
  }

  public static isControlPlaneError(value: unknown): value is ProviderControlPlaneError {
    if (typeof value !== "object" || value === null) return false;
    try {
      return #controlPlaneErrorBrand in value;
    } catch {
      return false;
    }
  }
}

const isProviderControlPlaneError = ProviderControlPlaneError.isControlPlaneError;

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

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const REGEXP_TEST_INTRINSIC = RegExp.prototype.test;
const STRING_TRIM_INTRINSIC = String.prototype.trim;

function controlPlaneRegExpTest(pattern: RegExp, value: string): boolean {
  const result: unknown = Reflect.apply(REGEXP_TEST_INTRINSIC, pattern, [value]);
  return result === true;
}

function trimControlPlaneText(value: string): string {
  const result: unknown = Reflect.apply(STRING_TRIM_INTRINSIC, value, []);
  if (typeof result !== "string") {
    throw new ProviderControlPlaneError(
      "MALFORMED_DEFINITION",
      "Provider text normalization failed"
    );
  }
  return result;
}

function nonSecretTextSchema(maxLength: number) {
  return z.string()
    .refine((value) => !controlPlaneRegExpTest(CONTROL_CHARACTER_PATTERN, value), {
      message: "CONTROL_CHARACTERS_NOT_ALLOWED"
    })
    .transform((value) => trimControlPlaneText(value))
    .pipe(z.string().min(1).max(maxLength))
    .refine((value) => !containsSecretLikeConfigurationText(value), {
      message: "SECRET_IN_CONFIGURATION"
    });
}

const BoundedDisplayTextSchema = nonSecretTextSchema(160);
const BoundedVersionTextSchema = nonSecretTextSchema(64);
const ReasoningLevelSchema = nonSecretTextSchema(64);
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
  })
  .transform((capabilities) => freezeCapabilities(capabilities));

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
  .pipe(ProviderSecretReferenceObjectSchema)
  .transform((reference) => freezeNullPrototype({ ...reference }));
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
  .transform((configuration) => {
    const reasoning = objectHasOwn(configuration, "reasoning")
      ? configuration.reasoning
      : undefined;
    const credentialRef = objectHasOwn(configuration, "credentialRef")
      ? configuration.credentialRef
      : undefined;
    return freezeNullPrototype({
      ...configuration,
      ...(reasoning === undefined
        ? {}
        : { reasoning: freezeNullPrototype({ ...reasoning }) }),
      ...(credentialRef === undefined
        ? {}
        : { credentialRef: freezeNullPrototype({ ...credentialRef }) })
    });
  });
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
  .pipe(ProviderModelDefinitionObjectSchema)
  .transform((model) => freezeNullPrototype({
    ...model,
    capabilities: model.capabilities
  }));
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

const RESOLUTION_CONSTRUCTION_TOKEN = Symbol("provider-resolution-construction");

class ResolvedProviderConfigurationValue implements ResolvedProviderConfiguration {
  readonly #resolutionBrand = true;

  public constructor(
    token: typeof RESOLUTION_CONSTRUCTION_TOKEN,
    public readonly configuration: ProviderConfiguration,
    public readonly provider: ProviderDefinition,
    public readonly model: ProviderModelDefinition
  ) {
    if (token !== RESOLUTION_CONSTRUCTION_TOKEN) {
      throw new ProviderControlPlaneError(
        "INVALID_FACTORY_INPUT",
        "Provider resolution construction is not permitted"
      );
    }
    objectFreeze(this);
  }

  public static isResolved(value: unknown): value is ResolvedProviderConfigurationValue {
    if (typeof value !== "object" || value === null) return false;
    try {
      return #resolutionBrand in value;
    } catch {
      return false;
    }
  }
}

const isResolvedProviderConfiguration = ResolvedProviderConfigurationValue.isResolved;

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

function sortedCodeUnitStringCopy<T extends string>(
  values: readonly T[]
): T[] {
  const output: T[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === undefined) continue;
    let insertionIndex = output.length;
    while (insertionIndex > 0) {
      const previous = output[insertionIndex - 1];
      if (previous === undefined || compareCodeUnits(previous, value) <= 0) break;
      output[insertionIndex] = previous;
      insertionIndex -= 1;
    }
    output[insertionIndex] = value;
  }
  return output;
}

function readonlyStringArraysEqual(
  left: readonly string[],
  right: readonly string[]
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function hasDuplicateStrings(values: readonly string[]): boolean {
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === undefined) continue;
    for (let previousIndex = 0; previousIndex < index; previousIndex += 1) {
      if (values[previousIndex] === value) return true;
    }
  }
  return false;
}

function freezeNullPrototype<T extends object>(value: T): T {
  objectSetPrototypeOf(value, null);
  return objectFreeze(value);
}

const MAP_HAS_INTRINSIC = Map.prototype.has;
const MAP_GET_INTRINSIC = Map.prototype.get;
const MAP_SET_INTRINSIC = Map.prototype.set;
const MAP_FOR_EACH_INTRINSIC = Map.prototype.forEach;
const SET_HAS_INTRINSIC = Set.prototype.has;
const SET_ADD_INTRINSIC = Set.prototype.add;

function setHas<T>(set: ReadonlySet<T>, value: T): boolean {
  const result: unknown = Reflect.apply(SET_HAS_INTRINSIC, set, [value]);
  return result === true;
}

function setAdd<T>(set: Set<T>, value: T): void {
  Reflect.apply(SET_ADD_INTRINSIC, set, [value]);
}

function providerMapHas(
  map: Map<ProviderId, ProviderDefinition>,
  providerId: ProviderId
): boolean {
  let result: unknown;
  try {
    result = Reflect.apply(MAP_HAS_INTRINSIC, map, [providerId]);
  } catch {
    throw new ProviderControlPlaneError(
      "INVALID_REGISTRY",
      "Provider registry storage is invalid"
    );
  }
  return result === true;
}

function isStoredProviderDefinition(
  value: unknown,
  expectedId: ProviderId
): value is ProviderDefinition {
  if (typeof value !== "object" || value === null) return false;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, "id");
    if (descriptor === undefined || !("value" in descriptor)) return false;
    const storedId: unknown = descriptor.value;
    return storedId === expectedId
      && Object.getPrototypeOf(value) === null
      && Object.isFrozen(value);
  } catch {
    return false;
  }
}

function providerMapGet(
  map: Map<ProviderId, ProviderDefinition>,
  providerId: ProviderId
): ProviderDefinition | undefined {
  let result: unknown;
  try {
    result = Reflect.apply(MAP_GET_INTRINSIC, map, [providerId]);
  } catch {
    throw new ProviderControlPlaneError(
      "INVALID_REGISTRY",
      "Provider registry storage is invalid"
    );
  }
  if (result === undefined) return undefined;
  if (!isStoredProviderDefinition(result, providerId)) {
    throw new ProviderControlPlaneError(
      "INVALID_REGISTRY",
      "Provider registry storage is invalid"
    );
  }
  return result;
}

function providerMapSet(
  map: Map<ProviderId, ProviderDefinition>,
  providerId: ProviderId,
  definition: ProviderDefinition
): void {
  try {
    Reflect.apply(MAP_SET_INTRINSIC, map, [providerId, definition]);
  } catch {
    throw new ProviderControlPlaneError(
      "INVALID_REGISTRY",
      "Provider registry storage is invalid"
    );
  }
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
const PROVIDER_ADAPTER_FACTORY_INPUT_KEYS = new Set([
  "resolved",
  "secretResolver",
  "runtime"
]);

const RESOLUTION_INPUT_KEYS = new Set(["registry", "configuration", "requirements"]);
const READINESS_INPUT_KEYS = new Set([
  "registry",
  "configuration",
  "secretResolver",
  "requirements"
]);

function objectHasUnknownOwnKeys(
  descriptors: Readonly<Record<string, PropertyDescriptor>>,
  allowedKeys: ReadonlySet<string>
): boolean {
  const keys = Object.keys(descriptors);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (key !== undefined && !setHas(allowedKeys, key)) return true;
  }
  return false;
}

function assertNoUnknownOwnOperationFields(
  value: unknown,
  allowedKeys: ReadonlySet<string>,
  errorCode: "MALFORMED_CONFIGURATION",
  message: string
): void {
  if (typeof value !== "object" || value === null) {
    throw new ProviderControlPlaneError(errorCode, message);
  }
  let descriptors: Readonly<Record<string, PropertyDescriptor>>;
  let symbols: readonly symbol[];
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
    symbols = Object.getOwnPropertySymbols(value);
  } catch {
    throw new ProviderControlPlaneError(errorCode, message);
  }
  if (
    symbols.length > 0
    || objectHasUnknownOwnKeys(descriptors, allowedKeys)
  ) {
    throw new ProviderControlPlaneError(errorCode, message);
  }
}

function readOwnDataProperty(
  value: unknown,
  key: string,
  errorCode:
    | "MALFORMED_CONFIGURATION"
    | "MALFORMED_REQUIREMENTS"
    | "INVALID_REGISTRY"
    | "INVALID_FACTORY_INPUT",
  message: string
): {
  readonly present: boolean;
  readonly value: unknown;
} {
  if (typeof value !== "object" || value === null) {
    throw new ProviderControlPlaneError(errorCode, message);
  }
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    throw new ProviderControlPlaneError(errorCode, message);
  }
  if (descriptor === undefined) {
    return freezeNullPrototype({ present: false, value: undefined });
  }
  if (!("value" in descriptor)) {
    throw new ProviderControlPlaneError(errorCode, message);
  }
  const propertyValue: unknown = descriptor.value;
  return freezeNullPrototype({ present: true, value: propertyValue });
}

function inspectPlainDataObjectProperties(
  value: object,
  allowedKeys: ReadonlySet<string>,
  errorCode: "MALFORMED_DEFINITION" | "INVALID_ADAPTER_FACTORY" | "INVALID_FACTORY_INPUT",
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
  objectSetPrototypeOf(inspected, null);
  const descriptorKeys = Object.keys(descriptors);
  for (let index = 0; index < descriptorKeys.length; index += 1) {
    const key = descriptorKeys[index];
    if (key === undefined) continue;
    const descriptor = descriptors[key];
    if (
      descriptor === undefined
      || !setHas(allowedKeys, key)
      || descriptor.enumerable !== true
      || !("value" in descriptor)
    ) {
      throw new ProviderControlPlaneError(errorCode, message);
    }
    const item: unknown = descriptor.value;
    inspected[key] = item;
  }
  return objectFreeze(inspected);
}

function readResolverMethodWithoutAccessors(
  value: object,
  key: "resolveSecret" | "hasSecret"
): unknown {
  const seen = new Set<object>();
  let current: object | null = value;
  for (let depth = 0; depth < 16 && current !== null; depth += 1) {
    if (current === Object.prototype) return undefined;
    if (setHas(seen, current)) {
      throw new ProviderControlPlaneError(
        "INVALID_FACTORY_INPUT",
        "Provider secret resolver prototype chain is malformed"
      );
    }
    setAdd(seen, current);

    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(current, key);
    } catch {
      throw new ProviderControlPlaneError(
        "INVALID_FACTORY_INPUT",
        "Provider secret resolver is malformed"
      );
    }
    if (descriptor !== undefined) {
      if (!("value" in descriptor)) {
        throw new ProviderControlPlaneError(
          "INVALID_FACTORY_INPUT",
          "Provider secret resolver methods must not be accessors"
        );
      }
      const member: unknown = descriptor.value;
      return member;
    }

    try {
      current = Object.getPrototypeOf(current);
    } catch {
      throw new ProviderControlPlaneError(
        "INVALID_FACTORY_INPUT",
        "Provider secret resolver prototype chain is malformed"
      );
    }
  }
  if (current !== null) {
    throw new ProviderControlPlaneError(
      "INVALID_FACTORY_INPUT",
      "Provider secret resolver prototype chain is too deep"
    );
  }
  return undefined;
}

function normalizeFactorySecretResolver(
  value: unknown,
  resolved: ResolvedProviderConfigurationValue
): ProviderSecretResolver | undefined {
  const expectedReference = resolved.configuration.credentialRef;
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null) {
    throw new ProviderControlPlaneError(
      "INVALID_FACTORY_INPUT",
      "Provider secret resolver is malformed"
    );
  }

  const resolveSecretCandidate = readResolverMethodWithoutAccessors(value, "resolveSecret");
  const hasSecretCandidate = readResolverMethodWithoutAccessors(value, "hasSecret");
  if (
    typeof resolveSecretCandidate !== "function"
    || (hasSecretCandidate !== undefined && typeof hasSecretCandidate !== "function")
  ) {
    throw new ProviderControlPlaneError(
      "INVALID_FACTORY_INPUT",
      "Provider secret resolver is malformed"
    );
  }
  if (expectedReference === undefined) return undefined;

  const expectedRequest = freezeNullPrototype({
    providerId: resolved.provider.id,
    reference: expectedReference
  }) satisfies ProviderSecretResolverRequest;

  const assertRequestMatches = (
    request: ProviderSecretResolverRequest
  ): void => {
    if (typeof request !== "object" || request === null) {
      throw new ProviderControlPlaneError(
        "CREDENTIAL_RESOLUTION_FAILED",
        "Provider credential request does not match the resolved configuration"
      );
    }
    let inspected: Readonly<Record<string, unknown>>;
    try {
      inspected = inspectPlainDataObjectProperties(
        request,
        new Set(["providerId", "reference"]),
        "INVALID_FACTORY_INPUT",
        "Provider credential request is malformed"
      );
    } catch {
      throw new ProviderControlPlaneError(
        "CREDENTIAL_RESOLUTION_FAILED",
        "Provider credential request does not match the resolved configuration"
      );
    }
    const providerId = ProviderIdSchema.safeParse(inspected.providerId);
    const reference = ProviderSecretReferenceSchema.safeParse(inspected.reference);
    if (
      !providerId.success
      || !reference.success
      || providerId.data !== expectedRequest.providerId
      || reference.data.id !== expectedRequest.reference.id
      || reference.data.purpose !== expectedRequest.reference.purpose
    ) {
      throw new ProviderControlPlaneError(
        "CREDENTIAL_RESOLUTION_FAILED",
        "Provider credential request does not match the resolved configuration"
      );
    }
  };

  const resolveSecret = async (
    request: ProviderSecretResolverRequest
  ): Promise<string | undefined> => {
    assertRequestMatches(request);
    let result: unknown;
    try {
      result = await Reflect.apply(resolveSecretCandidate, value, [expectedRequest]);
    } catch {
      throw new ProviderControlPlaneError(
        "CREDENTIAL_RESOLUTION_FAILED",
        "Provider credential resolution failed"
      );
    }
    if (result !== undefined && typeof result !== "string") {
      throw new ProviderControlPlaneError(
        "CREDENTIAL_RESOLUTION_FAILED",
        "Provider credential resolver returned an invalid value"
      );
    }
    return result;
  };

  if (hasSecretCandidate === undefined) {
    return freezeNullPrototype({ resolveSecret });
  }
  const hasSecret = async (
    request: ProviderSecretResolverRequest
  ): Promise<boolean> => {
    assertRequestMatches(request);
    let result: unknown;
    try {
      result = await Reflect.apply(hasSecretCandidate, value, [expectedRequest]);
    } catch {
      throw new ProviderControlPlaneError(
        "CREDENTIAL_RESOLUTION_FAILED",
        "Provider credential status check failed"
      );
    }
    if (typeof result !== "boolean") {
      throw new ProviderControlPlaneError(
        "CREDENTIAL_RESOLUTION_FAILED",
        "Provider credential status resolver returned an invalid value"
      );
    }
    return result;
  };
  return freezeNullPrototype({ resolveSecret, hasSecret });
}

const REGISTERED_FACTORY_CONSTRUCTION_TOKEN = Symbol("provider-factory-construction");

class RegisteredProviderAdapterFactory implements ProviderAdapterFactory {
  readonly #createAdapterImpl: ProviderAdapterFactoryDefinition["createAdapter"];
  readonly #ownerProviderId: ProviderId | undefined;
  public readonly createAdapter: ProviderAdapterFactory["createAdapter"];

  public constructor(
    token: typeof REGISTERED_FACTORY_CONSTRUCTION_TOKEN,
    ownerProviderId: ProviderId | undefined,
    public readonly id: ProviderAdapterFactoryId,
    createAdapterImpl: ProviderAdapterFactoryDefinition["createAdapter"]
  ) {
    if (token !== REGISTERED_FACTORY_CONSTRUCTION_TOKEN) {
      throw new ProviderControlPlaneError(
        "INVALID_ADAPTER_FACTORY",
        "Registered provider factory construction is not permitted"
      );
    }
    this.#ownerProviderId = ownerProviderId;
    this.#createAdapterImpl = createAdapterImpl;
    this.createAdapter = (input) => this.#createAdapter(input);
    objectFreeze(this);
  }

  public static isRegistered(value: unknown): value is RegisteredProviderAdapterFactory {
    if (typeof value !== "object" || value === null) return false;
    try {
      return #createAdapterImpl in value;
    } catch {
      return false;
    }
  }

  public static belongsToProvider(
    value: RegisteredProviderAdapterFactory,
    providerId: ProviderId
  ): boolean {
    try {
      return value.#ownerProviderId === providerId;
    } catch {
      return false;
    }
  }

  async #createAdapter(
    input: ProviderAdapterFactoryInput
  ): Promise<ReasoningProvider> {
    if (typeof input !== "object" || input === null) {
      throw new ProviderControlPlaneError(
        "INVALID_FACTORY_INPUT",
        "Provider adapter factory input is malformed"
      );
    }
    const inspected = inspectPlainDataObjectProperties(
      input,
      PROVIDER_ADAPTER_FACTORY_INPUT_KEYS,
      "INVALID_FACTORY_INPUT",
      "Provider adapter factory input is malformed"
    );
    const resolved = inspected.resolved;
    assertTrustedResolvedConfiguration(resolved);
    if (
      resolved.provider.adapterFactory !== this
      || this.#ownerProviderId !== resolved.provider.id
    ) {
      throw new ProviderControlPlaneError(
        "INVALID_FACTORY_INPUT",
        "Provider adapter factory does not belong to the resolved provider"
      );
    }

    const reference = resolved.configuration.credentialRef;
    if (
      reference === undefined
      && resolved.provider.credentialRequirement === "REQUIRED"
    ) {
      throw new ProviderControlPlaneError(
        "CREDENTIALS_REQUIRED",
        "Provider adapter factory requires a configured credential reference"
      );
    }

    const secretResolver = normalizeFactorySecretResolver(inspected.secretResolver, resolved);
    if (reference !== undefined && secretResolver === undefined) {
      throw new ProviderControlPlaneError(
        "CREDENTIALS_REQUIRED",
        "Provider adapter factory requires a runtime credential resolver"
      );
    }

    const normalizedInput = freezeNullPrototype({
      resolved,
      ...(secretResolver === undefined ? {} : { secretResolver }),
      ...(objectHasOwn(inspected, "runtime")
        ? { runtime: inspected.runtime }
        : {})
    }) satisfies ProviderAdapterFactoryInput;

    let adapter: ReasoningProvider;
    try {
      adapter = await this.#createAdapterImpl(normalizedInput);
    } catch (error) {
      if (
        isProviderControlPlaneError(error)
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

const isRegisteredProviderAdapterFactory = RegisteredProviderAdapterFactory.isRegistered;
const registeredProviderAdapterFactoryBelongsTo =
  RegisteredProviderAdapterFactory.belongsToProvider;

function normalizeFactory(
  factory: unknown,
  ownerProviderId: ProviderId | undefined
): ProviderAdapterFactory | undefined {
  if (factory === undefined) return undefined;
  if (isRegisteredProviderAdapterFactory(factory)) {
    if (
      ownerProviderId !== undefined
      && !registeredProviderAdapterFactoryBelongsTo(factory, ownerProviderId)
    ) {
      throw new ProviderControlPlaneError(
        "INVALID_ADAPTER_FACTORY",
        "Registered provider adapter factory belongs to a different provider"
      );
    }
    return factory;
  }
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
  return new RegisteredProviderAdapterFactory(
    REGISTERED_FACTORY_CONSTRUCTION_TOKEN,
    ownerProviderId,
    id.data,
    createAdapter
  );
}

const MODEL_CAPABILITY_KEYS = new Set([
  "inputModalities",
  "textStreaming",
  "structuredOutput",
  "persistentSession",
  "resumableSession",
  "cancellation",
  "sessionSurvivesClientAbort",
  "sessionSurvivesProviderCancel",
  "usageReporting",
  "reasoningLevels",
  "dataUse"
]);
const REQUIRED_MODEL_CAPABILITY_KEYS = [
  "inputModalities",
  "textStreaming",
  "structuredOutput",
  "persistentSession",
  "resumableSession",
  "cancellation",
  "sessionSurvivesClientAbort",
  "sessionSurvivesProviderCancel",
  "usageReporting",
  "dataUse"
] as const;

function readAdapterMember(
  value: object,
  key: string
): unknown {
  const seen = new Set<object>();
  let current: object | null = value;
  for (let depth = 0; depth < 16 && current !== null; depth += 1) {
    if (current === Object.prototype) return undefined;
    if (setHas(seen, current)) throw adapterDefinitionMismatch();
    setAdd(seen, current);

    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(current, key);
    } catch {
      throw adapterDefinitionMismatch();
    }
    if (descriptor !== undefined) {
      if ("value" in descriptor) {
        const member: unknown = descriptor.value;
        return member;
      }
      const getter = descriptor.get;
      if (getter === undefined) return undefined;
      try {
        const member: unknown = Reflect.apply(getter, value, []);
        return member;
      } catch {
        throw adapterDefinitionMismatch();
      }
    }
    try {
      current = Object.getPrototypeOf(current);
    } catch {
      throw adapterDefinitionMismatch();
    }
  }
  if (current !== null) throw adapterDefinitionMismatch();
  return undefined;
}

function snapshotAdapterCapabilities(value: unknown): unknown {
  if (typeof value !== "object" || value === null) {
    throw adapterDefinitionMismatch();
  }

  let descriptors: Readonly<Record<string, PropertyDescriptor>>;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw adapterDefinitionMismatch();
  }
  const descriptorKeys = Object.keys(descriptors);
  for (let index = 0; index < descriptorKeys.length; index += 1) {
    const key = descriptorKeys[index];
    if (key === undefined) continue;
    const descriptor = descriptors[key];
    if (
      descriptor !== undefined
      && descriptor.enumerable === true
      && !setHas(MODEL_CAPABILITY_KEYS, key)
    ) {
      throw adapterDefinitionMismatch();
    }
  }

  const snapshot: Record<string, unknown> = {};
  objectSetPrototypeOf(snapshot, null);
  for (let index = 0; index < REQUIRED_MODEL_CAPABILITY_KEYS.length; index += 1) {
    const key = REQUIRED_MODEL_CAPABILITY_KEYS[index];
    if (key === undefined) continue;
    snapshot[key] = readAdapterMember(value, key);
  }
  const reasoningLevels = readAdapterMember(value, "reasoningLevels");
  if (reasoningLevels !== undefined) {
    snapshot.reasoningLevels = reasoningLevels;
  }
  return objectFreeze(snapshot);
}

function supportMatchesBoolean(
  declared: CapabilitySupport,
  actual: boolean
): boolean {
  return declared === "UNKNOWN"
    || declared === (actual ? "SUPPORTED" : "UNSUPPORTED");
}

function runtimeDataUseMatchesProviderKind(
  kind: ProviderKind,
  dataUse: ModelCapabilities["dataUse"]
): boolean {
  if (kind === "REMOTE_API") return dataUse !== "LOCAL_ONLY";
  if (kind === "LOCAL_PROCESS") return dataUse === "LOCAL_ONLY";
  return true;
}

function sortedReasoningLevels(capabilities: ModelCapabilities): readonly string[] {
  return sortedCodeUnitStringCopy(capabilities.reasoningLevels ?? []);
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
    if (typeof adapter !== "object" || adapter === null) {
      throw adapterDefinitionMismatch();
    }
    const name = readAdapterMember(adapter, "name");
    const adapterVersion = readAdapterMember(adapter, "adapterVersion");
    const capabilities = readAdapterMember(adapter, "capabilities");
    const verifyBillingSafety = readAdapterMember(adapter, "verifyBillingSafety");
    const createSession = readAdapterMember(adapter, "createSession");
    if (
      name !== resolved.provider.id
      || adapterVersion !== resolved.provider.adapterVersion
      || typeof verifyBillingSafety !== "function"
      || typeof createSession !== "function"
    ) {
      throw adapterDefinitionMismatch();
    }

    const parsed = ModelCapabilitiesSchema.safeParse(
      snapshotAdapterCapabilities(capabilities)
    );
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
      reasoningMatches = declaredLevels === "UNKNOWN"
        ? executionReasoningLevels.length > 0
        : executionReasoningLevels.length > 0
          && readonlyStringArraysEqual(executionReasoningLevels, declaredLevels);
    }

    if (
      !supportMatchesBoolean(declared.imageInput, setHas(execution.inputModalities, "image"))
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
      || !runtimeDataUseMatchesProviderKind(resolved.provider.kind, execution.dataUse)
    ) {
      throw adapterDefinitionMismatch();
    }
  } catch (error) {
    if (isProviderControlPlaneError(error)) throw error;
    throw adapterDefinitionMismatch();
  }
}

function isCapabilityDeclarationConsistent(
  capabilities: ProviderModelCapabilities
): boolean {
  const levels = capabilities.reasoningLevels;
  if (capabilities.reasoningControls === "SUPPORTED") {
    if (
      levels !== "UNKNOWN"
      && (levels.length === 0 || hasDuplicateStrings(levels))
    ) {
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
      : objectFreeze(sortedCodeUnitStringCopy(capabilities.reasoningLevels));
  return freezeNullPrototype({ ...capabilities, reasoningLevels });
}

function freezeModel(model: ProviderModelDefinition): ProviderModelDefinition {
  return freezeNullPrototype({
    ...model,
    capabilities: freezeCapabilities(model.capabilities)
  });
}

function sortedFrozenModelCopy(
  values: readonly ProviderModelDefinition[]
): ProviderModelDefinition[] {
  const output: ProviderModelDefinition[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const source = values[index];
    if (source === undefined) {
      throw new ProviderControlPlaneError(
        "MALFORMED_DEFINITION",
        "Provider model list is malformed"
      );
    }
    const model = freezeModel(source);
    let insertionIndex = output.length;
    while (insertionIndex > 0) {
      const previous = output[insertionIndex - 1];
      if (previous === undefined || compareCodeUnits(previous.id, model.id) <= 0) break;
      output[insertionIndex] = previous;
      insertionIndex -= 1;
    }
    output[insertionIndex] = model;
  }
  return output;
}

function sortedProviderDefinitionCopy(
  values: readonly ProviderDefinition[]
): ProviderDefinition[] {
  const output: ProviderDefinition[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const provider = values[index];
    if (provider === undefined) {
      throw new ProviderControlPlaneError(
        "INVALID_REGISTRY",
        "Provider registry storage is invalid"
      );
    }
    let insertionIndex = output.length;
    while (insertionIndex > 0) {
      const previous = output[insertionIndex - 1];
      if (previous === undefined || compareCodeUnits(previous.id, provider.id) <= 0) break;
      output[insertionIndex] = previous;
      insertionIndex -= 1;
    }
    output[insertionIndex] = provider;
  }
  return output;
}

function defineProviderValue(input: unknown): ProviderDefinition {
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
  const ownerProviderIdResult = ProviderIdSchema.safeParse(inspected.id);
  const adapterFactory = normalizeFactory(
    inspected.adapterFactory,
    ownerProviderIdResult.success ? ownerProviderIdResult.data : undefined
  );
  const validateSettings = inspected.validateSettings;
  if (validateSettings !== undefined && typeof validateSettings !== "function") {
    throw new ProviderControlPlaneError(
      "MALFORMED_DEFINITION",
      "Provider definition is malformed"
    );
  }

  let metadataInput: SafeProviderConfigurationValue;
  try {
    metadataInput = inspectPlainProviderDefinitionValue({
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

  const adapterVersion = objectHasOwn(metadataResult.data, "adapterVersion")
    ? metadataResult.data.adapterVersion
    : undefined;
  if ((adapterFactory === undefined) !== (adapterVersion === undefined)) {
    throw new ProviderControlPlaneError(
      "MALFORMED_DEFINITION",
      "Executable provider definitions must pair an adapter factory with an adapter version"
    );
  }

  const credentialPurposes = metadataResult.data.credentialPurposes;
  if (
    hasDuplicateStrings(credentialPurposes)
    || (metadataResult.data.credentialRequirement === "NONE" && credentialPurposes.length !== 0)
    || (metadataResult.data.credentialRequirement !== "NONE" && credentialPurposes.length === 0)
  ) {
    throw new ProviderControlPlaneError(
      "MALFORMED_DEFINITION",
      "Provider credential declaration is inconsistent"
    );
  }

  const seenModelIds: ProviderModelId[] = [];
  for (let index = 0; index < metadataResult.data.models.length; index += 1) {
    const model = metadataResult.data.models[index];
    if (model === undefined) {
      throw new ProviderControlPlaneError(
        "MALFORMED_DEFINITION",
        "Provider model list is malformed"
      );
    }
    if (readonlyStringArrayContains(seenModelIds, model.id)) {
      throw new ProviderControlPlaneError(
        "DUPLICATE_MODEL",
        "Provider definition contains a duplicate model ID"
      );
    }
    seenModelIds[seenModelIds.length] = model.id;
    assertDefinitionCapabilitiesConsistent(model.capabilities);
    if (
      (metadataResult.data.kind === "REMOTE_API"
        && (
          model.capabilities.remoteExecution !== "SUPPORTED"
          || model.capabilities.localExecution !== "UNSUPPORTED"
          || model.capabilities.dataUse === "LOCAL_ONLY"
        ))
      || (metadataResult.data.kind === "LOCAL_PROCESS"
        && (
          model.capabilities.localExecution !== "SUPPORTED"
          || model.capabilities.remoteExecution !== "UNSUPPORTED"
          || (
            model.capabilities.dataUse !== "UNKNOWN"
            && model.capabilities.dataUse !== "LOCAL_ONLY"
          )
        ))
    ) {
      throw new ProviderControlPlaneError(
        "MALFORMED_DEFINITION",
        "Provider kind contradicts model execution capabilities"
      );
    }
  }

  const models = sortedFrozenModelCopy(metadataResult.data.models);

  return freezeNullPrototype({
    ...metadataResult.data,
    credentialPurposes: objectFreeze(sortedCodeUnitStringCopy(credentialPurposes)),
    models: objectFreeze(models),
    ...(adapterFactory === undefined ? {} : { adapterFactory }),
    ...(validateSettings === undefined
      ? {}
      : { validateSettings })
  });
}

export function defineProvider(input: ProviderDefinitionInput): ProviderDefinition {
  return defineProviderValue(input);
}

function snapshotProviderDefinitionInputs(
  inputs: readonly ProviderDefinitionInput[]
): readonly unknown[] {
  let descriptors: Readonly<Record<string, PropertyDescriptor>>;
  let symbols: readonly symbol[];
  try {
    if (!Array.isArray(inputs)) {
      throw new ProviderControlPlaneError(
        "MALFORMED_DEFINITION",
        "Provider registration batch is malformed"
      );
    }
    descriptors = Object.getOwnPropertyDescriptors(inputs);
    symbols = Object.getOwnPropertySymbols(inputs);
  } catch (error) {
    if (isProviderControlPlaneError(error)) throw error;
    throw new ProviderControlPlaneError(
      "MALFORMED_DEFINITION",
      "Provider registration batch is malformed"
    );
  }
  if (symbols.length > 0) {
    throw new ProviderControlPlaneError(
      "MALFORMED_DEFINITION",
      "Provider registration batch is malformed"
    );
  }
  const rawLength: unknown = descriptors.length?.value;
  if (
    typeof rawLength !== "number"
    || !Number.isSafeInteger(rawLength)
    || rawLength < 0
    || rawLength > 128
  ) {
    throw new ProviderControlPlaneError(
      "MALFORMED_DEFINITION",
      "Provider registration batch is malformed"
    );
  }
  const allowedKeys = new Set<string>(["length"]);
  const snapshot: unknown[] = [];
  for (let index = 0; index < rawLength; index += 1) {
    const key = String(index);
    setAdd(allowedKeys, key);
    const descriptor = descriptors[key];
    if (
      descriptor === undefined
      || descriptor.enumerable !== true
      || !("value" in descriptor)
    ) {
      throw new ProviderControlPlaneError(
        "MALFORMED_DEFINITION",
        "Provider registration batch is malformed"
      );
    }
    const item: unknown = descriptor.value;
    snapshot[index] = item;
  }
  if (objectHasUnknownOwnKeys(descriptors, allowedKeys)) {
    throw new ProviderControlPlaneError(
      "MALFORMED_DEFINITION",
      "Provider registration batch is malformed"
    );
  }
  return objectFreeze(snapshot);
}

export class ProviderRegistry {
  readonly #providers = new Map<ProviderId, ProviderDefinition>();

  public register(input: ProviderDefinitionInput): ProviderDefinition {
    const definition = defineProvider(input);
    this.#assertProviderIdAvailable(definition.id);
    providerMapSet(this.#providers, definition.id, definition);
    return definition;
  }

  public registerMany(inputs: readonly ProviderDefinitionInput[]): readonly ProviderDefinition[] {
    const snapshot = snapshotProviderDefinitionInputs(inputs);
    const definitions: ProviderDefinition[] = [];
    for (let index = 0; index < snapshot.length; index += 1) {
      definitions[index] = defineProviderValue(snapshot[index]);
    }

    const candidateIds: ProviderId[] = [];
    for (let index = 0; index < definitions.length; index += 1) {
      const definition = definitions[index];
      if (definition === undefined) {
        throw new ProviderControlPlaneError(
          "MALFORMED_DEFINITION",
          "Provider registration batch is malformed"
        );
      }
      if (readonlyStringArrayContains(candidateIds, definition.id)) {
        throw new ProviderControlPlaneError(
          "DUPLICATE_PROVIDER",
          "Provider ID is duplicated in the registration batch"
        );
      }
      candidateIds[candidateIds.length] = definition.id;
      this.#assertProviderIdAvailable(definition.id);
    }

    for (let index = 0; index < definitions.length; index += 1) {
      const definition = definitions[index];
      if (definition === undefined) {
        throw new ProviderControlPlaneError(
          "MALFORMED_DEFINITION",
          "Provider registration batch is malformed"
        );
      }
      providerMapSet(this.#providers, definition.id, definition);
    }
    return objectFreeze(definitions);
  }

  public enumerateProviders(): readonly ProviderDefinition[] {
    const values: ProviderDefinition[] = [];
    try {
      Reflect.apply(MAP_FOR_EACH_INTRINSIC, this.#providers, [
        (definition: ProviderDefinition, providerId: ProviderId) => {
          if (!isStoredProviderDefinition(definition, providerId)) {
            throw new ProviderControlPlaneError(
              "INVALID_REGISTRY",
              "Provider registry storage is invalid"
            );
          }
          values[values.length] = definition;
        }
      ]);
    } catch (error) {
      if (isProviderControlPlaneError(error)) throw error;
      throw new ProviderControlPlaneError(
        "INVALID_REGISTRY",
        "Provider registry storage is invalid"
      );
    }
    return objectFreeze(sortedProviderDefinitionCopy(values));
  }

  public enumerateModels(providerId: string): readonly ProviderModelDefinition[] {
    return this.#getProvider(providerId).models;
  }

  public getProvider(providerId: string): ProviderDefinition {
    return this.#getProvider(providerId);
  }

  public getModel(providerId: string, modelId: string): ProviderModelDefinition {
    return this.#getModel(this.#getProvider(providerId), modelId);
  }

  #getProvider(providerId: string): ProviderDefinition {
    const parsedId = ProviderIdSchema.safeParse(providerId);
    if (!parsedId.success) {
      throw new ProviderControlPlaneError("UNKNOWN_PROVIDER", "Provider is not registered");
    }
    const provider = providerMapGet(this.#providers, parsedId.data);
    if (provider === undefined) {
      throw new ProviderControlPlaneError("UNKNOWN_PROVIDER", "Provider is not registered");
    }
    return provider;
  }

  #getModel(provider: ProviderDefinition, modelId: string): ProviderModelDefinition {
    const parsedModelId = ProviderModelIdSchema.safeParse(modelId);
    if (!parsedModelId.success) {
      throw new ProviderControlPlaneError("UNKNOWN_MODEL", "Model is not registered");
    }
    for (let index = 0; index < provider.models.length; index += 1) {
      const model = provider.models[index];
      if (model !== undefined && model.id === parsedModelId.data) return model;
    }
    throw new ProviderControlPlaneError(
      "UNKNOWN_MODEL",
      "Model is not registered for provider"
    );
  }

  #assertProviderIdAvailable(providerId: ProviderId): void {
    if (providerMapHas(this.#providers, providerId)) {
      throw new ProviderControlPlaneError(
        "DUPLICATE_PROVIDER",
        "Provider ID is already registered"
      );
    }
  }
}

const providerRegistryGetProvider = ProviderRegistry.prototype.getProvider;
const providerRegistryGetModel = ProviderRegistry.prototype.getModel;

function resolveRegistrySelection(
  registry: unknown,
  providerId: string,
  modelId: string
): {
  readonly provider: ProviderDefinition;
  readonly model: ProviderModelDefinition;
} {
  if (typeof registry !== "object" || registry === null) {
    throw new ProviderControlPlaneError(
      "INVALID_REGISTRY",
      "Provider registry is invalid"
    );
  }
  try {
    const provider = Reflect.apply(providerRegistryGetProvider, registry, [providerId]);
    const model = Reflect.apply(providerRegistryGetModel, registry, [providerId, modelId]);
    return freezeNullPrototype({ provider, model });
  } catch (error) {
    if (isProviderControlPlaneError(error)) throw error;
    throw new ProviderControlPlaneError(
      "INVALID_REGISTRY",
      "Provider registry is invalid"
    );
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

function normalizeCapabilityRequirements(
  requirements: unknown
): readonly ProviderCapabilityKey[] {
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

  const uniqueRequirements: ProviderCapabilityKey[] = [];
  for (let index = 0; index < inspectedRequirements.length; index += 1) {
    const requirement = inspectedRequirements[index];
    const parsedRequirement = ProviderCapabilityKeySchema.safeParse(requirement);
    if (!parsedRequirement.success) {
      throw new ProviderControlPlaneError(
        "MALFORMED_REQUIREMENTS",
        "Provider capability requirements are malformed"
      );
    }
    if (!readonlyStringArrayContains(uniqueRequirements, parsedRequirement.data)) {
      uniqueRequirements[uniqueRequirements.length] = parsedRequirement.data;
    }
  }
  return objectFreeze(sortedCodeUnitStringCopy(uniqueRequirements));
}

interface CapturedCapabilityRequirements {
  readonly valid: boolean;
  readonly value: readonly ProviderCapabilityKey[];
}

function captureCapabilityRequirements(
  requirements: unknown
): CapturedCapabilityRequirements {
  try {
    return freezeNullPrototype({
      valid: true,
      value: normalizeCapabilityRequirements(requirements)
    });
  } catch {
    const empty: ProviderCapabilityKey[] = [];
    return freezeNullPrototype({
      valid: false,
      value: objectFreeze(empty)
    });
  }
}

function requireCapturedCapabilityRequirements(
  captured: CapturedCapabilityRequirements
): readonly ProviderCapabilityKey[] {
  if (!captured.valid) {
    throw new ProviderControlPlaneError(
      "MALFORMED_REQUIREMENTS",
      "Provider capability requirements are malformed"
    );
  }
  return captured.value;
}

function matchNormalizedCapabilityRequirements(
  capabilities: ProviderModelCapabilities,
  normalized: readonly ProviderCapabilityKey[]
): CapabilityMatchResult {
  const unsupported: ProviderCapabilityKey[] = [];
  const unknown: ProviderCapabilityKey[] = [];
  for (let index = 0; index < normalized.length; index += 1) {
    const requirement = normalized[index];
    if (requirement === undefined) continue;
    const support = supportForCapability(capabilities, requirement);
    if (support === "UNSUPPORTED") unsupported[unsupported.length] = requirement;
    if (support === "UNKNOWN") unknown[unknown.length] = requirement;
  }
  return freezeNullPrototype({
    compatible: unsupported.length === 0 && unknown.length === 0,
    unsupported: objectFreeze(unsupported),
    unknown: objectFreeze(unknown)
  });
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
  return matchNormalizedCapabilityRequirements(
    parsedCapabilities.data,
    normalizeCapabilityRequirements(requirements)
  );
}

function zodIssuesContainSecret(
  issues: readonly { readonly message: string }[]
): boolean {
  for (let index = 0; index < issues.length; index += 1) {
    if (issues[index]?.message === "SECRET_IN_CONFIGURATION") return true;
  }
  return false;
}

function parseConfiguration(value: unknown): ProviderConfiguration {
  const parsed = ProviderConfigurationSchema.safeParse(value);
  if (!parsed.success) {
    const containsSecret = zodIssuesContainSecret(parsed.error.issues);
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
    const containsSecret = zodIssuesContainSecret(parsed.error.issues);
    throw new ProviderControlPlaneError(
      containsSecret ? "SECRET_IN_CONFIGURATION" : "MALFORMED_CONFIGURATION",
      containsSecret
        ? "Provider configuration contains credential-like material"
        : "Provider-specific settings are malformed"
    );
  }
  return parsed.data;
}

function readonlyStringArrayContains(
  values: readonly string[],
  target: string
): boolean {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === target) return true;
  }
  return false;
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
  if (
    reference !== undefined
    && !readonlyStringArrayContains(provider.credentialPurposes, reference.purpose)
  ) {
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
  if (model.capabilities.reasoningControls === "UNKNOWN") {
    throw new ProviderControlPlaneError(
      "CAPABILITY_STATUS_UNKNOWN",
      "Configured model reasoning-control support is unknown"
    );
  }
  if (model.capabilities.reasoningControls === "UNSUPPORTED") {
    throw new ProviderControlPlaneError(
      "INCOMPATIBLE_CAPABILITY",
      "Configured model does not support reasoning controls"
    );
  }
  const levels = model.capabilities.reasoningLevels;
  if (levels === "UNKNOWN") {
    throw new ProviderControlPlaneError(
      "CAPABILITY_STATUS_UNKNOWN",
      "Configured model reasoning levels are unknown"
    );
  }
  if (!readonlyStringArrayContains(levels, reasoning.level)) {
    throw new ProviderControlPlaneError(
      "INCOMPATIBLE_CAPABILITY",
      "Configured model does not support the requested reasoning level"
    );
  }
}

function assertTrustedResolvedConfiguration(
  resolved: unknown
): asserts resolved is ResolvedProviderConfigurationValue {
  if (!isResolvedProviderConfiguration(resolved)) {
    throw new ProviderControlPlaneError(
      "INVALID_FACTORY_INPUT",
      "Provider adapter factory requires a control-plane resolution"
    );
  }
}

function resolveParsedProviderConfiguration(input: {
  readonly registry: unknown;
  readonly configuration: ProviderConfiguration;
  readonly requirements?: CapturedCapabilityRequirements;
}): ResolvedProviderConfiguration {
  const { provider, model } = resolveRegistrySelection(
    input.registry,
    input.configuration.providerId,
    input.configuration.modelId
  );
  const settings = validateProviderSettings(provider, input.configuration.settings);
  const configuration = settings === input.configuration.settings
    ? input.configuration
    : freezeNullPrototype({ ...input.configuration, ...(settings === undefined ? {} : { settings }) });

  validateCredentialReference(provider, configuration.credentialRef);
  validateReasoningConfiguration(model, configuration.reasoning);
  const match = matchNormalizedCapabilityRequirements(
    model.capabilities,
    input.requirements === undefined
      ? []
      : requireCapturedCapabilityRequirements(input.requirements)
  );
  if (match.unsupported.length > 0) {
    throw new ProviderControlPlaneError(
      "INCOMPATIBLE_CAPABILITY",
      "Configured model does not support required capabilities"
    );
  }
  if (match.unknown.length > 0) {
    throw new ProviderControlPlaneError(
      "CAPABILITY_STATUS_UNKNOWN",
      "Configured model required capabilities are unknown"
    );
  }
  return new ResolvedProviderConfigurationValue(
    RESOLUTION_CONSTRUCTION_TOKEN,
    configuration,
    provider,
    model
  );
}

export function resolveProviderConfiguration(input: {
  readonly registry: ProviderRegistry;
  readonly configuration: unknown;
  readonly requirements?: readonly ProviderCapabilityKey[];
}): ResolvedProviderConfiguration {
  assertNoUnknownOwnOperationFields(
    input,
    RESOLUTION_INPUT_KEYS,
    "MALFORMED_CONFIGURATION",
    "Provider resolution input is malformed"
  );
  const configurationProperty = readOwnDataProperty(
    input,
    "configuration",
    "MALFORMED_CONFIGURATION",
    "Provider resolution input is malformed"
  );
  const parsed = parseConfiguration(configurationProperty.value);
  if (!parsed.enabled) {
    throw new ProviderControlPlaneError("DISABLED", "Configured provider is disabled");
  }

  const registryProperty = readOwnDataProperty(
    input,
    "registry",
    "INVALID_REGISTRY",
    "Provider registry is invalid"
  );
  const requirementsProperty = readOwnDataProperty(
    input,
    "requirements",
    "MALFORMED_REQUIREMENTS",
    "Provider capability requirements are malformed"
  );
  const requirements = requirementsProperty.present
    ? captureCapabilityRequirements(requirementsProperty.value)
    : undefined;
  return resolveParsedProviderConfiguration({
    registry: registryProperty.value,
    configuration: parsed,
    ...(requirements === undefined ? {} : { requirements })
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
    assertNoUnknownOwnOperationFields(
      input,
      READINESS_INPUT_KEYS,
      "MALFORMED_CONFIGURATION",
      "Provider readiness input is malformed"
    );
    const configurationProperty = readOwnDataProperty(
      input,
      "configuration",
      "MALFORMED_CONFIGURATION",
      "Provider readiness input is malformed"
    );
    parsed = parseConfiguration(configurationProperty.value);
  } catch (error) {
    return freezeNullPrototype({
      state: "MISCONFIGURED",
      reason: isProviderControlPlaneError(error)
        ? error.code
        : "MALFORMED_CONFIGURATION"
    });
  }

  let registry: unknown;
  try {
    registry = readOwnDataProperty(
      input,
      "registry",
      "INVALID_REGISTRY",
      "Provider registry is invalid"
    ).value;
  } catch (error) {
    return freezeNullPrototype({
      state: "MISCONFIGURED",
      providerId: parsed.providerId,
      modelId: parsed.modelId,
      reason: isProviderControlPlaneError(error)
        ? error.code
        : "INVALID_REGISTRY"
    });
  }

  let requirements: CapturedCapabilityRequirements | undefined;
  try {
    const requirementsProperty = readOwnDataProperty(
      input,
      "requirements",
      "MALFORMED_REQUIREMENTS",
      "Provider capability requirements are malformed"
    );
    requirements = requirementsProperty.present
      ? captureCapabilityRequirements(requirementsProperty.value)
      : undefined;
  } catch {
    return freezeNullPrototype({
      state: "MISCONFIGURED",
      providerId: parsed.providerId,
      modelId: parsed.modelId,
      reason: "MALFORMED_REQUIREMENTS"
    });
  }

  let resolved: ResolvedProviderConfiguration;
  try {
    resolved = resolveParsedProviderConfiguration({
      registry,
      configuration: parsed
    });
  } catch (error) {
    const reason = isProviderControlPlaneError(error)
      ? error.code
      : "MALFORMED_CONFIGURATION";
    return freezeNullPrototype({
      state: reason === "CAPABILITY_STATUS_UNKNOWN" ? "UNKNOWN" : "MISCONFIGURED",
      providerId: parsed.providerId,
      modelId: parsed.modelId,
      reason
    });
  }

  if (requirements !== undefined) {
    let match: CapabilityMatchResult;
    try {
      match = matchNormalizedCapabilityRequirements(
        resolved.model.capabilities,
        requireCapturedCapabilityRequirements(requirements)
      );
    } catch (error) {
      return freezeNullPrototype({
        state: "MISCONFIGURED",
        providerId: resolved.provider.id,
        modelId: resolved.model.id,
        reason: isProviderControlPlaneError(error)
          ? error.code
          : "MALFORMED_REQUIREMENTS"
      });
    }
    if (match.unsupported.length > 0) {
      return freezeNullPrototype({
        state: "MISCONFIGURED",
        providerId: resolved.provider.id,
        modelId: resolved.model.id,
        reason: "INCOMPATIBLE_CAPABILITY"
      });
    }
    if (match.unknown.length > 0) {
      return freezeNullPrototype({
        state: "UNKNOWN",
        providerId: resolved.provider.id,
        modelId: resolved.model.id,
        reason: "CAPABILITY_STATUS_UNKNOWN"
      });
    }
  }

  if (!resolved.configuration.enabled) {
    return freezeNullPrototype({
      state: "DISABLED",
      providerId: resolved.provider.id,
      modelId: resolved.model.id
    });
  }

  if (resolved.provider.adapterFactory === undefined) {
    return freezeNullPrototype({
      state: "UNAVAILABLE",
      providerId: resolved.provider.id,
      modelId: resolved.model.id,
      reason: "ADAPTER_FACTORY_UNAVAILABLE"
    });
  }

  const reference = resolved.configuration.credentialRef;
  if (
    reference === undefined
    && resolved.provider.credentialRequirement === "REQUIRED"
  ) {
    return freezeNullPrototype({
      state: "CREDENTIALS_REQUIRED",
      providerId: resolved.provider.id,
      modelId: resolved.model.id
    });
  }

  let secretResolver: ProviderSecretResolver | undefined;
  try {
    const secretResolverProperty = readOwnDataProperty(
      input,
      "secretResolver",
      "INVALID_FACTORY_INPUT",
      "Provider readiness credential resolver is malformed"
    );
    secretResolver = normalizeFactorySecretResolver(
      secretResolverProperty.present ? secretResolverProperty.value : undefined,
      resolved
    );
  } catch {
    return freezeNullPrototype({
      state: "UNKNOWN",
      providerId: resolved.provider.id,
      modelId: resolved.model.id,
      reason: "CREDENTIAL_STATUS_UNKNOWN"
    });
  }

  if (reference !== undefined) {
    const hasSecret = secretResolver?.hasSecret;
    if (
      typeof hasSecret !== "function"
      || typeof secretResolver?.resolveSecret !== "function"
    ) {
      return freezeNullPrototype({
        state: "UNKNOWN",
        providerId: resolved.provider.id,
        modelId: resolved.model.id,
        reason: "CREDENTIAL_STATUS_UNKNOWN"
      });
    }
    let available: unknown;
    try {
      available = await Reflect.apply(hasSecret, secretResolver, [freezeNullPrototype({
        providerId: resolved.provider.id,
        reference
      })]);
    } catch {
      return freezeNullPrototype({
        state: "UNKNOWN",
        providerId: resolved.provider.id,
        modelId: resolved.model.id,
        reason: "CREDENTIAL_STATUS_UNKNOWN"
      });
    }
    if (typeof available !== "boolean") {
      return freezeNullPrototype({
        state: "UNKNOWN",
        providerId: resolved.provider.id,
        modelId: resolved.model.id,
        reason: "CREDENTIAL_STATUS_UNKNOWN"
      });
    }
    if (!available) {
      return freezeNullPrototype({
        state: "CREDENTIALS_REQUIRED",
        providerId: resolved.provider.id,
        modelId: resolved.model.id
      });
    }
  }

  return freezeNullPrototype({
    state: "AVAILABLE",
    providerId: resolved.provider.id,
    modelId: resolved.model.id
  });
}

export function toPersistableProviderConfiguration(
  value: unknown
): PersistableProviderConfiguration {
  const parsed = parseConfiguration(value);
  return freezeNullPrototype({
    version: 1,
    providerId: parsed.providerId,
    modelId: parsed.modelId,
    enabled: parsed.enabled,
    ...(parsed.reasoning === undefined
      ? {}
      : { reasoning: freezeNullPrototype({ ...parsed.reasoning }) }),
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
    let output = "[";
    for (let index = 0; index < value.length; index += 1) {
      if (index > 0) output += ",";
      const item = value[index];
      if (item === undefined) {
        throw new ProviderControlPlaneError(
          "MALFORMED_CONFIGURATION",
          "Provider configuration is malformed"
        );
      }
      output += canonicalizeSafeValue(item);
    }
    return output + "]";
  }

  const keys = sortedCodeUnitStringCopy(Object.keys(value));
  let output = "{";
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (key === undefined) continue;
    const item = value[key];
    if (item === undefined) {
      throw new ProviderControlPlaneError(
        "MALFORMED_CONFIGURATION",
        "Provider configuration is malformed"
      );
    }
    if (index > 0) output += ",";
    output += JSON.stringify(key) + ":" + canonicalizeSafeValue(item);
  }
  return output + "}";
}

export function createProviderConfigurationFingerprintMaterial(value: unknown): string {
  const parsed = parseConfiguration(value);
  const persistable = toPersistableProviderConfiguration(parsed);
  const material: SafeProviderConfigurationRecord = {
    version: persistable.version,
    providerId: persistable.providerId,
    modelId: persistable.modelId,
    enabled: persistable.enabled,
    ...(parsed.credentialRef === undefined
      ? {}
      : { credentialPurpose: parsed.credentialRef.purpose }),
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
  return freezeNullPrototype({
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
