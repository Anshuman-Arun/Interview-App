import { createHash } from "node:crypto";
import {
  MAX_SPEECH_BUFFERED_PCM_BYTES,
  MAX_SPEECH_FRAME_DURATION_MS,
  MAX_SPEECH_TIMESTAMP_DRIFT_MS,
  MAX_SPEECH_UTTERANCE_DURATION_MS,
  SourceAudioBasisSchema,
  SpeechPcmFrameEnvelopeSchema,
  SpeechStreamIdSchema,
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
  readonly streamId: SpeechStreamId;
  readonly firstSequence: number;
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
  const envelope = Object.freeze({ ...parsed.data });
  if (!ArrayBuffer.isView(payload)) {
    throw new PcmAdmissionError("INVALID_FRAME", "PCM payload must be a binary ArrayBuffer view");
  }
  if (isSharedBackingBuffer(payload.buffer)) {
    throw new PcmAdmissionError("INVALID_FRAME", "PCM payload must not use shared mutable backing storage");
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
  return Object.freeze({
    envelope,
    bytes,
    durationMs,
    fingerprint: createHash("sha256").update(bytes).digest("hex")
  });
}

export function advancePcmOrder(
  prior: PcmOrderState | undefined,
  frame: PcmFrameSnapshot
): PcmOrderState {
  if (!isRecord(frame)) {
    throw new PcmAdmissionError("INVALID_FRAME", "PCM order frame must be an object");
  }
  const parsedEnvelope = SpeechPcmFrameEnvelopeSchema.safeParse(frame.envelope);
  if (!parsedEnvelope.success) {
    throw new PcmAdmissionError("INVALID_FRAME", "PCM order frame metadata is invalid");
  }
  const envelope = parsedEnvelope.data;
  const durationMs = envelope.frameSamples / envelope.sampleRate * 1_000;
  const boundedPrior = prior === undefined ? undefined : snapshotPcmOrderState(prior);
  if (boundedPrior === undefined) {
    if (envelope.sequence !== 0) {
      throw new PcmAdmissionError("OUT_OF_ORDER_FRAME", "A new PCM stream must begin at sequence zero");
    }
    return {
      streamId: envelope.streamId,
      firstSequence: envelope.sequence,
      sampleRate: envelope.sampleRate,
      channels: envelope.channels,
      sampleFormat: envelope.sampleFormat,
      firstTimestampMs: envelope.timestampMs,
      cumulativeDurationMs: durationMs,
      lastSequence: envelope.sequence,
      nextEarliestTimestampMs: envelope.timestampMs + durationMs
    };
  }

  if (envelope.streamId !== boundedPrior.streamId) {
    throw new PcmAdmissionError("STREAM_CONFLICT", "PCM stream identity changed while advancing order state");
  }
  if (envelope.sampleRate !== boundedPrior.sampleRate
      || envelope.channels !== boundedPrior.channels
      || envelope.sampleFormat !== boundedPrior.sampleFormat) {
    throw new PcmAdmissionError("STREAM_CONFLICT", "PCM format changed within a stream");
  }
  if (envelope.sequence !== boundedPrior.lastSequence + 1) {
    throw new PcmAdmissionError("OUT_OF_ORDER_FRAME", "PCM sequence is duplicated, skipped, or reversed");
  }
  if (envelope.timestampMs + 0.001 < boundedPrior.nextEarliestTimestampMs) {
    throw new PcmAdmissionError("OUT_OF_ORDER_FRAME", "PCM timestamps overlap or reverse");
  }
  const expectedTimestampMs = boundedPrior.firstTimestampMs + boundedPrior.cumulativeDurationMs;
  if (envelope.timestampMs - expectedTimestampMs > MAX_SPEECH_TIMESTAMP_DRIFT_MS + 0.001) {
    throw new PcmAdmissionError("OUT_OF_ORDER_FRAME", "PCM timestamp drift exceeds the allowed bound");
  }

  return {
    ...boundedPrior,
    cumulativeDurationMs: boundedPrior.cumulativeDurationMs + durationMs,
    lastSequence: envelope.sequence,
    nextEarliestTimestampMs: envelope.timestampMs + durationMs
  };
}

const PCM_STORAGE_CHUNK_BYTES = 64 * 1024;

export class BoundedPcmBuffer {
  private readonly chunks: Uint8Array[] = [];
  private allocatedBytes = 0;
  private tailChunkUsed = 0;
  private byteLength = 0;
  private sampleCount = 0;
  private speechFrameCount = 0;
  private bufferOrder: PcmOrderState | undefined;
  private firstEnvelope: SpeechPcmFrameEnvelope | undefined;
  private lastEnvelope: SpeechPcmFrameEnvelope | undefined;
  private lastDurationMs = 0;

  public constructor(private readonly maxBytes = MAX_SPEECH_BUFFERED_PCM_BYTES) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_SPEECH_BUFFERED_PCM_BYTES) {
      throw new PcmAdmissionError("RESOURCE_LIMIT", "PCM buffer limit must remain within the hard speech bound");
    }
  }

  public append(snapshot: PcmFrameSnapshot, speech: boolean): void {
    if (!isRecord(snapshot)) {
      throw new PcmAdmissionError("INVALID_FRAME", "PCM snapshot must be an object");
    }
    if (typeof speech !== "boolean") {
      throw new PcmAdmissionError("INVALID_FRAME", "PCM speech classification must be boolean");
    }

    const ownedSnapshot = snapshotPcmFrame(snapshot.envelope, snapshot.bytes);
    if (this.firstEnvelope !== undefined && ownedSnapshot.envelope.streamId !== this.firstEnvelope.streamId) {
      throw new PcmAdmissionError("STREAM_CONFLICT", "PCM stream identity changed within one utterance");
    }

    let nextOrder: PcmOrderState;
    if (this.bufferOrder === undefined) {
      nextOrder = initialBufferedOrder(ownedSnapshot);
    } else {
      nextOrder = advancePcmOrder(this.bufferOrder, ownedSnapshot);
    }

    if (this.byteLength + ownedSnapshot.bytes.byteLength > this.maxBytes) {
      throw new PcmAdmissionError("RESOURCE_LIMIT", "PCM buffer limit exceeded");
    }
    const nextSampleCount = this.sampleCount + ownedSnapshot.envelope.frameSamples;
    const nextDurationMs = nextSampleCount / ownedSnapshot.envelope.sampleRate * 1_000;
    if (nextDurationMs > MAX_SPEECH_UTTERANCE_DURATION_MS + 0.001) {
      throw new PcmAdmissionError("RESOURCE_LIMIT", "PCM utterance duration limit exceeded");
    }

    this.appendBytes(ownedSnapshot.bytes);
    this.bufferOrder = nextOrder;
    this.firstEnvelope ??= ownedSnapshot.envelope;
    this.lastEnvelope = ownedSnapshot.envelope;
    this.lastDurationMs = ownedSnapshot.durationMs;
    this.byteLength += ownedSnapshot.bytes.byteLength;
    this.sampleCount = nextSampleCount;
    if (speech) this.speechFrameCount += 1;
  }

  public clear(): void {
    this.chunks.length = 0;
    this.allocatedBytes = 0;
    this.tailChunkUsed = 0;
    this.byteLength = 0;
    this.sampleCount = 0;
    this.speechFrameCount = 0;
    this.bufferOrder = undefined;
    this.firstEnvelope = undefined;
    this.lastEnvelope = undefined;
    this.lastDurationMs = 0;
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
    return this.firstEnvelope === undefined
      ? 0
      : this.sampleCount / this.firstEnvelope.sampleRate * 1_000;
  }

  public materialize(): Uint8Array {
    const output = new Uint8Array(this.byteLength);
    let targetOffset = 0;
    let remaining = this.byteLength;
    for (const chunk of this.chunks) {
      if (remaining <= 0) break;
      const used = Math.min(chunk.byteLength, remaining);
      output.set(chunk.subarray(0, used), targetOffset);
      targetOffset += used;
      remaining -= used;
    }
    if (remaining !== 0) {
      throw new PcmAdmissionError("INVALID_FRAME", "PCM storage accounting is inconsistent");
    }
    return output;
  }

  public sourceBasis(streamId: SpeechStreamId): SourceAudioBasis {
    const boundedStreamId = SpeechStreamIdSchema.safeParse(streamId);
    if (!boundedStreamId.success) {
      throw new PcmAdmissionError("INVALID_FRAME", "PCM source basis stream identity is invalid");
    }
    const first = this.firstEnvelope;
    const last = this.lastEnvelope;
    if (first === undefined || last === undefined || this.sampleCount <= 0) {
      throw new PcmAdmissionError("INVALID_FRAME", "Cannot derive an audio basis from an empty buffer");
    }
    if (boundedStreamId.data !== first.streamId) {
      throw new PcmAdmissionError("STREAM_CONFLICT", "PCM source basis stream identity does not match buffered audio");
    }
    const hash = createHash("sha256");
    let remaining = this.byteLength;
    for (const chunk of this.chunks) {
      if (remaining <= 0) break;
      const used = Math.min(chunk.byteLength, remaining);
      hash.update(chunk.subarray(0, used));
      remaining -= used;
    }
    if (remaining !== 0) {
      throw new PcmAdmissionError("INVALID_FRAME", "PCM storage accounting is inconsistent");
    }
    return SourceAudioBasisSchema.parse({
      streamId: boundedStreamId.data,
      firstSequence: first.sequence,
      lastSequence: last.sequence,
      startTimestampMs: first.timestampMs,
      endTimestampMs: last.timestampMs + this.lastDurationMs,
      sampleRate: first.sampleRate,
      channels: first.channels,
      sampleCount: this.sampleCount,
      pcmSha256: hash.digest("hex")
    });
  }

  private appendBytes(bytes: Uint8Array): void {
    let sourceOffset = 0;
    while (sourceOffset < bytes.byteLength) {
      let tail = this.chunks.at(-1);
      if (tail === undefined || this.tailChunkUsed === tail.byteLength) {
        const remainingCapacity = this.maxBytes - this.allocatedBytes;
        const capacity = Math.min(PCM_STORAGE_CHUNK_BYTES, remainingCapacity);
        if (capacity <= 0) {
          throw new PcmAdmissionError("RESOURCE_LIMIT", "PCM storage allocation limit exceeded");
        }
        tail = new Uint8Array(capacity);
        this.chunks.push(tail);
        this.allocatedBytes += capacity;
        this.tailChunkUsed = 0;
      }

      const writable = Math.min(tail.byteLength - this.tailChunkUsed, bytes.byteLength - sourceOffset);
      tail.set(bytes.subarray(sourceOffset, sourceOffset + writable), this.tailChunkUsed);
      this.tailChunkUsed += writable;
      sourceOffset += writable;
    }
  }
}


