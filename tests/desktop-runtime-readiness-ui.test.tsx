import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderLaunchOption } from "../packages/domain/src/index.js";
import { AppearanceProvider } from "../apps/web/src/appearance/AppearanceProvider.js";
import {
  parseDesktopRuntimeStatus,
  type DesktopRuntimeStatus
} from "../apps/web/src/desktop-runtime.js";
import { SettingsPage } from "../apps/web/src/pages/SettingsPage.js";

const READY_PROVIDER = {
  providerId: "antigravity-cli",
  providerDisplayName: "Antigravity CLI",
  providerKind: "CLI",
  modelId: "gemini-3.7-flash-medium",
  modelDisplayName: "Gemini 3.7 Flash Medium",
  availability: "AVAILABLE"
} as unknown as ProviderLaunchOption;

const AUTH_REQUIRED_PROVIDER = {
  ...READY_PROVIDER,
  availability: "UNAVAILABLE",
  reason: "CREDENTIALS_REQUIRED"
} as unknown as ProviderLaunchOption;

function runtimeStatus(input: {
  readonly speech?: DesktopRuntimeStatus["speech"];
  readonly tts?: DesktopRuntimeStatus["tts"];
  readonly vision?: DesktopRuntimeStatus["vision"];
  readonly python?: DesktopRuntimeStatus["python"];
  readonly voiceRestartRequired?: boolean;
  readonly visionRestartRequired?: boolean;
} = {}): DesktopRuntimeStatus {
  return {
    protocolVersion: 1,
    speech: input.speech ?? { state: "READY" },
    tts: input.tts ?? { state: "READY" },
    vision: input.vision ?? { state: "READY" },
    python: input.python ?? {
      state: "READY",
      strategy: "SYSTEM_CPYTHON",
      supportedVersions: ["3.12", "3.13"]
    },
    voiceSetup: {
      state: input.voiceRestartRequired === true ? "INSTALLED" : "IDLE",
      restartRequired: input.voiceRestartRequired === true
    },
    visionSetup: {
      state: input.visionRestartRequired === true ? "INSTALLED" : "IDLE",
      restartRequired: input.visionRestartRequired === true
    }
  };
}

function clearDesktopBridge(): void {
  delete (globalThis as typeof globalThis & {
    interviewDesktop?: unknown;
  }).interviewDesktop;
}

afterEach(() => {
  clearDesktopBridge();
});

describe("desktop local AI readiness UX", () => {
  it("parses independent voice and vision capability combinations", () => {
    const parsed = parseDesktopRuntimeStatus(runtimeStatus({
      speech: { state: "READY" },
      tts: { state: "READY" },
      vision: { state: "MISSING_ASSET", reasonCode: "VISION_ASSET_MISSING" }
    }));
    expect(parsed).toEqual(runtimeStatus({
      speech: { state: "READY" },
      tts: { state: "READY" },
      vision: { state: "MISSING_ASSET", reasonCode: "VISION_ASSET_MISSING" }
    }));

    const inverse = parseDesktopRuntimeStatus(runtimeStatus({
      speech: { state: "MISSING_ASSET", reasonCode: "SPEECH_ASSET_MISSING" },
      tts: { state: "MISSING_ASSET", reasonCode: "TTS_ASSET_MISSING" },
      vision: { state: "READY" }
    }));
    expect(inverse?.vision.state).toBe("READY");
    expect(inverse?.speech.state).toBe("MISSING_ASSET");
  });

  it("rejects malformed or legacy shared runtime status payloads", () => {
    const valid = runtimeStatus();
    const { vision: _vision, ...missingVision } = valid;
    expect(parseDesktopRuntimeStatus(missingVision)).toBeUndefined();

    expect(parseDesktopRuntimeStatus({
      protocolVersion: 1,
      speech: valid.speech,
      tts: valid.tts,
      vision: valid.vision,
      python: valid.python,
      modelSetup: { state: "IDLE", restartRequired: false }
    })).toBeUndefined();

    expect(parseDesktopRuntimeStatus({
      ...valid,
      python: {
        ...valid.python,
        supportedVersions: ["3.11", "3.13"]
      }
    })).toBeUndefined();

    expect(parseDesktopRuntimeStatus({
      ...valid,
      unexpectedPrivilegedField: "nope"
    })).toBeUndefined();
  });

  it("preserves Python reason codes while presenting supported runtime metadata", () => {
    const parsed = parseDesktopRuntimeStatus(runtimeStatus({
      python: {
        state: "UNAVAILABLE",
        reasonCode: "PYTHON_RUNTIME_INCOMPATIBLE",
        strategy: "SYSTEM_CPYTHON",
        supportedVersions: ["3.12", "3.13"]
      },
      speech: {
        state: "UNAVAILABLE",
        reasonCode: "PYTHON_RUNTIME_INCOMPATIBLE"
      },
      tts: {
        state: "UNAVAILABLE",
        reasonCode: "PYTHON_RUNTIME_INCOMPATIBLE"
      },
      vision: {
        state: "UNAVAILABLE",
        reasonCode: "PYTHON_RUNTIME_INCOMPATIBLE"
      }
    }));
    expect(parsed?.python.reasonCode).toBe("PYTHON_RUNTIME_INCOMPATIBLE");
    expect(parsed?.python.supportedVersions).toEqual(["3.12", "3.13"]);
  });

  it("degrades Settings cleanly when the Electron bridge is absent", () => {
    clearDesktopBridge();
    const markup = renderToStaticMarkup(
      React.createElement(
        AppearanceProvider,
        null,
        React.createElement(SettingsPage, {
          providerOptions: [READY_PROVIDER],
          providerOptionsLoading: false,
          providerOptionsError: null,
          onRefreshProviderOptions: vi.fn(async () => [READY_PROVIDER]),
          onStartInterview: vi.fn()
        })
      )
    );
    expect(markup).toContain("Interview readiness");
    expect(markup).toContain("DESKTOP ONLY");
    expect(markup).toContain("Typed interviews are ready.");
    expect(markup).toContain("Start interview");
    expect(markup).not.toContain("Python prerequisite required");
  });

  it("uses authoritative provider readiness language for Antigravity authentication", () => {
    const markup = renderToStaticMarkup(
      React.createElement(
        AppearanceProvider,
        null,
        React.createElement(SettingsPage, {
          providerOptions: [AUTH_REQUIRED_PROVIDER],
          providerOptionsLoading: false,
          providerOptionsError: null,
          onRefreshProviderOptions: vi.fn(async () => [AUTH_REQUIRED_PROVIDER]),
          onStartInterview: vi.fn()
        })
      )
    );
    expect(markup).toContain("Authenticate Antigravity through its CLI, then re-check.");
    expect(markup).toContain("A live AI interview needs a ready reasoning provider.");
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Start interview<\/button>/u);
    expect(markup).not.toContain("API key");
  });
});
