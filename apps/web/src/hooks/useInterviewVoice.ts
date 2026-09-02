import {
  useCallback,
  useEffect,
  useRef,
  useState
} from "react";
import type { SessionId } from "../../../../packages/domain/src/index.js";
import {
  AudioInfrastructureError,
  BrowserAudioDeviceManager,
  BrowserMicrophoneCapture,
  type AudioDeviceDescriptor,
  type AudioFrame
} from "../audio/index.js";
import {
  BrowserVoiceClient,
  type BrowserVoiceCommit,
  type BrowserVoiceFrameResult,
  type BrowserVoiceStream
} from "../voice-client.js";

// Final STT runs inline. Buffer a small, explicit amount of continuing
// capture while recognition is pending, bounded independently by time, memory,
// and fragmentation so non-48-kHz browser AudioContexts do not collapse the
// latency budget or expand memory without limit.
const MAX_PENDING_MICROPHONE_FRAMES = 256;
const MAX_PENDING_MICROPHONE_DURATION_MS = 3_000;
const MAX_PENDING_MICROPHONE_BYTES = 2 * 1024 * 1024;
const VOICE_CANCEL_TIMEOUT_MS = 1_000;
const VOICE_CANCEL_ATTEMPTS = 2;

export type VoicePermissionState =
  | "UNKNOWN"
  | "GRANTED"
  | "DENIED"
  | "UNSUPPORTED"
  | "ERROR";

export interface InterviewVoiceState {
  readonly microphoneEnabled: boolean;
  readonly listening: boolean;
  readonly speaking: boolean;
  readonly permission: VoicePermissionState;
  readonly error: string | null;
  readonly inputDevices: readonly AudioDeviceDescriptor[];
  readonly outputDevices: readonly AudioDeviceDescriptor[];
  readonly inputDeviceId: string | undefined;
  readonly outputDeviceId: string | undefined;
}

export interface InterviewVoiceControls {
  readonly enableMicrophone: () => Promise<void>;
  readonly disableMicrophone: () => Promise<void>;
  readonly selectInputDevice: (deviceId: string | undefined) => Promise<void>;
  readonly selectOutputDevice: (deviceId: string | undefined) => void;
  readonly refreshAudioDevices: () => Promise<void>;
}

export interface UseInterviewVoiceOptions {
  readonly sessionId: SessionId | null;
  readonly sessionActive: boolean;
  readonly voiceBaseUrl: string;
  readonly authenticatedFetch: typeof fetch;
  readonly speaking: boolean;
  readonly interruptPlaybackForBargeIn: () => void;
  readonly setOutputDeviceId: (deviceId: string | undefined) => void;
  readonly onVoiceCommit: (commit: BrowserVoiceCommit) => void;
}

export interface UseInterviewVoiceResult {
  readonly voice: InterviewVoiceState;
  readonly voiceControls: InterviewVoiceControls;
}

export function applyAdmittedVoiceFrameResult(
  result: BrowserVoiceFrameResult,
  callbacks: {
    readonly interruptPlaybackForBargeIn: () => void;
    readonly onVoiceCommit: (commit: BrowserVoiceCommit) => void;
  }
): void {
  if (result.events.some((event) => event.type === "SPEECH_STARTED")) {
    callbacks.interruptPlaybackForBargeIn();
  }
  if (result.commit !== undefined) callbacks.onVoiceCommit(result.commit);
}

