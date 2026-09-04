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
  readonly voiceSetup: DesktopModelSetupStatus;
  readonly visionSetup: DesktopModelSetupStatus;
}

export interface DesktopRuntimeBridge {
  readonly getLocalRuntimeStatus: () => Promise<unknown>;
  readonly installVoiceModels?: () => Promise<unknown>;
  readonly installVisionModel?: () => Promise<unknown>;
  readonly restartApp?: () => Promise<void>;
}

export function getDesktopRuntimeBridge(): DesktopRuntimeBridge | undefined {
  const bridge = (globalThis as typeof globalThis & {
    readonly interviewDesktop?: {
      readonly getLocalRuntimeStatus?: unknown;
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
  return {
    getLocalRuntimeStatus: bridge.getLocalRuntimeStatus.bind(bridge),
    ...(typeof bridge.installVoiceModels === "function"
      ? { installVoiceModels: bridge.installVoiceModels.bind(bridge) }
      : {}),
    ...(typeof bridge.installVisionModel === "function"
      ? { installVisionModel: bridge.installVisionModel.bind(bridge) }
      : {}),
    ...(typeof bridge.restartApp === "function"
      ? { restartApp: bridge.restartApp.bind(bridge) }
      : {})
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
    "voiceSetup",
    "visionSetup"
  ])) {
    return undefined;
  }
  const speech = parseCapability(value["speech"]);
  const tts = parseCapability(value["tts"]);
  const vision = parseCapability(value["vision"]);
  const python = parsePython(value["python"]);
  const voiceSetup = parseSetup(value["voiceSetup"]);
  const visionSetup = parseSetup(value["visionSetup"]);
  if (
    value["protocolVersion"] !== 1
    || speech === undefined
    || tts === undefined
    || vision === undefined
    || python === undefined
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
    voiceSetup,
    visionSetup
  };
}

export async function readDesktopRuntimeStatus(
  bridge: DesktopRuntimeBridge
): Promise<DesktopRuntimeStatus> {
  const parsed = parseDesktopRuntimeStatus(
    await bridge.getLocalRuntimeStatus()
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
  const reasonCode = value["reasonCode"];
  const expectedKeys = reasonCode === undefined
    ? ["state"]
    : ["reasonCode", "state"];
  if (
    !hasExactKeys(value, expectedKeys)
    || !isCapabilityState(value["state"])
    || (
      reasonCode !== undefined
      && (
        typeof reasonCode !== "string"
        || !/^[A-Z0-9_]{1,96}$/u.test(reasonCode)
      )
    )
  ) {
    return undefined;
  }
  return {
    state: value["state"],
    ...(reasonCode === undefined ? {} : { reasonCode })
  };
}

function parsePython(
  value: unknown
): DesktopPythonRuntimeStatus | undefined {
  if (!isRecord(value)) return undefined;
  const reasonCode = value["reasonCode"];
  const expectedKeys = reasonCode === undefined
    ? ["state", "strategy", "supportedVersions"]
    : ["reasonCode", "state", "strategy", "supportedVersions"];
  const versions = value["supportedVersions"];
  if (
    !hasExactKeys(value, expectedKeys)
    || !isCapabilityState(value["state"])
    || (
      reasonCode !== undefined
      && (
        typeof reasonCode !== "string"
        || !/^[A-Z0-9_]{1,96}$/u.test(reasonCode)
      )
    )
    || value["strategy"] !== "SYSTEM_CPYTHON"
    || !Array.isArray(versions)
    || versions.length !== 2
    || versions[0] !== "3.12"
    || versions[1] !== "3.13"
  ) {
    return undefined;
  }
  return {
    state: value["state"],
    ...(reasonCode === undefined ? {} : { reasonCode }),
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
