import {
  DataUsePolicySchema,
  ProviderLaunchOptionSchema,
  type InterviewerProposal,
  type ProviderLaunchAvailabilityReason,
  type ProviderLaunchOption,
  type ProviderPolicy,
  type ProviderSelectionReference,
  type ReasoningProvider
} from "../../../packages/domain/src/index.js";
import {
  ProviderControlPlaneError,
  evaluateProviderReadiness,
  registerBuiltInProviders,
  resolveAdapterFactory,
  resolveProviderConfiguration,
  type ProviderControlPlaneErrorCode,
  type ProviderRegistry,
  type ProviderSecretResolver
} from "../../../packages/providers/src/index.js";

const REFLECT_APPLY_INTRINSIC = Reflect.apply;
const RUNTIME_CONFIGURATION_KEYS = new Set([
  "enabled",
  "reasoning",
  "settings",
  "credentialRef"
]);
const POLICY_KEYS = new Set([
  "allowMeteredUsage",
  "maximumDataUse",
  "billingVerificationMaxAgeMs"
]);
const SELECTION_KEYS = new Set(["providerId", "modelId"]);

export const DEFAULT_PROVIDER_SELECTION: ProviderSelectionReference = Object.freeze({
  providerId: "mock-model",
  modelId: "mock-default"
});

export const DEFAULT_PROVIDER_RUNTIME_POLICY: ProviderPolicy = Object.freeze({
  allowMeteredUsage: false,
  maximumDataUse: "LOCAL_ONLY",
  billingVerificationMaxAgeMs: 60_000
});

export interface ProviderRuntimeConfigurationSource {
  readonly resolveConfiguration: (
    selection: ProviderSelectionReference
  ) => unknown;
}

export interface ProviderAdapterRuntimeSource {
  readonly resolveRuntime: (
    selection: ProviderSelectionReference
  ) => unknown;
}

export interface ProviderRuntimePolicySource {
  readonly resolvePolicy: (
    selection: ProviderSelectionReference
  ) => unknown;
}

export interface ProviderRuntimeResolverOptions {
  readonly registry?: ProviderRegistry;
  readonly configurationSource?: ProviderRuntimeConfigurationSource;
  readonly adapterRuntimeSource?: ProviderAdapterRuntimeSource;
  readonly secretResolver?: ProviderSecretResolver;
  readonly policySource?: ProviderRuntimePolicySource;
}

export interface ProviderRuntimeResolution {
  readonly providerId: string;
  readonly modelId: string;
  readonly provider: ReasoningProvider;
  readonly policy: ProviderPolicy;
}

export type ProviderRuntimeResolutionErrorCode =
  | ProviderControlPlaneErrorCode
  | "RUNTIME_CONFIGURATION_FAILED"
  | "RUNTIME_DEPENDENCY_FAILED"
  | "POLICY_RESOLUTION_FAILED"
  | "MOCK_PROPOSAL_REQUIRED"
  | "RUNTIME_RESOLUTION_CANCELLED";

export class ProviderRuntimeResolutionError extends Error {
  public constructor(public readonly code: ProviderRuntimeResolutionErrorCode) {
    super(providerRuntimeResolutionErrorMessage(code));
    this.name = "ProviderRuntimeResolutionError";
  }
}

type RuntimeSourceOperation = (selection: ProviderSelectionReference) => unknown;

interface CapturedRuntimeSourceOperation {
  readonly receiver: object;
  readonly operation: RuntimeSourceOperation;
}

export class ProviderRuntimeResolver {
  private readonly registry: ProviderRegistry;
  private readonly configurationOperation: CapturedRuntimeSourceOperation | undefined;
  private readonly adapterRuntimeOperation: CapturedRuntimeSourceOperation | undefined;
  private readonly secretResolver: ProviderSecretResolver | undefined;
  private readonly policyOperation: CapturedRuntimeSourceOperation | undefined;

