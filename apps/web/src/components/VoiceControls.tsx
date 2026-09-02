import type {
  InterviewVoiceControls,
  InterviewVoiceState
} from "../hooks/useInterviewVoice.js";

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

  return (
    <div
      className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-2"
      data-testid="voice-controls"
    >
      <button
        type="button"
        disabled={!canUseMicrophone}
        onClick={() => {
          void (state.microphoneEnabled
            ? controls.disableMicrophone()
            : controls.enableMicrophone());
        }}
        className="rounded border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {state.microphoneEnabled ? "Disable microphone" : "Enable microphone"}
      </button>

      <label className="flex items-center gap-1 text-[11px] text-slate-600">
        <span>Input</span>
        <select
          value={state.inputDeviceId ?? ""}
          disabled={disabled || state.inputDevices.length === 0}
          onChange={(event) => {
            void controls.selectInputDevice(event.target.value || undefined);
          }}
          className="max-w-44 rounded border border-slate-200 bg-white px-1.5 py-1 text-[11px]"
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

      <label className="flex items-center gap-1 text-[11px] text-slate-600">
        <span>Output</span>
        <select
          value={state.outputDeviceId ?? ""}
          disabled={state.outputDevices.length === 0}
          onChange={(event) => {
            controls.selectOutputDevice(event.target.value || undefined);
          }}
          className="max-w-44 rounded border border-slate-200 bg-white px-1.5 py-1 text-[11px]"
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

      <div className="ml-auto flex items-center gap-2 text-[11px] text-slate-500">
        <span data-testid="voice-listening-status">
          {state.listening ? "Listening" : "Not listening"}
        </span>
        <span aria-hidden="true">·</span>
        <span data-testid="voice-speaking-status">
          {state.speaking ? "Speaking" : "Not speaking"}
        </span>
        <span aria-hidden="true">·</span>
        <span>Mic: {state.permission.toLowerCase()}</span>
      </div>

      {state.error !== null && (
        <div
          className="basis-full text-[11px] text-rose-700"
          role="status"
          data-testid="voice-error"
        >
          {state.error}
        </div>
      )}
    </div>
  );
}
