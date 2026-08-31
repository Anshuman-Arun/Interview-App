import {
  browserMediaDevices,
  isPermissionDenied,
  type AudioMediaDevicesLike,
  type AudioMediaStreamLike,
  type AudioMediaStreamTrackLike
} from "./devices.js";
import {
  AudioInfrastructureError,
  type AudioCaptureState,
  type AudioFrame
} from "./types.js";

export interface CaptureAudioBufferLike {
  readonly sampleRate: number;
  readonly numberOfChannels: number;
  getChannelData(channel: number): Float32Array;
}

export interface CaptureAudioProcessEventLike {
  readonly inputBuffer: CaptureAudioBufferLike;
}

export interface CaptureAudioNodeLike {
  connect(destination: unknown): void;
  disconnect(): void;
}

export interface CaptureScriptProcessorLike extends CaptureAudioNodeLike {
  onaudioprocess: ((event: CaptureAudioProcessEventLike) => void) | null;
}

export interface CaptureAudioContextLike {
  readonly sampleRate: number;
  readonly destination: unknown;
  readonly state?: string;
  createMediaStreamSource(stream: AudioMediaStreamLike): CaptureAudioNodeLike;
  createScriptProcessor(bufferSize: number, inputChannels: number, outputChannels: number): CaptureScriptProcessorLike;
  resume?(): Promise<void>;
  close(): Promise<void>;
}

export interface BrowserMicrophoneCaptureEnvironment {
  readonly mediaDevices: AudioMediaDevicesLike | undefined;
  readonly createAudioContext: () => CaptureAudioContextLike;
  readonly now: () => number;
}

export interface MicrophoneCaptureOptions {
  readonly deviceId?: string;
  readonly channelCount?: number;
  readonly frameSize?: number;
  readonly onFrame: (frame: AudioFrame) => void;
  readonly onError?: (error: AudioInfrastructureError) => void;
}

interface CaptureResources {
  readonly operation: number;
  readonly tracks: readonly AudioMediaStreamTrackLike[];
  readonly trackEnded: () => void;
  readonly context: CaptureAudioContextLike;
  readonly source: CaptureAudioNodeLike;
  readonly processor: CaptureScriptProcessorLike;
}

const DEFAULT_FRAME_SIZE = 2_048;
const MAX_SCRIPT_PROCESSOR_CHANNELS = 32;
const SCRIPT_PROCESSOR_FRAME_SIZES: ReadonlySet<number> = new Set([
  256,
  512,
  1_024,
  2_048,
  4_096,
  8_192,
  16_384
]);

export class BrowserMicrophoneCapture {
  private stateValue: AudioCaptureState = "IDLE";
  private operation = 0;
  private disposeRequested = false;
  private resources: CaptureResources | undefined;
  private cleanupTail: Promise<void> = Promise.resolve();
  private setupTail: Promise<void> = Promise.resolve();
  private acquisitionTail: Promise<void> = Promise.resolve();
  private startAbort: AbortController | undefined;
  private sequence = 0;
  private startedAtMs = 0;
  private lastCapturedAtMs = 0;

  public constructor(
    private readonly environment: BrowserMicrophoneCaptureEnvironment = defaultCaptureEnvironment()
  ) {}

  public get state(): AudioCaptureState {
    return this.stateValue;
  }