  public constructor(options: ProviderRuntimeResolverOptions = {}) {
    this.registry = options.registry ?? registerBuiltInProviders();
    this.configurationOperation = captureRuntimeSourceOperation(
      options.configurationSource,
      "resolveConfiguration",
      "RUNTIME_CONFIGURATION_FAILED"
    );
    this.adapterRuntimeOperation = captureRuntimeSourceOperation(
      options.adapterRuntimeSource,
      "resolveRuntime",
      "RUNTIME_DEPENDENCY_FAILED"
    );
    this.secretResolver = options.secretResolver;
    this.policyOperation = captureRuntimeSourceOperation(
      options.policySource,
      "resolvePolicy",
      "POLICY_RESOLUTION_FAILED"
    );
  }

  public async listLaunchOptions(): Promise<readonly ProviderLaunchOption[]> {
    const options: ProviderLaunchOption[] = [];
    for (const provider of this.registry.enumerateProviders()) {
      for (const model of provider.models) {
        options.push(await this.evaluateLaunchOption({
          providerId: provider.id,
          modelId: model.id
        }));
      }
    }
    return Object.freeze(options);
  }

  public async evaluateLaunchOption(
    inputSelection?: ProviderSelectionReference
  ): Promise<ProviderLaunchOption> {
    const selection = snapshotProviderSelection(inputSelection);
    let provider;
    let model;
    try {
      provider = this.registry.getProvider(selection.providerId);
      model = this.registry.getModel(selection.providerId, selection.modelId);
    } catch {
      return unavailableLaunchOption(selection, "PROVIDER_UNAVAILABLE");
    }

    const base = {
      providerId: provider.id,
      providerDisplayName: provider.displayName,
      providerKind: provider.kind,
      modelId: model.id,
      modelDisplayName: model.displayName
    } as const;

    let runtimeConfiguration: unknown;
    try {
      runtimeConfiguration = await invokeRuntimeSource(this.configurationOperation, selection);
    } catch {
      return ProviderLaunchOptionSchema.parse({
        ...base,
        availability: "UNAVAILABLE",
        reason: "RUNTIME_CONFIGURATION_UNAVAILABLE"
      });
    }

    const configuration = composeProviderConfiguration(selection, runtimeConfiguration);
    const readiness = await evaluateProviderReadiness({
      registry: this.registry,
      configuration,
      ...(this.secretResolver === undefined ? {} : { secretResolver: this.secretResolver }),
      requirements: ["TEXT_GENERATION"]
    });
    if (readiness.state !== "AVAILABLE") {
      return ProviderLaunchOptionSchema.parse({
        ...base,
        availability: "UNAVAILABLE",
        reason: mapReadinessReason(readiness.state)
      });
    }

    let policy: ProviderPolicy;
    try {
      policy = snapshotProviderPolicy(
        this.policyOperation === undefined
          ? DEFAULT_PROVIDER_RUNTIME_POLICY
          : await invokeRuntimeSource(this.policyOperation, selection)
      );
    } catch {
      return ProviderLaunchOptionSchema.parse({
        ...base,
        availability: "UNAVAILABLE",
        reason: "POLICY_UNAVAILABLE"
      });
    }

    if (!providerModelFitsPolicy(model.capabilities, policy)) {
      return ProviderLaunchOptionSchema.parse({
        ...base,
        availability: "UNAVAILABLE",
        reason: "POLICY_DENIED"
      });
    }

    if (!(selection.providerId === "mock-model" && selection.modelId === "mock-default")) {
      try {
        await invokeRuntimeSource(this.adapterRuntimeOperation, selection);
      } catch {
        return ProviderLaunchOptionSchema.parse({
          ...base,
          availability: "UNAVAILABLE",
          reason: "RUNTIME_DEPENDENCY_UNAVAILABLE"
        });
      }
    }

    return ProviderLaunchOptionSchema.parse({
      ...base,
      availability: "AVAILABLE"
    });
  }

