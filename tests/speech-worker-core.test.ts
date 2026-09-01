import { describe, expect, it } from "vitest";
import { newRequestId } from "../packages/domain/src/index.js";
import {
  AdaptiveEndpointingPolicy,
  DeterministicEnergyVadBackend,
  type VadBackend
} from "../packages/local-compute/src/speech-vad.js";
import {
  DeterministicFakeRecognizer,
  type RecognizerAudioInput,
  type SpeechRecognizer
} from "../packages/local-compute/src/speech-stt.js";
import {
  SpeechWorkerCore,
  type SpeechWorkerCoreOptions
} from "../packages/local-compute/src/speech-worker.js";
import type { SpeechPcmFrameEnvelope, SpeechWorkerEvent } from "../packages/local-compute/src/speech-protocol.js";

interface FrameFixture {
  readonly envelope: SpeechPcmFrameEnvelope;
  readonly pcm: Float32Array;
}

function frame(
  sequence: number,
  speech: boolean,
  overrides: Partial<SpeechPcmFrameEnvelope> = {}
): FrameFixture {
  const sampleRate = overrides.sampleRate ?? 16_000;
  const frameSamples = overrides.frameSamples ?? sampleRate / 50;
  const pcm = new Float32Array(frameSamples);
  pcm.fill(speech ? 0.1 : 0);
  const envelope = {
    protocolVersion: 1,
    requestId: newRequestId(),
    streamId: "stream-a",
    sequence,
    sampleRate,
    channels: 1,
    sampleFormat: "F32LE",
    frameSamples,
    payloadByteLength: pcm.byteLength,
    timestampMs: sequence * (frameSamples / sampleRate * 1_000),
    ...overrides
  } satisfies SpeechPcmFrameEnvelope;
  return { envelope, pcm };
}

function core(options: Partial<SpeechWorkerCoreOptions> = {}): SpeechWorkerCore {
  return new SpeechWorkerCore({
    vadBackend: new DeterministicEnergyVadBackend(),
    recognizer: new DeterministicFakeRecognizer(),
    ...options
  });
}

async function feedNormalUtterance(worker: SpeechWorkerCore, streamId = "stream-a"): Promise<SpeechWorkerEvent[]> {
  const events: SpeechWorkerEvent[] = [];
  for (let sequence = 0; sequence < 31; sequence += 1) {
    const fixture = frame(sequence, sequence < 6, { streamId });
    events.push(...await worker.submitFrame(fixture.envelope, fixture.pcm));
  }
  return events;
}

