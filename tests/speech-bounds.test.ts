import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { newRequestId, newUtteranceId } from "../packages/domain/src/index.js";
import {
  MAX_SPEECH_BUFFERED_PCM_BYTES,
  MAX_SPEECH_TIMESTAMP_MS,
  MAX_SPEECH_TRANSCRIPT_RESULT_CACHE,
  MAX_SPEECH_WORD_TIMINGS,
  SourceAudioBasisSchema,
  SpeechModelIdentitySchema,
  SpeechPcmFrameEnvelopeSchema,
  SpeechWorkerEventSchema,
  TranscriptCandidateSchema,
  type SourceAudioBasis
} from "../packages/local-compute/src/speech-protocol.js";
import { advancePcmOrder, BoundedPcmBuffer, snapshotPcmFrame } from "../packages/local-compute/src/speech-pcm.js";
import {
  MoonshineSpeechRecognizer,
  TranscriptResultGate,
  type RecognizerAudioInput
} from "../packages/local-compute/src/speech-stt.js";
import { SileroVadBackend, type SileroVadRuntime } from "../packages/local-compute/src/speech-vad.js";

function sourceBasis(sampleCount = 3_200): SourceAudioBasis {
  const sampleRate = 16_000;
  return {
    streamId: "bounds-stream",
    firstSequence: 0,
    lastSequence: Math.ceil(sampleCount / (sampleRate / 10)) - 1,
    startTimestampMs: 0,
    endTimestampMs: sampleCount / sampleRate * 1_000,
    sampleRate,
    channels: 1,
    sampleCount,
    pcmSha256: sha256(new Uint8Array(sampleCount * 4))
  };
}