  public async start(options: MicrophoneCaptureOptions): Promise<void> {
    this.assertUsable();
    if (this.stateValue === "STARTING") {
      throw new AudioInfrastructureError("CAPTURE_FAILED", "Microphone capture is already starting");
    }

    const admissionOperation = this.operation;
    let acceptedOptions: MicrophoneCaptureOptions;
    try {
      acceptedOptions = snapshotMicrophoneCaptureOptions(options);
    } catch (error) {
      this.assertUsable();
      if (this.operation !== admissionOperation) return;
      throw error;
    }
    this.assertUsable();
    if (this.operation !== admissionOperation) return;
    const deviceId = acceptedOptions.deviceId;
    const frameSize = acceptedOptions.frameSize ?? DEFAULT_FRAME_SIZE;
    const channelCount = acceptedOptions.channelCount ?? 1;
    const onFrame = acceptedOptions.onFrame;
    const onError = acceptedOptions.onError;

    if (this.stateValue === "CAPTURING") return;

    const capabilityOperation = this.operation;
    let mediaDevices: AudioMediaDevicesLike | undefined;
    let getUserMedia: AudioMediaDevicesLike["getUserMedia"];
    try {
      mediaDevices = this.environment.mediaDevices;
      getUserMedia = mediaDevices?.getUserMedia;
    } catch (error) {
      this.assertUsable();
      if (this.operation !== capabilityOperation) return;
      throw new AudioInfrastructureError(
        isPermissionDenied(error) ? "PERMISSION_DENIED" : "UNSUPPORTED",
        "Browser microphone capability could not be read",
        { cause: error }
      );
    }

    this.assertUsable();
    if (this.operation !== capabilityOperation) return;
    if (mediaDevices === undefined || typeof getUserMedia !== "function") {
      throw new AudioInfrastructureError("UNSUPPORTED", "Browser microphone APIs are unavailable");
    }

    const operation = ++this.operation;
    this.stateValue = "STARTING";

    await this.cleanupTail;
    if (!this.isCurrent(operation)) return;

    const startAbort = new AbortController();
    this.startAbort = startAbort;

    let stream: AudioMediaStreamLike | undefined;
    let tracks: readonly AudioMediaStreamTrackLike[] = [];
    let context: CaptureAudioContextLike | undefined;
    let source: CaptureAudioNodeLike | undefined;
    let processor: CaptureScriptProcessorLike | undefined;
    let trackEnded: (() => void) | undefined;
    let trackEndedDuringStart = false;
    let releaseAcquisition: (() => void) | undefined;
    let releaseSetup: (() => void) | undefined;

    try {
      const acquisition = await this.acquireStream(
        operation,
        startAbort.signal,
        () => getUserMedia.call(mediaDevices, {
          audio: {
            channelCount,
            ...(deviceId === undefined || deviceId === "" || deviceId === "default"
              ? {}
              : { deviceId: { exact: deviceId } })
          },
          video: false
        })
      );
      if (acquisition === undefined) return;
      stream = acquisition.stream;
      releaseAcquisition = acquisition.release;
      releaseSetup = this.beginSetupTracking();

      if (!this.isCurrent(operation)) {
        stopStreamAudioTracks(stream);
        return;
      }

      const getAudioTracks = stream.getAudioTracks;
      this.throwIfOperationSuperseded(operation);
      if (typeof getAudioTracks !== "function") {
        throw new AudioInfrastructureError(
          "CAPTURE_FAILED",
          "Microphone stream does not expose a callable getAudioTracks method"
        );
      }
      const streamTracks = getAudioTracks.call(stream);
      this.throwIfOperationSuperseded(operation);
      if (!Array.isArray(streamTracks)) {
        throw new AudioInfrastructureError(
          "CAPTURE_FAILED",
          "Microphone stream audio tracks must be returned as an array"
        );
      }
      const ownedTracks: AudioMediaStreamTrackLike[] = [];
      const ownedTrackSet = new Set<AudioMediaStreamTrackLike>();
      tracks = ownedTracks;
      for (let index = 0; index < streamTracks.length; index += 1) {
        const track = streamTracks[index];
        this.throwIfOperationSuperseded(operation);
        if (typeof track !== "object" || track === null) {
          throw new AudioInfrastructureError(
            "CAPTURE_FAILED",
            "Microphone stream contained malformed audio track metadata"
          );
        }
        if (ownedTrackSet.has(track)) continue;

        const stopTrack = track.stop;
        this.throwIfOperationSuperseded(operation);
        const addEndedListener = track.addEventListener;
        this.throwIfOperationSuperseded(operation);
        const removeEndedListener = track.removeEventListener;
        this.throwIfOperationSuperseded(operation);
        if (
          typeof stopTrack !== "function"
          || typeof addEndedListener !== "function"
          || typeof removeEndedListener !== "function"
        ) {
          throw new AudioInfrastructureError(
            "CAPTURE_FAILED",
            "Microphone stream contained an audio track without required lifecycle methods"
          );
        }
        ownedTrackSet.add(track);
        ownedTracks.push(track);
      }
      this.throwIfOperationSuperseded(operation);
      if (tracks.length === 0) {
        throw new AudioInfrastructureError("DEVICE_UNAVAILABLE", "Microphone stream contained no audio track");
      }
      if (this.anyTrackEnded(tracks, operation)) {
        throw new AudioInfrastructureError("DEVICE_UNAVAILABLE", "Microphone stream contained an ended audio track");
      }

      const createAudioContext = this.environment.createAudioContext;
      this.throwIfOperationSuperseded(operation);
      context = createAudioContext.call(this.environment);
      this.throwIfOperationSuperseded(operation);
      const captureSampleRate = readCaptureContextSampleRate(context);
      this.throwIfOperationSuperseded(operation);
      const contextReady = await ensureCaptureContextRunning(context, startAbort.signal);
      if (!contextReady || !this.isCurrent(operation)) {
        await this.trackCleanup(releaseCaptureParts(tracks, undefined, context, undefined, undefined));
        return;
      }

      const createMediaStreamSource = context.createMediaStreamSource;
      this.throwIfOperationSuperseded(operation);
      source = createMediaStreamSource.call(context, stream);
      this.throwIfOperationSuperseded(operation);
      this.validateCaptureNode(source, "media stream source", operation);

      const createScriptProcessor = context.createScriptProcessor;
      this.throwIfOperationSuperseded(operation);
      processor = createScriptProcessor.call(context, frameSize, channelCount, 1);
      this.throwIfOperationSuperseded(operation);
      this.validateCaptureNode(processor, "script processor", operation);
      trackEnded = (): void => {
        if (this.stateValue === "STARTING" && this.isCurrent(operation)) {
          trackEndedDuringStart = true;
          return;
        }
        void this.fail(
          operation,
          new AudioInfrastructureError("DEVICE_UNAVAILABLE", "Microphone device became unavailable"),
          onError
        );
      };

      for (const track of tracks) {
        const addEndedListener = track.addEventListener;
        this.throwIfOperationSuperseded(operation);
        addEndedListener.call(track, "ended", trackEnded);
        this.throwIfOperationSuperseded(operation);
      }
      const trackEndedAfterListenerInstall = this.anyTrackEnded(tracks, operation);
      if (trackEndedDuringStart || trackEndedAfterListenerInstall) {
        throw new AudioInfrastructureError(
          "DEVICE_UNAVAILABLE",
          "Microphone device became unavailable during capture setup"
        );
      }

      const sourceConnect = source.connect;
      this.throwIfOperationSuperseded(operation);
      sourceConnect.call(source, processor);
      this.throwIfOperationSuperseded(operation);

      const destination = context.destination;
      this.throwIfOperationSuperseded(operation);
      const processorConnect = processor.connect;
      this.throwIfOperationSuperseded(operation);
      processorConnect.call(processor, destination);
      this.throwIfOperationSuperseded(operation);

      const trackEndedAfterConnect = this.anyTrackEnded(tracks, operation);
      if (trackEndedDuringStart || trackEndedAfterConnect) {
        throw new AudioInfrastructureError(
          "DEVICE_UNAVAILABLE",
          "Microphone device became unavailable during capture setup"
        );
      }

      if (!this.isCurrent(operation)) {
        await this.trackCleanup(releaseCaptureParts(tracks, trackEnded, context, source, processor));
        return;
      }

      this.sequence = 0;
      this.startedAtMs = this.readCaptureTime(operation);
      this.throwIfOperationSuperseded(operation);
      this.lastCapturedAtMs = this.startedAtMs;
      const trackEndedBeforeHandler = this.anyTrackEnded(tracks, operation);
      if (trackEndedDuringStart || trackEndedBeforeHandler) {
        throw new AudioInfrastructureError(
          "DEVICE_UNAVAILABLE",
          "Microphone device became unavailable during capture setup"
        );
      }

      this.throwIfOperationSuperseded(operation);
      processor.onaudioprocess = (event): void => {
        if (this.stateValue !== "CAPTURING" || !this.isCurrent(operation)) return;
        try {
          const inputBuffer = event.inputBuffer;
          this.throwIfOperationSuperseded(operation);
          const consumerResult: unknown = onFrame(
            this.makeFrame(
              inputBuffer,
              captureSampleRate,
              channelCount,
              frameSize,
              operation
            )
          );
          if (isPromiseLike(consumerResult)) {
            void Promise.resolve(consumerResult).catch((error: unknown) =>
              this.fail(
                operation,
                new AudioInfrastructureError(
                  "CAPTURE_FAILED",
                  "Audio frame consumer rejected",
                  { cause: error }
                ),
                onError
              )
            );
          }
        } catch (error) {
          void this.fail(
            operation,
            new AudioInfrastructureError("CAPTURE_FAILED", "Audio frame processing failed", { cause: error }),
            onError
          );
        }
      };
      this.throwIfOperationSuperseded(operation);

      const trackEndedAfterHandler = this.anyTrackEnded(tracks, operation);
      if (trackEndedDuringStart || trackEndedAfterHandler) {
        throw new AudioInfrastructureError(
          "DEVICE_UNAVAILABLE",
          "Microphone device became unavailable during capture setup"
        );
      }

      this.resources = { operation, tracks, trackEnded, context, source, processor };
      stream = undefined;
      if (this.isCurrent(operation)) {
        this.stateValue = "CAPTURING";
      } else {
        await this.releaseResourcesForOperation(operation);
      }
    } catch (error) {
      if (stream !== undefined) {
        stopStreamAudioTracks(stream, tracks);
      }
      await this.trackCleanup(releaseCaptureParts(tracks, trackEnded, context, source, processor));
      if (!this.isCurrent(operation)) return;

      const mapped = mapCaptureError(error);
      if (!this.isCurrent(operation)) return;
      this.stateValue = "FAILED";
      notifyCaptureError(onError, mapped);
      throw mapped;
    } finally {
      releaseAcquisition?.();
      releaseSetup?.();
      if (this.startAbort === startAbort) this.startAbort = undefined;
      startAbort.abort();
    }
  }

