// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  VoiceControls
} from "../apps/web/src/components/VoiceControls.js";
import type {
  InterviewVoiceControls,
  InterviewVoiceState
} from "../apps/web/src/hooks/useInterviewVoice.js";

let mountedRoot: Root | undefined;
let mountedContainer: HTMLDivElement | undefined;

afterEach(() => {
  if (mountedRoot !== undefined) {
    act(() => mountedRoot?.unmount());
  }
  mountedContainer?.remove();
  mountedRoot = undefined;
  mountedContainer = undefined;
  vi.restoreAllMocks();
});

function renderVoiceControls(
  state: InterviewVoiceState,
  controls: InterviewVoiceControls,
  disabled = false
): HTMLDivElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <VoiceControls state={state} controls={controls} disabled={disabled} />
    );
  });
  mountedRoot = root;
  mountedContainer = container;
  return container;
}

function baseState(): InterviewVoiceState {
  return {
    microphoneEnabled: false,
    listening: false,
    speaking: false,
    permission: "GRANTED",
    error: null,
    inputDevices: [
      {
        kind: "INPUT",
        deviceId: "default",
        label: "Default microphone",
        isDefault: true,
        availability: "AVAILABLE"
      },
      {
        kind: "INPUT",
        deviceId: "mic-a",
        label: "Desk microphone",
        isDefault: false,
        availability: "AVAILABLE"
      },
      {
        kind: "INPUT",
        deviceId: "mic-b",
        label: "Headset microphone",
        isDefault: false,
        availability: "AVAILABLE"
      }
    ],
    outputDevices: [
      {
        kind: "OUTPUT",
        deviceId: "default",
        label: "Default speaker",
        isDefault: true,
        availability: "AVAILABLE"
      }
    ],
    inputDeviceId: undefined,
    outputDeviceId: undefined
  };
}

function controlsWith(
  selectInputDevice: InterviewVoiceControls["selectInputDevice"]
): InterviewVoiceControls {
  return {
    enableMicrophone: vi.fn(async () => undefined),
    disableMicrophone: vi.fn(async () => undefined),
    selectInputDevice,
    selectOutputDevice: vi.fn(),
    refreshAudioDevices: vi.fn(async () => undefined)
  };
}

describe("VoiceControls device picker keyboard behavior", () => {
  it("uses roving tab focus and arrow keys to select adjacent microphones", () => {
    const selectInputDevice = vi.fn<InterviewVoiceControls["selectInputDevice"]>(
      async () => undefined
    );
    const container = renderVoiceControls(
      baseState(),
      controlsWith(selectInputDevice)
    );
    const radios = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        '[role="radiogroup"][aria-label="Microphone"] [role="radio"]'
      )
    );

    expect(radios).toHaveLength(3);
    expect(radios.map((radio) => radio.tabIndex)).toEqual([0, -1, -1]);

    radios[0]?.focus();
    act(() => {
      radios[0]?.dispatchEvent(new KeyboardEvent("keydown", {
        key: "ArrowDown",
        bubbles: true,
        cancelable: true
      }));
    });

    expect(selectInputDevice).toHaveBeenLastCalledWith("mic-a");
    expect(document.activeElement).toBe(radios[1]);

    act(() => {
      radios[1]?.dispatchEvent(new KeyboardEvent("keydown", {
        key: "ArrowRight",
        bubbles: true,
        cancelable: true
      }));
    });

    expect(selectInputDevice).toHaveBeenLastCalledWith("mic-b");
    expect(document.activeElement).toBe(radios[2]);

    act(() => {
      radios[2]?.dispatchEvent(new KeyboardEvent("keydown", {
        key: "ArrowDown",
        bubbles: true,
        cancelable: true
      }));
    });

    expect(selectInputDevice).toHaveBeenLastCalledWith(undefined);
    expect(document.activeElement).toBe(radios[0]);
  });

  it("supports Home and End navigation without making every radio a tab stop", () => {
    const selectInputDevice = vi.fn<InterviewVoiceControls["selectInputDevice"]>(
      async () => undefined
    );
    const state = { ...baseState(), inputDeviceId: "mic-a" };
    const container = renderVoiceControls(
      state,
      controlsWith(selectInputDevice)
    );
    const radios = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        '[role="radiogroup"][aria-label="Microphone"] [role="radio"]'
      )
    );

    expect(radios.map((radio) => radio.tabIndex)).toEqual([-1, 0, -1]);

    radios[1]?.focus();
    act(() => {
      radios[1]?.dispatchEvent(new KeyboardEvent("keydown", {
        key: "End",
        bubbles: true,
        cancelable: true
      }));
    });
    expect(selectInputDevice).toHaveBeenLastCalledWith("mic-b");
    expect(document.activeElement).toBe(radios[2]);

    act(() => {
      radios[2]?.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Home",
        bubbles: true,
        cancelable: true
      }));
    });
    expect(selectInputDevice).toHaveBeenLastCalledWith(undefined);
    expect(document.activeElement).toBe(radios[0]);
  });
});
