import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  AdaptiveEndpointingPolicy,
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

describe("adaptive endpointing policy", () => {
  const policy = new AdaptiveEndpointingPolicy({
    minimumSpeechMs: 120,
    minimumSilenceMs: 500,
    incompleteSilenceMs: 900,
    maximumPauseMs: 1_500,
    maximumUtteranceMs: 60_000
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
