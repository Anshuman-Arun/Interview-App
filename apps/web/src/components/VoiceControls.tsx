import type {
  InterviewVoiceControls,
  InterviewVoiceState
} from "../hooks/useInterviewVoice.js";
import styles from "./VoiceControls.module.css";

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
  const statusLabel = state.speaking
    ? "Interviewer speaking"
    : state.listening
      ? "Listening"
      : state.microphoneEnabled
        ? "Microphone ready"
        : "Microphone off";

  return (
    <div
      className={styles.controls ?? ""}
      data-testid="voice-controls"
      data-listening={String(state.listening)}
      data-speaking={String(state.speaking)}
    >
      <div className={styles.primaryRow}>
        <button
          type="button"
          disabled={!canUseMicrophone}
          aria-pressed={state.microphoneEnabled}
          onClick={() => {
            void (state.microphoneEnabled
              ? controls.disableMicrophone()
              : controls.enableMicrophone());
          }}
          className={styles.microphoneButton}
        >
          <span
            className={
              state.microphoneEnabled
                ? (styles.microphoneDotActive ?? "")
                : (styles.microphoneDot ?? "")
            }
            aria-hidden="true"
          />
          {state.microphoneEnabled ? "Disable microphone" : "Enable microphone"}
        </button>

        <span
          className={styles.voiceStatus}
          role="status"
          aria-live="polite"
        >
          {statusLabel}
        </span>

        <span className={styles.speakingState} data-testid="voice-listening-status">
          {state.listening ? "Listening" : "Not listening"}
        </span>
        <span className={styles.speakingState} data-testid="voice-speaking-status">
          {state.speaking ? "Speaking" : "Not speaking"}
        </span>

        <details className={styles.deviceMenu}>
          <summary>Audio</summary>
          <div className={styles.devicePopover}>
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

            <div className={styles.permission}>
              Microphone permission: {state.permission.toLowerCase()}
            </div>
          </div>
        </details>
      </div>

      {state.error !== null && (
        <div
          className={styles.error}
          role="status"
          data-testid="voice-error"
        >
          {state.error}
        </div>
      )}
    </div>
  );
}
