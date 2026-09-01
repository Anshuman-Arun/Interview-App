import { describe, expect, it } from "vitest";
import { newRequestId } from "../packages/domain/src/index.js";
import {
  MAX_SPEECH_BUFFERED_PCM_BYTES,
  MAX_SPEECH_CONCURRENT_STREAMS,
  MAX_SPEECH_PRE_SPEECH_DURATION_MS,
  MAX_SPEECH_RECOGNIZER_TIMEOUT_MS,
  MAX_SPEECH_REMEMBERED_MESSAGES,
  MAX_SPEECH_VAD_TIMEOUT_MS,
  type SpeechPcmFrameEnvelope,
  type SpeechWorkerEvent
} from "../packages/local-compute/src/speech-protocol.js";
import {
  AdaptiveEndpointingPolicy,
  DeterministicEnergyVadBackend,
  VoiceActivityStateMachine,
  type VadBackend
} from "../packages/local-compute/src/speech-vad.js";
import {
  DeterministicFakeRecognizer,
  type RecognizerAudioInput,
  type SpeechRecognizer
} from "../packages/local-compute/src/speech-stt.js";
import { SpeechWorkerCore } from "../packages/local-compute/src/speech-worker.js";

interface FrameFixture {
  readonly envelope: SpeechPcmFrameEnvelope;
  readonly pcm: Float32Array;
}

function frame(
  sequence: number,
  speech: boolean,
  streamId = "race-stream",
  requestId = newRequestId(),
  timestampMs = sequence * 20
): FrameFixture {
  const pcm = new Float32Array(320);
  pcm.fill(speech ? 0.1 : 0);
  return {
    envelope: {
      protocolVersion: 1,
      requestId,
      streamId,
      sequence,
      sampleRate: 16_000,
      channels: 1,
      sampleFormat: "F32LE",
      frameSamples: 320,
      payloadByteLength: pcm.byteLength,
      timestampMs
    },
    pcm
  };
}

function worker(overrides: Partial<ConstructorParameters<typeof SpeechWorkerCore>[0]> = {}): SpeechWorkerCore {
  return new SpeechWorkerCore({
    vadBackend: new DeterministicEnergyVadBackend(),
    recognizer: new DeterministicFakeRecognizer(),
    ...overrides
  });
}

