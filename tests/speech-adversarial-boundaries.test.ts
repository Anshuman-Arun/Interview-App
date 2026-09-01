import { describe, expect, it } from "vitest";
import { newRequestId, newUtteranceId } from "../packages/domain/src/index.js";
import {
  AdaptiveEndpointingPolicy,
  DeterministicEnergyVadBackend,
  VoiceActivityStateMachine,
  type VadBackend
} from "../packages/local-compute/src/speech-vad.js";
import {
  DeterministicFakeRecognizer,
  type SpeechRecognizer
} from "../packages/local-compute/src/speech-stt.js";
import { SpeechWorkerCore } from "../packages/local-compute/src/speech-worker.js";
import type { SpeechWorkerEvent } from "../packages/local-compute/src/speech-protocol.js";

function frame(sequence: number, speech = true, streamId = "adversarial-stream") {
  const pcm = new Float32Array(320);
  pcm.fill(speech ? 0.1 : 0);
  return {
    envelope: {
      protocolVersion: 1,
      requestId: newRequestId(),
      streamId,
      sequence,
      sampleRate: 16_000,
      channels: 1,
      sampleFormat: "F32LE",
      frameSamples: 320,
      payloadByteLength: pcm.byteLength,
      timestampMs: sequence * 20
    } as const,
    pcm
  };
}

