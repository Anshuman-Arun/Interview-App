export const DESKTOP_FIRST_RUN_SETUP_KEY = "interview.desktop.first-run-readiness.v1";

export type DesktopRuntimeCapabilityState =
  | "READY"
  | "MISSING_ASSET"
  | "FAILED"
  | "UNAVAILABLE";

export type DesktopModelSetupState =
  | "IDLE"
  | "INSTALLING"
  | "INSTALLED"
  | "FAILED";

export interface DesktopRuntimeCapabilityStatus {
  readonly state: DesktopRuntimeCapabilityState;
  readonly reasonCode?: string;
}

export interface DesktopPythonRuntimeStatus
  extends DesktopRuntimeCapabilityStatus {
  readonly strategy: "SYSTEM_CPYTHON";
  readonly supportedVersions: readonly ["3.12", "3.13"];
}

export interface DesktopModelSetupStatus {
  readonly state: DesktopModelSetupState;
  readonly restartRequired: boolean;
}

export interface DesktopRuntimeStatus {
  readonly protocolVersion: 1;
  readonly speech: DesktopRuntimeCapabilityStatus;
  readonly tts: DesktopRuntimeCapabilityStatus;
  readonly vision: DesktopRuntimeCapabilityStatus;
  readonly python: DesktopPythonRuntimeStatus;
  readonly pythonSetup: DesktopModelSetupStatus;
  readonly voiceSetup: DesktopModelSetupStatus;
  readonly visionSetup: DesktopModelSetupStatus;
}

export interface DesktopRuntimeBridge {
  readonly getLocalRuntimeStatus: () => Promise<unknown>;
  readonly refreshLocalRuntimeStatus?: () => Promise<unknown>;
  readonly installPythonRuntime?: () => Promise<unknown>;
  readonly installVoiceModels?: () => Promise<unknown>;
  readonly installVisionModel?: () => Promise<unknown>;
  readonly restartApp?: () => Promise<void>;
}

export function getDesktopRuntimeBridge(): DesktopRuntimeBridge | undefined {
  const bridge = (globalThis as typeof globalThis & {
    readonly interviewDesktop?: {
      readonly getLocalRuntimeStatus?: unknown;
      readonly refreshLocalRuntimeStatus?: unknown;
      readonly installPythonRuntime?: unknown;
      readonly installVoiceModels?: unknown;
      readonly installVisionModel?: unknown;
      readonly restartApp?: unknown;
    };
  }).interviewDesktop;
  if (
    bridge === undefined
    || typeof bridge.getLocalRuntimeStatus !== "function"
  ) {
    return undefined;
  }
  const getLocalRuntimeStatus =
    bridge.getLocalRuntimeStatus as () => Promise<unknown>;
  const refreshLocalRuntimeStatus = typeof bridge.refreshLocalRuntimeStatus === "function"
    ? bridge.refreshLocalRuntimeStatus as () => Promise<unknown>
    : undefined;
  const installPythonRuntime = typeof bridge.installPythonRuntime === "function"
    ? bridge.installPythonRuntime as () => Promise<unknown>
    : undefined;
  const installVoiceModels = typeof bridge.installVoiceModels === "function"
    ? bridge.installVoiceModels as () => Promise<unknown>
    : undefined;
  const installVisionModel = typeof bridge.installVisionModel === "function"
    ? bridge.installVisionModel as () => Promise<unknown>
    : undefined;
  const restartApp = typeof bridge.restartApp === "function"
    ? bridge.restartApp as () => Promise<void>
    : undefined;
  return {
    getLocalRuntimeStatus,
    ...(refreshLocalRuntimeStatus === undefined ? {} : { refreshLocalRuntimeStatus }),
    ...(installPythonRuntime === undefined ? {} : { installPythonRuntime }),
    ...(installVoiceModels === undefined ? {} : { installVoiceModels }),
    ...(installVisionModel === undefined ? {} : { installVisionModel }),
    ...(restartApp === undefined ? {} : { restartApp })
  };
}

