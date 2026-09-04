// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderLaunchOption } from "../packages/domain/src/index.js";
import { AppearanceProvider } from "../apps/web/src/appearance/AppearanceProvider.js";
import {
  parseDesktopRuntimeStatus,
  type DesktopRuntimeStatus
} from "../apps/web/src/desktop-runtime.js";
import { NewInterviewPage } from "../apps/web/src/pages/NewInterviewPage.js";
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
    pythonSetup: {
      state: "IDLE",
      restartRequired: false
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
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  document.body.replaceChildren();
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
    const missingVision: Record<string, unknown> = { ...valid };
    delete missingVision["vision"];
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

    expect(parseDesktopRuntimeStatus({
      ...valid,
      speech: { state: "READY", reasonCode: "SHOULD_NOT_EXIST" }
    })).toBeUndefined();

    expect(parseDesktopRuntimeStatus({
      ...valid,
      vision: { state: "FAILED" }
    })).toBeUndefined();

    expect(parseDesktopRuntimeStatus({
      ...valid,
      python: {
        state: "READY",
        reasonCode: "PYTHON_RUNTIME_DEPENDENCIES_MISSING",
        strategy: "SYSTEM_CPYTHON",
        supportedVersions: ["3.12", "3.13"]
      }
    })).toBeUndefined();

    expect(parseDesktopRuntimeStatus({
      ...valid,
      python: {
        state: "FAILED",
        reasonCode: "PYTHON_RUNTIME_INCOMPATIBLE",
        strategy: "SYSTEM_CPYTHON",
        supportedVersions: ["3.12", "3.13"]
      }
    })).toBeUndefined();

    expect(parseDesktopRuntimeStatus({
      ...valid,
      voiceSetup: { state: "INSTALLED", restartRequired: false }
    })).toBeUndefined();

    expect(parseDesktopRuntimeStatus({
      ...valid,
      visionSetup: { state: "IDLE", restartRequired: true }
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

  it("does not leave local capabilities stuck on CHECKING after a runtime read failure", async () => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("interviewDesktop", {
      getLocalRuntimeStatus: vi.fn(async () => {
        throw new Error("runtime bridge failure");
      })
    });

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <AppearanceProvider>
          <SettingsPage
            providerOptions={[READY_PROVIDER]}
            providerOptionsLoading={false}
            providerOptionsError={null}
            onRefreshProviderOptions={vi.fn(async () => [READY_PROVIDER])}
            onStartInterview={vi.fn()}
          />
        </AppearanceProvider>
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain(
      "Local runtime status could not be verified. Re-check or restart Interview App."
    );
    expect(container.textContent).not.toContain("CHECKING");
    expect(container.textContent).toContain("UNAVAILABLE");

    await act(async () => {
      root.unmount();
    });
  });

  it("keeps New Interview usable when desktop local readiness is malformed", async () => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("interviewDesktop", {
      getLocalRuntimeStatus: vi.fn(async () => ({ protocolVersion: 999 }))
    });

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <NewInterviewPage
          catalog={[]}
          catalogLoading={false}
          catalogError={null}
          providerOptions={[READY_PROVIDER]}
          providerOptionsLoading={false}
          providerOptionsError={null}
          activeSessionId={null}
          startPending={false}
          onRefreshCatalog={vi.fn(async () => [])}
          onRefreshProviderOptions={vi.fn(async () => [READY_PROVIDER])}
          onStart={vi.fn(async () => undefined)}
          onResumeActive={null}
        />
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain(
      "Local AI readiness could not be verified — typed input and drawing still work."
    );
    expect(container.textContent).toContain("Start interview");

    await act(async () => {
      root.unmount();
    });
  });

  it("fails closed when an Antigravity re-check errors even if a prior option was ready", () => {
    const markup = renderToStaticMarkup(
      React.createElement(
        AppearanceProvider,
        null,
        React.createElement(SettingsPage, {
          providerOptions: [READY_PROVIDER],
          providerOptionsLoading: false,
          providerOptionsError: "Provider readiness could not be refreshed.",
          onRefreshProviderOptions: vi.fn(async () => [READY_PROVIDER]),
          onStartInterview: vi.fn()
        })
      )
    );
    expect(markup).toContain("A live AI interview needs a ready reasoning provider.");
    expect(markup).toContain("Provider readiness could not be refreshed.");
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Start interview<\/button>/u);
  });

  it("walks Python, voice, vision, and restart setup through live renderer state", async () => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    const baseUnavailable = runtimeStatus({
      speech: {
        state: "UNAVAILABLE",
        reasonCode: "PYTHON_RUNTIME_DEPENDENCIES_MISSING"
      },
      tts: {
        state: "UNAVAILABLE",
        reasonCode: "PYTHON_RUNTIME_DEPENDENCIES_MISSING"
      },
      vision: {
        state: "UNAVAILABLE",
        reasonCode: "PYTHON_RUNTIME_DEPENDENCIES_MISSING"
      },
      python: {
        state: "UNAVAILABLE",
        reasonCode: "PYTHON_RUNTIME_DEPENDENCIES_MISSING",
        strategy: "SYSTEM_CPYTHON",
        supportedVersions: ["3.12", "3.13"]
      }
    });
    let current: DesktopRuntimeStatus = baseUnavailable;
    const getLocalRuntimeStatus = vi.fn(async () => current);
    const installPythonRuntime = vi.fn(async () => {
      current = {
        ...current,
        pythonSetup: { state: "INSTALLED", restartRequired: true }
      };
      return current;
    });
    const installVoiceModels = vi.fn(async () => {
      current = {
        ...current,
        voiceSetup: { state: "INSTALLED", restartRequired: true }
      };
      return current;
    });
    const installVisionModel = vi.fn(async () => {
      current = {
        ...current,
        visionSetup: { state: "INSTALLED", restartRequired: true }
      };
      return current;
    });
    const restartApp = vi.fn(async () => undefined);
    vi.stubGlobal("interviewDesktop", {
      getLocalRuntimeStatus,
      installPythonRuntime,
      installVoiceModels,
      installVisionModel,
      restartApp
    });

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const findButton = (label: string): HTMLButtonElement => {
      const match = Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent.trim() === label);
      if (!(match instanceof HTMLButtonElement)) {
        throw new Error(`Missing button: ${label}`);
      }
      return match;
    };

    await act(async () => {
      root.render(
        <AppearanceProvider>
          <SettingsPage
            providerOptions={[READY_PROVIDER]}
            providerOptionsLoading={false}
            providerOptionsError={null}
            onRefreshProviderOptions={vi.fn(async () => [READY_PROVIDER])}
            onStartInterview={vi.fn()}
          />
        </AppearanceProvider>
      );
    });
    expect(getLocalRuntimeStatus).toHaveBeenCalled();
    expect(findButton("Install voice models").disabled).toBe(true);
    expect(findButton("Install vision model").disabled).toBe(true);

    await act(async () => {
      findButton("Install Python components").click();
    });
    expect(installPythonRuntime).toHaveBeenCalledTimes(1);
    expect(findButton("Install voice models").disabled).toBe(false);
    expect(findButton("Install vision model").disabled).toBe(false);
    expect(findButton("Restart Interview App").disabled).toBe(false);

    const voiceButton = findButton("Install voice models");
    const visionButton = findButton("Install vision model");
    await act(async () => {
      voiceButton.click();
      visionButton.click();
    });
    expect(installVoiceModels).toHaveBeenCalledTimes(1);
    expect(installVisionModel).not.toHaveBeenCalled();
    expect(findButton("Installed — restart required")).toBeTruthy();

    await act(async () => {
      findButton("Install vision model").click();
    });
    expect(installVisionModel).toHaveBeenCalledTimes(1);

    await act(async () => {
      findButton("Restart Interview App").click();
    });
    expect(restartApp).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.unmount();
    });
    Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
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