  public async restart(options: MicrophoneCaptureOptions): Promise<void> {
    this.assertUsable();
    const admissionOperation = this.operation;
    let acceptedOptions: MicrophoneCaptureOptions;
    try {
      acceptedOptions = snapshotMicrophoneCaptureOptions(options);
    } catch (error) {
      this.assertUsable();
      if (this.operation !== admissionOperation) return;
      throw error;
    }
    this.assertUsable();
    if (this.operation !== admissionOperation) return;

    const stopping = this.stop();
    const restartStopOperation = this.operation;
    await stopping;

    this.assertUsable();
    if (this.operation !== restartStopOperation) return;
    await this.start(acceptedOptions);
  }

  public async cancel(): Promise<void> {
    await this.stop();
  }

  public async stop(): Promise<void> {
    if (this.disposeRequested || this.stateValue === "DISPOSED") {
      await Promise.all([this.cleanupTail, this.setupTail]);
      return;
    }

    this.abortStartWait();
    ++this.operation;
    this.stateValue = "STOPPED";
    await Promise.all([this.releaseResources(), this.setupTail]);
  }

  public async dispose(): Promise<void> {
    this.abortStartWait();
    if (!this.disposeRequested) {
      this.disposeRequested = true;
      ++this.operation;
      this.stateValue = "DISPOSED";
    }
    await Promise.all([this.releaseResources(), this.setupTail]);
  }