export function parseDesktopRuntimeStatus(
  value: unknown
): DesktopRuntimeStatus | undefined {
  if (!isRecord(value)) return undefined;
  if (!hasExactKeys(value, [
    "protocolVersion",
    "speech",
    "tts",
    "vision",
    "python",
    "pythonSetup",
    "voiceSetup",
    "visionSetup"
  ])) {
    return undefined;
  }
  const speech = parseCapability(value["speech"]);
  const tts = parseCapability(value["tts"]);
  const vision = parseCapability(value["vision"]);
  const python = parsePython(value["python"]);
  const pythonSetup = parseSetup(value["pythonSetup"]);
  const voiceSetup = parseSetup(value["voiceSetup"]);
  const visionSetup = parseSetup(value["visionSetup"]);
  if (
    value["protocolVersion"] !== 1
    || speech === undefined
    || tts === undefined
    || vision === undefined
    || python === undefined
    || pythonSetup === undefined
    || voiceSetup === undefined
    || visionSetup === undefined
  ) {
    return undefined;
  }
  return {
    protocolVersion: 1,
    speech,
    tts,
    vision,
    python,
    pythonSetup,
    voiceSetup,
    visionSetup
  };
}

export async function readDesktopRuntimeStatus(
  bridge: DesktopRuntimeBridge,
  options: { readonly refreshPrerequisites?: boolean } = {}
): Promise<DesktopRuntimeStatus> {
  const readStatus = options.refreshPrerequisites === true
    && bridge.refreshLocalRuntimeStatus !== undefined
    ? bridge.refreshLocalRuntimeStatus
    : bridge.getLocalRuntimeStatus;
  const parsed = parseDesktopRuntimeStatus(
    await readStatus()
  );
  if (parsed === undefined) {
    throw new Error("Desktop runtime status is malformed");
  }
  return parsed;
}

function parseCapability(
  value: unknown
): DesktopRuntimeCapabilityStatus | undefined {
  if (!isRecord(value)) return undefined;
  const state = value["state"];
  if (!isCapabilityState(state)) return undefined;
  const reasonCode = value["reasonCode"];
  const reasonRequired = state !== "READY";
  const expectedKeys = reasonRequired
    ? ["reasonCode", "state"]
    : ["state"];
  if (
    !hasExactKeys(value, expectedKeys)
    || (
      reasonRequired
      && (
        typeof reasonCode !== "string"
        || !/^[A-Z0-9_]{1,96}$/u.test(reasonCode)
      )
    )
    || (!reasonRequired && reasonCode !== undefined)
  ) {
    return undefined;
  }
  return {
    state,
    ...(reasonRequired ? { reasonCode: reasonCode as string } : {})
  };
}

function parsePython(
  value: unknown
): DesktopPythonRuntimeStatus | undefined {
  if (!isRecord(value)) return undefined;
  const state = value["state"];
  if (state !== "READY" && state !== "UNAVAILABLE") return undefined;
  const reasonCode = value["reasonCode"];
  const reasonRequired = state === "UNAVAILABLE";
  const expectedKeys = reasonRequired
    ? ["reasonCode", "state", "strategy", "supportedVersions"]
    : ["state", "strategy", "supportedVersions"];
  const versions = value["supportedVersions"];
  if (
    !hasExactKeys(value, expectedKeys)
    || (
      reasonRequired
      && (
        typeof reasonCode !== "string"
        || !/^[A-Z0-9_]{1,96}$/u.test(reasonCode)
      )
    )
    || (!reasonRequired && reasonCode !== undefined)
    || value["strategy"] !== "SYSTEM_CPYTHON"
    || !Array.isArray(versions)
    || versions.length !== 2
    || versions[0] !== "3.12"
    || versions[1] !== "3.13"
  ) {
    return undefined;
  }
  return {
    state,
    ...(reasonRequired ? { reasonCode: reasonCode as string } : {}),
    strategy: "SYSTEM_CPYTHON",
    supportedVersions: ["3.12", "3.13"]
  };
}

function parseSetup(
  value: unknown
): DesktopModelSetupStatus | undefined {
  if (
    !isRecord(value)
    || !hasExactKeys(value, ["state", "restartRequired"])
    || !isSetupState(value["state"])
    || typeof value["restartRequired"] !== "boolean"
    || (value["state"] === "INSTALLED") !== value["restartRequired"]
  ) {
    return undefined;
  }
  return {
    state: value["state"],
    restartRequired: value["restartRequired"]
  };
}

function isCapabilityState(
  value: unknown
): value is DesktopRuntimeCapabilityState {
  return value === "READY"
    || value === "MISSING_ASSET"
    || value === "FAILED"
    || value === "UNAVAILABLE";
}

function isSetupState(
  value: unknown
): value is DesktopModelSetupState {
  return value === "IDLE"
    || value === "INSTALLING"
    || value === "INSTALLED"
    || value === "FAILED";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[]
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}
