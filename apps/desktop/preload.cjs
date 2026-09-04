"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const CHANNEL = "interview-desktop:get-bootstrap";
const ZOOM_CHANNEL = "interview-desktop:set-zoom";
const ZOOM_CHANGED_CHANNEL = "interview-desktop:zoom-changed";
const LOCAL_RUNTIME_STATUS_CHANNEL = "interview-desktop:get-local-runtime-status";
const INSTALL_PYTHON_RUNTIME_CHANNEL = "interview-desktop:install-python-runtime";
const INSTALL_VOICE_MODELS_CHANNEL = "interview-desktop:install-voice-models";
const INSTALL_VISION_MODEL_CHANNEL = "interview-desktop:install-vision-model";
const RESTART_APP_CHANNEL = "interview-desktop:restart-app";
const AUTH_HEADER_VALUE = "desktop-managed-v1";
const MIN_ZOOM_FACTOR = 0.25;
const MAX_ZOOM_FACTOR = 5;

function isZoomFactor(value) {
  return typeof value === "number"
    && Number.isFinite(value)
    && value >= MIN_ZOOM_FACTOR
    && value <= MAX_ZOOM_FACTOR;
}

function isExactLoopbackOrigin(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:"
      && (parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]")
      && parsed.username.length === 0
      && parsed.password.length === 0
      && parsed.pathname === "/"
      && parsed.search.length === 0
      && parsed.hash.length === 0;
  } catch {
    return false;
  }
}