  private abortStartWait(): void {
    const controller = this.startAbort;
    this.startAbort = undefined;
    controller?.abort();
  }

  private beginSetupTracking(): () => void {
    let resolveSetup: (() => void) | undefined;
    const setup = new Promise<void>((resolve) => {
      resolveSetup = resolve;
    });
    const previous = this.setupTail.catch(() => undefined);
    this.setupTail = Promise.all([previous, setup]).then(() => undefined);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      resolveSetup?.();
    };
  }

  private async acquireStream(
    operation: number,
    signal: AbortSignal,
    acquire: () => Promise<AudioMediaStreamLike>
  ): Promise<{
    readonly stream: AudioMediaStreamLike;
    readonly release: () => void;
  } | undefined> {
    const previous = this.acquisitionTail;
    let releaseSlot: (() => void) | undefined;
    const slot = new Promise<void>((resolve) => {
      releaseSlot = resolve;
    });
    this.acquisitionTail = previous.then(() => slot, () => slot);
    const previousFinished = await waitForPromiseOrAbort(previous, signal);

    if (releaseSlot === undefined) {
      throw new Error("Audio acquisition slot was not initialized");
    }
    const releaseReservedSlot = releaseSlot;

    if (!previousFinished || !this.isCurrent(operation)) {
      releaseReservedSlot();
      return undefined;
    }

    let acquisitionPromise: Promise<AudioMediaStreamLike>;
    try {
      acquisitionPromise = Promise.resolve(acquire());
    } catch (error) {
      releaseReservedSlot();
      throw error;
    }

    const outcome = await waitForMediaStreamOrAbort(acquisitionPromise, signal);
    if (outcome.status === "ABORTED") {
      // getUserMedia itself cannot be aborted. Detach this start() from the
      // browser wait, but keep the serialization slot reserved until the
      // browser eventually settles so a replacement acquisition cannot overlap.
      void acquisitionPromise.then(
        (lateStream) => {
          try {
            stopStreamAudioTracks(lateStream);
          } finally {
            releaseReservedSlot();
          }
        },
        () => {
          releaseReservedSlot();
        }
      );
      return undefined;
    }

    if (outcome.status === "REJECTED") {
      releaseReservedSlot();
      throw outcome.error;
    }

    const stream = outcome.stream;
    if (!this.isCurrent(operation)) {
      try {
        stopStreamAudioTracks(stream);
      } finally {
        releaseReservedSlot();
      }
      return undefined;
    }

    let released = false;
    return {
      stream,
      release: () => {
        if (released) return;
        released = true;
        releaseReservedSlot();
      }
    };
  }

  private validateCaptureNode(
    node: CaptureAudioNodeLike,
    label: string,
    operation: number
  ): void {
    if (typeof node !== "object" || node === null) {
      throw new AudioInfrastructureError(
        "CAPTURE_FAILED",
        `Audio ${label} factory returned a non-object value`
      );
    }
    const connect = node.connect;
    this.throwIfOperationSuperseded(operation);
    const disconnect = node.disconnect;
    this.throwIfOperationSuperseded(operation);
    if (typeof connect !== "function" || typeof disconnect !== "function") {
      throw new AudioInfrastructureError(
        "CAPTURE_FAILED",
        `Audio ${label} does not expose callable connect/disconnect methods`
      );
    }
  }

  private anyTrackEnded(
    tracks: readonly AudioMediaStreamTrackLike[],
    operation: number
  ): boolean {
    for (const track of tracks) {
      const readyState = track.readyState;
      this.throwIfOperationSuperseded(operation);
      if (
        readyState !== undefined
        && readyState !== "live"
        && readyState !== "ended"
      ) {
        throw new AudioInfrastructureError(
          "CAPTURE_FAILED",
          "Microphone track reported an invalid readyState"
        );
      }
      if (readyState === "ended") return true;
    }
    return false;
  }

  private makeFrame(
    buffer: CaptureAudioBufferLike,
    expectedSampleRate: number,
    expectedChannelCount: number,
    maximumSampleCount: number,
    operation: number
  ): AudioFrame {
    const sampleRate = buffer.sampleRate;
    this.throwIfOperationSuperseded(operation);
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
      throw new RangeError("Audio input buffer sample rate must be a positive finite number");
    }
    if (sampleRate !== expectedSampleRate) {
      throw new RangeError("Audio input buffer sample rate changed within a capture cycle");
    }

    const channelCount = buffer.numberOfChannels;
    this.throwIfOperationSuperseded(operation);
    if (!Number.isSafeInteger(channelCount) || channelCount < 1 || channelCount > MAX_SCRIPT_PROCESSOR_CHANNELS) {
      throw new RangeError("Audio input buffer channel count must be an integer from 1 through 32");
    }
    if (channelCount !== expectedChannelCount) {
      throw new RangeError("Audio input buffer channel count changed within a capture cycle");
    }

    const getChannelData = buffer.getChannelData;
    this.throwIfOperationSuperseded(operation);
    if (typeof getChannelData !== "function") {
      throw new RangeError("Audio input buffer must expose getChannelData");
    }

    const channels: Float32Array[] = [];
    let sampleCount: number | undefined;
    for (let channel = 0; channel < channelCount; channel += 1) {
      const channelSamples = getChannelData.call(buffer, channel);
      this.throwIfOperationSuperseded(operation);
      if (!(channelSamples instanceof Float32Array)) {
        throw new RangeError("Audio input buffer channel data must be Float32Array PCM");
      }
      if (sampleCount === undefined) {
        sampleCount = channelSamples.length;
        if (sampleCount < 1) {
          throw new RangeError("Audio input buffer must contain at least one sample");
        }
        if (sampleCount > maximumSampleCount) {
          throw new RangeError("Audio input buffer exceeded the configured capture frame size");
        }
      } else if (channelSamples.length !== sampleCount) {
        throw new RangeError("Audio input buffer channels must contain the same number of samples");
      }
      channels.push(channelSamples);
    }

    if (sampleCount === undefined) {
      throw new RangeError("Audio input buffer contained no channels");
    }

    const samples = new Float32Array(sampleCount * channelCount);
    for (let channel = 0; channel < channelCount; channel += 1) {
      const channelSamples = channels[channel];
      if (channelSamples === undefined) {
        throw new RangeError("Audio input buffer channel disappeared during normalization");
      }
      for (let sample = 0; sample < sampleCount; sample += 1) {
        const value = channelSamples[sample];
        if (value === undefined || !Number.isFinite(value)) {
          throw new RangeError("Audio input buffer samples must be finite numbers");
        }
        samples[sample * channelCount + channel] = value;
      }
    }

    const capturedAtMs = this.readCaptureTime(operation);
    this.throwIfOperationSuperseded(operation);
    if (capturedAtMs < this.lastCapturedAtMs) {
      throw new RangeError("Audio capture clock moved backwards within a capture cycle");
    }

    const offsetMs = capturedAtMs - this.startedAtMs;
    if (!Number.isFinite(offsetMs) || offsetMs < 0) {
      throw new RangeError("Audio capture offset must remain a non-negative finite number");
    }
    if (!Number.isSafeInteger(this.sequence) || this.sequence < 0) {
      throw new RangeError("Audio capture sequence must remain a non-negative safe integer");
    }
    this.throwIfOperationSuperseded(operation);
    const frame: AudioFrame = {
      sequence: this.sequence,
      sampleRate,
      channelCount,
      capturedAtMs,
      offsetMs,
      samples
    };
    if (this.sequence === Number.MAX_SAFE_INTEGER) {
      throw new RangeError("Audio capture sequence exhausted the safe integer range");
    }
    this.sequence += 1;
    this.lastCapturedAtMs = capturedAtMs;
    this.throwIfOperationSuperseded(operation);
    return frame;
  }

  private readCaptureTime(operation: number): number {
    const now = this.environment.now;
    this.throwIfOperationSuperseded(operation);
    if (typeof now !== "function") {
      throw new RangeError("Audio capture environment must expose a callable clock");
    }

    const value = now.call(this.environment);
    this.throwIfOperationSuperseded(operation);
    if (!Number.isFinite(value)) {
      throw new RangeError("Audio capture clock must return a finite timestamp");
    }
    return value;
  }

  private async fail(
    operation: number,
    error: AudioInfrastructureError,
    onError: ((error: AudioInfrastructureError) => void) | undefined
  ): Promise<void> {
    if (!this.isCurrent(operation)) return;
    if (this.stateValue !== "CAPTURING" && this.stateValue !== "STARTING") return;

    ++this.operation;
    this.stateValue = "FAILED";
    const cleanup = this.releaseResourcesForOperation(operation);
    notifyCaptureError(onError, error);
    await cleanup;
  }

  private releaseResources(): Promise<void> {
    const resources = this.resources;
    this.resources = undefined;
    if (resources === undefined) return this.cleanupTail;

    return this.trackCleanup(
      releaseCaptureParts(
        resources.tracks,
        resources.trackEnded,
        resources.context,
        resources.source,
        resources.processor
      )
    );
  }

  private releaseResourcesForOperation(operation: number): Promise<void> {
    const resources = this.resources;
    if (resources?.operation !== operation) return this.cleanupTail;
    this.resources = undefined;

    return this.trackCleanup(
      releaseCaptureParts(
        resources.tracks,
        resources.trackEnded,
        resources.context,
        resources.source,
        resources.processor
      )
    );
  }

  private trackCleanup(cleanup: Promise<void>): Promise<void> {
    const previous = this.cleanupTail.catch(() => undefined);
    const guardedCleanup = cleanup.catch(() => undefined);
    this.cleanupTail = Promise.all([previous, guardedCleanup]).then(() => undefined);
    return this.cleanupTail;
  }

  private throwIfOperationSuperseded(operation: number): void {
    if (this.isCurrent(operation)) return;
    throw new AudioInfrastructureError(
      "CANCELLED",
      "Microphone capture operation was superseded by a newer lifecycle command"
    );
  }

  private isCurrent(operation: number): boolean {
    return !this.disposeRequested && operation === this.operation;
  }

  private assertUsable(): void {
    if (this.disposeRequested || this.stateValue === "DISPOSED") {
      throw new AudioInfrastructureError("DISPOSED", "Microphone capture has been disposed");
    }
  }
}

