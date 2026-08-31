import type { AudioFrame } from "./types.js";

export interface AudioBufferPushResult {
  readonly accepted: boolean;
  readonly droppedOldest: AudioFrame | undefined;
}

export class BoundedAudioFrameBuffer {
  private readonly frames: AudioFrame[] = [];
  private readonly capacityValue: number;
  private cancelled = false;
  private mutationEpoch = 0;

  public constructor(capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new RangeError("Audio buffer capacity must be a positive safe integer");
    }
    this.capacityValue = capacity;
  }

  public get capacity(): number {
    return this.capacityValue;
  }

  public get size(): number {
    return this.frames.length;
  }

  public get isCancelled(): boolean {
    return this.cancelled;
  }

  public push(frame: AudioFrame): AudioBufferPushResult {
    if (this.cancelled) return { accepted: false, droppedOldest: undefined };

    const mutationEpoch = this.mutationEpoch;
    const snapshot = snapshotAudioFrame(frame);
    const ownedSnapshot = ownAudioFrameSnapshot(snapshot);
    if (this.cancelled || this.mutationEpoch !== mutationEpoch) {
      return { accepted: false, droppedOldest: undefined };
    }
    validateAudioFrame(ownedSnapshot);
    if (this.cancelled || this.mutationEpoch !== mutationEpoch) {
      return { accepted: false, droppedOldest: undefined };
    }
    const ownedFrame: AudioFrame = ownedSnapshot;

    let droppedOldest: AudioFrame | undefined;
    if (this.frames.length === this.capacity) {
      droppedOldest = this.frames.shift();
    }
    this.frames.push(ownedFrame);
    return { accepted: true, droppedOldest };
  }

  public shift(): AudioFrame | undefined {
    if (this.cancelled) return undefined;
    return this.frames.shift();
  }

  public peek(): AudioFrame | undefined {
    if (this.cancelled) return undefined;
    const frame = this.frames[0];
    return frame === undefined ? undefined : cloneValidatedAudioFrame(frame);
  }

  public clear(): void {
    this.mutationEpoch += 1;
    this.frames.length = 0;
  }

  public cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.clear();
  }

  public snapshot(): readonly AudioFrame[] {
    return this.frames.map(cloneValidatedAudioFrame);
  }
}

interface AudioFrameSnapshot {
  readonly sequence: unknown;
  readonly sampleRate: unknown;
  readonly channelCount: unknown;
  readonly capturedAtMs: unknown;
  readonly offsetMs: unknown;
  readonly samples: unknown;
}

function snapshotAudioFrame(frame: AudioFrame): AudioFrameSnapshot {
  if (typeof frame !== "object" || frame === null) {
    throw new RangeError("Audio frame must be an object");
  }

  return {
    sequence: frame.sequence,
    sampleRate: frame.sampleRate,
    channelCount: frame.channelCount,
    capturedAtMs: frame.capturedAtMs,
    offsetMs: frame.offsetMs,
    samples: frame.samples
  };
}

function ownAudioFrameSnapshot(frame: AudioFrameSnapshot): AudioFrameSnapshot {
  const samples = frame.samples;
  return {
    sequence: frame.sequence,
    sampleRate: frame.sampleRate,
    channelCount: frame.channelCount,
    capturedAtMs: frame.capturedAtMs,
    offsetMs: frame.offsetMs,
    samples: samples instanceof Float32Array ? new Float32Array(samples) : samples
  };
}

function validateAudioFrame(frame: AudioFrameSnapshot): asserts frame is AudioFrame {
  if (typeof frame.sequence !== "number" || !Number.isSafeInteger(frame.sequence) || frame.sequence < 0) {
    throw new RangeError("Audio frame sequence must be a non-negative safe integer");
  }
  if (typeof frame.sampleRate !== "number" || !Number.isFinite(frame.sampleRate) || frame.sampleRate <= 0) {
    throw new RangeError("Audio frame sample rate must be a positive finite number");
  }
  if (
    typeof frame.channelCount !== "number"
    || !Number.isSafeInteger(frame.channelCount)
    || frame.channelCount < 1
  ) {
    throw new RangeError("Audio frame channel count must be a positive safe integer");
  }
  if (typeof frame.capturedAtMs !== "number" || !Number.isFinite(frame.capturedAtMs)) {
    throw new RangeError("Audio frame capture timestamp must be finite");
  }
  if (typeof frame.offsetMs !== "number" || !Number.isFinite(frame.offsetMs) || frame.offsetMs < 0) {
    throw new RangeError("Audio frame offset must be a non-negative finite number");
  }
  if (!(frame.samples instanceof Float32Array) || frame.samples.length < 1) {
    throw new RangeError("Audio frame samples must be a non-empty Float32Array");
  }
  if (frame.samples.length % frame.channelCount !== 0) {
    throw new RangeError("Audio frame samples must contain complete interleaved channels");
  }
  for (const value of frame.samples) {
    if (!Number.isFinite(value)) {
      throw new RangeError("Audio frame samples must be finite numbers");
    }
  }
}

function cloneValidatedAudioFrame(frame: AudioFrame): AudioFrame {
  return {
    sequence: frame.sequence,
    sampleRate: frame.sampleRate,
    channelCount: frame.channelCount,
    capturedAtMs: frame.capturedAtMs,
    offsetMs: frame.offsetMs,
    samples: Float32Array.prototype.slice.call(frame.samples)
  };
}