describe("speech protocol hard bounds", () => {
  it("rejects negative or unsupported sample rates and malformed payload metadata", () => {
    const base = {
      protocolVersion: 1,
      requestId: newRequestId(),
      streamId: "bounds-stream",
      sequence: 0,
      sampleRate: 16_000,
      channels: 1,
      sampleFormat: "F32LE",
      frameSamples: 320,
      payloadByteLength: 1_280,
      timestampMs: 0
    } as const;

    expect(SpeechPcmFrameEnvelopeSchema.safeParse({ ...base, requestId: "r".repeat(129) }).success).toBe(false);
    expect(SpeechPcmFrameEnvelopeSchema.safeParse({ ...base, sampleRate: -16_000 }).success).toBe(false);
    expect(SpeechPcmFrameEnvelopeSchema.safeParse({ ...base, sampleRate: 44_100 }).success).toBe(false);
    expect(SpeechPcmFrameEnvelopeSchema.safeParse({ ...base, payloadByteLength: 1_276 }).success).toBe(false);
    expect(SpeechPcmFrameEnvelopeSchema.safeParse({ ...base, timestampMs: MAX_SPEECH_TIMESTAMP_MS + 1 }).success).toBe(false);
  });

  it("rejects malformed source-basis duration/drift and transcript timing metadata above hard bounds", () => {
    expect(SourceAudioBasisSchema.safeParse(sourceBasis(960_001)).success).toBe(false);
    expect(SourceAudioBasisSchema.safeParse({
      ...sourceBasis(),
      endTimestampMs: 1_000
    }).success).toBe(false);
    expect(SourceAudioBasisSchema.safeParse({
      ...sourceBasis(),
      endTimestampMs: 100
    }).success).toBe(false);
    expect(SourceAudioBasisSchema.safeParse({
      ...sourceBasis(),
      firstSequence: 0,
      lastSequence: 0
    }).success).toBe(false);
    const basis = sourceBasis();
    const words = Array.from({ length: MAX_SPEECH_WORD_TIMINGS + 1 }, (_, index) => ({
      word: "x",
      startMs: index / 10,
      endMs: index / 10 + 0.01
    }));
    expect(TranscriptCandidateSchema.safeParse({
      requestId: newRequestId(),
      utteranceId: newUtteranceId(),
      text: "x",
      isFinal: true,
      model: { name: "fake", version: "1" },
      sourceAudioBasis: basis,
      words
    }).success).toBe(false);
    expect(TranscriptCandidateSchema.safeParse({
      requestId: newRequestId(),
      utteranceId: newUtteranceId(),
      text: "x",
      isFinal: true,
      model: { name: "fake\nmodel", version: "1" },
      sourceAudioBasis: basis
    }).success).toBe(false);
  });

  it("keeps near-maximum admitted frame timestamps representable in finalized audio bases", () => {
    const pcm = new Float32Array(320);
    const snapshot = snapshotPcmFrame({
      protocolVersion: 1,
      requestId: newRequestId(),
      streamId: "max-timestamp",
      sequence: 0,
      sampleRate: 16_000,
      channels: 1,
      sampleFormat: "F32LE",
      frameSamples: 320,
      payloadByteLength: pcm.byteLength,
      timestampMs: MAX_SPEECH_TIMESTAMP_MS
    }, pcm);
    const buffer = new BoundedPcmBuffer();
    buffer.append(snapshot, false);
    expect(buffer.sourceBasis("max-timestamp")).toMatchObject({
      startTimestampMs: MAX_SPEECH_TIMESTAMP_MS,
      endTimestampMs: MAX_SPEECH_TIMESTAMP_MS + 20
    });
  });

  it("rejects unsafe transcript text at the protocol schema even without the STT normalizer", () => {
    const basis = sourceBasis();
    const common = {
      requestId: newRequestId(),
      utteranceId: newUtteranceId(),
      isFinal: true,
      model: { name: "model", version: "1" },
      sourceAudioBasis: basis
    };
    expect(TranscriptCandidateSchema.safeParse({ ...common, text: "line\nbreak" }).success).toBe(false);
    expect(TranscriptCandidateSchema.safeParse({ ...common, text: "bidi\u202Etext" }).success).toBe(false);
    expect(TranscriptCandidateSchema.safeParse({ ...common, text: "bad\uD800text" }).success).toBe(false);
  });

  it("cross-validates event envelopes against nested audio/candidate metadata", () => {
    const basis = sourceBasis();
    const requestId = newRequestId();
    const utteranceId = newUtteranceId();
    expect(SpeechWorkerEventSchema.safeParse({
      protocolVersion: 1,
      requestId,
      streamId: "other-stream",
      type: "UTTERANCE_FINALIZED",
      utteranceId,
      finalizationReason: "SILENCE",
      speechFrameCount: 1,
      durationMs: 200,
      sourceAudioBasis: basis
    }).success).toBe(false);
    expect(SpeechWorkerEventSchema.safeParse({
      protocolVersion: 1,
      requestId,
      streamId: basis.streamId,
      type: "TRANSCRIPT_CANDIDATE",
      candidate: {
        requestId: newRequestId(),
        utteranceId,
        text: "mismatch",
        isFinal: true,
        model: { name: "model", version: "1" },
        sourceAudioBasis: basis
      }
    }).success).toBe(false);
    expect(SpeechWorkerEventSchema.safeParse({
      protocolVersion: 1,
      requestId,
      streamId: basis.streamId,
      type: "POSSIBLE_ENDPOINT",
      utteranceId,
      silenceMs: 0
    }).success).toBe(false);
    expect(SpeechWorkerEventSchema.safeParse({
      protocolVersion: 1,
      requestId,
      streamId: basis.streamId,
      type: "UTTERANCE_DISCARDED",
      reason: "FALSE_START"
    }).success).toBe(false);
  });

  it("allows bounded Unicode model identities but rejects blank/control-only metadata", () => {
    expect(SpeechModelIdentitySchema.safeParse({ name: "月光-model", version: "版本-1" }).success).toBe(true);
    expect(SpeechModelIdentitySchema.safeParse({ name: "   ", version: "1" }).success).toBe(false);
    expect(SpeechModelIdentitySchema.safeParse({ name: "model", version: "v\n1" }).success).toBe(false);
  });

  it("normalizes hostile PCM metadata/order accessors to stable admission errors", () => {
    const throwingEnvelope = Object.defineProperty({}, "protocolVersion", {
      enumerable: true,
      get() { throw new Error("credential=pcm-envelope-secret"); }
    });
    expect(() => snapshotPcmFrame(throwingEnvelope, new Float32Array(1)))
      .toThrowError(expect.objectContaining({
        name: "Error",
        code: "INVALID_FRAME",
        message: "PCM frame metadata is invalid"
      }));

    const pcm = new Float32Array(320);
    const first = snapshotPcmFrame({
      protocolVersion: 1,
      requestId: newRequestId(),
      streamId: "throwing-order-state",
      sequence: 0,
      sampleRate: 16_000,
      channels: 1,
      sampleFormat: "F32LE",
      frameSamples: 320,
      payloadByteLength: pcm.byteLength,
      timestampMs: 0
    }, pcm);
    const base = advancePcmOrder(undefined, first);
    const hostilePrior = { ...base };
    Object.defineProperty(hostilePrior, "lastSequence", {
      enumerable: true,
      get() { throw new Error("credential=pcm-order-secret"); }
    });
    const second = snapshotPcmFrame({
      ...first.envelope,
      requestId: newRequestId(),
      sequence: 1,
      timestampMs: 20
    }, pcm);
    expect(() => advancePcmOrder(hostilePrior as never, second))
      .toThrowError(expect.objectContaining({
        code: "INVALID_FRAME",
        message: "Prior PCM ordering state is invalid"
      }));
  });

  it("snapshots accessor-backed PCM ordering state before validation and use", () => {
    const pcm = new Float32Array(320);
    const first = snapshotPcmFrame({
      protocolVersion: 1,
      requestId: newRequestId(),
      streamId: "accessor-order",
      sequence: 0,
      sampleRate: 16_000,
      channels: 1,
      sampleFormat: "F32LE",
      frameSamples: 320,
      payloadByteLength: pcm.byteLength,
      timestampMs: 0
    }, pcm);
    const base = advancePcmOrder(undefined, first);
    const reads: Record<string, number> = {};
    const getter = <T>(name: keyof typeof base, value: T) => ({
      enumerable: true,
      get() {
        reads[name] = (reads[name] ?? 0) + 1;
        if ((reads[name] ?? 0) > 1 && name === "lastSequence") return 999 as T;
        return value;
      }
    });
    const accessorState = {};
    for (const key of Object.keys(base) as Array<keyof typeof base>) {
      Object.defineProperty(accessorState, key, getter(key, base[key]));
    }

    const second = snapshotPcmFrame({
      ...first.envelope,
      requestId: newRequestId(),
      sequence: 1,
      timestampMs: 20
    }, pcm);
    const next = advancePcmOrder(accessorState as never, second);
    expect(next.lastSequence).toBe(1);
    expect(Math.max(...Object.values(reads))).toBe(1);
  });

  it("binds direct PCM order state to one stream and rejects malformed prior state", () => {
    const pcm = new Float32Array(320);
    const first = snapshotPcmFrame({
      protocolVersion: 1,
      requestId: newRequestId(),
      streamId: "order-a",
      sequence: 0,
      sampleRate: 16_000,
      channels: 1,
      sampleFormat: "F32LE",
      frameSamples: 320,
      payloadByteLength: pcm.byteLength,
      timestampMs: 0
    }, pcm);
    const state = advancePcmOrder(undefined, first);
    const otherStream = snapshotPcmFrame({
      ...first.envelope,
      requestId: newRequestId(),
      streamId: "order-b",
      sequence: 1,
      timestampMs: 20
    }, pcm);
    expect(() => advancePcmOrder(state, otherStream)).toThrow(/stream identity/u);
    const next = snapshotPcmFrame({
      ...first.envelope,
      requestId: newRequestId(),
      sequence: 1,
      timestampMs: 20
    }, pcm);
    expect(() => advancePcmOrder({ ...state, cumulativeDurationMs: Number.NaN }, next))
      .toThrow(/PCM ordering state/u);
    expect(() => advancePcmOrder({
      ...state,
      cumulativeDurationMs: 20,
      nextEarliestTimestampMs: 400
    }, next)).toThrow(/PCM ordering state/u);
    expect(() => advancePcmOrder({
      ...state,
      cumulativeDurationMs: Number.MAX_VALUE,
      nextEarliestTimestampMs: Number.MAX_VALUE
    }, next)).toThrow(/PCM ordering state/u);
    expect(() => advancePcmOrder({
      ...state,
      cumulativeDurationMs: 200,
      nextEarliestTimestampMs: 200
    }, next)).toThrow(/PCM ordering state/u);
    expect(() => advancePcmOrder({
      ...state,
      lastSequence: 999,
      cumulativeDurationMs: 1,
      nextEarliestTimestampMs: 1
    }, next)).toThrow(/PCM ordering state/u);
    expect(() => advancePcmOrder(undefined, null as never)).toThrow(/frame must be an object/u);
  });

  it("enforces buffer/cache hard limits even when helpers are used directly", () => {
    expect(() => new BoundedPcmBuffer(MAX_SPEECH_BUFFERED_PCM_BYTES + 1)).toThrow(/hard speech bound/u);
    expect(() => new TranscriptResultGate(MAX_SPEECH_TRANSCRIPT_RESULT_CACHE + 1)).toThrow(/hard speech cache limit/u);

    const mono16 = new Float32Array(320);
    const first = snapshotPcmFrame({
      protocolVersion: 1,
      requestId: newRequestId(),
      streamId: "direct-buffer",
      sequence: 0,
      sampleRate: 16_000,
      channels: 1,
      sampleFormat: "F32LE",
      frameSamples: 320,
      payloadByteLength: mono16.byteLength,
      timestampMs: 0
    }, mono16);
    const mono48 = new Float32Array(960);
    const second = snapshotPcmFrame({
      protocolVersion: 1,
      requestId: newRequestId(),
      streamId: "direct-buffer",
      sequence: 1,
      sampleRate: 48_000,
      channels: 1,
      sampleFormat: "F32LE",
      frameSamples: 960,
      payloadByteLength: mono48.byteLength,
      timestampMs: 20
    }, mono48);
    const buffer = new BoundedPcmBuffer();
    expect(() => buffer.append(null as never, false)).toThrow(/snapshot must be an object/u);
    buffer.append(first, false);
    first.bytes[0] = 255;
    expect(buffer.materialize()[0]).toBe(0);
    expect(() => buffer.append(second, false)).toThrow(/format changed/u);

    const skippedPcm = new Float32Array(320);
    const skipped = snapshotPcmFrame({
      ...first.envelope,
      requestId: newRequestId(),
      sequence: 2,
      timestampMs: 40
    }, skippedPcm);
    expect(() => buffer.append(skipped, false)).toThrow(/sequence/u);

    const otherStream = snapshotPcmFrame({
      ...first.envelope,
      requestId: newRequestId(),
      streamId: "other-stream",
      sequence: 1,
      timestampMs: 20
    }, skippedPcm);
    expect(() => buffer.append(otherStream, false)).toThrow(/stream identity/u);
    expect(() => buffer.sourceBasis("other-stream")).toThrow(/stream identity/u);
  });

  it("enforces the global utterance-duration limit before Moonshine runtime invocation", async () => {
    let invoked = false;
    const recognizer = new MoonshineSpeechRecognizer({
      runtime: {
        runtimeVersion: "test",
        supportsAbort: false,
        async transcribe() {
          invoked = true;
          return { text: "should not run" };
        }
      },
      modelPath: "models/moonshine/model.bin",
      modelVersion: "model-v1"
    });
    const input: RecognizerAudioInput = {
      requestId: newRequestId(),
      utteranceId: newUtteranceId(),
      pcmBytes: new Uint8Array(4),
      sourceAudioBasis: sourceBasis(960_001)
    };
    await expect(recognizer.recognize(input, new AbortController().signal)).rejects.toThrow(/maximum utterance duration/u);
    expect(invoked).toBe(false);
  });

  it("passes stream identity to the Silero seam so recurrent runtime state can remain isolated", async () => {
    const observedStreams: string[] = [];
    const runtime: SileroVadRuntime = {
      runtimeVersion: "test",
      async score(input) {
        observedStreams.push(input.streamId);
        return 0;
      }
    };
    const backend = new SileroVadBackend(runtime, "models/silero/model.onnx");
    const pcm = new Float32Array(320);
    for (const streamId of ["silero-left", "silero-right"]) {
      const snapshot = snapshotPcmFrame({
        protocolVersion: 1,
        requestId: newRequestId(),
        streamId,
        sequence: 0,
        sampleRate: 16_000,
        channels: 1,
        sampleFormat: "F32LE",
        frameSamples: 320,
        payloadByteLength: pcm.byteLength,
        timestampMs: 0
      }, pcm);
      await backend.classify(snapshot);
    }
    expect(observedStreams).toEqual(["silero-left", "silero-right"]);
  });

  it("requires a local Silero path and rejects malformed backend probabilities", async () => {
    const runtime = {
      runtimeVersion: "test",
      async score() { return 1.1; }
    };
    expect(() => new SileroVadBackend(runtime, "https://example.invalid/silero.onnx")).toThrow(/local filesystem path/u);
    expect(() => new SileroVadBackend(runtime, "models/silero/model.onnx\nother")).toThrow(/local filesystem path/u);
    expect(() => new SileroVadBackend(runtime, "file:/tmp/silero.onnx")).toThrow(/local filesystem path/u);
    expect(() => new SileroVadBackend(runtime, "\\\\server\\share\\silero.onnx")).toThrow(/local filesystem path/u);
    expect(() => new SileroVadBackend(runtime, "C:\\models\\silero\\model.onnx")).not.toThrow();
    expect(() => new SileroVadBackend({ ...runtime, runtimeVersion: "bad\nruntime" }, "models/silero/model.onnx")).toThrow(/runtime version/u);

    const backend = new SileroVadBackend(runtime, "models/silero/silero.onnx");
    const pcm = new Float32Array(320);
    const frame = snapshotPcmFrame({
      protocolVersion: 1,
      requestId: newRequestId(),
      streamId: "bounds-stream",
      sequence: 0,
      sampleRate: 16_000,
      channels: 1,
      sampleFormat: "F32LE",
      frameSamples: 320,
      payloadByteLength: pcm.byteLength,
      timestampMs: 0
    }, pcm);
    await expect(backend.classify(frame)).rejects.toThrow(/bounded range/u);
  });
});


function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
