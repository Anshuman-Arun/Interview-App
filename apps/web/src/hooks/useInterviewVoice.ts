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
  type BrowserVoiceStream
} from "../voice-client.js";

const MAX_PENDING_MICROPHONE_FRAMES = 8;
const VOICE_CANCEL_TIMEOUT_MS = 1_000;

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
  const frameQueueRef = useRef<AudioFrame[]>([]);
  const drainingRef = useRef(false);
  const epochRef = useRef(0);
  const mountedRef = useRef(true);
  const microphoneEnabledRef = useRef(false);
  const selectedInputRef = useRef<string | undefined>(undefined);
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

  const disableMicrophone = useCallback(async (): Promise<void> => {
    const nextEpoch = epochRef.current + 1;
    epochRef.current = nextEpoch;
    microphoneEnabledRef.current = false;
    frameQueueRef.current.length = 0;
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

  const failVoiceCycle = useCallback((reason: string, permissionState?: VoicePermissionState): void => {
    safelySetError(reason);
    if (permissionState !== undefined && mountedRef.current) setPermission(permissionState);
    void disableMicrophone();
  }, [disableMicrophone, safelySetError]);

  const processFrameResult = useCallback((result: Awaited<ReturnType<BrowserVoiceStream["sendFrame"]>>, epoch: number): void => {
    if (epoch !== epochRef.current || !microphoneEnabledRef.current) return;
    if (result.events.some((event) => event.type === "SPEECH_STARTED")) {
      // The server emitted this event only after beginUtterance() committed the
      // authoritative invalidation. Physical interruption therefore follows,
      // rather than races ahead of, authority.
      optionsRef.current.interruptPlaybackForBargeIn();
    }
    if (result.commit !== undefined) {
      optionsRef.current.onVoiceCommit(result.commit);
    }
    if (result.terminal) streamRef.current = null;
  }, []);

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

        let stream = streamRef.current;
        if (stream === null || stream.isClosed) {
          try {
            stream = await client.openStream(sessionId);
          } catch (openError) {
            if (epoch !== epochRef.current) return;
            failVoiceCycle(safeVoiceError(openError));
            return;
          }
          if (!isVoiceEpochCurrent(epochRef.current, microphoneEnabledRef.current, epoch)) {
            await cancelStreamBounded(stream);
            return;
          }
          streamRef.current = stream;
        }

        const frame = frameQueueRef.current.shift();
        if (frame === undefined) continue;
        try {
          const result = await stream.sendFrame(frame);
          processFrameResult(result, epoch);
        } catch (frameError) {
          if (epoch !== epochRef.current) return;
          failVoiceCycle(safeVoiceError(frameError));
          return;
        }
      }
    } finally {
      drainingRef.current = false;
      if (
        epoch === epochRef.current
        && microphoneEnabledRef.current
        && frameQueueRef.current.length > 0
      ) {
        void drainFrames(epoch);
      }
    }
  }, [failVoiceCycle, processFrameResult]);

  const enqueueFrame = useCallback((frame: AudioFrame, epoch: number): void => {
    if (epoch !== epochRef.current || !microphoneEnabledRef.current) return;
    if (frameQueueRef.current.length >= MAX_PENDING_MICROPHONE_FRAMES) {
      failVoiceCycle("Microphone transport backpressure limit reached");
      return;
    }
    frameQueueRef.current.push(frame);
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
          if (epoch !== epochRef.current) return;
          failVoiceCycle(
            captureError.message,
            captureError.code === "PERMISSION_DENIED" ? "DENIED" : "ERROR"
          );
        }
      });
      if (!isVoiceEpochCurrent(epochRef.current, microphoneEnabledRef.current, epoch)) return;
      if (mountedRef.current) {
        setPermission("GRANTED");
        setListening(true);
      }
    } catch (captureError) {
      if (epoch !== epochRef.current) return;
      const classified = classifyCaptureError(captureError);
      if (mountedRef.current) setPermission(classified.permission);
      failVoiceCycle(classified.message);
    }
  }, [enqueueFrame, failVoiceCycle, safelySetError]);

  const enableMicrophone = useCallback(async (): Promise<void> => {
    if (microphoneEnabledRef.current) return;
    await startCapture(selectedInputRef.current);
  }, [startCapture]);

  const selectInputDevice = useCallback(async (deviceId: string | undefined): Promise<void> => {
    const normalized = normalizeDeviceId(deviceId);
    selectedInputRef.current = normalized;
    if (mountedRef.current) setInputDeviceId(normalized);
    if (!microphoneEnabledRef.current) return;
    await disableMicrophone();
    await startCapture(normalized);
  }, [disableMicrophone, startCapture]);

  const selectOutputDevice = useCallback((deviceId: string | undefined): void => {
    const normalized = normalizeDeviceId(deviceId);
    optionsRef.current.setOutputDeviceId(normalized);
    if (mountedRef.current) setOutputDeviceIdState(normalized);
  }, []);

  const refreshAudioDevices = useCallback(async (): Promise<void> => {
    const manager = devicesRef.current;
    if (manager === null) return;
    const result = await manager.enumerate();
    if (!mountedRef.current) return;
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
    epochRef.current += 1;
    microphoneEnabledRef.current = false;
    frameQueueRef.current.length = 0;
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
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => {
    controller.abort();
  }, VOICE_CANCEL_TIMEOUT_MS);
  try {
    await stream.cancel(controller.signal);
  } catch {
    // Transport cancellation is best-effort. Local integration epochs and the
    // server-side stream lease independently suppress late worker callbacks.
  } finally {
    globalThis.clearTimeout(timeout);
  }
}


function isVoiceEpochCurrent(
  currentEpoch: number,
  microphoneEnabled: boolean,
  expectedEpoch: number
): boolean {
  return currentEpoch === expectedEpoch && microphoneEnabled;
}
