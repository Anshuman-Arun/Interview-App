import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  AdaptiveEndpointingPolicy,
  ScriptedVadBackend,
  VoiceActivityStateMachine
} from "../packages/local-compute/src/speech-vad.js";

describe("deterministic voice activity state machine", () => {
  it("stays silent for silence-only input", () => {
    const vad = new VoiceActivityStateMachine();
    for (let index = 0; index < 100; index += 1) vad.step(0, 20);
    expect(vad.snapshot()).toEqual({ state: "SILENCE", speechMs: 0, silenceMs: 0, utteranceMs: 0 });
  });

  it("rejects a false onset before hysteresis is satisfied", () => {
    const vad = new VoiceActivityStateMachine();
    expect(vad.step(1, 20).state).toBe("POSSIBLE_SPEECH");
    const rejected = vad.step(0, 20);
    expect(rejected.falseStart).toBe(true);
    expect(rejected.state).toBe("SILENCE");
  });

  it("continues speech after a brief pause", () => {
    const vad = new VoiceActivityStateMachine();
    for (let index = 0; index < 6; index += 1) vad.step(1, 20);
    for (let index = 0; index < 10; index += 1) vad.step(0, 20);
    expect(vad.snapshot().state).toBe("POSSIBLE_END");
    expect(vad.snapshot().silenceMs).toBe(200);
    const resumed = vad.step(0.8, 20);
    expect(resumed.state).toBe("SPEECH");
    expect(resumed.silenceMs).toBe(0);
  });

  it("supports explicit cancellation and reset", () => {
    const vad = new VoiceActivityStateMachine();
    vad.step(1, 20);
    vad.cancel();
    expect(vad.snapshot().state).toBe("CANCELLED");
    expect(() => vad.step(1, 20)).toThrow();
    vad.reset();
    expect(vad.snapshot().state).toBe("SILENCE");
  });

  it("runtime-rejects incomplete or unexpected VAD configuration", () => {
    expect(() => new VoiceActivityStateMachine({
      onsetThreshold: 0.5
    } as never)).toThrow(/VAD configuration/u);
    expect(() => new VoiceActivityStateMachine({
      onsetThreshold: 0.5,
      continuationThreshold: 0.4,
      onsetHysteresisMs: 40,
      unexpected: true
    } as never)).toThrow(/VAD configuration/u);
  });

  it("fails closed before standalone VAD state can exceed the global utterance duration", () => {
    const vad = new VoiceActivityStateMachine({
      onsetThreshold: 0.5,
      continuationThreshold: 0.5,
      onsetHysteresisMs: 20
    });
    for (let index = 0; index < 600; index += 1) vad.step(1, 100);
    expect(vad.snapshot().utteranceMs).toBe(60_000);
    expect(() => vad.step(1, 100)).toThrow(/global limit/u);
    expect(vad.snapshot().utteranceMs).toBe(60_000);
  });

  it("snapshots VAD configuration so caller mutation cannot change thresholds mid-stream", () => {
    const config = {
      onsetThreshold: 0.8,
      continuationThreshold: 0.4,
      onsetHysteresisMs: 40
    };
    const vad = new VoiceActivityStateMachine(config);
    config.onsetThreshold = 0.1;
    expect(vad.step(0.5, 20).state).toBe("SILENCE");
  });

  it("does not allow cancellation to rewrite an already finalized terminal state", () => {
    const vad = new VoiceActivityStateMachine();
    vad.finalize();
    expect(() => vad.cancel()).toThrow(/Finalized/u);
    expect(vad.snapshot().state).toBe("FINALIZED");
  });

  it("snapshots scripted backend inputs so caller mutation cannot change results", async () => {
    const probabilities = [1, 0];
    const backend = new ScriptedVadBackend(probabilities);
    probabilities[0] = 0;
    await expect(backend.classify()).resolves.toEqual({ speechProbability: 1 });
  });

  it("is deterministic for arbitrary bounded VAD observations", () => {
    fc.assert(fc.property(
      fc.array(fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }), { maxLength: 200 }),
      (probabilities) => {
        const left = new VoiceActivityStateMachine();
        const right = new VoiceActivityStateMachine();
        const leftSteps = probabilities.map((probability) => left.step(probability, 20));
        const rightSteps = probabilities.map((probability) => right.step(probability, 20));
        expect(leftSteps).toEqual(rightSteps);
      }
    ));
  });
});