function snapshotMicrophoneCaptureOptions(options: MicrophoneCaptureOptions): MicrophoneCaptureOptions {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("Audio capture options must be an object");
  }

  const deviceId = options.deviceId;
  const frameSize = options.frameSize ?? DEFAULT_FRAME_SIZE;
  const channelCount = options.channelCount ?? 1;
  const onFrame = options.onFrame;
  const onError = options.onError;

  if (deviceId !== undefined) {
    if (typeof deviceId !== "string") {
      throw new TypeError("Audio capture deviceId must be a string");
    }
    if (deviceId.length > 0 && deviceId.trim().length === 0) {
      throw new TypeError("Audio capture deviceId must not be whitespace-only");
    }
  }
  if (typeof onFrame !== "function") {
    throw new TypeError("Audio capture onFrame callback must be callable");
  }
  if (onError !== undefined && typeof onError !== "function") {
    throw new TypeError("Audio capture onError callback must be callable");
  }
  if (!SCRIPT_PROCESSOR_FRAME_SIZES.has(frameSize)) {
    throw new RangeError(
      "Audio capture frame size must be one of 256, 512, 1024, 2048, 4096, 8192, or 16384 samples"
    );
  }
  if (!Number.isInteger(channelCount) || channelCount < 1 || channelCount > MAX_SCRIPT_PROCESSOR_CHANNELS) {
    throw new RangeError("Audio capture channel count must be an integer from 1 through 32");
  }

  return {
    ...(deviceId === undefined ? {} : { deviceId }),
    frameSize,
    channelCount,
    onFrame,
    ...(onError === undefined ? {} : { onError })
  };
}