describe("PCM admission and bounded buffering", () => {
  it("accepts valid mono 16 kHz and 48 kHz frames", async () => {
    const worker16 = core();
    const mono16 = frame(0, false);
    await expect(worker16.submitFrame(mono16.envelope, mono16.pcm)).resolves.toEqual([]);

    const worker48 = core();
    const mono48 = frame(0, false, { sampleRate: 48_000, frameSamples: 960, payloadByteLength: 3_840 });
    await expect(worker48.submitFrame(mono48.envelope, mono48.pcm)).resolves.toEqual([]);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])("rejects non-finite sample %s", async (sample) => {
    const worker = core();
    const fixture = frame(0, false);
    fixture.pcm[0] = sample;
    await expect(worker.submitFrame(fixture.envelope, fixture.pcm)).rejects.toMatchObject({ code: "INVALID_FRAME" });
  });

  it("rejects unsupported channels and absurd frame duration", async () => {
    const worker = core();
    const invalidChannels = frame(0, false);
    await expect(worker.submitFrame({ ...invalidChannels.envelope, channels: 2 }, invalidChannels.pcm)).rejects.toMatchObject({ code: "INVALID_FRAME" });

    const huge = frame(0, false, { frameSamples: 2_000, payloadByteLength: 8_000 });
    await expect(core().submitFrame(huge.envelope, huge.pcm)).rejects.toMatchObject({ code: "INVALID_FRAME" });
  });

  it("fails closed on sequence duplication and timestamp reversal", async () => {
    const duplicateWorker = core();
    const first = frame(0, false);
    await duplicateWorker.submitFrame(first.envelope, first.pcm);
    const duplicate = frame(0, false);
    await expect(duplicateWorker.submitFrame(duplicate.envelope, duplicate.pcm)).rejects.toMatchObject({ code: "OUT_OF_ORDER_FRAME" });

    const timestampWorker = core();
    const start = frame(0, false);
    await timestampWorker.submitFrame(start.envelope, start.pcm);
    const reversed = frame(1, false, { timestampMs: 0 });
    await expect(timestampWorker.submitFrame(reversed.envelope, reversed.pcm)).rejects.toMatchObject({ code: "OUT_OF_ORDER_FRAME" });
  });

  it("deduplicates the same frame request and rejects conflicting RequestId reuse", async () => {
    const worker = core();
    const fixture = frame(0, false);
    const first = await worker.submitFrame(fixture.envelope, fixture.pcm);
    expect(await worker.submitFrame(fixture.envelope, fixture.pcm)).toEqual(first);
    const conflicting = new Float32Array(fixture.pcm);
    conflicting[0] = 0.1;
    await expect(worker.submitFrame(fixture.envelope, conflicting)).rejects.toMatchObject({ code: "REQUEST_ID_CONFLICT" });
  });

  it("snapshots mutable caller-owned PCM before asynchronous VAD work", async () => {
    let release: (() => void) | undefined;
    let observed = -1;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const delayedVad: VadBackend = {
      async classify(input) {
        await gate;
        observed = new DataView(input.bytes.buffer, input.bytes.byteOffset, input.bytes.byteLength).getFloat32(0, true);
        return { speechProbability: 1 };
      }
    };
    const worker = core({ vadBackend: delayedVad });
    const fixture = frame(0, true);
    const pending = worker.submitFrame(fixture.envelope, fixture.pcm);
    fixture.pcm.fill(0);
    release?.();
    await pending;
    expect(observed).toBeCloseTo(0.1);
  });

  it("enforces buffered PCM and concurrent stream limits", async () => {
    const bounded = core({ maxBufferedPcmBytes: 1_280 });
    const first = frame(0, true);
    await bounded.submitFrame(first.envelope, first.pcm);
    const second = frame(1, true);
    await expect(bounded.submitFrame(second.envelope, second.pcm)).rejects.toMatchObject({ code: "RESOURCE_LIMIT" });

    const concurrent = core({ maxConcurrentStreams: 2 });
    for (const streamId of ["one", "two"]) {
      const fixture = frame(0, true, { streamId });
      await concurrent.submitFrame(fixture.envelope, fixture.pcm);
    }
    const third = frame(0, true, { streamId: "three" });
    await expect(concurrent.submitFrame(third.envelope, third.pcm)).rejects.toMatchObject({ code: "RESOURCE_LIMIT" });
  });
});