export function useInterviewVoice(options: UseInterviewVoiceOptions): UseInterviewVoiceResult {
  const [microphoneEnabled, setMicrophoneEnabled] = useState(false);
  const [listening, setListening] = useState(false);
  const [permission, setPermission] = useState<VoicePermissionState>("UNKNOWN");
  const [error, setError] = useState<string | null>(null);
  const [inputDevices, setInputDevices] = useState<readonly AudioDeviceDescriptor[]>([]);
  const [outputDevices, setOutputDevices] = useState<readonly AudioDeviceDescriptor[]>([]);
  const [inputDeviceId, setInputDeviceId] = useState<string | undefined>(undefined);
  const [outputDeviceId, setOutputDeviceIdState] = useState<string | undefined>(undefined);

  const captureRef = useRef<BrowserMicrophoneCapture | null>(null);
  const devicesRef = useRef<BrowserAudioDeviceManager | null>(null);
  const clientRef = useRef<BrowserVoiceClient | null>(null);
  const streamRef = useRef<BrowserVoiceStream | null>(null);
  const transportAbortRef = useRef<AbortController | null>(null);
  const frameQueueRef = useRef<AudioFrame[]>([]);
  const drainingRef = useRef(false);
  const epochRef = useRef(0);
  const mountedRef = useRef(true);
  const microphoneEnabledRef = useRef(false);
  const selectedInputRef = useRef<string | undefined>(undefined);
  const inputDeviceSwitchEpochRef = useRef(0);
  const inputDeviceSwitchPendingRef = useRef(false);
  const deviceEnumerationEpochRef = useRef(0);
  const optionsRef = useRef(options);
  const observedSessionIdRef = useRef<SessionId | null>(options.sessionId);
  optionsRef.current = options;
  selectedInputRef.current = inputDeviceId;
  microphoneEnabledRef.current = microphoneEnabled;

  if (captureRef.current === null) captureRef.current = new BrowserMicrophoneCapture();
  if (devicesRef.current === null) devicesRef.current = new BrowserAudioDeviceManager();

  useEffect(() => {
    clientRef.current = new BrowserVoiceClient({
      baseUrl: options.voiceBaseUrl,
      authenticatedFetch: options.authenticatedFetch
    });
  }, [options.authenticatedFetch, options.voiceBaseUrl]);

  const safelySetError = useCallback((message: string | null): void => {
    if (mountedRef.current) setError(message);
  }, []);

  const cancelCurrentStream = useCallback(async (): Promise<void> => {
    const stream = streamRef.current;
    streamRef.current = null;
    if (stream === null) return;
    await cancelStreamBounded(stream);
  }, []);

  const stopMicrophone = useCallback(async (): Promise<void> => {
    const nextEpoch = epochRef.current + 1;
    epochRef.current = nextEpoch;
    microphoneEnabledRef.current = false;
    frameQueueRef.current.length = 0;
    transportAbortRef.current?.abort();
    transportAbortRef.current = null;
    if (mountedRef.current) {
      setMicrophoneEnabled(false);
      setListening(false);
    }

    const capture = captureRef.current;
    await Promise.all([
      capture?.stop() ?? Promise.resolve(),
      cancelCurrentStream()
    ]);
  }, [cancelCurrentStream]);

  const disableMicrophone = useCallback(async (): Promise<void> => {
    // Explicit/session-driven disable owns the lifecycle over any pending
    // input-device switch and must prevent that switch from resurrecting the
    // microphone after teardown completes.
    inputDeviceSwitchEpochRef.current += 1;
    inputDeviceSwitchPendingRef.current = false;
    await stopMicrophone();
  }, [stopMicrophone]);

  const failVoiceCycle = useCallback((reason: string, permissionState?: VoicePermissionState): void => {
    safelySetError(reason);
    if (permissionState !== undefined && mountedRef.current) setPermission(permissionState);
    void disableMicrophone();
  }, [disableMicrophone, safelySetError]);

  const processFrameResult = useCallback((
    result: Awaited<ReturnType<BrowserVoiceStream["sendFrame"]>>,
    epoch: number,
    sourceSessionId: SessionId
  ): void => {
    if (!isVoiceContextCurrent(
      epochRef.current,
      microphoneEnabledRef.current,
      epoch,
      optionsRef.current.sessionId,
      sourceSessionId
    )) return;
    // The server emits SPEECH_STARTED only after beginUtterance() commits the
    // authoritative invalidation. The same bridge used by tests performs the
    // physical interruption only after that authority transition.
    applyAdmittedVoiceFrameResult(result, {
      interruptPlaybackForBargeIn: optionsRef.current.interruptPlaybackForBargeIn,
      onVoiceCommit: optionsRef.current.onVoiceCommit
    });
    const workerError = result.events.find((event) => event.type === "SPEECH_WORKER_ERROR");
    if (workerError !== undefined) {
      streamRef.current = null;
      failVoiceCycle(workerError.message);
      return;
    }
    if (result.terminal) streamRef.current = null;
  }, [failVoiceCycle]);

  const drainFrames = useCallback(async (epoch: number): Promise<void> => {
    if (drainingRef.current) return;
    drainingRef.current = true;
    try {
      while (
        epoch === epochRef.current
        && microphoneEnabledRef.current
        && frameQueueRef.current.length > 0
      ) {
        const sessionId = optionsRef.current.sessionId;
        const client = clientRef.current;
        if (sessionId === null || !optionsRef.current.sessionActive || client === null) {
          failVoiceCycle("Voice input requires an active interview session");
          return;
        }

        const transportSignal = transportAbortRef.current?.signal;
        if (transportSignal === undefined || transportSignal.aborted) return;

        let stream = streamRef.current;
        if (stream !== null && stream.sessionId !== sessionId) {
          streamRef.current = null;
          await cancelStreamBounded(stream);
          return;
        }
        if (stream === null || stream.isClosed) {
          try {
            stream = await client.openStream(sessionId, transportSignal);
          } catch (openError) {
            if (
              epoch !== epochRef.current
              || optionsRef.current.sessionId !== sessionId
            ) return;
            failVoiceCycle(safeVoiceError(openError));
            return;
          }
          if (!isVoiceContextCurrent(
            epochRef.current,
            microphoneEnabledRef.current,
            epoch,
            optionsRef.current.sessionId,
            sessionId
          )) {
            await cancelStreamBounded(stream);
            return;
          }
          streamRef.current = stream;
        }

        const frame = frameQueueRef.current.shift();
        if (frame === undefined) continue;
        try {
          const result = await stream.sendFrame(frame, transportSignal);
          processFrameResult(result, epoch, stream.sessionId);
          if (
            result.carryCurrentFrameToNextStream === true
            && isVoiceContextCurrent(
              epochRef.current,
              microphoneEnabledRef.current,
              epoch,
              optionsRef.current.sessionId,
              stream.sessionId
            )
          ) {
            // MAX_DURATION finalization can use the current frame only as an
            // endpoint trigger. Reframe that exact captured PCM as sequence 0
            // of the next stream instead of dropping continuing student speech,
            // but never bypass the same pending PCM budget used by capture.
            if (!pendingFrameFitsBudget(frameQueueRef.current, frame)) {
              failVoiceCycle("Microphone transport backpressure limit reached");
              return;
            }
            frameQueueRef.current.unshift(frame);
          }
        } catch (frameError) {
          if (
            epoch !== epochRef.current
            || optionsRef.current.sessionId !== stream.sessionId
          ) return;
          failVoiceCycle(safeVoiceError(frameError));
          return;
        }
      }
    } finally {
      drainingRef.current = false;
      if (
        microphoneEnabledRef.current
        && frameQueueRef.current.length > 0
      ) {
        // An older epoch may finish after a rapid disable/re-enable cycle.
        // Hand any newly queued frames to the currently authoritative epoch
        // rather than leaving them stranded behind the old drain flag.
        void drainFrames(epochRef.current);
      }
    }
  }, [failVoiceCycle, processFrameResult]);

  const enqueueFrame = useCallback((frame: AudioFrame, epoch: number): void => {
    if (epoch !== epochRef.current || !microphoneEnabledRef.current) return;
    const queued = frameQueueRef.current;
    if (!pendingFrameFitsBudget(queued, frame)) {
      failVoiceCycle("Microphone transport backpressure limit reached");
      return;
    }
    queued.push(frame);
    void drainFrames(epoch);
  }, [drainFrames, failVoiceCycle]);

  const startCapture = useCallback(async (deviceId: string | undefined): Promise<void> => {
    const sessionId = optionsRef.current.sessionId;
    if (sessionId === null || !optionsRef.current.sessionActive) {
      throw new Error("Voice input requires an active interview session");
    }
    const capture = captureRef.current;
    if (capture === null) throw new Error("Browser microphone capture is unavailable");

    const epoch = epochRef.current + 1;
    epochRef.current = epoch;
    microphoneEnabledRef.current = true;
    frameQueueRef.current.length = 0;
    streamRef.current = null;
    transportAbortRef.current?.abort();
    const transportController = new AbortController();
    transportAbortRef.current = transportController;
    safelySetError(null);
    if (mountedRef.current) {
      setMicrophoneEnabled(true);
      setListening(false);
    }

    try {
      await capture.start({
        ...(deviceId === undefined ? {} : { deviceId }),
        channelCount: 1,
        frameSize: 2_048,
        onFrame: (frame) => enqueueFrame(frame, epoch),
        onError: (captureError) => {
          if (
            epoch !== epochRef.current
            || optionsRef.current.sessionId !== sessionId
          ) return;
          failVoiceCycle(
            captureError.message,
            captureError.code === "PERMISSION_DENIED" ? "DENIED" : "ERROR"
          );
        }
      });
      if (!isVoiceContextCurrent(
        epochRef.current,
        microphoneEnabledRef.current,
        epoch,
        optionsRef.current.sessionId,
        sessionId
      )) return;
      if (mountedRef.current) {
        setPermission("GRANTED");
        setListening(true);
      }
    } catch (captureError) {
      if (
        epoch !== epochRef.current
        || optionsRef.current.sessionId !== sessionId
      ) return;
      const classified = classifyCaptureError(captureError);
      if (mountedRef.current) setPermission(classified.permission);
      failVoiceCycle(classified.message);
    }
  }, [enqueueFrame, failVoiceCycle, safelySetError]);

  const enableMicrophone = useCallback(async (): Promise<void> => {
    if (microphoneEnabledRef.current || inputDeviceSwitchPendingRef.current) return;
    await startCapture(selectedInputRef.current);
  }, [startCapture]);

  const selectInputDevice = useCallback(async (deviceId: string | undefined): Promise<void> => {
    const normalized = normalizeDeviceId(deviceId);
    selectedInputRef.current = normalized;
    if (mountedRef.current) setInputDeviceId(normalized);

    const shouldRestart =
      microphoneEnabledRef.current || inputDeviceSwitchPendingRef.current;
    if (!shouldRestart) return;

    inputDeviceSwitchPendingRef.current = true;
    const switchEpoch = inputDeviceSwitchEpochRef.current + 1;
    inputDeviceSwitchEpochRef.current = switchEpoch;

    // Use the internal stop primitive here: the public disable operation
    // intentionally invalidates all pending switches.
    await stopMicrophone();

    if (
      inputDeviceSwitchEpochRef.current !== switchEpoch
      || selectedInputRef.current !== normalized
      || !mountedRef.current
      || !optionsRef.current.sessionActive
      || optionsRef.current.sessionId === null
    ) return;

    try {
      await startCapture(normalized);
    } finally {
      if (inputDeviceSwitchEpochRef.current === switchEpoch) {
        inputDeviceSwitchPendingRef.current = false;
      }
    }
  }, [startCapture, stopMicrophone]);

  const selectOutputDevice = useCallback((deviceId: string | undefined): void => {
    const normalized = normalizeDeviceId(deviceId);
    optionsRef.current.setOutputDeviceId(normalized);
    if (mountedRef.current) setOutputDeviceIdState(normalized);
  }, []);

  const refreshAudioDevices = useCallback(async (): Promise<void> => {
    const manager = devicesRef.current;
    if (manager === null) return;
    const enumerationEpoch = deviceEnumerationEpochRef.current + 1;
    deviceEnumerationEpochRef.current = enumerationEpoch;
    const result = await manager.enumerate();
    if (
      !mountedRef.current
      || deviceEnumerationEpochRef.current !== enumerationEpoch
    ) return;
    if (result.status === "PERMISSION_DENIED") {
      setPermission((current) => current === "GRANTED" ? current : "DENIED");
    } else if (result.status === "UNSUPPORTED") {
      setPermission((current) => current === "GRANTED" ? current : "UNSUPPORTED");
    } else if (result.status === "FAILED") {
      safelySetError(result.message);
    }
    const inputs = result.devices.filter((device) => device.kind === "INPUT");
    const outputs = result.devices.filter((device) => device.kind === "OUTPUT");
    setInputDevices(inputs);
    setOutputDevices(outputs);

    const currentInput = selectedInputRef.current;
    if (
      currentInput !== undefined
      && !inputs.some((device) => device.deviceId === currentInput)
    ) {
      selectedInputRef.current = undefined;
      setInputDeviceId(undefined);
      if (inputDeviceSwitchPendingRef.current) {
        inputDeviceSwitchEpochRef.current += 1;
        inputDeviceSwitchPendingRef.current = false;
      }
      if (microphoneEnabledRef.current) {
        failVoiceCycle("Selected microphone disappeared");
      }
    }
    const currentOutput = outputDeviceId;
    if (
      currentOutput !== undefined
      && !outputs.some((device) => device.deviceId === currentOutput)
    ) {
      optionsRef.current.setOutputDeviceId(undefined);
      setOutputDeviceIdState(undefined);
    }
  }, [failVoiceCycle, outputDeviceId, safelySetError]);

  useEffect(() => {
    void refreshAudioDevices();
    const manager = devicesRef.current;
    if (manager === null) return;
    try {
      return manager.subscribe(() => refreshAudioDevices());
    } catch {
      return;
    }
  }, [refreshAudioDevices]);

  useEffect(() => {
    const previousSessionId = observedSessionIdRef.current;
    observedSessionIdRef.current = options.sessionId;
    if (
      previousSessionId !== options.sessionId
      && (microphoneEnabledRef.current || streamRef.current !== null)
    ) {
      // Session replacement is an authority boundary. Invalidate the local
      // epoch immediately so late STT/frame callbacks from the old session
      // cannot reach the newly selected session.
      void disableMicrophone();
      return;
    }
    if (options.sessionActive && options.sessionId !== null) return;
    if (microphoneEnabledRef.current || streamRef.current !== null) {
      void disableMicrophone();
    }
  }, [disableMicrophone, options.sessionActive, options.sessionId]);

  useEffect(() => () => {
    mountedRef.current = false;
    deviceEnumerationEpochRef.current += 1;
    inputDeviceSwitchEpochRef.current += 1;
    inputDeviceSwitchPendingRef.current = false;
    epochRef.current += 1;
    microphoneEnabledRef.current = false;
    frameQueueRef.current.length = 0;
    transportAbortRef.current?.abort();
    transportAbortRef.current = null;
    const stream = streamRef.current;
    streamRef.current = null;
    if (stream !== null) void cancelStreamBounded(stream);
    const capture = captureRef.current;
    captureRef.current = null;
    if (capture !== null) void capture.dispose().catch(() => undefined);
  }, []);

  return {
    voice: {
      microphoneEnabled,
      listening,
      speaking: options.speaking,
      permission,
      error,
      inputDevices,
      outputDevices,
      inputDeviceId,
      outputDeviceId
    },
    voiceControls: {
      enableMicrophone,
      disableMicrophone,
      selectInputDevice,
      selectOutputDevice,
      refreshAudioDevices
    }
  };
}