export function defaultCaptureEnvironment(): BrowserMicrophoneCaptureEnvironment {
  return {
    mediaDevices: browserMediaDevices(),
    createAudioContext: () => {
      let AudioContextConstructor: typeof globalThis.AudioContext;
      try {
        AudioContextConstructor = globalThis.AudioContext;
      } catch (error) {
        throw new AudioInfrastructureError(
          "UNSUPPORTED",
          "Web Audio API capability could not be read",
          { cause: error }
        );
      }
      if (typeof AudioContextConstructor !== "function") {
        throw new AudioInfrastructureError("UNSUPPORTED", "Web Audio API is unavailable");
      }

      const context = new AudioContextConstructor();
      const runtimeContext: unknown = context;
      if (!isCaptureAudioContextLike(runtimeContext)) {
        closeUnknownAudioContext(runtimeContext);
        throw new AudioInfrastructureError(
          "UNSUPPORTED",
          "Required Web Audio capture APIs are unavailable"
        );
      }
      return runtimeContext;
    },
    now: () => globalThis.performance.now()
  };
}

async function releaseCaptureParts(
  tracks: readonly AudioMediaStreamTrackLike[],
  trackEnded: (() => void) | undefined,
  context: CaptureAudioContextLike | undefined,
  source: CaptureAudioNodeLike | undefined,
  processor: CaptureScriptProcessorLike | undefined
): Promise<void> {
  if (processor !== undefined) {
    try {
      processor.onaudioprocess = null;
    } catch {
      // Continue releasing the remaining owned resources.
    }
  }

  if (trackEnded !== undefined) {
    try {
      for (const track of tracks) {
        try {
          track.removeEventListener("ended", trackEnded);
        } catch {
          // Continue releasing the remaining owned resources.
        }
      }
    } catch {
      // A malformed track collection must not skip node/context cleanup below.
    }
  }

  if (source !== undefined) {
    try {
      source.disconnect();
    } catch {
      // A browser may reject disconnect for a node that failed before attachment.
    }
  }
  if (processor !== undefined) {
    try {
      processor.disconnect();
    } catch {
      // A browser may reject disconnect for a node that failed before attachment.
    }
  }

  stopTracks(tracks);

  if (context !== undefined) {
    try {
      await context.close();
    } catch {
      // Resource release is best-effort after tracks and nodes have been detached.
    }
  }
}

