import { useEffect, useRef } from "react";
import type {
  InterviewVoiceControls,
  InterviewVoiceState
} from "../hooks/useInterviewVoice.js";
import "./VoiceControls.css";

export interface VoiceControlsProps {
  readonly state: InterviewVoiceState;
  readonly controls: InterviewVoiceControls;
  readonly disabled: boolean;
}

type VoiceDevice = InterviewVoiceState["inputDevices"][number];

function selectedDeviceLabel(
  devices: readonly VoiceDevice[],
  selectedId: string | undefined,
  fallback: string
): string {
  if (selectedId === undefined) return "System default";
  return devices.find((device) => device.deviceId === selectedId)?.label ?? fallback;
}

function DevicePicker({
  label,
  devices,
  selectedId,
  disabled,
  fallbackLabel,
  onSelect
}: {
  readonly label: string;
  readonly devices: readonly VoiceDevice[];
  readonly selectedId: string | undefined;
  readonly disabled: boolean;
  readonly fallbackLabel: string;
  readonly onSelect: (deviceId: string | undefined) => void;
}) {
  const choices = devices.filter((device) => !device.isDefault);
  return (
    <section className="voice-device-picker">
      <div className="voice-device-picker__heading">
        <span>{label}</span>
        <strong>{selectedDeviceLabel(devices, selectedId, fallbackLabel)}</strong>
      </div>
      <div
        className="voice-device-picker__choices"
        role="radiogroup"
        aria-label={label}
        aria-disabled={disabled}
      >
        <button
          type="button"
          role="radio"
          aria-checked={selectedId === undefined}
          disabled={disabled}
          onClick={() => onSelect(undefined)}
        >
          <span className="voice-device-picker__choice-mark" aria-hidden="true" />
          <span>System default</span>
        </button>
        {choices.map((device) => (
          <button
            key={device.deviceId}
            type="button"
            role="radio"
            aria-checked={selectedId === device.deviceId}
            disabled={disabled}
            onClick={() => onSelect(device.deviceId)}
          >
            <span className="voice-device-picker__choice-mark" aria-hidden="true" />
            <span>{device.label ?? fallbackLabel}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

export function VoiceControls({
  state,
  controls,
  disabled
}: VoiceControlsProps) {
  const detailsRef = useRef<HTMLDetailsElement | null>(null);
  const canUseMicrophone = !disabled
    && state.permission !== "UNSUPPORTED";

  const visibleState = state.speaking
    ? "Interviewer speaking"
    : state.listening
      ? "Listening"
      : state.microphoneEnabled
        ? "Microphone ready"
        : "Microphone off";

  useEffect(() => {
    const closeOutside = (event: PointerEvent): void => {
      const details = detailsRef.current;
      if (
        details === null
        || !details.open
        || !(event.target instanceof Node)
        || details.contains(event.target)
      ) {
        return;
      }
      details.open = false;
    };
    const closeEscape = (event: KeyboardEvent): void => {
      const details = detailsRef.current;
      if (event.key !== "Escape" || details === null || !details.open) return;
      details.open = false;
      details.querySelector<HTMLElement>("summary")?.focus();
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeEscape);
    };
  }, []);

  return (
    <div
      className="voice-strip"
      data-testid="voice-controls"
      data-listening={String(state.listening)}
      data-speaking={String(state.speaking)}
    >
      <button
        type="button"
        disabled={!canUseMicrophone}
        aria-pressed={state.microphoneEnabled}
        onClick={() => {
          void (state.microphoneEnabled
            ? controls.disableMicrophone()
            : controls.enableMicrophone());
        }}
        className="voice-strip__mic"
      >
        <span
          className="voice-strip__dot"
          data-active={String(state.microphoneEnabled)}
          aria-hidden="true"
        />
        {state.microphoneEnabled ? "Mic on" : "Mic off"}
      </button>

      <span className="voice-strip__state" role="status" aria-live="polite">
        {visibleState}
      </span>

      <span className="voice-strip__sr" data-testid="voice-listening-status">
        {state.listening ? "Listening" : "Not listening"}
      </span>
      <span className="voice-strip__sr" data-testid="voice-speaking-status">
        {state.speaking ? "Speaking" : "Not speaking"}
      </span>

      <details ref={detailsRef} className="voice-strip__devices">
        <summary aria-label="Choose audio devices">
          Audio
          <span aria-hidden="true">⌄</span>
        </summary>
        <div className="voice-strip__popover">
          <div className="voice-strip__popover-header">
            <strong>Audio devices</strong>
            <span>Choose without leaving the interview</span>
          </div>

          <DevicePicker
            label="Microphone"
            devices={state.inputDevices}
            selectedId={state.inputDeviceId}
            disabled={disabled || state.inputDevices.length === 0}
            fallbackLabel="Microphone"
            onSelect={(deviceId) => {
              void controls.selectInputDevice(deviceId);
            }}
          />

          <DevicePicker
            label="Speaker"
            devices={state.outputDevices}
            selectedId={state.outputDeviceId}
            disabled={state.outputDevices.length === 0}
            fallbackLabel="Speaker"
            onSelect={controls.selectOutputDevice}
          />

          <span className="voice-strip__permission">
            Microphone permission: {state.permission.toLowerCase()}
          </span>
        </div>
      </details>

      {state.error !== null && (
        <div
          className="voice-strip__error"
          role="status"
          data-testid="voice-error"
        >
          {state.error}
        </div>
      )}
    </div>
  );
}