function initialBufferedOrder(frame: PcmFrameSnapshot): PcmOrderState {
  return {
    streamId: frame.envelope.streamId,
    firstSequence: frame.envelope.sequence,
    sampleRate: frame.envelope.sampleRate,
    channels: frame.envelope.channels,
    sampleFormat: frame.envelope.sampleFormat,
    firstTimestampMs: frame.envelope.timestampMs,
    cumulativeDurationMs: frame.durationMs,
    lastSequence: frame.envelope.sequence,
    nextEarliestTimestampMs: frame.envelope.timestampMs + frame.durationMs
  };
}


function snapshotPcmOrderState(value: unknown): PcmOrderState {
  if (!isRecord(value)) {
    throw new PcmAdmissionError("INVALID_FRAME", "Prior PCM ordering state is invalid");
  }
  const snapshot: PcmOrderState = {
    streamId: value.streamId as SpeechStreamId,
    firstSequence: value.firstSequence as number,
    sampleRate: value.sampleRate as number,
    channels: value.channels as number,
    sampleFormat: value.sampleFormat as string,
    firstTimestampMs: value.firstTimestampMs as number,
    cumulativeDurationMs: value.cumulativeDurationMs as number,
    lastSequence: value.lastSequence as number,
    nextEarliestTimestampMs: value.nextEarliestTimestampMs as number
  };
  validatePcmOrderState(snapshot);
  return snapshot;
}