function readCaptureContextSampleRate(context: CaptureAudioContextLike): number {
  const sampleRate = context.sampleRate;
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new AudioInfrastructureError(
      "CAPTURE_FAILED",
      "Audio context reported an invalid sample rate"
    );
  }
  return sampleRate;
}

async function ensureCaptureContextRunning(
  context: CaptureAudioContextLike,
  signal: AbortSignal
): Promise<boolean> {
  if (signal.aborted) return false;

  const initialState = context.state;
  if (signal.aborted) return false;
  if (initialState === undefined || initialState === "running") return true;
  if (initialState === "closed") {
    throw new AudioInfrastructureError("CAPTURE_FAILED", "Audio context is already closed");
  }

  const resume = context.resume;
  if (signal.aborted) return false;
  if (typeof resume !== "function") {
    throw new AudioInfrastructureError(
      "UNSUPPORTED",
      "Resuming a suspended audio context is unsupported"
    );
  }

  let resumePromise: Promise<void>;
  try {
    resumePromise = Promise.resolve(resume.call(context));
  } catch (error) {
    throw mapAudioContextResumeError(error);
  }

  const outcome = await waitForPromiseOutcomeOrAbort(resumePromise, signal);
  if (outcome.status === "ABORTED") return false;
  if (outcome.status === "REJECTED") {
    throw mapAudioContextResumeError(outcome.error);
  }

  const resumedState = context.state;
  if (resumedState !== undefined && resumedState !== "running") {
    throw new AudioInfrastructureError(
      "CAPTURE_FAILED",
      `Audio context did not enter running state (state: ${resumedState})`
    );
  }
  return true;
}

type PromiseAbortOutcome =
  | { readonly status: "RESOLVED" }
  | { readonly status: "REJECTED"; readonly error: unknown }
  | { readonly status: "ABORTED" };

async function waitForPromiseOutcomeOrAbort(
  promise: Promise<void>,
  signal: AbortSignal
): Promise<PromiseAbortOutcome> {
  if (signal.aborted) {
    void promise.catch(() => undefined);
    return { status: "ABORTED" };
  }

  return new Promise<PromiseAbortOutcome>((resolve) => {
    let settled = false;
    const onAbort = (): void => finish({ status: "ABORTED" });
    const finish = (outcome: PromiseAbortOutcome): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(outcome);
    };

    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      () => finish({ status: "RESOLVED" }),
      (error: unknown) => finish({ status: "REJECTED", error })
    );
  });
}

function mapAudioContextResumeError(error: unknown): AudioInfrastructureError {
  if (error instanceof AudioInfrastructureError) return error;
  if (isPermissionDenied(error)) {
    return new AudioInfrastructureError(
      "PERMISSION_DENIED",
      "Audio context resume was not permitted",
      { cause: error }
    );
  }
  return new AudioInfrastructureError(
    "CAPTURE_FAILED",
    "Audio context could not resume",
    { cause: error }
  );
}

type MediaStreamAbortOutcome =
  | { readonly status: "RESOLVED"; readonly stream: AudioMediaStreamLike }
  | { readonly status: "REJECTED"; readonly error: unknown }
  | { readonly status: "ABORTED" };