  public async resolve(input: {
    readonly selection?: ProviderSelectionReference;
    readonly mockProposal?: InterviewerProposal;
    readonly cancellationRequested?: () => boolean;
  }): Promise<ProviderRuntimeResolution> {
    assertRuntimeResolutionActive(input.cancellationRequested);
    const selection = snapshotProviderSelection(input.selection);

    let runtimeConfiguration: unknown;
    try {
      runtimeConfiguration = await invokeRuntimeSource(
        this.configurationOperation,
        selection
      );
    } catch {
      throw new ProviderRuntimeResolutionError("RUNTIME_CONFIGURATION_FAILED");
    }

    assertRuntimeResolutionActive(input.cancellationRequested);
    const configuration = composeProviderConfiguration(selection, runtimeConfiguration);
    let resolved: ReturnType<typeof resolveProviderConfiguration>;
    try {
      resolved = resolveProviderConfiguration({
        registry: this.registry,
        configuration,
        requirements: ["TEXT_GENERATION"]
      });
    } catch (error) {
      throw controlPlaneResolutionError(error);
    }

    // Resolve and validate the application safety policy before touching
    // adapter-specific runtime dependencies or credential material.
    let rawPolicy: unknown;
    try {
      rawPolicy = this.policyOperation === undefined
        ? DEFAULT_PROVIDER_RUNTIME_POLICY
        : await invokeRuntimeSource(this.policyOperation, selection);
    } catch {
      throw new ProviderRuntimeResolutionError("POLICY_RESOLUTION_FAILED");
    }
    assertRuntimeResolutionActive(input.cancellationRequested);
    const policy = snapshotProviderPolicy(rawPolicy);

    let runtime: unknown;
    if (selection.providerId === "mock-model" && selection.modelId === "mock-default") {
      if (input.mockProposal === undefined) {
        throw new ProviderRuntimeResolutionError("MOCK_PROPOSAL_REQUIRED");
      }
      runtime = Object.freeze({ proposal: input.mockProposal });
    } else {
      try {
        runtime = await invokeRuntimeSource(this.adapterRuntimeOperation, selection);
      } catch {
        throw new ProviderRuntimeResolutionError("RUNTIME_DEPENDENCY_FAILED");
      }
    }

    assertRuntimeResolutionActive(input.cancellationRequested);

    let provider: ReasoningProvider;
    try {
      const factory = resolveAdapterFactory(resolved);
      provider = await factory.createAdapter({
        resolved,
        ...(this.secretResolver === undefined ? {} : { secretResolver: this.secretResolver }),
        ...(runtime === undefined ? {} : { runtime })
      });
    } catch (error) {
      throw controlPlaneResolutionError(error);
    }

    assertRuntimeResolutionActive(input.cancellationRequested);
    return Object.freeze({
      providerId: resolved.provider.id,
      modelId: resolved.model.id,
      provider,
      policy
    });
  }
}

function assertRuntimeResolutionActive(
  cancellationRequested: (() => boolean) | undefined
): void {
  if (cancellationRequested === undefined) return;
  let cancelled: boolean;
  try {
    cancelled = cancellationRequested();
  } catch {
    throw new ProviderRuntimeResolutionError("RUNTIME_RESOLUTION_CANCELLED");
  }
  if (cancelled) {
    throw new ProviderRuntimeResolutionError("RUNTIME_RESOLUTION_CANCELLED");
  }
}