describe("VAD segmentation and endpointing integration", () => {
  it("emits no speech for silence only", async () => {
    const worker = core();
    const events: SpeechWorkerEvent[] = [];
    for (let sequence = 0; sequence < 50; sequence += 1) {
      const fixture = frame(sequence, false);
      events.push(...await worker.submitFrame(fixture.envelope, fixture.pcm));
    }
    expect(events).toEqual([]);
  });

  it("rejects a false onset", async () => {
    const worker = core();
    const first = frame(0, true);
    await worker.submitFrame(first.envelope, first.pcm);
    const second = frame(1, false);
    const events = await worker.submitFrame(second.envelope, second.pcm);
    expect(events).toContainEqual(expect.objectContaining({ type: "UTTERANCE_DISCARDED", reason: "FALSE_START" }));
  });

  it("discards confirmed but too-short speech", async () => {
    const worker = core();
    const events: SpeechWorkerEvent[] = [];
    for (let sequence = 0; sequence < 28; sequence += 1) {
      const fixture = frame(sequence, sequence < 3);
      events.push(...await worker.submitFrame(fixture.envelope, fixture.pcm));
    }
    expect(events).toContainEqual(expect.objectContaining({ type: "SPEECH_STARTED" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "UTTERANCE_DISCARDED", reason: "TOO_SHORT" }));
    expect(events.some((event) => event.type === "TRANSCRIPT_CANDIDATE")).toBe(false);
  });

  it("finalizes a normal utterance exactly once and emits a transcript proposal", async () => {
    const worker = core();
    const events = await feedNormalUtterance(worker);
    expect(events.filter((event) => event.type === "SPEECH_STARTED")).toHaveLength(1);
    expect(events.filter((event) => event.type === "UTTERANCE_FINALIZED")).toHaveLength(1);
    expect(events.filter((event) => event.type === "TRANSCRIPT_CANDIDATE")).toHaveLength(1);
    expect(events).toContainEqual(expect.objectContaining({ type: "UTTERANCE_FINALIZED", finalizationReason: "SILENCE" }));
  });

  it("keeps a short pause in the same utterance", async () => {
    const worker = core();
    const events: SpeechWorkerEvent[] = [];
    let sequence = 0;
    for (; sequence < 6; sequence += 1) {
      const fixture = frame(sequence, true);
      events.push(...await worker.submitFrame(fixture.envelope, fixture.pcm));
    }
    for (let pause = 0; pause < 10; pause += 1, sequence += 1) {
      const fixture = frame(sequence, false);
      events.push(...await worker.submitFrame(fixture.envelope, fixture.pcm));
    }
    for (let resumed = 0; resumed < 4; resumed += 1, sequence += 1) {
      const fixture = frame(sequence, true);
      events.push(...await worker.submitFrame(fixture.envelope, fixture.pcm));
    }
    expect(events.filter((event) => event.type === "SPEECH_STARTED")).toHaveLength(1);
    expect(events.some((event) => event.type === "UTTERANCE_FINALIZED")).toBe(false);
  });

  it("supports explicit flush without committing any application Turn", async () => {
    const worker = core();
    for (let sequence = 0; sequence < 6; sequence += 1) {
      const fixture = frame(sequence, true);
      await worker.submitFrame(fixture.envelope, fixture.pcm);
    }
    const events = await worker.flush({
      protocolVersion: 1,
      requestId: newRequestId(),
      streamId: "stream-a",
      type: "FLUSH_SPEECH"
    });
    expect(events).toContainEqual(expect.objectContaining({ type: "UTTERANCE_FINALIZED", finalizationReason: "FLUSH" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "TRANSCRIPT_CANDIDATE" }));
  });
});