async function waitForMediaStreamOrAbort(
  promise: Promise<AudioMediaStreamLike>,
  signal: AbortSignal
): Promise<MediaStreamAbortOutcome> {
  if (signal.aborted) {
    void promise.catch(() => undefined);
    return { status: "ABORTED" };
  }

  return new Promise<MediaStreamAbortOutcome>((resolve) => {
    let settled = false;
    const onAbort = (): void => finish({ status: "ABORTED" });
    const finish = (outcome: MediaStreamAbortOutcome): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(outcome);
    };

    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (stream) => finish({ status: "RESOLVED", stream }),
      (error: unknown) => finish({ status: "REJECTED", error })
    );
  });
}

async function waitForPromiseOrAbort(
  promise: Promise<void>,
  signal: AbortSignal
): Promise<boolean> {
  if (signal.aborted) return false;

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const onAbort = (): void => finish(false);
    const finish = (completed: boolean): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(completed);
    };

    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      () => finish(true),
      () => finish(true)
    );
  });
}

function stopStreamAudioTracks(
  stream: AudioMediaStreamLike,
  alreadyOwned: readonly AudioMediaStreamTrackLike[] = []
): void {
  const handled = new Set<AudioMediaStreamTrackLike>(alreadyOwned);
  const stopReturnedTracks = (tracks: readonly AudioMediaStreamTrackLike[]): boolean => {
    if (!Array.isArray(tracks)) return false;
    for (let index = 0; index < tracks.length; index += 1) {
      let track: AudioMediaStreamTrackLike | undefined;
      try {
        track = tracks[index];
      } catch {
        continue;
      }
      if (track === undefined || handled.has(track)) continue;
      handled.add(track);
      try {
        track.stop();
      } catch {
        // Continue attempting to stop other independently accessible tracks.
      }
    }
    return true;
  };

  try {
    const getAudioTracks = stream.getAudioTracks;
    if (typeof getAudioTracks === "function") {
      try {
        stopReturnedTracks(getAudioTracks.call(stream));
      } catch {
        // Continue to getTracks(), which real MediaStream also exposes.
      }
    }
  } catch {
    // Fall through to getTracks().
  }

  try {
    const getTracks = stream.getTracks;
    if (typeof getTracks !== "function") return;
    stopReturnedTracks(getTracks.call(stream));
  } catch {
    // Best-effort late-stream cleanup cannot access any remaining tracks.
  }
}

function stopTracks(tracks: readonly AudioMediaStreamTrackLike[]): void {
  try {
    for (const track of tracks) {
      try {
        track.stop();
      } catch {
        // Continue stopping other tracks and closing the capture context.
      }
    }
  } catch {
    // Malformed browser values must not poison later cleanup/start cycles.
  }
}

function notifyCaptureError(
  callback: ((error: AudioInfrastructureError) => void) | undefined,
  error: AudioInfrastructureError
): void {
  try {
    const observerResult: unknown = callback?.(error);
    if (isPromiseLike(observerResult)) {
      void Promise.resolve(observerResult).catch(() => undefined);
    }
  } catch {
    // Error observers do not own the capture lifecycle.
  }
}

function mapCaptureError(error: unknown): AudioInfrastructureError {
  if (error instanceof AudioInfrastructureError) return error;
  if (isPermissionDenied(error)) {
    return new AudioInfrastructureError("PERMISSION_DENIED", "Microphone permission was denied", { cause: error });
  }

  const name = errorName(error);
  if (name === "NotFoundError" || name === "OverconstrainedError" || name === "NotReadableError") {
    return new AudioInfrastructureError("DEVICE_UNAVAILABLE", "Requested microphone is unavailable", { cause: error });
  }

  return new AudioInfrastructureError("CAPTURE_FAILED", "Microphone capture failed", { cause: error });
}

function closeUnknownAudioContext(value: unknown): void {
  try {
    if (typeof value !== "object" || value === null) return;
    const close = Reflect.get(value, "close");
    if (typeof close !== "function") return;
    const result = Reflect.apply(close, value, []);
    void Promise.resolve(result).catch(() => undefined);
  } catch {
    // Capability detection still reports UNSUPPORTED even if partial cleanup is impossible.
  }
}

function isCaptureAudioContextLike(value: unknown): value is CaptureAudioContextLike {
  try {
    if (typeof value !== "object" || value === null) return false;
    const sampleRate = Reflect.get(value, "sampleRate");
    return typeof sampleRate === "number"
      && Number.isFinite(sampleRate)
      && sampleRate > 0
      && "destination" in value
      && typeof Reflect.get(value, "createMediaStreamSource") === "function"
      && typeof Reflect.get(value, "createScriptProcessor") === "function"
      && typeof Reflect.get(value, "close") === "function";
  } catch {
    return false;
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  try {
    if ((typeof value !== "object" || value === null) && typeof value !== "function") return false;
    return typeof Reflect.get(value, "then") === "function";
  } catch {
    return false;
  }
}

function errorName(error: unknown): string {
  try {
    if (typeof error !== "object" || error === null || !("name" in error)) return "";
    return String(Reflect.get(error, "name"));
  } catch {
    return "";
  }
}