function pendingFrameFitsBudget(
  queued: readonly AudioFrame[],
  frame: AudioFrame
): boolean {
  if (queued.length >= MAX_PENDING_MICROPHONE_FRAMES) return false;

  let pendingDurationMs = 0;
  let pendingBytes = 0;
  for (const pending of queued) {
    const durationMs = pending.samples.length / pending.sampleRate * 1_000;
    if (
      !Number.isFinite(durationMs)
      || durationMs <= 0
      || !Number.isSafeInteger(pending.samples.byteLength)
    ) {
      return false;
    }
    pendingDurationMs += durationMs;
    pendingBytes += pending.samples.byteLength;
    if (
      pendingDurationMs > MAX_PENDING_MICROPHONE_DURATION_MS
      || pendingBytes > MAX_PENDING_MICROPHONE_BYTES
    ) {
      return false;
    }
  }

  const frameDurationMs = frame.samples.length / frame.sampleRate * 1_000;
  return Number.isFinite(frameDurationMs)
    && frameDurationMs > 0
    && pendingDurationMs + frameDurationMs <= MAX_PENDING_MICROPHONE_DURATION_MS
    && pendingBytes + frame.samples.byteLength <= MAX_PENDING_MICROPHONE_BYTES;
}

function classifyCaptureError(error: unknown): {
  readonly permission: VoicePermissionState;
  readonly message: string;
} {
  if (error instanceof AudioInfrastructureError) {
    if (error.code === "PERMISSION_DENIED") {
      return { permission: "DENIED", message: error.message };
    }
    if (error.code === "UNSUPPORTED") {
      return { permission: "UNSUPPORTED", message: error.message };
    }
    return { permission: "ERROR", message: error.message };
  }
  return { permission: "ERROR", message: safeVoiceError(error) };
}

