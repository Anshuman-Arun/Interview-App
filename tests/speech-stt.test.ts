import { createHash } from "node:crypto";
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
  const sampleCount = overrides.sampleCount ?? 3_200;
  const sampleRate = overrides.sampleRate ?? 16_000;
  return {
    streamId: "stream-stt",
    firstSequence: 0,
    lastSequence: 9,
    startTimestampMs: 100,
    endTimestampMs: 100 + sampleCount / sampleRate * 1_000,
    sampleRate,
    channels: 1,
    sampleCount,
    pcmSha256: sha256(new Uint8Array(sampleCount * 4)),
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
  it("bounds fake-recognizer cancellation identities even when called directly from JavaScript", async () => {
    const recognizer = new DeterministicFakeRecognizer();
    await expect(recognizer.cancel("x".repeat(129) as never)).rejects.toThrow();
  });

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

  it("normalizes bounded control/format abuse and whitespace", () => {
    expect(normalizeTranscriptText("  hello\u0000   world\nnext  ")).toBe("hello world next");
    expect(normalizeTranscriptText("left\u202Eevil\u2069 right")).toBe("left evil right");
    expect(normalizeTranscriptText("zero\u200Bwidth")).toBe("zero width");
    expect(normalizeTranscriptText("left\u200Eright\u061Cdone")).toBe("left right done");
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

  it("runtime-validates the expected callback basis instead of trusting typed callers", () => {
    const input = recognizerInput();
    const raw = {
      requestId: input.requestId,
      utteranceId: input.utteranceId,
      text: "candidate",
      isFinal: true,
      model: { name: "fake", version: "1" },
      sourceAudioBasis: input.sourceAudioBasis
    };
    expect(() => validateTranscriptCandidate(raw, {
      ...input,
      sourceAudioBasis: { ...input.sourceAudioBasis, sampleCount: Number.NaN }
    })).toThrow();
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
  it("runtime-rejects malformed or typoed adapter configuration", () => {
    const runtime = {
      runtimeVersion: "test-runtime",
      supportsAbort: false,
      async transcribe() { return { text: "ok" }; }
    };
    expect(() => new MoonshineSpeechRecognizer(null as never)).toThrow(/options must be an object/u);
    expect(() => new MoonshineSpeechRecognizer({
      runtime: null,
      modelPath: "models/moonshine/model.bin",
      modelVersion: "1"
    } as never)).toThrow(/runtime must be an object/u);
    expect(() => new MoonshineSpeechRecognizer({
      runtime,
      modelPath: "models/moonshine/model.bin",
      modelVersion: "1",
      modelVerison: "typo"
    } as never)).toThrow(/unexpected field/u);
    expect(() => new MoonshineSpeechRecognizer({
      runtime,
      modelPath: "models/moonshine/model.bin",
      modelVersion: 1
    } as never)).toThrow(/model version must be a string/u);
    expect(() => new MoonshineSpeechRecognizer({
      runtime: { ...runtime, transcribe: "not-a-function" },
      modelPath: "models/moonshine/model.bin",
      modelVersion: "1"
    } as never)).toThrow(/transcribe callback is required/u);
  });

  it("requires explicit safe local model paths and never treats URLs/control characters as model sources", () => {
    const runtime = {
      runtimeVersion: "test-runtime",
      supportsAbort: false,
      async transcribe() { return { text: "ok" }; }
    };
    expect(() => new MoonshineSpeechRecognizer({
      runtime,
      modelPath: "https://example.invalid/model",
      modelVersion: "test"
    })).toThrow(/local filesystem path/u);
    expect(() => new MoonshineSpeechRecognizer({
      runtime,
      modelPath: "models/moonshine/model.bin\nother",
      modelVersion: "test"
    })).toThrow(/local filesystem path/u);
    expect(() => new MoonshineSpeechRecognizer({
      runtime,
      modelPath: "file:/tmp/model.bin",
      modelVersion: "test"
    })).toThrow(/local filesystem path/u);
    expect(() => new MoonshineSpeechRecognizer({
      runtime,
      modelPath: "\\\\server\\share\\model.bin",
      modelVersion: "test"
    })).toThrow(/local filesystem path/u);
    expect(() => new MoonshineSpeechRecognizer({
      runtime,
      modelPath: "C:\\models\\moonshine\\model.bin",
      modelVersion: "test"
    })).not.toThrow();
  });

  it("rejects malformed runtime output before copying unbounded timing metadata", async () => {
    const input = recognizerInput();
    const recognizer = new MoonshineSpeechRecognizer({
      runtime: {
        runtimeVersion: "test-runtime",
        supportsAbort: false,
        async transcribe() {
          return {
            text: "too many timings",
            words: Array.from({ length: 1_001 }, () => ({ word: "x", startMs: 0, endMs: 1 }))
          };
        }
      },
      modelPath: "models/moonshine/model.bin",
      modelVersion: "model-v1"
    });
    await expect(recognizer.recognize(input, new AbortController().signal)).rejects.toThrow();
  });

  it("runtime-rejects malformed direct recognition input", async () => {
    const recognizer = new MoonshineSpeechRecognizer({
      runtime: {
        runtimeVersion: "test-runtime",
        supportsAbort: false,
        async transcribe() { return { text: "should not run" }; }
      },
      modelPath: "models/moonshine/model.bin",
      modelVersion: "model-v1"
    });
    await expect(recognizer.recognize(null as never, new AbortController().signal))
      .rejects.toThrow(/input must be an object/u);
  });

  it("rejects malformed cancellation signals and short-circuits already-aborted Moonshine calls", async () => {
    let transcribeCalls = 0;
    const recognizer = new MoonshineSpeechRecognizer({
      runtime: {
        runtimeVersion: "test-runtime",
        supportsAbort: true,
        async transcribe() {
          transcribeCalls += 1;
          return { text: "should not run" };
        }
      },
      modelPath: "models/moonshine/model.bin",
      modelVersion: "model-v1"
    });
    const input = recognizerInput();

    await expect(recognizer.recognize(input, null as never))
      .rejects.toThrow(/cancellation signal is invalid/u);

    const controller = new AbortController();
    controller.abort();
    await expect(recognizer.recognize(input, controller.signal))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(transcribeCalls).toBe(0);
  });

  it("rejects PCM whose byte length does not match its claimed source basis", async () => {
    const input = recognizerInput();
    const recognizer = new MoonshineSpeechRecognizer({
      runtime: {
        runtimeVersion: "test-runtime",
        supportsAbort: false,
        async transcribe() { return { text: "should not run" }; }
      },
      modelPath: "models/moonshine/model.bin",
      modelVersion: "model-v1"
    });
    await expect(recognizer.recognize(
      { ...input, pcmBytes: new Uint8Array(4) },
      new AbortController().signal
    )).rejects.toThrow(/PCM length/u);
  });

  it("rejects PCM whose bytes do not match the claimed source hash", async () => {
    const input = recognizerInput();
    const recognizer = new MoonshineSpeechRecognizer({
      runtime: {
        runtimeVersion: "test-runtime",
        supportsAbort: false,
        async transcribe() { return { text: "should not run" }; }
      },
      modelPath: "models/moonshine/model.bin",
      modelVersion: "model-v1"
    });
    const tampered = new Uint8Array(input.pcmBytes);
    tampered[0] = 1;
    await expect(recognizer.recognize(
      { ...input, pcmBytes: tampered },
      new AbortController().signal
    )).rejects.toThrow(/do not match the source audio basis/u);
  });

  it("rejects runtimes that mutate the PCM buffer they were given", async () => {
    const input = recognizerInput();
    const recognizer = new MoonshineSpeechRecognizer({
      runtime: {
        runtimeVersion: "test-runtime",
        supportsAbort: false,
        async transcribe(value: { readonly pcmBytes: Uint8Array }) {
          value.pcmBytes[0] = 1;
          return { text: "mutated" };
        }
      },
      modelPath: "models/moonshine/model.bin",
      modelVersion: "model-v1"
    });
    await expect(recognizer.recognize(input, new AbortController().signal)).rejects.toThrow(/mutated PCM/u);
    expect(input.pcmBytes[0]).toBe(0);
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


function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