function validatePcmOrderState(prior: PcmOrderState): void {
  const streamId = SpeechStreamIdSchema.safeParse(prior.streamId);
  const sampleDerivedEndMs = prior.firstTimestampMs + prior.cumulativeDurationMs;
  const frameCount = prior.lastSequence - prior.firstSequence + 1;
  const minimumRepresentableDurationMs = frameCount / prior.sampleRate * 1_000;
  const maximumRepresentableDurationMs = frameCount * MAX_SPEECH_FRAME_DURATION_MS;
  if (!streamId.success
      || (prior.sampleRate !== 16_000 && prior.sampleRate !== 48_000)
      || prior.channels !== 1
      || prior.sampleFormat !== "F32LE"
      || !Number.isSafeInteger(prior.firstSequence)
      || prior.firstSequence < 0
      || !Number.isSafeInteger(prior.lastSequence)
      || prior.lastSequence < prior.firstSequence
      || !Number.isFinite(prior.firstTimestampMs)
      || prior.firstTimestampMs < 0
      || !Number.isFinite(prior.cumulativeDurationMs)
      || prior.cumulativeDurationMs <= 0
      || !Number.isFinite(minimumRepresentableDurationMs)
      || !Number.isFinite(maximumRepresentableDurationMs)
      || prior.cumulativeDurationMs + 0.001 < minimumRepresentableDurationMs
      || prior.cumulativeDurationMs > maximumRepresentableDurationMs + 0.001
      || !Number.isFinite(sampleDerivedEndMs)
      || sampleDerivedEndMs > Number.MAX_SAFE_INTEGER
      || !Number.isFinite(prior.nextEarliestTimestampMs)
      || prior.nextEarliestTimestampMs > Number.MAX_SAFE_INTEGER
      || prior.nextEarliestTimestampMs + 0.001 < sampleDerivedEndMs
      || prior.nextEarliestTimestampMs > sampleDerivedEndMs + MAX_SPEECH_TIMESTAMP_DRIFT_MS + 0.001) {
    throw new PcmAdmissionError("INVALID_FRAME", "Prior PCM ordering state is invalid");
  }
}


function isSharedBackingBuffer(buffer: ArrayBufferLike): boolean {
  return typeof SharedArrayBuffer !== "undefined" && buffer instanceof SharedArrayBuffer;
}


function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