function captureRuntimeSourceOperation(
  source: object | undefined,
  key: string,
  errorCode:
    | "RUNTIME_CONFIGURATION_FAILED"
    | "RUNTIME_DEPENDENCY_FAILED"
    | "POLICY_RESOLUTION_FAILED"
): CapturedRuntimeSourceOperation | undefined {
  if (source === undefined) return undefined;

  let current: object | null = source;
  for (let depth = 0; depth < 16 && current !== null; depth += 1) {
    if (current === Object.prototype) break;

    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(current, key);
    } catch {
      throw new ProviderRuntimeResolutionError(errorCode);
    }
    if (descriptor !== undefined) {
      if (!("value" in descriptor) || typeof descriptor.value !== "function") {
        throw new ProviderRuntimeResolutionError(errorCode);
      }
      return Object.freeze({
        receiver: source,
        operation: descriptor.value as RuntimeSourceOperation
      });
    }

    try {
      const prototypeCandidate: unknown = Object.getPrototypeOf(current);
      if (prototypeCandidate !== null && typeof prototypeCandidate !== "object") {
        throw new ProviderRuntimeResolutionError(errorCode);
      }
      current = prototypeCandidate;
    } catch {
      throw new ProviderRuntimeResolutionError(errorCode);
    }
  }

  throw new ProviderRuntimeResolutionError(errorCode);
}

async function invokeRuntimeSource(
  operation: CapturedRuntimeSourceOperation | undefined,
  selection: ProviderSelectionReference
): Promise<unknown> {
  if (operation === undefined) return undefined;
  return await REFLECT_APPLY_INTRINSIC(
    operation.operation,
    operation.receiver,
    [selection]
  );
}

function snapshotProviderSelection(
  value: ProviderSelectionReference | undefined
): ProviderSelectionReference {
  if (value === undefined) return DEFAULT_PROVIDER_SELECTION;
  const snapshot = snapshotPlainOwnDataRecord(
    value,
    SELECTION_KEYS,
    "MALFORMED_CONFIGURATION"
  );
  const providerId = snapshot.providerId;
  const modelId = snapshot.modelId;
  if (typeof providerId !== "string" || typeof modelId !== "string") {
    throw new ProviderRuntimeResolutionError("MALFORMED_CONFIGURATION");
  }
  return Object.freeze({ providerId, modelId });
}

function composeProviderConfiguration(
  selection: ProviderSelectionReference,
  runtimeConfiguration: unknown
): unknown {
  const extras = snapshotRuntimeConfiguration(runtimeConfiguration);
  const configuration: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  configuration.version = 1;
  configuration.providerId = selection.providerId;
  configuration.modelId = selection.modelId;
  configuration.enabled = "enabled" in extras ? extras.enabled : true;
  if (extras.reasoning !== undefined) configuration.reasoning = extras.reasoning;
  if (extras.settings !== undefined) configuration.settings = extras.settings;
  if (extras.credentialRef !== undefined) configuration.credentialRef = extras.credentialRef;
  return Object.freeze(configuration);
}

function snapshotRuntimeConfiguration(value: unknown): {
  readonly enabled?: unknown;
  readonly reasoning?: unknown;
  readonly settings?: unknown;
  readonly credentialRef?: unknown;
} {
  if (value === undefined) return Object.freeze({});
  return snapshotPlainOwnDataRecord(
    value,
    RUNTIME_CONFIGURATION_KEYS,
    "RUNTIME_CONFIGURATION_FAILED"
  );
}

function snapshotProviderPolicy(value: unknown): ProviderPolicy {
  const descriptors = inspectPlainOwnDataRecord(
    value,
    POLICY_KEYS,
    "POLICY_RESOLUTION_FAILED"
  );

  const allowMeteredUsage = readRequiredDataProperty(
    descriptors,
    "allowMeteredUsage",
    "POLICY_RESOLUTION_FAILED"
  );
  const maximumDataUse = readRequiredDataProperty(
    descriptors,
    "maximumDataUse",
    "POLICY_RESOLUTION_FAILED"
  );
  const billingVerificationMaxAgeMs = readRequiredDataProperty(
    descriptors,
    "billingVerificationMaxAgeMs",
    "POLICY_RESOLUTION_FAILED"
  );
  const parsedDataUse = DataUsePolicySchema.safeParse(maximumDataUse);
  if (
    typeof allowMeteredUsage !== "boolean"
    || !parsedDataUse.success
    || typeof billingVerificationMaxAgeMs !== "number"
    || !Number.isFinite(billingVerificationMaxAgeMs)
    || billingVerificationMaxAgeMs <= 0
  ) {
    throw new ProviderRuntimeResolutionError("POLICY_RESOLUTION_FAILED");
  }

  return Object.freeze({
    allowMeteredUsage,
    maximumDataUse: parsedDataUse.data,
    billingVerificationMaxAgeMs
  });
}

