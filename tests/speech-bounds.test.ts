import { describe, expect, it } from "vitest";
import { newRequestId, newUtteranceId } from "../packages/domain/src/index.js";
import {
  MAX_SPEECH_WORD_TIMINGS,
  SpeechPcmFrameEnvelopeSchema,
  TranscriptCandidateSchema,
  type SourceAudioBasis
} from "../packages/local-compute/src/speech-protocol.js";
import { snapshotPcmFrame } from "../packages/local-compute/src/speech-pcm.js";
import {
  MoonshineSpeechRecognizer,
  type RecognizerAudioInput
} from "../packages/local-compute/src/speech-stt.js";
import { SileroVadBackend } from "../packages/local-compute/src/speech-vad.js";

function sourceBasis(sampleCount = 3_200): SourceAudioBasis {
  return {
    streamId: "bounds-stream",
    firstSequence: 0,
    lastSequence: 0,
    startTimestampMs: 0,
    endTimestampMs: sampleCount / 16_000 * 1_000,
    sampleRate: 16_000,
    channels: 1,
    sampleCount,
    pcmSha256: "c".repeat(64)
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

    expect(SpeechPcmFrameEnvelopeSchema.safeParse({ ...base, sampleRate: -16_000 }).success).toBe(false);
    expect(SpeechPcmFrameEnvelopeSchema.safeParse({ ...base, sampleRate: 44_100 }).success).toBe(false);
    expect(SpeechPcmFrameEnvelopeSchema.safeParse({ ...base, payloadByteLength: 1_276 }).success).toBe(false);
  });

  it("rejects transcript timing metadata above the fixed entry bound", () => {
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

  it("requires a local Silero path and rejects malformed backend probabilities", async () => {
    const runtime = {
      runtimeVersion: "test",
      async score() { return 1.1; }
    };
    expect(() => new SileroVadBackend(runtime, "https://example.invalid/silero.onnx")).toThrow(/local path/u);

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
    await expect(backend.classify(frame)).rejects.toThrow(/within \[0, 1\]/u);
  });
});
