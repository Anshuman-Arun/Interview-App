import { describe, expect, it } from "vitest";
import { newRequestId, newUtteranceId } from "../packages/domain/src/index.js";
import {
  DeterministicFakeRecognizer,
  MoonshineSpeechRecognizer,
  TranscriptResultGate,
  normalizeTranscriptText,
  validateTranscriptCandidate,
  type RecognizerAudioInput
} from "../packages/local-compute/src/speech-stt.js";
import type { SourceAudioBasis } from "../packages/local-compute/src/speech-protocol.js";

function basis(overrides: Partial<SourceAudioBasis> = {}): SourceAudioBasis {
  return {
    streamId: "stream-stt",
    firstSequence: 0,
    lastSequence: 9,
    startTimestampMs: 100,
    endTimestampMs: 300,
    sampleRate: 16_000,
    channels: 1,
    sampleCount: 3_200,
    pcmSha256: "a".repeat(64),
    ...overrides
  };
}

function recognizerInput(): RecognizerAudioInput {
  return {
    requestId: newRequestId(),
    utteranceId: newUtteranceId(),
    pcmBytes: new Uint8Array(3_200 * 4),
    sourceAudioBasis: basis()
  };
}

describe("transcript validation", () => {
  it("accepts deterministic and empty final transcripts", async () => {
    const input = recognizerInput();
    const recognizer = new DeterministicFakeRecognizer((value) => ({
      requestId: value.requestId,
      utteranceId: value.utteranceId,
      text: "",
      isFinal: true,
      model: { name: "fake", version: "1" },
      sourceAudioBasis: value.sourceAudioBasis
    }));
    const raw = await recognizer.recognize(input, new AbortController().signal);
    expect(validateTranscriptCandidate(raw, input).text).toBe("");
  });

  it("normalizes bounded control characters and whitespace", () => {
    expect(normalizeTranscriptText("  hello\u0000   world\nnext  ")).toBe("hello world next");
  });

  it("rejects oversized or invalid-Unicode transcripts", () => {
    expect(() => normalizeTranscriptText("x".repeat(20_001))).toThrow(/maximum length/u);
    expect(() => normalizeTranscriptText("bad\uD800text")).toThrow(/invalid Unicode/u);
  });

  it("rejects malformed confidence, wrong IDs, and wrong audio basis", () => {
    const input = recognizerInput();
    const valid = {
      requestId: input.requestId,
      utteranceId: input.utteranceId,
      text: "candidate",
      isFinal: true,
      confidence: 0.7,
      model: { name: "fake", version: "1" },
      sourceAudioBasis: input.sourceAudioBasis
    };
    expect(() => validateTranscriptCandidate({ ...valid, confidence: 1.1 }, input)).toThrow();
    expect(() => validateTranscriptCandidate({ ...valid, requestId: newRequestId() }, input)).toThrow(/requestId/u);
    expect(() => validateTranscriptCandidate({ ...valid, utteranceId: newUtteranceId() }, input)).toThrow(/utteranceId/u);
    expect(() => validateTranscriptCandidate({ ...valid, sourceAudioBasis: basis({ pcmSha256: "b".repeat(64) }) }, input)).toThrow(/audio basis/u);
  });

  it("rejects malformed or overlapping timing metadata", () => {
    const input = recognizerInput();
    const base = {
      requestId: input.requestId,
      utteranceId: input.utteranceId,
      text: "two words",
      isFinal: true,
      model: { name: "fake", version: "1" },
      sourceAudioBasis: input.sourceAudioBasis
    };
    expect(() => validateTranscriptCandidate({
      ...base,
      words: [
        { word: "two", startMs: 0, endMs: 120 },
        { word: "words", startMs: 100, endMs: 180 }
      ]
    }, input)).toThrow(/overlap/u);
    expect(() => validateTranscriptCandidate({
      ...base,
      words: [{ word: "late", startMs: 0, endMs: 500 }]
    }, input)).toThrow(/duration/u);
  });

  it("deduplicates identical recognizer callbacks and fails closed on conflicting reuse", () => {
    const input = recognizerInput();
    const gate = new TranscriptResultGate();
    const raw = {
      requestId: input.requestId,
      utteranceId: input.utteranceId,
      text: "same",
      isFinal: true,
      model: { name: "fake", version: "1" },
      sourceAudioBasis: input.sourceAudioBasis
    };
    expect(gate.admit(raw, input).duplicate).toBe(false);
    expect(gate.admit(raw, input).duplicate).toBe(true);
    expect(() => gate.admit({ ...raw, text: "conflicting" }, input)).toThrow(/conflicting/u);
  });
});

describe("Moonshine-compatible adapter seam", () => {
  it("requires explicit local model paths and never treats a URL as a model source", () => {
    const runtime = {
      runtimeVersion: "test-runtime",
      supportsAbort: false,
      async transcribe() { return { text: "ok" }; }
    };
    expect(() => new MoonshineSpeechRecognizer({
      runtime,
      modelPath: "https://example.invalid/model",
      modelVersion: "test"
    })).toThrow(/local path/u);
  });

  it("reports honest cancellation capability and exposes model identity", async () => {
    let signalWasProvided = false;
    const runtime = {
      runtimeVersion: "test-runtime",
      supportsAbort: false,
      async transcribe(value: { readonly signal?: AbortSignal }) {
        signalWasProvided = value.signal !== undefined;
        return { text: "moonshine transcript", confidence: 0.8 };
      }
    };
    const recognizer = new MoonshineSpeechRecognizer({
      runtime,
      modelPath: "models/moonshine/model.bin",
      modelVersion: "model-v1"
    });
    const input = recognizerInput();
    const raw = await recognizer.recognize(input, new AbortController().signal);
    const candidate = validateTranscriptCandidate(raw, input);
    expect(recognizer.cancellationCapability).toBe("NONE");
    expect(signalWasProvided).toBe(false);
    expect(candidate.model).toEqual({ name: "moonshine", version: "model-v1" });
    expect(candidate.text).toBe("moonshine transcript");
  });
});
