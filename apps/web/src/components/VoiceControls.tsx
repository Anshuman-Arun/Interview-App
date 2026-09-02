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

export function VoiceControls({
  state,
  controls,
  disabled
}: VoiceControlsProps) {
  const canUseMicrophone = !disabled
    && state.permission !== "UNSUPPORTED";

  const visibleState = state.speaking
    ? "Interviewer speaking"
    : state.listening
      ? "Listening"
      : state.microphoneEnabled
        ? "Microphone ready"
        : "Microphone off";

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
        {state.microphoneEnabled ? "Disable microphone" : "Enable microphone"}
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

      <details className="voice-strip__devices">
        <summary>Audio</summary>
        <div className="voice-strip__popover">
          <label>
            <span>Input</span>
            <select
              value={state.inputDeviceId ?? ""}
              disabled={disabled || state.inputDevices.length === 0}
              onChange={(event) => {
                void controls.selectInputDevice(event.target.value || undefined);
              }}
            >
              <option value="">System default</option>
              {state.inputDevices
                .filter((device) => !device.isDefault)
                .map((device) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label ?? "Microphone"}
                  </option>
                ))}
            </select>
          </label>

          <label>
            <span>Output</span>
            <select
              value={state.outputDeviceId ?? ""}
              disabled={state.outputDevices.length === 0}
              onChange={(event) => {
                controls.selectOutputDevice(event.target.value || undefined);
              }}
            >
              <option value="">System default</option>
              {state.outputDevices
                .filter((device) => !device.isDefault)
                .map((device) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label ?? "Speaker"}
                  </option>
                ))}
            </select>
          </label>

          <span className="voice-strip__permission">
            Mic: {state.permission.toLowerCase()}
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
