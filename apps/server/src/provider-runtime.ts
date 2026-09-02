import {
  DataUsePolicySchema,
  type InterviewerProposal,
  type ProviderPolicy,
  type ProviderSelectionReference,
  type ReasoningProvider
} from "../../../packages/domain/src/index.js";
import {
  ProviderControlPlaneError,
  registerBuiltInProviders,
  resolveAdapterFactory,
  resolveProviderConfiguration,
  type ProviderControlPlaneErrorCode,
  type ProviderRegistry,
  type ProviderSecretResolver
} from "../../../packages/providers/src/index.js";

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
  ) => unknown | Promise<unknown>;
}

export interface ProviderAdapterRuntimeSource {
  readonly resolveRuntime: (
    selection: ProviderSelectionReference
  ) => unknown | Promise<unknown>;
}

export interface ProviderRuntimePolicySource {
  readonly resolvePolicy: (
    selection: ProviderSelectionReference
  ) => ProviderPolicy | Promise<ProviderPolicy>;
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
  | "MOCK_PROPOSAL_REQUIRED";

export class ProviderRuntimeResolutionError extends Error {
  public constructor(public readonly code: ProviderRuntimeResolutionErrorCode) {
    super(providerRuntimeResolutionErrorMessage(code));
    this.name = "ProviderRuntimeResolutionError";
  }
}

export class ProviderRuntimeResolver {
  private readonly registry: ProviderRegistry;
  private readonly configurationSource: ProviderRuntimeConfigurationSource | undefined;
  private readonly adapterRuntimeSource: ProviderAdapterRuntimeSource | undefined;
  private readonly secretResolver: ProviderSecretResolver | undefined;
  private readonly policySource: ProviderRuntimePolicySource | undefined;

  public constructor(options: ProviderRuntimeResolverOptions = {}) {
    this.registry = options.registry ?? registerBuiltInProviders();
    this.configurationSource = options.configurationSource;
    this.adapterRuntimeSource = options.adapterRuntimeSource;
    this.secretResolver = options.secretResolver;
    this.policySource = options.policySource;
  }

  public async resolve(input: {
    readonly selection?: ProviderSelectionReference;
    readonly mockProposal?: InterviewerProposal;
  }): Promise<ProviderRuntimeResolution> {
    const selection = input.selection ?? DEFAULT_PROVIDER_SELECTION;

    let runtimeConfiguration: unknown;
    try {
      runtimeConfiguration = await this.configurationSource?.resolveConfiguration(selection);
    } catch {
      throw new ProviderRuntimeResolutionError("RUNTIME_CONFIGURATION_FAILED");
    }

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

    let runtime: unknown;
    if (selection.providerId === "mock-model" && selection.modelId === "mock-default") {
      if (input.mockProposal === undefined) {
        throw new ProviderRuntimeResolutionError("MOCK_PROPOSAL_REQUIRED");
      }
      runtime = Object.freeze({ proposal: input.mockProposal });
    } else {
      try {
        runtime = await this.adapterRuntimeSource?.resolveRuntime(selection);
      } catch {
        throw new ProviderRuntimeResolutionError("RUNTIME_DEPENDENCY_FAILED");
      }
    }

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

    let rawPolicy: ProviderPolicy;
    try {
      rawPolicy = this.policySource === undefined
        ? DEFAULT_PROVIDER_RUNTIME_POLICY
        : await this.policySource.resolvePolicy(selection);
    } catch {
      throw new ProviderRuntimeResolutionError("POLICY_RESOLUTION_FAILED");
    }
    const policy = snapshotProviderPolicy(rawPolicy);

    return Object.freeze({
      providerId: resolved.provider.id,
      modelId: resolved.model.id,
      provider,
      policy
    });
  }
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
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProviderRuntimeResolutionError("RUNTIME_CONFIGURATION_FAILED");
  }

  let descriptors: Readonly<Record<string, PropertyDescriptor>>;
  let symbols: readonly symbol[];
  let prototype: object | null;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
    symbols = Object.getOwnPropertySymbols(value);
    prototype = Object.getPrototypeOf(value);
  } catch {
    throw new ProviderRuntimeResolutionError("RUNTIME_CONFIGURATION_FAILED");
  }
  if (
    symbols.length !== 0
    || (prototype !== Object.prototype && prototype !== null)
  ) {
    throw new ProviderRuntimeResolutionError("RUNTIME_CONFIGURATION_FAILED");
  }

  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(descriptors)) {
    if (!RUNTIME_CONFIGURATION_KEYS.has(key)) {
      throw new ProviderRuntimeResolutionError("RUNTIME_CONFIGURATION_FAILED");
    }
    const descriptor = descriptors[key];
    if (
      descriptor === undefined
      || descriptor.enumerable !== true
      || !("value" in descriptor)
    ) {
      throw new ProviderRuntimeResolutionError("RUNTIME_CONFIGURATION_FAILED");
    }
    output[key] = descriptor.value;
  }
  return Object.freeze(output);
}

function snapshotProviderPolicy(value: ProviderPolicy): ProviderPolicy {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProviderRuntimeResolutionError("POLICY_RESOLUTION_FAILED");
  }

  let descriptors: Readonly<Record<string, PropertyDescriptor>>;
  let symbols: readonly symbol[];
  let prototype: object | null;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
    symbols = Object.getOwnPropertySymbols(value);
    prototype = Object.getPrototypeOf(value);
  } catch {
    throw new ProviderRuntimeResolutionError("POLICY_RESOLUTION_FAILED");
  }
  if (
    symbols.length !== 0
    || (prototype !== Object.prototype && prototype !== null)
    || Object.keys(descriptors).some((key) => !POLICY_KEYS.has(key))
  ) {
    throw new ProviderRuntimeResolutionError("POLICY_RESOLUTION_FAILED");
  }

  const allowMeteredUsage = readPolicyDataProperty(descriptors, "allowMeteredUsage");
  const maximumDataUse = readPolicyDataProperty(descriptors, "maximumDataUse");
  const billingVerificationMaxAgeMs = readPolicyDataProperty(
    descriptors,
    "billingVerificationMaxAgeMs"
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

function readPolicyDataProperty(
  descriptors: Readonly<Record<string, PropertyDescriptor>>,
  key: string
): unknown {
  const descriptor = descriptors[key];
  if (
    descriptor === undefined
    || descriptor.enumerable !== true
    || !("value" in descriptor)
  ) {
    throw new ProviderRuntimeResolutionError("POLICY_RESOLUTION_FAILED");
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
    default:
      return "Provider runtime resolution failed";
  }
}