describe("recognition cancellation, races, and diagnostics", () => {
  it("suppresses a late recognizer result after cancellation even without runtime abort", async () => {
    const deferred = deferredRecognizer("NONE");
    const worker = core({ recognizer: deferred.recognizer });
    for (let sequence = 0; sequence < 30; sequence += 1) {
      const fixture = frame(sequence, sequence < 6);
      await worker.submitFrame(fixture.envelope, fixture.pcm);
    }
    const finalFrame = frame(30, false);
    const finalizing = worker.submitFrame(finalFrame.envelope, finalFrame.pcm);
    const recognitionInput = await deferred.started;

    const cancelRequest = {
      protocolVersion: 1 as const,
      requestId: newRequestId(),
      streamId: "stream-a",
      type: "CANCEL_SPEECH" as const
    };
    const cancelled = await worker.cancel(cancelRequest);
    expect(cancelled).toContainEqual(expect.objectContaining({ type: "SPEECH_CANCELLED", cancellation: "SUPPRESS_LATE_RESULT_ONLY" }));
    expect(await worker.cancel(cancelRequest)).toEqual(cancelled);

    deferred.resolve(validRaw(recognitionInput));
    const finalEvents = await finalizing;
    expect(finalEvents).toEqual([]);
  });

  it("suppresses recognition during shutdown and makes shutdown idempotent", async () => {
    const deferred = deferredRecognizer("NONE");
    const worker = core({ recognizer: deferred.recognizer });
    for (let sequence = 0; sequence < 30; sequence += 1) {
      const fixture = frame(sequence, sequence < 6);
      await worker.submitFrame(fixture.envelope, fixture.pcm);
    }
    const finalFrame = frame(30, false);
    const finalizing = worker.submitFrame(finalFrame.envelope, finalFrame.pcm);
    const recognitionInput = await deferred.started;
    await worker.shutdown();
    await worker.shutdown();
    deferred.resolve(validRaw(recognitionInput));
    expect(await finalizing).toEqual([]);
    expect(worker.getActiveStreamCount()).toBe(0);
  });

  it("maps recognizer exceptions and malformed results to stable bounded errors", async () => {
    const throwing: SpeechRecognizer = {
      modelIdentity: { name: "throwing", version: "1" },
      cancellationCapability: "NONE",
      async recognize() { throw new Error("credential=super-secret and transcript body"); }
    };
    const failed = core({ recognizer: throwing });
    const failedEvents = await feedNormalUtterance(failed, "failed");
    expect(failedEvents).toContainEqual(expect.objectContaining({
      type: "SPEECH_WORKER_ERROR",
      code: "RECOGNIZER_FAILURE",
      message: "Recognizer failed to produce a result"
    }));
    expect(JSON.stringify(failed.getDiagnostics())).not.toContain("super-secret");

    const malformed = new DeterministicFakeRecognizer((input) => ({
      ...validRaw(input),
      requestId: newRequestId()
    }));
    const malformedEvents = await feedNormalUtterance(core({ recognizer: malformed }), "malformed");
    expect(malformedEvents).toContainEqual(expect.objectContaining({ type: "SPEECH_WORKER_ERROR", code: "RECOGNIZER_PROTOCOL_ERROR" }));
  });

  it("bounds diagnostics under repeated recognizer failures", async () => {
    const throwing: SpeechRecognizer = {
      modelIdentity: { name: "throwing", version: "1" },
      cancellationCapability: "NONE",
      async recognize() { throw new Error("unbounded provider exception text".repeat(1_000)); }
    };
    const worker = core({
      recognizer: throwing,
      endpointingFactory: () => new AdaptiveEndpointingPolicy({
        minimumSpeechMs: 20,
        minimumSilenceMs: 20,
        incompleteSilenceMs: 20,
        maximumPauseMs: 20,
        maximumUtteranceMs: 1_000
      })
    });
    for (let attempt = 0; attempt < 35; attempt += 1) {
      const streamId = `diag-${String(attempt)}`;
      for (let sequence = 0; sequence < 4; sequence += 1) {
        const fixture = frame(sequence, sequence < 3, { streamId });
        await worker.submitFrame(fixture.envelope, fixture.pcm);
      }
    }
    expect(worker.getDiagnostics().length).toBeLessThanOrEqual(32);
    expect(JSON.stringify(worker.getDiagnostics()).length).toBeLessThan(20_000);
  });

  it("allows independent simultaneous streams with one serialized owner per stream", async () => {
    const worker = core({ maxConcurrentStreams: 4 });
    const left = frame(0, true, { streamId: "left" });
    const right = frame(0, true, { streamId: "right" });
    await Promise.all([
      worker.submitFrame(left.envelope, left.pcm),
      worker.submitFrame(right.envelope, right.pcm)
    ]);
    expect(worker.getActiveStreamCount()).toBe(2);
  });
});

function validRaw(input: RecognizerAudioInput) {
  return {
    requestId: input.requestId,
    utteranceId: input.utteranceId,
    text: "late transcript",
    isFinal: true,
    model: { name: "deferred", version: "1" },
    sourceAudioBasis: input.sourceAudioBasis
  };
}

function deferredRecognizer(cancellationCapability: "NONE" | "RUNTIME_ABORT") {
  let startedResolve: ((input: RecognizerAudioInput) => void) | undefined;
  let resultResolve: ((value: unknown) => void) | undefined;
  const started = new Promise<RecognizerAudioInput>((resolve) => { startedResolve = resolve; });
  const result = new Promise<unknown>((resolve) => { resultResolve = resolve; });
  const recognizer: SpeechRecognizer = {
    modelIdentity: { name: "deferred", version: "1" },
    cancellationCapability,
    async recognize(input) {
      startedResolve?.(input);
      return result;
    },
    async cancel() {
      return cancellationCapability === "RUNTIME_ABORT";
    }
  };
  return {
    recognizer,
    started,
    resolve(value: unknown) { resultResolve?.(value); }
  };
}
