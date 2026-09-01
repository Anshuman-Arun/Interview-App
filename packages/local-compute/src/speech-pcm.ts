import { createHash } from "node:crypto";
import {
  MAX_SPEECH_BUFFERED_PCM_BYTES,
  MAX_SPEECH_TIMESTAMP_DRIFT_MS,
  MAX_SPEECH_UTTERANCE_DURATION_MS,
  SourceAudioBasisSchema,
  SpeechPcmFrameEnvelopeSchema,
  type SourceAudioBasis,
  type SpeechPcmFrameEnvelope,
  type SpeechStreamId
} from "./speech-protocol.js";

export type PcmAdmissionErrorCode =
  | "INVALID_FRAME"
  | "OUT_OF_ORDER_FRAME"
  | "STREAM_CONFLICT"
  | "RESOURCE_LIMIT";

export class PcmAdmissionError extends Error {
  public constructor(
    public readonly code: PcmAdmissionErrorCode,
    message: string
  ) {
    super(message);
  }
}

export interface PcmFrameSnapshot {
  readonly envelope: SpeechPcmFrameEnvelope;
  readonly bytes: Uint8Array;
  readonly durationMs: number;
  readonly fingerprint: string;
}

export interface PcmOrderState {
  readonly sampleRate: number;
  readonly channels: number;
  readonly sampleFormat: string;
  readonly firstTimestampMs: number;
  readonly cumulativeDurationMs: number;
  readonly lastSequence: number;
  readonly nextEarliestTimestampMs: number;
}

export function snapshotPcmFrame(input: unknown, payload: unknown): PcmFrameSnapshot {
  const parsed = SpeechPcmFrameEnvelopeSchema.safeParse(input);
  if (!parsed.success) throw new PcmAdmissionError("INVALID_FRAME", "PCM frame metadata is invalid");
  const envelope = parsed.data;
  if (!ArrayBuffer.isView(payload)) {
    throw new PcmAdmissionError("INVALID_FRAME", "PCM payload must be a binary ArrayBuffer view");
  }
  if (payload.byteLength !== envelope.payloadByteLength) {
    throw new PcmAdmissionError("INVALID_FRAME", "PCM payload length does not match declared length");
  }

  const source = new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
  const bytes = new Uint8Array(source.length);
  bytes.set(source);

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 0; offset < bytes.byteLength; offset += 4) {
    const sample = view.getFloat32(offset, true);
    if (!Number.isFinite(sample)) {
      throw new PcmAdmissionError("INVALID_FRAME", "PCM payload contains a non-finite sample");
    }
  }

  const durationMs = envelope.frameSamples / envelope.sampleRate * 1_000;
  return {
    envelope,
    bytes,
    durationMs,
    fingerprint: createHash("sha256").update(bytes).digest("hex")
  };
}

export function advancePcmOrder(
  prior: PcmOrderState | undefined,
  frame: PcmFrameSnapshot
): PcmOrderState {
  const { envelope, durationMs } = frame;
  if (prior === undefined) {
    if (envelope.sequence !== 0) {
      throw new PcmAdmissionError("OUT_OF_ORDER_FRAME", "A new PCM stream must begin at sequence zero");
    }
    return {
      sampleRate: envelope.sampleRate,
      channels: envelope.channels,
      sampleFormat: envelope.sampleFormat,
      firstTimestampMs: envelope.timestampMs,
      cumulativeDurationMs: durationMs,
      lastSequence: envelope.sequence,
      nextEarliestTimestampMs: envelope.timestampMs + durationMs
    };
  }

  if (envelope.sampleRate !== prior.sampleRate
      || envelope.channels !== prior.channels
      || envelope.sampleFormat !== prior.sampleFormat) {
    throw new PcmAdmissionError("STREAM_CONFLICT", "PCM format changed within a stream");
  }
  if (envelope.sequence !== prior.lastSequence + 1) {
    throw new PcmAdmissionError("OUT_OF_ORDER_FRAME", "PCM sequence is duplicated, skipped, or reversed");
  }
  if (envelope.timestampMs + 0.001 < prior.nextEarliestTimestampMs) {
    throw new PcmAdmissionError("OUT_OF_ORDER_FRAME", "PCM timestamps overlap or reverse");
  }
  const expectedTimestampMs = prior.firstTimestampMs + prior.cumulativeDurationMs;
  if (envelope.timestampMs - expectedTimestampMs > MAX_SPEECH_TIMESTAMP_DRIFT_MS + 0.001) {
    throw new PcmAdmissionError("OUT_OF_ORDER_FRAME", "PCM timestamp drift exceeds the allowed bound");
  }

  return {
    ...prior,
    cumulativeDurationMs: prior.cumulativeDurationMs + durationMs,
    lastSequence: envelope.sequence,
    nextEarliestTimestampMs: envelope.timestampMs + durationMs
  };
}