function hasExactKeys(value, expectedKeys) {
  if (typeof value !== "object" || value === null) return false;
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function validateBootstrap(value) {
  if (typeof value !== "object" || value === null) throw new Error("Desktop bootstrap is unavailable");
  if (
    !hasExactKeys(value, [
      "protocolVersion",
      "commandBaseUrl",
      "rendererStreamUrl",
      "voiceBaseUrl",
      "authentication",
      "appVersion",
      "platform"
    ])
    || !hasExactKeys(value.authentication, ["mode", "headerValue"])
    ||
    value.protocolVersion !== 1
    || !isExactLoopbackOrigin(value.commandBaseUrl)
    || typeof value.rendererStreamUrl !== "string"
    || !isExactLoopbackOrigin(value.voiceBaseUrl)
    || typeof value.authentication !== "object"
    || value.authentication === null
    || value.authentication.mode !== "DESKTOP_MANAGED"
    || value.authentication.headerValue !== AUTH_HEADER_VALUE
    || typeof value.appVersion !== "string"
    || value.appVersion.trim().length === 0
    || typeof value.platform !== "string"
    || value.platform.trim().length === 0
  ) {
    throw new Error("Desktop bootstrap is malformed");
  }
  const stream = new URL(value.rendererStreamUrl);
  if (
    stream.protocol !== "http:"
    || (stream.hostname !== "127.0.0.1" && stream.hostname !== "[::1]")
    || stream.username.length !== 0
    || stream.password.length !== 0
    || stream.pathname !== "/v1/renderer-stream"
    || stream.search.length !== 0
    || stream.hash.length !== 0
  ) {
    throw new Error("Desktop bootstrap is malformed");
  }
  return Object.freeze({
    protocolVersion: 1,
    commandBaseUrl: value.commandBaseUrl,
    rendererStreamUrl: value.rendererStreamUrl,
    voiceBaseUrl: value.voiceBaseUrl,
    authentication: Object.freeze({
      mode: "DESKTOP_MANAGED",
      headerValue: AUTH_HEADER_VALUE
    }),
    appVersion: value.appVersion,
    platform: value.platform
  });
}

const RUNTIME_STATES = new Set(["READY", "MISSING_ASSET", "FAILED", "UNAVAILABLE"]);
const MODEL_SETUP_STATES = new Set(["IDLE", "INSTALLING", "INSTALLED", "FAILED"]);

function validateCapabilityStatus(value) {
  if (
    typeof value !== "object"
    || value === null
    || !RUNTIME_STATES.has(value.state)
    || (value.reasonCode !== undefined
      && (typeof value.reasonCode !== "string"
        || !/^[A-Z0-9_]{1,96}$/.test(value.reasonCode)))
  ) {
    throw new Error("Desktop local runtime status is malformed");
  }
  const keys = Object.keys(value).sort();
  const expected = value.reasonCode === undefined ? ["state"] : ["reasonCode", "state"];
  if (
    keys.length !== expected.length
    || !keys.every((key, index) => key === expected[index])
  ) {
    throw new Error("Desktop local runtime status is malformed");
  }
  return Object.freeze({
    state: value.state,
    ...(value.reasonCode === undefined ? {} : { reasonCode: value.reasonCode })
  });
}

function validateSetupStatus(value) {
  if (
    typeof value !== "object"
    || value === null
    || !hasExactKeys(value, ["state", "restartRequired"])
    || !MODEL_SETUP_STATES.has(value.state)
    || typeof value.restartRequired !== "boolean"
  ) {
    throw new Error("Desktop local runtime status is malformed");
  }
  return Object.freeze({
    state: value.state,
    restartRequired: value.restartRequired
  });
}

function validatePythonStatus(value) {
  if (typeof value !== "object" || value === null) {
    throw new Error("Desktop local runtime status is malformed");
  }
  const reasonCodePresent = value.reasonCode !== undefined;
  const expectedKeys = reasonCodePresent
    ? ["reasonCode", "state", "strategy", "supportedVersions"]
    : ["state", "strategy", "supportedVersions"];
  if (
    !hasExactKeys(value, expectedKeys)
    || !RUNTIME_STATES.has(value.state)
    || (reasonCodePresent
      && (typeof value.reasonCode !== "string"
        || !/^[A-Z0-9_]{1,96}$/.test(value.reasonCode)))
    || value.strategy !== "SYSTEM_CPYTHON"
    || !Array.isArray(value.supportedVersions)
    || value.supportedVersions.length !== 2
    || value.supportedVersions[0] !== "3.12"
    || value.supportedVersions[1] !== "3.13"
  ) {
    throw new Error("Desktop local runtime status is malformed");
  }
  return Object.freeze({
    state: value.state,
    ...(reasonCodePresent ? { reasonCode: value.reasonCode } : {}),
    strategy: "SYSTEM_CPYTHON",
    supportedVersions: Object.freeze(["3.12", "3.13"])
  });
}

function validateLocalRuntimeStatus(value) {
  if (
    typeof value !== "object"
    || value === null
    || !hasExactKeys(value, [
      "protocolVersion",
      "speech",
      "tts",
      "vision",
      "python",
      "pythonSetup",
      "voiceSetup",
      "visionSetup"
    ])
    || value.protocolVersion !== 1
  ) {
    throw new Error("Desktop local runtime status is malformed");
  }
  return Object.freeze({
    protocolVersion: 1,
    speech: validateCapabilityStatus(value.speech),
    tts: validateCapabilityStatus(value.tts),
    vision: validateCapabilityStatus(value.vision),
    python: validatePythonStatus(value.python),
    pythonSetup: validateSetupStatus(value.pythonSetup),
    voiceSetup: validateSetupStatus(value.voiceSetup),
    visionSetup: validateSetupStatus(value.visionSetup)
  });
}

const bootstrap = validateBootstrap(ipcRenderer.sendSync(CHANNEL));
contextBridge.exposeInMainWorld("interviewDesktop", Object.freeze({
  getBootstrap: () => ({
    ...bootstrap,
    authentication: { ...bootstrap.authentication }
  }),
  setZoomFactor: (factor) => {
    if (!isZoomFactor(factor)) {
      throw new Error("Desktop zoom factor is unsupported");
    }
    if (ipcRenderer.sendSync(ZOOM_CHANNEL, factor) !== true) {
      throw new Error("Desktop zoom request was rejected");
    }
  },
  getLocalRuntimeStatus: async () =>
    validateLocalRuntimeStatus(await ipcRenderer.invoke(LOCAL_RUNTIME_STATUS_CHANNEL)),
  installPythonRuntime: async () =>
    validateLocalRuntimeStatus(await ipcRenderer.invoke(INSTALL_PYTHON_RUNTIME_CHANNEL)),
  installVoiceModels: async () =>
    validateLocalRuntimeStatus(await ipcRenderer.invoke(INSTALL_VOICE_MODELS_CHANNEL)),
  installVisionModel: async () =>
    validateLocalRuntimeStatus(await ipcRenderer.invoke(INSTALL_VISION_MODEL_CHANNEL)),
  restartApp: async () => {
    if (await ipcRenderer.invoke(RESTART_APP_CHANNEL) !== true) {
      throw new Error("Desktop restart request was rejected");
    }
  },
  onZoomFactorChanged: (listener) => {
    if (typeof listener !== "function") {
      throw new Error("Desktop zoom listener must be a function");
    }
    const handler = (_event, factor) => {
      if (isZoomFactor(factor)) listener(factor);
    };
    ipcRenderer.on(ZOOM_CHANGED_CHANNEL, handler);
    return () => ipcRenderer.removeListener(ZOOM_CHANGED_CHANNEL, handler);
  }
}));