describe("speech worker adversarial callback boundaries", () => {
  it("runtime-validates malformed construction options instead of relying on TypeScript", () => {
    type Options = ConstructorParameters<typeof SpeechWorkerCore>[0];
    const castOptions = (value: unknown): Options => value as Options;

    expect(() => new SpeechWorkerCore(castOptions(null))).toThrow(/options must be an object/u);
    expect(() => new SpeechWorkerCore(castOptions({
      recognizer: new DeterministicFakeRecognizer()
    }))).toThrow(/VAD backend must be an object/u);
    expect(() => new SpeechWorkerCore(castOptions({
      vadBackend: { classify: "not-a-function" },
      recognizer: new DeterministicFakeRecognizer()
    }))).toThrow(/VAD classify callback is required/u);
    expect(() => new SpeechWorkerCore(castOptions({
      vadBackend: new DeterministicEnergyVadBackend(),
      recognizer: {
        modelIdentity: { name: "fake", version: "1" },
        cancellationCapability: "NONE",
        recognize: async () => ({}),
        cancel: "not-a-function"
      }
    }))).toThrow(/cancel callback must be a function/u);
    expect(() => new SpeechWorkerCore(castOptions({
      vadBackend: new DeterministicEnergyVadBackend(),
      recognizer: new DeterministicFakeRecognizer(),
      endpointingFactory: "not-a-function"
    }))).toThrow(/endpointing factory must be a function/u);
    expect(() => new SpeechWorkerCore(castOptions({
      vadBackend: new DeterministicEnergyVadBackend(),
      recognizer: new DeterministicFakeRecognizer(),
      maxConcurrentStreams: null
    }))).toThrow(/maxConcurrentStreams/u);
    expect(() => new SpeechWorkerCore(castOptions({
      vadBackend: new DeterministicEnergyVadBackend(),
      recognizer: new DeterministicFakeRecognizer(),
      maxConcurrentStream: 1
    }))).toThrow(/unexpected field/u);
  });

  it("snapshots accessor-backed configuration exactly once at construction", async () => {
    let limitReads = 0;
    const options = {
      vadBackend: new DeterministicEnergyVadBackend(),
      recognizer: new DeterministicFakeRecognizer(),
      get maxConcurrentStreams() {
        limitReads += 1;
        return 1;
      }
    };
    const worker = new SpeechWorkerCore(options);
    expect(limitReads).toBe(1);

    const first = frame(0, true, "getter-left");
    await worker.submitFrame(first.envelope, first.pcm);
    const second = frame(0, true, "getter-right");
    await expect(worker.submitFrame(second.envelope, second.pcm)).rejects.toMatchObject({
      code: "RESOURCE_LIMIT"
    });
    expect(limitReads).toBe(1);
  });
  it("maps arbitrary VAD exceptions to a stable code and closes the poisoned stream", async () => {
    const vadBackend: VadBackend = {
      async classify() {
        throw new Error("token=secret-vad-runtime-message");
      }
    };
    const worker = new SpeechWorkerCore({
      vadBackend,
      recognizer: new DeterministicFakeRecognizer()
    });
    const first = frame(0);
    await expect(worker.submitFrame(first.envelope, first.pcm)).rejects.toMatchObject({
      code: "VAD_FAILURE",
      message: "VAD backend failed"
    });
    expect(worker.getActiveStreamCount()).toBe(0);

    const late = frame(1);
    await expect(worker.submitFrame(late.envelope, late.pcm)).rejects.toMatchObject({
      code: "STREAM_FINALIZED"
    });
  });

  it("rejects extra fields in custom VAD observations as protocol violations", async () => {
    const vadBackend: VadBackend = {
      async classify() {
        return { speechProbability: 0, unexpected: "x" };
      }
    };
    const worker = new SpeechWorkerCore({
      vadBackend,
      recognizer: new DeterministicFakeRecognizer()
    });
    const fixture = frame(0);
    await expect(worker.submitFrame(fixture.envelope, fixture.pcm)).rejects.toMatchObject({
      code: "VAD_PROTOCOL_ERROR",
      message: "VAD backend returned an invalid observation"
    });
    expect(worker.getActiveStreamCount()).toBe(0);
  });

  it("rejects forged VAD state-machine output from an injected subclass", async () => {
    class ForgedVadState extends VoiceActivityStateMachine {
      public override step() {
        return {
          state: "SPEECH",
          speechMs: 0,
          silenceMs: 0,
          utteranceMs: 20,
          speechClassified: true,
          speechStarted: true,
          possibleEndpoint: false,
          falseStart: false
        } as never;
      }
    }
    const worker = new SpeechWorkerCore({
      vadBackend: new DeterministicEnergyVadBackend(),
      recognizer: new DeterministicFakeRecognizer(),
      vadStateFactory: () => new ForgedVadState()
    });
    const fixture = frame(0);
    await expect(worker.submitFrame(fixture.envelope, fixture.pcm)).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
      message: "VAD state machine returned an invalid state"
    });
    expect(worker.getActiveStreamCount()).toBe(0);
  });

  it("rejects malformed endpoint decisions from an injected subclass", async () => {
    class ForgedEndpointingPolicy extends AdaptiveEndpointingPolicy {
      public override decide() {
        return { kind: "FINALIZE", reason: "NOT_A_REASON" } as never;
      }
    }
    const worker = new SpeechWorkerCore({
      vadBackend: new DeterministicEnergyVadBackend(),
      recognizer: new DeterministicFakeRecognizer(),
      endpointingFactory: () => new ForgedEndpointingPolicy()
    });
    const fixture = frame(0, false, "forged-endpoint");
    await expect(worker.submitFrame(fixture.envelope, fixture.pcm)).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
      message: "Endpointing policy failed"
    });
    expect(worker.getActiveStreamCount()).toBe(0);
  });

  it("fails closed on malformed VAD probability output", async () => {
    const vadBackend: VadBackend = {
      async classify() {
        return { speechProbability: 2 };
      }
    };
    const worker = new SpeechWorkerCore({
      vadBackend,
      recognizer: new DeterministicFakeRecognizer()
    });
    const fixture = frame(0);
    await expect(worker.submitFrame(fixture.envelope, fixture.pcm)).rejects.toMatchObject({
      code: "VAD_PROTOCOL_ERROR",
      message: "VAD backend returned an invalid observation"
    });
    expect(worker.getActiveStreamCount()).toBe(0);
  });

  it("runtime-validates endpoint heuristics instead of trusting typed callers", async () => {
    const worker = new SpeechWorkerCore({
      vadBackend: new DeterministicEnergyVadBackend(),
      recognizer: new DeterministicFakeRecognizer()
    });
    const fixture = frame(0);
    await expect(worker.submitFrame(fixture.envelope, fixture.pcm, {
      appearsIncomplete: "yes",
      extraPayload: "x".repeat(10_000)
    })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(worker.getActiveStreamCount()).toBe(0);
  });

  it("maps stream factory exceptions to a stable worker error without leaking arbitrary text", async () => {
    const worker = new SpeechWorkerCore({
      vadBackend: new DeterministicEnergyVadBackend(),
      recognizer: new DeterministicFakeRecognizer(),
      vadStateFactory: () => {
        throw new Error("credential=stream-factory-secret");
      }
    });
    const fixture = frame(0);
    await expect(worker.submitFrame(fixture.envelope, fixture.pcm)).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
      message: "Speech stream configuration could not be initialized"
    });
    expect(JSON.stringify(worker.getDiagnostics())).not.toContain("stream-factory-secret");
  });

  it("rejects a state factory that reuses one mutable VAD instance across streams", async () => {
    const sharedVad = new VoiceActivityStateMachine();
    const worker = new SpeechWorkerCore({
      vadBackend: new DeterministicEnergyVadBackend(),
      recognizer: new DeterministicFakeRecognizer(),
      vadStateFactory: () => sharedVad
    });
    const first = frame(0, false, "shared-vad-left");
    await worker.submitFrame(first.envelope, first.pcm);
    const second = frame(0, false, "shared-vad-right");
    await expect(worker.submitFrame(second.envelope, second.pcm)).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
      message: "Speech stream configuration could not be initialized"
    });
  });

  it("rejects recent utterance identity reuse after a false start", async () => {
    const repeatedUtteranceId = newUtteranceId();
    const worker = new SpeechWorkerCore({
      vadBackend: new DeterministicEnergyVadBackend(),
      recognizer: new DeterministicFakeRecognizer(),
      utteranceIdFactory: () => repeatedUtteranceId
    });
    const onset = frame(0, true, "duplicate-utterance");
    await worker.submitFrame(onset.envelope, onset.pcm);
    const falseStart = frame(1, false, "duplicate-utterance");
    await worker.submitFrame(falseStart.envelope, falseStart.pcm);
    const repeatedOnset = frame(2, true, "duplicate-utterance");
    await expect(worker.submitFrame(repeatedOnset.envelope, repeatedOnset.pcm)).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
      message: "Speech worker could not create a valid utterance identity"
    });
    expect(worker.getActiveStreamCount()).toBe(0);
  });

  it("snapshots recognizer identity/cancellation metadata instead of trusting later mutation", async () => {
    const mutable = {
      modelIdentity: { name: "stable-model", version: "1" },
      cancellationCapability: "NONE" as const,
      async recognize(input: Parameters<SpeechRecognizer["recognize"]>[0]) {
        return {
          requestId: input.requestId,
          utteranceId: input.utteranceId,
          text: "stable",
          isFinal: true,
          model: { name: "stable-model", version: "1" },
          sourceAudioBasis: input.sourceAudioBasis
        };
      }
    };
    const worker = new SpeechWorkerCore({
      vadBackend: new DeterministicEnergyVadBackend(),
      recognizer: mutable
    });
    mutable.modelIdentity.name = "mutated-model";

    const events: SpeechWorkerEvent[] = [];
    for (let sequence = 0; sequence < 31; sequence += 1) {
      const fixture = frame(sequence, sequence < 6, "metadata-snapshot");
      events.push(...await worker.submitFrame(fixture.envelope, fixture.pcm));
    }
    const transcript = events.find((event) => event.type === "TRANSCRIPT_CANDIDATE");
    expect(transcript?.type).toBe("TRANSCRIPT_CANDIDATE");
    if (transcript?.type === "TRANSCRIPT_CANDIDATE") {
      expect(transcript.candidate.model).toEqual({ name: "stable-model", version: "1" });
    }
  });

  it("rejects recognizer model-identity spoofing before emitting a transcript", async () => {
    const recognizer: SpeechRecognizer = {
      modelIdentity: { name: "configured-model", version: "v1" },
      cancellationCapability: "NONE",
      async recognize(input) {
        return {
          requestId: input.requestId,
          utteranceId: input.utteranceId,
          text: "spoofed",
          isFinal: true,
          model: { name: "different-model", version: "v9" },
          sourceAudioBasis: input.sourceAudioBasis
        };
      }
    };
    const worker = new SpeechWorkerCore({
      vadBackend: new DeterministicEnergyVadBackend(),
      recognizer,
      endpointingFactory: () => new AdaptiveEndpointingPolicy({
        minimumSpeechMs: 20,
        minimumSilenceMs: 20,
        incompleteSilenceMs: 20,
        maximumPauseMs: 20,
        maximumUtteranceMs: 1_000
      })
    });

    const events: SpeechWorkerEvent[] = [];
    for (let sequence = 0; sequence < 4; sequence += 1) {
      const fixture = frame(sequence, sequence < 3, "model-spoof");
      events.push(...await worker.submitFrame(fixture.envelope, fixture.pcm));
    }

    expect(events).toContainEqual(expect.objectContaining({
      type: "SPEECH_WORKER_ERROR",
      code: "RECOGNIZER_PROTOCOL_ERROR"
    }));
    expect(events.some((event) => event.type === "TRANSCRIPT_CANDIDATE")).toBe(false);
  });
});