describe("VAD adapter direct-call boundaries", () => {
  it("rejects malformed direct frames and scripted probabilities", async () => {
    const energy = new DeterministicEnergyVadBackend();
    await expect(energy.classify(null as never)).rejects.toThrow(/frame input must be an object/u);
    expect(() => new ScriptedVadBackend([0, 1.1])).toThrow(/Scripted VAD probability/u);
    expect(() => new ScriptedVadBackend(null as never)).toThrow(/must be an array/u);
  });

  it("short-circuits already-aborted Silero calls before runtime invocation", async () => {
    let scoreCalls = 0;
    const backend = new SileroVadBackend({
      runtimeVersion: "test-runtime",
      async score() {
        scoreCalls += 1;
        return 0.5;
      }
    }, "models/silero/model.onnx");
    const controller = new AbortController();
    controller.abort();
    await expect(backend.classify(null as never, controller.signal))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(scoreCalls).toBe(0);
    await expect(backend.classify(null as never, null as never))
      .rejects.toThrow(/cancellation signal is invalid/u);
  });
});

describe("adaptive endpointing policy", () => {
  const policy = new AdaptiveEndpointingPolicy({
    minimumSpeechMs: 120,
    minimumSilenceMs: 500,
    incompleteSilenceMs: 900,
    maximumPauseMs: 1_500,
    maximumUtteranceMs: 60_000
  });

  it("runtime-rejects incomplete or unexpected endpoint configuration", () => {
    expect(() => new AdaptiveEndpointingPolicy({
      minimumSpeechMs: 120
    } as never)).toThrow(/Endpointing configuration/u);
    expect(() => new AdaptiveEndpointingPolicy({
      minimumSpeechMs: 120,
      minimumSilenceMs: 500,
      incompleteSilenceMs: 900,
      maximumPauseMs: 1_500,
      maximumUtteranceMs: 60_000,
      unexpected: true
    } as never)).toThrow(/Endpointing configuration/u);
  });

  it("runtime-rejects malformed or internally inconsistent heuristic input", () => {
    expect(() => policy.decide({
      state: "POSSIBLE_END",
      speechMs: Number.NaN,
      silenceMs: 100,
      utteranceMs: 200
    })).toThrow();
    expect(() => policy.decide({
      state: "POSSIBLE_END",
      speechMs: 300,
      silenceMs: 0,
      utteranceMs: 200
    })).toThrow(/Speech duration/u);
  });

  it("snapshots endpoint configuration so caller mutation cannot change policy mid-stream", () => {
    const config = {
      minimumSpeechMs: 120,
      minimumSilenceMs: 500,
      incompleteSilenceMs: 900,
      maximumPauseMs: 1_500,
      maximumUtteranceMs: 60_000
    };
    const stable = new AdaptiveEndpointingPolicy(config);
    config.minimumSilenceMs = 1;
    expect(stable.decide({
      state: "POSSIBLE_END",
      speechMs: 400,
      silenceMs: 100,
      utteranceMs: 500
    })).toEqual({ kind: "CONTINUE" });
  });

  it("uses maximum pause as an absolute cap for incomplete-utterance extension", () => {
    const capped = new AdaptiveEndpointingPolicy({
      minimumSpeechMs: 120,
      minimumSilenceMs: 500,
      incompleteSilenceMs: 5_000,
      maximumPauseMs: 1_500,
      maximumUtteranceMs: 60_000
    });
    expect(capped.decide({
      state: "POSSIBLE_END",
      speechMs: 400,
      silenceMs: 1_499,
      utteranceMs: 1_899,
      appearsIncomplete: true
    })).toEqual({ kind: "CONTINUE" });
    expect(capped.decide({
      state: "POSSIBLE_END",
      speechMs: 400,
      silenceMs: 1_500,
      utteranceMs: 1_900,
      appearsIncomplete: true
    })).toEqual({ kind: "FINALIZE", reason: "SILENCE" });
  });

  it("rejects endpoint decisions against terminal VAD states", () => {
    expect(() => policy.decide({
      state: "CANCELLED",
      speechMs: 400,
      silenceMs: 500,
      utteranceMs: 900
    })).toThrow(/terminal/u);
  });

  it("rejects endpoint snapshots that no real VAD state could produce", () => {
    expect(() => policy.decide({
      state: "SILENCE",
      speechMs: 1,
      silenceMs: 0,
      utteranceMs: 1
    })).toThrow(/Silent VAD state/u);
    expect(() => policy.decide({
      state: "POSSIBLE_END",
      speechMs: 100,
      silenceMs: 0,
      utteranceMs: 100
    })).toThrow(/Possible-end VAD state/u);
    expect(() => policy.decide({
      state: "SPEECH",
      speechMs: 100,
      silenceMs: 50,
      utteranceMs: 150
    })).toThrow(/Speech VAD state/u);
  });

  it("does not finalize on a brief pause", () => {
    expect(policy.decide({ state: "POSSIBLE_END", speechMs: 400, silenceMs: 300, utteranceMs: 700 })).toEqual({ kind: "CONTINUE" });
  });

  it("finalizes after sufficient silence", () => {
    expect(policy.decide({ state: "POSSIBLE_END", speechMs: 400, silenceMs: 500, utteranceMs: 900 })).toEqual({
      kind: "FINALIZE",
      reason: "SILENCE"
    });
  });

  it("extends pause tolerance for an incomplete utterance hint", () => {
    expect(policy.decide({
      state: "POSSIBLE_END",
      speechMs: 400,
      silenceMs: 700,
      utteranceMs: 1_100,
      appearsIncomplete: true
    })).toEqual({ kind: "CONTINUE" });
    expect(policy.decide({
      state: "POSSIBLE_END",
      speechMs: 400,
      silenceMs: 900,
      utteranceMs: 1_300,
      appearsIncomplete: true
    })).toEqual({ kind: "FINALIZE", reason: "SILENCE" });
  });

  it("discards short speech and supports explicit flush", () => {
    expect(policy.decide({ state: "SPEECH", speechMs: 80, silenceMs: 0, utteranceMs: 80, explicitFlush: true })).toEqual({
      kind: "DISCARD",
      reason: "TOO_SHORT"
    });
    expect(policy.decide({ state: "SPEECH", speechMs: 200, silenceMs: 0, utteranceMs: 200, explicitFlush: true })).toEqual({
      kind: "FINALIZE",
      reason: "FLUSH"
    });
  });

  it("rejects endpoint configurations whose minimum speech can never fit", () => {
    expect(() => new AdaptiveEndpointingPolicy({
      minimumSpeechMs: 201,
      minimumSilenceMs: 20,
      incompleteSilenceMs: 20,
      maximumPauseMs: 300,
      maximumUtteranceMs: 200
    })).toThrow(/Minimum speech duration/u);
  });

  it("forces a deterministic maximum-duration endpoint", () => {
    const shortPolicy = new AdaptiveEndpointingPolicy({
      minimumSpeechMs: 20,
      minimumSilenceMs: 100,
      incompleteSilenceMs: 200,
      maximumPauseMs: 300,
      maximumUtteranceMs: 200
    });
    expect(shortPolicy.decide({ state: "SPEECH", speechMs: 180, silenceMs: 0, utteranceMs: 200 })).toEqual({
      kind: "FINALIZE",
      reason: "MAX_DURATION"
    });
  });
});