describe("speech worker adversarial races and hard limits", () => {
  it("tombstones cancellation even when it arrives before the first frame", async () => {
    const subject = worker();
    await subject.cancel({
      protocolVersion: 1,
      requestId: newRequestId(),
      streamId: "cancel-before-frame",
      type: "CANCEL_SPEECH"
    });

    const late = frame(0, true, "cancel-before-frame");
    await expect(subject.submitFrame(late.envelope, late.pcm)).rejects.toMatchObject({
      code: "STREAM_FINALIZED"
    });
  });

  it("reserves RequestIds globally while work is in flight across different streams", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const vadBackend: VadBackend = {
      async classify() {
        await gate;
        return { speechProbability: 0 };
      }
    };
    const subject = worker({ vadBackend });
    const sharedRequestId = newRequestId();
    const left = frame(0, false, "left-race", sharedRequestId);
    const right = frame(0, false, "right-race", sharedRequestId);

    const first = subject.submitFrame(left.envelope, left.pcm);
    await expect(subject.submitFrame(right.envelope, right.pcm)).rejects.toMatchObject({
      code: "REQUEST_ID_CONFLICT"
    });
    release?.();
    await expect(first).resolves.toEqual([]);
  });

  it("coalesces identical concurrent RequestIds instead of running VAD twice", async () => {
    let classifyCount = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const vadBackend: VadBackend = {
      async classify() {
        classifyCount += 1;
        await gate;
        return { speechProbability: 0 };
      }
    };
    const subject = worker({ vadBackend });
    const fixture = frame(0, false);

    const first = subject.submitFrame(fixture.envelope, fixture.pcm);
    const duplicate = subject.submitFrame(fixture.envelope, fixture.pcm);
    release?.();

    expect(await first).toEqual([]);
    expect(await duplicate).toEqual([]);
    expect(classifyCount).toBe(1);
  });

  it("times out a hung VAD callback, closes the stream, and emits only stable diagnostics", async () => {
    const vadBackend: VadBackend = {
      async classify() {
        return new Promise(() => undefined);
      }
    };
    const subject = worker({ vadBackend, vadTimeoutMs: 20 });
    const fixture = frame(0, true);

    await expect(subject.submitFrame(fixture.envelope, fixture.pcm)).rejects.toMatchObject({
      code: "VAD_TIMEOUT",
      message: "VAD backend timed out"
    });
    expect(subject.getActiveStreamCount()).toBe(0);
    expect(subject.getDiagnostics()).toContainEqual(expect.objectContaining({ code: "VAD_TIMEOUT" }));
  });

  it("times out a hung recognizer without leaving the stream or request pending forever", async () => {
    const recognizer: SpeechRecognizer = {
      modelIdentity: { name: "hung-recognizer", version: "1" },
      cancellationCapability: "NONE",
      async recognize() {
        return new Promise(() => undefined);
      }
    };
    const subject = worker({
      recognizer,
      recognizerTimeoutMs: 20,
      endpointingFactory: shortEndpointing
    });

    const events: SpeechWorkerEvent[] = [];
    for (let sequence = 0; sequence < 4; sequence += 1) {
      const fixture = frame(sequence, sequence < 3, "recognizer-timeout");
      events.push(...await subject.submitFrame(fixture.envelope, fixture.pcm));
    }

    expect(events).toContainEqual(expect.objectContaining({
      type: "SPEECH_WORKER_ERROR",
      code: "RECOGNIZER_TIMEOUT"
    }));
    expect(events.some((event) => event.type === "TRANSCRIPT_CANDIDATE")).toBe(false);
    expect(subject.getActiveStreamCount()).toBe(0);
  });

  it("bounds a hanging runtime cancellation callback and still suppresses the late recognition", async () => {
    const deferred = deferredRecognizerWithHangingCancel();
    const subject = worker({
      recognizer: deferred.recognizer,
      endpointingFactory: shortEndpointing,
      cancellationTimeoutMs: 20,
      recognizerTimeoutMs: 200
    });

    for (let sequence = 0; sequence < 3; sequence += 1) {
      const fixture = frame(sequence, true, "cancel-hang");
      await subject.submitFrame(fixture.envelope, fixture.pcm);
    }
    const endpoint = frame(3, false, "cancel-hang");
    const finalizing = subject.submitFrame(endpoint.envelope, endpoint.pcm);
    const recognitionInput = await deferred.started;

    const cancelled = await subject.cancel({
      protocolVersion: 1,
      requestId: newRequestId(),
      streamId: "cancel-hang",
      type: "CANCEL_SPEECH"
    });
    expect(cancelled).toContainEqual(expect.objectContaining({
      type: "SPEECH_CANCELLED",
      cancellation: "SUPPRESS_LATE_RESULT_ONLY"
    }));
    expect(subject.getDiagnostics()).toContainEqual(expect.objectContaining({ code: "CANCELLATION_TIMEOUT" }));

    deferred.resolve(validRaw(recognitionInput, "hanging-cancel"));
    expect(await finalizing).toEqual([]);
  });

  it("shares concurrent shutdown and bounds a hanging recognizer cancel hook", async () => {
    const deferred = deferredRecognizerWithHangingCancel();
    const subject = worker({
      recognizer: deferred.recognizer,
      endpointingFactory: shortEndpointing,
      cancellationTimeoutMs: 20,
      recognizerTimeoutMs: 200
    });

    for (let sequence = 0; sequence < 3; sequence += 1) {
      const fixture = frame(sequence, true, "shutdown-hang");
      await subject.submitFrame(fixture.envelope, fixture.pcm);
    }
    const endpoint = frame(3, false, "shutdown-hang");
    const finalizing = subject.submitFrame(endpoint.envelope, endpoint.pcm);
    const recognitionInput = await deferred.started;

    const firstShutdown = subject.shutdown();
    const secondShutdown = subject.shutdown();
    expect(secondShutdown).toBe(firstShutdown);
    await Promise.all([firstShutdown, secondShutdown]);

    deferred.resolve(validRaw(recognitionInput, "hanging-cancel"));
    expect(await finalizing).toEqual([]);
    expect(subject.getActiveStreamCount()).toBe(0);
  });

  it("expires a silence-only stream so it cannot hold a concurrency slot forever", async () => {
    const subject = worker({ maxPreSpeechDurationMs: 60 });
    const events: SpeechWorkerEvent[] = [];
    for (let sequence = 0; sequence < 3; sequence += 1) {
      const fixture = frame(sequence, false, "silent-timeout");
      events.push(...await subject.submitFrame(fixture.envelope, fixture.pcm));
    }

    expect(events).toContainEqual(expect.objectContaining({
      type: "UTTERANCE_DISCARDED",
      reason: "NO_SPEECH_TIMEOUT"
    }));
    expect(subject.getActiveStreamCount()).toBe(0);
  });

  it("reports acoustic onset time rather than the later hysteresis-confirmation frame", async () => {
    const subject = worker();
    const first = frame(0, true, "onset-time", newRequestId(), 100);
    const second = frame(1, true, "onset-time", newRequestId(), 120);
    const third = frame(2, true, "onset-time", newRequestId(), 140);

    await subject.submitFrame(first.envelope, first.pcm);
    await subject.submitFrame(second.envelope, second.pcm);
    const events = await subject.submitFrame(third.envelope, third.pcm);

    expect(events).toContainEqual(expect.objectContaining({
      type: "SPEECH_STARTED",
      atTimestampMs: 100
    }));
  });

  it("finalizes before a frame that would exceed a configured maximum utterance duration", async () => {
    const subject = worker({
      vadStateFactory: () => new VoiceActivityStateMachine({
        onsetThreshold: 0.5,
        continuationThreshold: 0.5,
        onsetHysteresisMs: 20
      }),
      endpointingFactory: () => new AdaptiveEndpointingPolicy({
        minimumSpeechMs: 20,
        minimumSilenceMs: 20,
        incompleteSilenceMs: 20,
        maximumPauseMs: 20,
        maximumUtteranceMs: 50
      })
    });

    const first = frame(0, true, "max-duration");
    const second = frame(1, true, "max-duration");
    const overflow = frame(2, true, "max-duration");
    await subject.submitFrame(first.envelope, first.pcm);
    await subject.submitFrame(second.envelope, second.pcm);
    const events = await subject.submitFrame(overflow.envelope, overflow.pcm);

    const finalized = events.find((event) => event.type === "UTTERANCE_FINALIZED");
    expect(finalized).toMatchObject({
      type: "UTTERANCE_FINALIZED",
      finalizationReason: "MAX_DURATION",
      durationMs: 40,
      sourceAudioBasis: { lastSequence: 1, sampleCount: 640 }
    });
  });

  it("rejects cumulative timestamp drift and non-binary payload objects", async () => {
    const timestampSubject = worker();
    const first = frame(0, false, "timestamp-drift", newRequestId(), 0);
    await timestampSubject.submitFrame(first.envelope, first.pcm);
    const drifted = frame(1, false, "timestamp-drift", newRequestId(), 300);
    await expect(timestampSubject.submitFrame(drifted.envelope, drifted.pcm)).rejects.toMatchObject({
      code: "OUT_OF_ORDER_FRAME"
    });

    const payloadSubject = worker();
    const valid = frame(0, false, "payload-object");
    await expect(payloadSubject.submitFrame(valid.envelope, { byteLength: valid.pcm.byteLength })).rejects.toMatchObject({
      code: "INVALID_FRAME"
    });
  });

  it("does not allow configuration to raise the protocol hard limits", () => {
    expect(() => worker({ maxConcurrentStreams: MAX_SPEECH_CONCURRENT_STREAMS + 1 })).toThrow();
    expect(() => worker({ maxBufferedPcmBytes: MAX_SPEECH_BUFFERED_PCM_BYTES + 1 })).toThrow();
    expect(() => worker({ maxRememberedMessages: MAX_SPEECH_REMEMBERED_MESSAGES + 1 })).toThrow();
    expect(() => worker({ maxPreSpeechDurationMs: MAX_SPEECH_PRE_SPEECH_DURATION_MS + 1 })).toThrow();
    expect(() => worker({ vadTimeoutMs: MAX_SPEECH_VAD_TIMEOUT_MS + 1 })).toThrow();
    expect(() => worker({ recognizerTimeoutMs: MAX_SPEECH_RECOGNIZER_TIMEOUT_MS + 1 })).toThrow();
  });
});