function snapshotPlainOwnDataRecord(
  value: unknown,
  allowedKeys: ReadonlySet<string>,
  errorCode: ProviderRuntimeResolutionErrorCode
): Readonly<Record<string, unknown>> {
  const descriptors = inspectPlainOwnDataRecord(value, allowedKeys, errorCode);
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(descriptors)) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new ProviderRuntimeResolutionError(errorCode);
    }
    output[key] = descriptor.value;
  }
  return Object.freeze(output);
}

function inspectPlainOwnDataRecord(
  value: unknown,
  allowedKeys: ReadonlySet<string>,
  errorCode: ProviderRuntimeResolutionErrorCode
): Readonly<Record<string, PropertyDescriptor>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProviderRuntimeResolutionError(errorCode);
  }

  let descriptors: Readonly<Record<string, PropertyDescriptor>>;
  let symbols: readonly symbol[];
  let prototype: object | null;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
    symbols = Object.getOwnPropertySymbols(value);
    const prototypeCandidate: unknown = Object.getPrototypeOf(value);
    if (prototypeCandidate !== null && typeof prototypeCandidate !== "object") {
      throw new ProviderRuntimeResolutionError(errorCode);
    }
    prototype = prototypeCandidate;
  } catch {
    throw new ProviderRuntimeResolutionError(errorCode);
  }

  if (
    symbols.length !== 0
    || (prototype !== Object.prototype && prototype !== null)
  ) {
    throw new ProviderRuntimeResolutionError(errorCode);
  }

  for (const key of Object.keys(descriptors)) {
    const descriptor = descriptors[key];
    if (
      !allowedKeys.has(key)
      || descriptor === undefined
      || descriptor.enumerable !== true
      || !("value" in descriptor)
    ) {
      throw new ProviderRuntimeResolutionError(errorCode);
    }
  }
  return descriptors;
}

function readRequiredDataProperty(
  descriptors: Readonly<Record<string, PropertyDescriptor>>,
  key: string,
  errorCode: ProviderRuntimeResolutionErrorCode
): unknown {
  const descriptor = descriptors[key];
  if (descriptor === undefined || !("value" in descriptor)) {
    throw new ProviderRuntimeResolutionError(errorCode);
  }
  return descriptor.value;
}

function controlPlaneResolutionError(error: unknown): ProviderRuntimeResolutionError {
  if (ProviderControlPlaneError.isControlPlaneError(error)) {
    return new ProviderRuntimeResolutionError(error.code);
  }
  return new ProviderRuntimeResolutionError("ADAPTER_FACTORY_FAILED");
}

function providerRuntimeResolutionErrorMessage(
  code: ProviderRuntimeResolutionErrorCode
): string {
  switch (code) {
    case "RUNTIME_CONFIGURATION_FAILED":
      return "Provider runtime configuration could not be resolved";
    case "RUNTIME_DEPENDENCY_FAILED":
      return "Provider runtime dependencies could not be resolved";
    case "POLICY_RESOLUTION_FAILED":
      return "Provider runtime policy could not be resolved";
    case "MOCK_PROPOSAL_REQUIRED":
      return "Mock provider execution requires an application-owned proposal";
    case "RUNTIME_RESOLUTION_CANCELLED":
      return "Provider runtime resolution was cancelled";
    default:
      return "Provider runtime resolution failed";
  }
}