function safeVoiceError(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message.trim();
    if (message.length > 0 && message.length <= 256) return message;
  }
  return "Voice input failed";
}

function normalizeDeviceId(deviceId: string | undefined): string | undefined {
  if (deviceId === undefined || deviceId === "" || deviceId === "default") return undefined;
  if (
    typeof deviceId !== "string"
    || deviceId.length > 512
    || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(deviceId)
  ) {
    throw new Error("Audio device identifier is invalid");
  }
  return deviceId;
}


async function cancelStreamBounded(stream: BrowserVoiceStream): Promise<void> {
  const attemptBudgetMs = Math.floor(VOICE_CANCEL_TIMEOUT_MS / VOICE_CANCEL_ATTEMPTS);
  for (let attempt = 0; attempt < VOICE_CANCEL_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeout = globalThis.setTimeout(() => {
      controller.abort();
    }, attemptBudgetMs);
    try {
      await stream.cancel(controller.signal);
      return;
    } catch {
      // Retry within the same total bounded cancellation budget. Local epochs
      // and the server-side idle lease remain the final fail-closed backstops.
    } finally {
      globalThis.clearTimeout(timeout);
    }
  }
}


function isVoiceContextCurrent(
  currentEpoch: number,
  microphoneEnabled: boolean,
  expectedEpoch: number,
  currentSessionId: SessionId | null,
  expectedSessionId: SessionId
): boolean {
  return currentEpoch === expectedEpoch
    && microphoneEnabled
    && currentSessionId === expectedSessionId;
}