function shortEndpointing(): AdaptiveEndpointingPolicy {
  return new AdaptiveEndpointingPolicy({
    minimumSpeechMs: 20,
    minimumSilenceMs: 20,
    incompleteSilenceMs: 20,
    maximumPauseMs: 20,
    maximumUtteranceMs: 1_000
  });
}

function validRaw(input: RecognizerAudioInput, modelName: string) {
  return {
    requestId: input.requestId,
    utteranceId: input.utteranceId,
    text: "late transcript",
    isFinal: true,
    model: { name: modelName, version: "1" },
    sourceAudioBasis: input.sourceAudioBasis
  };
}

function deferredRecognizerWithHangingCancel() {
  let startedResolve: ((input: RecognizerAudioInput) => void) | undefined;
  let resultResolve: ((value: unknown) => void) | undefined;
  const started = new Promise<RecognizerAudioInput>((resolve) => { startedResolve = resolve; });
  const result = new Promise<unknown>((resolve) => { resultResolve = resolve; });
  const recognizer: SpeechRecognizer = {
    modelIdentity: { name: "hanging-cancel", version: "1" },
    cancellationCapability: "RUNTIME_ABORT",
    async recognize(input) {
      startedResolve?.(input);
      return result;
    },
    async cancel() {
      return new Promise(() => undefined);
    }
  };
  return {
    recognizer,
    started,
    resolve(value: unknown) { resultResolve?.(value); }
  };
}