interface BufferedFrame {
  readonly snapshot: PcmFrameSnapshot;
  readonly speech: boolean;
}

export class BoundedPcmBuffer {
  private readonly frames: BufferedFrame[] = [];
  private byteLength = 0;
  private sampleCount = 0;
  private speechFrameCount = 0;

  public constructor(private readonly maxBytes = MAX_SPEECH_BUFFERED_PCM_BYTES) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_SPEECH_BUFFERED_PCM_BYTES) {
      throw new PcmAdmissionError("RESOURCE_LIMIT", "PCM buffer limit must remain within the hard speech bound");
    }
  }

  public append(snapshot: PcmFrameSnapshot, speech: boolean): void {
    const first = this.frames[0]?.snapshot;
    if (first !== undefined
        && (snapshot.envelope.sampleRate !== first.envelope.sampleRate
          || snapshot.envelope.channels !== first.envelope.channels
          || snapshot.envelope.sampleFormat !== first.envelope.sampleFormat)) {
      throw new PcmAdmissionError("STREAM_CONFLICT", "PCM buffer format changed within one utterance");
    }
    if (this.byteLength + snapshot.bytes.byteLength > this.maxBytes) {
      throw new PcmAdmissionError("RESOURCE_LIMIT", "PCM buffer limit exceeded");
    }
    const nextSampleCount = this.sampleCount + snapshot.envelope.frameSamples;
    const nextDurationMs = nextSampleCount / snapshot.envelope.sampleRate * 1_000;
    if (nextDurationMs > MAX_SPEECH_UTTERANCE_DURATION_MS + 0.001) {
      throw new PcmAdmissionError("RESOURCE_LIMIT", "PCM utterance duration limit exceeded");
    }
    this.frames.push({ snapshot, speech });
    this.byteLength += snapshot.bytes.byteLength;
    this.sampleCount = nextSampleCount;
    if (speech) this.speechFrameCount += 1;
  }

  public clear(): void {
    this.frames.length = 0;
    this.byteLength = 0;
    this.sampleCount = 0;
    this.speechFrameCount = 0;
  }

  public getByteLength(): number {
    return this.byteLength;
  }

  public getSampleCount(): number {
    return this.sampleCount;
  }

  public getSpeechFrameCount(): number {
    return this.speechFrameCount;
  }

  public getDurationMs(): number {
    const first = this.frames[0]?.snapshot;
    return first === undefined ? 0 : this.sampleCount / first.envelope.sampleRate * 1_000;
  }

  public materialize(): Uint8Array {
    const output = new Uint8Array(this.byteLength);
    let offset = 0;
    for (const frame of this.frames) {
      output.set(frame.snapshot.bytes, offset);
      offset += frame.snapshot.bytes.byteLength;
    }
    return output;
  }

  public sourceBasis(streamId: SpeechStreamId): SourceAudioBasis {
    const first = this.frames[0]?.snapshot;
    const last = this.frames.at(-1)?.snapshot;
    if (first === undefined || last === undefined || this.sampleCount <= 0) {
      throw new PcmAdmissionError("INVALID_FRAME", "Cannot derive an audio basis from an empty buffer");
    }
    const hash = createHash("sha256");
    for (const frame of this.frames) hash.update(frame.snapshot.bytes);
    return SourceAudioBasisSchema.parse({
      streamId,
      firstSequence: first.envelope.sequence,
      lastSequence: last.envelope.sequence,
      startTimestampMs: first.envelope.timestampMs,
      endTimestampMs: last.envelope.timestampMs + last.durationMs,
      sampleRate: first.envelope.sampleRate,
      channels: first.envelope.channels,
      sampleCount: this.sampleCount,
      pcmSha256: hash.digest("hex")
    });
  }
}
