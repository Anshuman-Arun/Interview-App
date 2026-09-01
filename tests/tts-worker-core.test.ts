import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { newRequestId } from "../packages/domain/src/index.js";
import {
  DeterministicFakeSpeechSynthesizer,
  KokoroSpeechSynthesizer,
  TTS_LIMITS,
  computeTtsChunkBasisHash,
  TtsAudioChunkSchema,
  TtsCancellationResultSchema,
  TtsIncomingMessageSchema,
  TtsRequestManager,
  TtsStreamMessageSchema,
  TtsSynthesizeRequestSchema,
  TtsWorkerCore,
  TtsWorkerError,
  normalizeTtsText,
  planTtsRequest,
  planTtsSegments,
  snapshotAndValidatePcm,
  type KokoroRuntime,
  type KokoroRuntimeSession,
  type KokoroRuntimeSynthesisResult,
  type SpeechSynthesizer,
  type SynthesizedPcm,
  type TtsLanguage,
  type TtsMessageSink,
  type TtsModelIdentity,
  type TtsSampleRate,
  type TtsSegmentSynthesisRequest,
  type TtsStreamMessage,
  type TtsSynthesizeRequest
} from "../packages/local-compute/src/index.js";

function request(overrides: Partial<TtsSynthesizeRequest> = {}): TtsSynthesizeRequest {
  return {
    protocolVersion: 1,
    type: "SYNTHESIZE",
    requestId: newRequestId(),
    text: "Could you justify that step?",
    voice: "fake-neutral",
    speed: 1,
    language: "en-US",
    sampleRate: 24_000,
    outputFormat: "PCM_F32LE",
    ...overrides
  };
}

function cancelRequest(requestId: TtsSynthesizeRequest["requestId"]) {
  return {
    protocolVersion: 1 as const,
    type: "CANCEL_SYNTHESIS" as const,
    requestId
  };
}

function tinyPcm(
  synthesisRequest: TtsSegmentSynthesisRequest,
  frameCount = 8
): SynthesizedPcm {
  const samples = new Float32Array(frameCount);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = ((index % 5) - 2) / 20;
  }
  return {
    sampleRate: synthesisRequest.sampleRate,
    channels: 1,
    durationMs: (frameCount / synthesisRequest.sampleRate) * 1_000,
    samples
  };
}

class TinySynthesizer implements SpeechSynthesizer {
  public readonly identity: TtsModelIdentity = {
    engine: "test",
    modelId: "tiny",
    modelVersion: "1",
    runtimeVersion: "test",
    waveformDeterminism: "BYTE_STABLE"
  };
  public readonly supportedVoices = new Set(["fake-neutral"]);
  public readonly supportedLanguages: ReadonlySet<TtsLanguage>;
  public readonly supportedSampleRates: ReadonlySet<TtsSampleRate>;
  public calls = 0;
  public cancelCalls = 0;

  public constructor(
    languages: readonly TtsLanguage[] = ["en-US", "en-GB"],
    sampleRates: readonly TtsSampleRate[] = [22_050, 24_000, 44_100, 48_000]
  ) {
    this.supportedLanguages = new Set<TtsLanguage>(languages);
    this.supportedSampleRates = new Set<TtsSampleRate>(sampleRates);
  }

  public async synthesize(synthesisRequest: TtsSegmentSynthesisRequest): Promise<SynthesizedPcm> {
    this.calls += 1;
    return tinyPcm(synthesisRequest);
  }

  public async cancel(): Promise<"UNSUPPORTED"> {
    this.cancelCalls += 1;
    return "UNSUPPORTED";
  }
}

interface PendingSynthesis {
  readonly request: TtsSegmentSynthesisRequest;
  readonly resolve: (value: SynthesizedPcm) => void;
}

class DeferredSynthesizer implements SpeechSynthesizer {
  public readonly identity: TtsModelIdentity = {
    engine: "test",
    modelId: "deferred",
    modelVersion: "1",
    runtimeVersion: "test",
    waveformDeterminism: "BYTE_STABLE"
  };
  public readonly supportedVoices = new Set(["fake-neutral"]);
  public readonly supportedLanguages = new Set<TtsLanguage>(["en-US", "en-GB"]);
  public readonly supportedSampleRates = new Set<TtsSampleRate>([22_050, 24_000, 44_100, 48_000]);
  public readonly pending: PendingSynthesis[] = [];
  public calls = 0;
  public cancelCalls = 0;

  public synthesize(synthesisRequest: TtsSegmentSynthesisRequest): Promise<SynthesizedPcm> {
    this.calls += 1;
    return new Promise<SynthesizedPcm>((resolvePromise) => {
      this.pending.push({ request: synthesisRequest, resolve: resolvePromise });
    });
  }

  public async cancel(): Promise<"UNSUPPORTED"> {
    this.cancelCalls += 1;
    return "UNSUPPORTED";
  }

  public resolveNext(frameCount = 8): void {
    const next = this.pending.shift();
    if (next === undefined) throw new Error("No pending synthesis");
    next.resolve(tinyPcm(next.request, frameCount));
  }
}

class HangingCancellationSynthesizer extends DeferredSynthesizer {
  private readonly cancellationResolvers: Array<(result: "UNSUPPORTED") => void> = [];

  public override async cancel(): Promise<"UNSUPPORTED"> {
    this.cancelCalls += 1;
    return new Promise<"UNSUPPORTED">((resolvePromise) => {
      this.cancellationResolvers.push(resolvePromise);
    });
  }

  public resolveCancellation(): void {
    const resolvePromise = this.cancellationResolvers.shift();
    if (resolvePromise === undefined) throw new Error("No pending cancellation");
    resolvePromise("UNSUPPORTED");
  }
}

class HangingCloseSynthesizer extends DeferredSynthesizer {
  public closeCalls = 0;

  public async close(): Promise<void> {
    this.closeCalls += 1;
    await new Promise<void>(() => undefined);
  }
}

class SelectiveDeferredSynthesizer implements SpeechSynthesizer {
  public readonly identity: TtsModelIdentity = {
    engine: "test",
    modelId: "selective-deferred",
    modelVersion: "1",
    runtimeVersion: "test",
    waveformDeterminism: "BYTE_STABLE"
  };
  public readonly supportedVoices = new Set(["fake-neutral"]);
  public readonly supportedLanguages = new Set<TtsLanguage>(["en-US", "en-GB"]);
  public readonly supportedSampleRates = new Set<TtsSampleRate>([22_050, 24_000, 44_100, 48_000]);
  public readonly pending: PendingSynthesis[] = [];

  public synthesize(synthesisRequest: TtsSegmentSynthesisRequest): Promise<SynthesizedPcm> {
    if (synthesisRequest.text === "hold-runtime-open") {
      return new Promise<SynthesizedPcm>((resolvePromise) => {
        this.pending.push({ request: synthesisRequest, resolve: resolvePromise });
      });
    }
    return Promise.resolve(tinyPcm(synthesisRequest));
  }

  public async cancel(): Promise<"UNSUPPORTED"> {
    return "UNSUPPORTED";
  }

  public resolveHeld(): void {
    const next = this.pending.shift();
    if (next === undefined) throw new Error("No held synthesis");
    next.resolve(tinyPcm(next.request));
  }
}

class ThrowingSynthesizer implements SpeechSynthesizer {
  public readonly identity: TtsModelIdentity = {
    engine: "test",
    modelId: "throwing",
    modelVersion: "1",
    runtimeVersion: "test",
    waveformDeterminism: "NOT_GUARANTEED"
  };
  public readonly supportedVoices = new Set(["fake-neutral"]);
  public readonly supportedLanguages = new Set<TtsLanguage>(["en-US"]);
  public readonly supportedSampleRates = new Set<TtsSampleRate>([22_050, 24_000, 44_100, 48_000]);

  public async synthesize(): Promise<SynthesizedPcm> {
    const privateModelPath = resolve("fixtures/private-model/kokoro.onnx");
    throw new Error(`failure at ${privateModelPath} authorization=secret-value`);
  }
}

class SecretTypedErrorSynthesizer implements SpeechSynthesizer {
  public readonly identity: TtsModelIdentity = {
    engine: "test",
    modelId: "typed-error",
    modelVersion: "1",
    runtimeVersion: "test",
    waveformDeterminism: "NOT_GUARANTEED"
  };
  public readonly supportedVoices = new Set(["fake-neutral"]);
  public readonly supportedLanguages = new Set<TtsLanguage>(["en-US"]);
  public readonly supportedSampleRates = new Set<TtsSampleRate>([24_000]);

  public async synthesize(): Promise<SynthesizedPcm> {
    const hiddenPath = resolve("fixtures/hidden-runtime/model.onnx");
    throw new TtsWorkerError(
      "SYNTHESIS_FAILED",
      `backend secret at ${hiddenPath} token=should-not-escape`
    );
  }
}

class SpoofedApplicationErrorSynthesizer implements SpeechSynthesizer {
  public readonly identity: TtsModelIdentity = {
    engine: "test",
    modelId: "spoofed-application-error",
    modelVersion: "1",
    runtimeVersion: "test",
    waveformDeterminism: "NOT_GUARANTEED"
  };
  public readonly supportedVoices = new Set(["fake-neutral"]);
  public readonly supportedLanguages = new Set<TtsLanguage>(["en-US"]);
  public readonly supportedSampleRates = new Set<TtsSampleRate>([24_000]);

  public async synthesize(): Promise<SynthesizedPcm> {
    throw new TtsWorkerError("REQUEST_ID_CONFLICT", "backend attempted to forge application state");
  }
}

class InvalidCodeSynthesizer implements SpeechSynthesizer {
  public readonly identity: TtsModelIdentity = {
    engine: "test",
    modelId: "invalid-code",
    modelVersion: "1",
    runtimeVersion: "test",
    waveformDeterminism: "NOT_GUARANTEED"
  };
  public readonly supportedVoices = new Set(["fake-neutral"]);
  public readonly supportedLanguages = new Set<TtsLanguage>(["en-US"]);
  public readonly supportedSampleRates = new Set<TtsSampleRate>([24_000]);

  public async synthesize(): Promise<SynthesizedPcm> {
    const error = new TtsWorkerError("SYNTHESIS_FAILED", "typed but corrupted code");
    Reflect.set(error, "code", "NOT_A_TTS_ERROR_CODE");
    throw error;
  }
}

class HostileOutputSynthesizer implements SpeechSynthesizer {
  public readonly identity: TtsModelIdentity = {
    engine: "test",
    modelId: "hostile",
    modelVersion: "1",
    runtimeVersion: "test",
    waveformDeterminism: "NOT_GUARANTEED"
  };
  public readonly supportedVoices = new Set(["fake-neutral"]);
  public readonly supportedLanguages = new Set<TtsLanguage>(["en-US"]);
  public readonly supportedSampleRates = new Set<TtsSampleRate>([22_050, 24_000, 44_100, 48_000]);

  public constructor(
    private readonly output: (request: TtsSegmentSynthesisRequest) => SynthesizedPcm
  ) {}

  public async synthesize(synthesisRequest: TtsSegmentSynthesisRequest): Promise<SynthesizedPcm> {
    return this.output(synthesisRequest);
  }
}

async function waitFor(predicate: () => boolean, attempts = 100): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 0));
  }
  throw new Error("Timed out waiting for TTS test condition");
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function runAndCollect(
  manager: TtsRequestManager,
  synthesisRequest: TtsSynthesizeRequest
): Promise<{ readonly messages: TtsStreamMessage[]; readonly summary: Awaited<ReturnType<TtsRequestManager["run"]>> }> {
  const messages: TtsStreamMessage[] = [];
  const summary = await manager.run(synthesisRequest, (message) => {
    messages.push(message);
  });
  return { messages, summary };
}

describe("TTS request validation", () => {
  it("accepts a strict protocol-v1 request and rejects unknown fields", () => {
    const valid = request();
    expect(TtsSynthesizeRequestSchema.parse(valid)).toEqual(valid);
    expect(TtsIncomingMessageSchema.parse(valid)).toEqual(valid);
    expect(() => TtsSynthesizeRequestSchema.parse({ ...valid, arbitrary: true })).toThrow();
  });

  it.each([
    ["empty", ""],
    ["whitespace", " \t\n "],
    ["too long", "x".repeat(TTS_LIMITS.maxTextCharacters + 1)],
    ["control", `hello${String.fromCharCode(1)}world`],
    ["lone surrogate", `hello${String.fromCharCode(0xd800)}world`]
  ])("rejects %s text", (_label, text) => {
    expect(() => TtsSynthesizeRequestSchema.parse({ ...request(), text })).toThrow();
  });

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    0.49,
    2.01,
    "1"
  ])("rejects invalid speed %s without coercion", (speed) => {
    expect(() => TtsSynthesizeRequestSchema.parse({ ...request(), speed })).toThrow();
  });

  it("contains request/cancellation property-access failures instead of leaking getter exceptions", async () => {
    const manager = new TtsRequestManager(new TinySynthesizer());

    const hostileSynthesis = { ...request() } as Record<string, unknown>;
    Object.defineProperty(hostileSynthesis, "text", {
      enumerable: true,
      get: () => {
        throw new Error("secret-synthesis-getter");
      }
    });
    try {
      await manager.run(hostileSynthesis, () => undefined);
      throw new Error("Expected hostile synthesis request to fail");
    } catch (error) {
      expect(error).toMatchObject({
        code: "INVALID_REQUEST",
        message: "TTS request was rejected"
      });
      expect(String(error)).not.toContain("secret-synthesis-getter");
    }

    const hostileCancellation: Record<string, unknown> = {
      protocolVersion: 1,
      type: "CANCEL_SYNTHESIS"
    };
    Object.defineProperty(hostileCancellation, "requestId", {
      enumerable: true,
      get: () => {
        throw new Error("secret-cancel-getter");
      }
    });
    try {
      await manager.cancel(hostileCancellation);
      throw new Error("Expected hostile cancellation request to fail");
    } catch (error) {
      expect(error).toMatchObject({ code: "INVALID_REQUEST" });
      expect(String(error)).not.toContain("secret-cancel-getter");
    }
  });

  it("bounds and sanitizes request identity metadata", () => {
    expect(() => TtsSynthesizeRequestSchema.parse({
      ...request(),
      requestId: "bad request id"
    })).toThrow();
    expect(() => TtsSynthesizeRequestSchema.parse({
      ...request(),
      requestId: `r_${"x".repeat(TTS_LIMITS.maxRequestIdCharacters)}`
    })).toThrow();
  });

  it("rejects bidi controls, BOM, and Unicode noncharacters instead of passing invisible control semantics to TTS", () => {
    for (const text of [
      `left${String.fromCodePoint(0x202e)}right`,
      `left${String.fromCodePoint(0x2067)}right`,
      `${String.fromCodePoint(0xfeff)}hello`,
      `hello${String.fromCodePoint(0xffff)}`
    ]) {
      expect(() => TtsSynthesizeRequestSchema.parse({ ...request(), text })).toThrow();
    }
  });

  it("rejects unsupported language, sample rate, malformed voice, and oversized voice metadata", () => {
    expect(() => TtsSynthesizeRequestSchema.parse({ ...request(), language: "fr-FR" })).toThrow();
    expect(() => TtsSynthesizeRequestSchema.parse({ ...request(), sampleRate: 16_000 })).toThrow();
    expect(() => TtsSynthesizeRequestSchema.parse({ ...request(), voice: "bad voice" })).toThrow();
    expect(() => TtsSynthesizeRequestSchema.parse({
      ...request(),
      voice: "v".repeat(TTS_LIMITS.maxVoiceCharacters + 1)
    })).toThrow();
  });

  it("rejects contradictory cancellation-result envelopes", () => {
    const requestId = newRequestId();
    expect(() => TtsCancellationResultSchema.parse({
      protocolVersion: 1,
      type: "CANCEL_RESULT",
      requestId,
      accepted: false,
      runtimeCancellation: "REQUESTED"
    })).toThrow();
    expect(() => TtsCancellationResultSchema.parse({
      protocolVersion: 1,
      type: "CANCEL_RESULT",
      requestId,
      accepted: false,
      runtimeCancellation: "UNSUPPORTED"
    })).toThrow();
    expect(TtsCancellationResultSchema.parse({
      protocolVersion: 1,
      type: "CANCEL_RESULT",
      requestId,
      accepted: false,
      runtimeCancellation: "NOT_NEEDED"
    }).accepted).toBe(false);
  });

  it("rejects a syntactically valid but unavailable voice before model execution", async () => {
    const synth = new TinySynthesizer();
    const manager = new TtsRequestManager(synth);
    await expect(manager.run(request({ voice: "other-voice" }), () => undefined))
      .rejects.toMatchObject({ code: "UNSUPPORTED_VOICE" });
    expect(synth.calls).toBe(0);
  });

  it("rejects a supported protocol sample rate unavailable in the selected synthesizer before model execution", async () => {
    const synth = new TinySynthesizer(["en-US", "en-GB"], [24_000]);
    const manager = new TtsRequestManager(synth);
    await expect(manager.run(request({ sampleRate: 48_000 }), () => undefined))
      .rejects.toMatchObject({ code: "UNSUPPORTED_SAMPLE_RATE" });
    expect(synth.calls).toBe(0);
  });

  it("rejects a supported protocol language unavailable in the selected synthesizer", async () => {
    const synth = new TinySynthesizer(["en-US"]);
    const manager = new TtsRequestManager(synth);
    await expect(manager.run(request({ language: "en-GB" }), () => undefined))
      .rejects.toMatchObject({ code: "UNSUPPORTED_LANGUAGE" });
    expect(synth.calls).toBe(0);
  });

  it("rejects requests that cannot fit the configured PCM byte budget at the requested sample rate", async () => {
    const synth = new TinySynthesizer(["en-US", "en-GB"], [24_000, 48_000]);
    const manager = new TtsRequestManager(synth);
    const longButGloballyAllowedText = "x".repeat(1_000);

    await expect(manager.run(request({
      text: longButGloballyAllowedText,
      sampleRate: 48_000
    }), () => undefined)).rejects.toMatchObject({ code: "RESOURCE_LIMIT" });
    expect(synth.calls).toBe(0);

    expect(() => planTtsRequest(request({
      text: longButGloballyAllowedText,
      sampleRate: 24_000
    }))).not.toThrow();
  });

  it("rejects requests whose deterministic duration estimate is impossible before synthesis", () => {
    const slow = request({
      speed: 0.5,
      text: "long ".repeat(500)
    });
    expect(() => planTtsRequest(slow)).toThrow(expect.objectContaining({ code: "RESOURCE_LIMIT" }));
  });
});

describe("TTS normalization and segmentation", () => {
  it("normalizes line endings and whitespace conservatively without rewriting math-like tokens", () => {
    expect(normalizeTtsText("  line   one\r\n\r\nx^2   +  P(A|B)\n1/2  "))
      .toBe("line one\n\nx^2 + P(A|B)\n1/2");
  });

  it("uses deterministic punctuation-aware segmentation", () => {
    const text = normalizeTtsText(
      "First claim. Second claim? Third claim! A longer continuation, with a fallback boundary; then more text."
    );
    const first = planTtsSegments(text, 1, {
      maxSegmentCharacters: 35,
      maxSegmentDurationMs: TTS_LIMITS.maxSegmentDurationMs
    });
    const second = planTtsSegments(text, 1, {
      maxSegmentCharacters: 35,
      maxSegmentDurationMs: TTS_LIMITS.maxSegmentDurationMs
    });
    expect(second).toEqual(first);
    expect(first.length).toBeGreaterThan(1);
    expect(first.every((segment) => Array.from(segment.text).length <= 35)).toBe(true);
  });

  it("falls back safely on long unbroken input and never splits beyond the configured character bound", () => {
    const normalized = "x".repeat(1_301);
    const segments = planTtsSegments(normalized, 2, {
      maxSegmentCharacters: 500,
      maxSegmentDurationMs: TTS_LIMITS.maxSegmentDurationMs,
      maxEstimatedDurationMs: TTS_LIMITS.maxEstimatedDurationMs
    });
    expect(segments.map((segment) => segment.text).join("")).toBe(normalized);
    expect(segments.map((segment) => Array.from(segment.text).length)).toEqual([500, 500, 301]);
  });

  it("handles exact segmentation boundaries deterministically", () => {
    const exact = planTtsSegments("x".repeat(500), 2, {
      maxSegmentCharacters: 500,
      maxSegmentDurationMs: TTS_LIMITS.maxSegmentDurationMs,
      maxEstimatedDurationMs: TTS_LIMITS.maxEstimatedDurationMs
    });
    const over = planTtsSegments("x".repeat(501), 2, {
      maxSegmentCharacters: 500,
      maxSegmentDurationMs: TTS_LIMITS.maxSegmentDurationMs,
      maxEstimatedDurationMs: TTS_LIMITS.maxEstimatedDurationMs
    });
    expect(exact).toHaveLength(1);
    expect(over).toHaveLength(2);
    expect(over[0]?.text).toHaveLength(500);
  });

  it("rejects oversized standalone segmentation input before materializing segment state", () => {
    expect(() => planTtsSegments(
      "x".repeat(TTS_LIMITS.maxTextCharacters + 1),
      1
    )).toThrow(expect.objectContaining({ code: "RESOURCE_LIMIT" }));
  });

  it("does not allow helper-supplied planning limits to widen production hard bounds", () => {
    expect(() => planTtsSegments("bounded text", 1, {
      maxSegmentCharacters: TTS_LIMITS.maxSegmentCharacters + 1
    })).toThrow(expect.objectContaining({ code: "INTERNAL_ERROR" }));
    expect(() => planTtsSegments("bounded text", 1, {
      maxSegmentDurationMs: TTS_LIMITS.maxSegmentDurationMs + 1
    })).toThrow(expect.objectContaining({ code: "INTERNAL_ERROR" }));
    expect(() => planTtsSegments("bounded text", 1, {
      maxEstimatedDurationMs: TTS_LIMITS.maxEstimatedDurationMs + 1
    })).toThrow(expect.objectContaining({ code: "INTERNAL_ERROR" }));
  });

  it("returns an immutable planned request snapshot consistent with its basis hashes", () => {
    const planned = planTtsRequest(request());
    expect(Object.isFrozen(planned)).toBe(true);
    expect(Object.isFrozen(planned.request)).toBe(true);
    expect(Object.isFrozen(planned.segments)).toBe(true);
    expect(planned.segments.every((segment) => Object.isFrozen(segment))).toBe(true);
  });

  it("keeps math-like wording byte-for-byte except conservative whitespace normalization", () => {
    const normalized = normalizeTtsText("x^2  P(A|B)  1/2  R(3,3)");
    expect(normalized).toBe("x^2 P(A|B) 1/2 R(3,3)");
    expect(planTtsSegments(normalized, 1)[0]?.text).toBe(normalized);
  });
});

describe("TTS PCM trust boundary", () => {
  it("contains hostile PCM metadata getters as OUTPUT_INVALID", () => {
    const hostileOutput: Record<string, unknown> = {
      sampleRate: 24_000,
      channels: 1,
      durationMs: 1
    };
    Object.defineProperty(hostileOutput, "samples", {
      enumerable: true,
      get: () => {
        throw new Error("secret-pcm-getter");
      }
    });
    try {
      snapshotAndValidatePcm(hostileOutput, 24_000);
      throw new Error("Expected hostile PCM output to fail");
    } catch (error) {
      expect(error).toMatchObject({
        code: "OUTPUT_INVALID",
        message: "Synthesizer returned malformed PCM metadata"
      });
      expect(String(error)).not.toContain("secret-pcm-getter");
    }
  });

  it("accepts valid deterministic fake PCM", async () => {
    const synth = new DeterministicFakeSpeechSynthesizer();
    const synthesisRequest: TtsSegmentSynthesisRequest = {
      requestId: newRequestId(),
      segmentIndex: 0,
      text: "test",
      voice: "fake-neutral",
      speed: 1,
      language: "en-US",
      sampleRate: 24_000
    };
    const output = await synth.synthesize(synthesisRequest);
    const validated = snapshotAndValidatePcm(output, 24_000);
    expect(validated.frameCount).toBeGreaterThan(0);
    expect(validated.byteLength).toBe(validated.frameCount * 4);
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY]
  ])("rejects %s PCM samples", (_label, sample) => {
    expect(() => snapshotAndValidatePcm({
      sampleRate: 24_000,
      channels: 1,
      durationMs: 1 / 24,
      samples: new Float32Array([sample])
    }, 24_000)).toThrow(expect.objectContaining({ code: "OUTPUT_INVALID" }));
  });

  it.each([
    ["above +1", 1.0001],
    ["below -1", -1.0001]
  ])("rejects normalized PCM amplitudes %s", (_label, sample) => {
    expect(() => snapshotAndValidatePcm({
      sampleRate: 24_000,
      channels: 1,
      durationMs: 1 / 24,
      samples: new Float32Array([sample])
    }, 24_000)).toThrow(expect.objectContaining({ code: "OUTPUT_INVALID" }));
  });

  it("rejects wrong sample rate and wrong channel count", () => {
    const samples = new Float32Array([0, 0]);
    expect(() => snapshotAndValidatePcm({
      sampleRate: 22_050,
      channels: 1,
      durationMs: (2 / 22_050) * 1_000,
      samples
    }, 24_000)).toThrow(expect.objectContaining({ code: "OUTPUT_INVALID" }));
    expect(() => snapshotAndValidatePcm({
      sampleRate: 24_000,
      channels: 2,
      durationMs: (2 / 24_000) * 1_000,
      samples
    }, 24_000)).toThrow(expect.objectContaining({ code: "OUTPUT_INVALID" }));
  });

  it("rejects mismatched duration metadata", () => {
    expect(() => snapshotAndValidatePcm({
      sampleRate: 24_000,
      channels: 1,
      durationMs: 500,
      samples: new Float32Array(24)
    }, 24_000)).toThrow(expect.objectContaining({ code: "OUTPUT_INVALID" }));
  });

  it("snapshots mutable model output before admitting it", () => {
    const source = new Float32Array([0.25, -0.25]);
    const validated = snapshotAndValidatePcm({
      sampleRate: 24_000,
      channels: 1,
      durationMs: (2 / 24_000) * 1_000,
      samples: source
    }, 24_000);
    source[0] = Number.NaN;
    source[1] = 1;
    expect(Array.from(validated.samples)).toEqual([0.25, -0.25]);
  });

  it("rejects proxied or property-shadowed Float32Array storage at the PCM trust boundary", () => {
    const proxied = new Proxy(new Float32Array([0]), {});
    try {
      snapshotAndValidatePcm({
        sampleRate: 24_000,
        channels: 1,
        durationMs: (1 / 24_000) * 1_000,
        samples: proxied
      }, 24_000);
      throw new Error("Expected proxied PCM storage to fail");
    } catch (error) {
      expect(error).toMatchObject({ code: "OUTPUT_INVALID" });
      expect(error).toBeInstanceOf(TtsWorkerError);
    }

    const frames = Math.floor(TTS_LIMITS.maxPcmBytes / 4) + 1;
    const shadowed = new Float32Array(frames);
    Object.defineProperty(shadowed, "length", { value: 1 });
    Object.defineProperty(shadowed, "byteLength", { value: 4 });
    expect(() => snapshotAndValidatePcm({
      sampleRate: 24_000,
      channels: 1,
      durationMs: (1 / 24_000) * 1_000,
      samples: shadowed
    }, 24_000)).toThrow(expect.objectContaining({ code: "RESOURCE_LIMIT" }));
  });

  it("rejects oversized hostile PCM output", () => {
    const samples = new Float32Array(Math.floor(TTS_LIMITS.maxPcmBytes / 4) + 1);
    expect(() => snapshotAndValidatePcm({
      sampleRate: 48_000,
      channels: 1,
      durationMs: (samples.length / 48_000) * 1_000,
      samples
    }, 48_000)).toThrow(expect.objectContaining({ code: "RESOURCE_LIMIT" }));
  });

  it("rejects hostile output duration even when PCM bytes remain under the byte cap", () => {
    const frames = Math.ceil((TTS_LIMITS.maxOutputDurationMs / 1_000) * 22_050) + 1;
    const samples = new Float32Array(frames);
    expect(samples.byteLength).toBeLessThan(TTS_LIMITS.maxPcmBytes);
    expect(() => snapshotAndValidatePcm({
      sampleRate: 22_050,
      channels: 1,
      durationMs: (frames / 22_050) * 1_000,
      samples
    }, 22_050)).toThrow(expect.objectContaining({ code: "RESOURCE_LIMIT" }));
  });
});

describe("TTS stream sequencing and source basis", () => {
  it("emits exactly one begin/end, strict sequence order, bounded chunks, and verifiable hashes", async () => {
    const manager = new TtsRequestManager(new TinySynthesizer());
    const { messages, summary } = await runAndCollect(manager, request());
    expect(messages[0]?.type).toBe("AUDIO_BEGIN");
    expect(messages.at(-1)?.type).toBe("AUDIO_END");
    expect(messages.filter((message) => message.type === "AUDIO_BEGIN")).toHaveLength(1);
    expect(messages.filter((message) => message.type === "AUDIO_END")).toHaveLength(1);
    expect(messages.map((message) => message.sequence)).toEqual(
      Array.from({ length: messages.length }, (_, index) => index)
    );
    for (const message of messages) expect(() => TtsStreamMessageSchema.parse(message)).not.toThrow();

    const chunks = messages.filter((message): message is Extract<TtsStreamMessage, { type: "AUDIO_CHUNK" }> =>
      message.type === "AUDIO_CHUNK"
    );
    expect(chunks.length).toBeGreaterThan(0);
    const aggregate = createHash("sha256");
    for (const chunk of chunks) {
      const bytes = Buffer.from(chunk.audioBase64, "base64");
      const pcmHash = createHash("sha256").update(bytes).digest("hex");
      const basisHash = computeTtsChunkBasisHash({
        requestBasisHash: chunk.requestBasisHash,
        sequence: chunk.sequence,
        segmentIndex: chunk.segmentIndex,
        segmentHash: chunk.segmentHash,
        chunkIndex: chunk.chunkIndex,
        finalInSegment: chunk.finalInSegment,
        sampleRate: chunk.sampleRate,
        frameCount: chunk.frameCount,
        byteLength: chunk.byteLength,
        pcmHash
      });
      expect(chunk.pcmHash).toBe(pcmHash);
      expect(chunk.chunkBasisHash).toBe(basisHash);
      expect(chunk.byteLength).toBe(chunk.frameCount * 4);
      expect(chunk.frameCount).toBeLessThanOrEqual(TTS_LIMITS.maxChunkFrames);
      expect(() => TtsAudioChunkSchema.parse(chunk)).not.toThrow();
      aggregate.update(bytes);
    }

    const end = messages.at(-1);
    expect(end?.type).toBe("AUDIO_END");
    if (end?.type !== "AUDIO_END") throw new Error("Expected AUDIO_END");
    expect(end.audioHash).toBe(aggregate.digest("hex"));
    expect(end.totalBytes).toBe(summary.totalBytes);
    expect(end.totalFrames).toBe(summary.totalFrames);
    expect(summary.outcome).toBe("DONE");
    expect(summary.totalBytes).toBeLessThanOrEqual(TTS_LIMITS.maxPcmBytes);
  });

  it("preserves deterministic segment transitions without duplicate chunks", async () => {
    const manager = new TtsRequestManager(new TinySynthesizer());
    const longText = `${"a".repeat(560)} ${"b".repeat(20)}`;
    const { messages } = await runAndCollect(manager, request({ text: longText, speed: 2 }));
    const chunks = messages.filter((message): message is Extract<TtsStreamMessage, { type: "AUDIO_CHUNK" }> =>
      message.type === "AUDIO_CHUNK"
    );
    expect(new Set(chunks.map((chunk) => chunk.sequence)).size).toBe(chunks.length);
    expect(new Set(chunks.map((chunk) => chunk.chunkIndex)).size).toBe(chunks.length);
    expect(new Set(chunks.map((chunk) => chunk.segmentIndex))).toEqual(new Set([0, 1]));
    for (const segmentIndex of [0, 1]) {
      expect(chunks.filter((chunk) => chunk.segmentIndex === segmentIndex && chunk.finalInSegment)).toHaveLength(1);
    }
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["out-of-range", 1.5]
  ])("independently rejects %s float32 samples in chunk bytes", (_label, sample) => {
    const bytes = Buffer.alloc(4);
    bytes.writeFloatLE(sample, 0);
    const requestBasisHash = createHash("sha256").update("request").digest("hex");
    const segmentHash = createHash("sha256").update("segment").digest("hex");
    const pcmHash = createHash("sha256").update(bytes).digest("hex");
    const chunkBasisHash = computeTtsChunkBasisHash({
      requestBasisHash,
      sequence: 1,
      segmentIndex: 0,
      segmentHash,
      chunkIndex: 0,
      finalInSegment: true,
      sampleRate: 24_000,
      frameCount: 1,
      byteLength: 4,
      pcmHash
    });
    expect(() => TtsAudioChunkSchema.parse({
      protocolVersion: 1,
      type: "AUDIO_CHUNK",
      requestId: newRequestId(),
      requestBasisHash,
      sequence: 1,
      segmentIndex: 0,
      segmentHash,
      pcmHash,
      chunkBasisHash,
      chunkIndex: 0,
      finalInSegment: true,
      sampleRate: 24_000,
      channels: 1,
      sampleFormat: "F32LE",
      frameCount: 1,
      byteLength: 4,
      audioBase64: bytes.toString("base64")
    })).toThrow();
  });

  it("rejects oversized hash fields before chunk decoding work", () => {
    const bytes = Buffer.alloc(4);
    const validHash = createHash("sha256").update(bytes).digest("hex");
    const requestBasisHash = validHash;
    const segmentHash = validHash;
    const pcmHash = validHash;
    const chunkBasisHash = computeTtsChunkBasisHash({
      requestBasisHash,
      sequence: 1,
      segmentIndex: 0,
      segmentHash,
      chunkIndex: 0,
      finalInSegment: true,
      sampleRate: 24_000,
      frameCount: 1,
      byteLength: 4,
      pcmHash
    });
    const base = {
      protocolVersion: 1,
      type: "AUDIO_CHUNK" as const,
      requestId: newRequestId(),
      requestBasisHash,
      sequence: 1,
      segmentIndex: 0,
      segmentHash,
      pcmHash,
      chunkBasisHash,
      chunkIndex: 0,
      finalInSegment: true,
      sampleRate: 24_000 as const,
      channels: 1 as const,
      sampleFormat: "F32LE" as const,
      frameCount: 1,
      byteLength: 4,
      audioBase64: bytes.toString("base64")
    };
    expect(() => TtsAudioChunkSchema.parse({
      ...base,
      requestBasisHash: "a".repeat(100_000)
    })).toThrow();
  });

  it("rejects malformed chunk metadata independently", () => {
    const parsed = planTtsRequest(request());
    const requestBasisHash = parsed.requestBasisHash;
    const segmentHash = parsed.segments[0]?.textHash ?? "0".repeat(64);
    const audioBase64 = Buffer.alloc(4).toString("base64");
    const pcmHash = createHash("sha256").update(Buffer.from(audioBase64, "base64")).digest("hex");
    const chunkBasisHash = computeTtsChunkBasisHash({
      requestBasisHash,
      sequence: 1,
      segmentIndex: 0,
      segmentHash,
      chunkIndex: 0,
      finalInSegment: true,
      sampleRate: 24_000,
      frameCount: 1,
      byteLength: 4,
      pcmHash
    });
    const valid = {
      protocolVersion: 1 as const,
      type: "AUDIO_CHUNK" as const,
      requestId: parsed.request.requestId,
      requestBasisHash,
      sequence: 1,
      segmentIndex: 0,
      segmentHash,
      pcmHash,
      chunkBasisHash,
      chunkIndex: 0,
      finalInSegment: true,
      sampleRate: 24_000 as const,
      channels: 1 as const,
      sampleFormat: "F32LE" as const,
      frameCount: 1,
      byteLength: 4,
      audioBase64
    };
    expect(() => TtsAudioChunkSchema.parse(valid)).not.toThrow();
    expect(() => TtsAudioChunkSchema.parse({ ...valid, frameCount: TTS_LIMITS.maxChunkFrames + 1 })).toThrow();
    expect(() => TtsAudioChunkSchema.parse({ ...valid, byteLength: 3 })).toThrow();
    expect(() => TtsAudioChunkSchema.parse({ ...valid, audioBase64: "AAAA" })).toThrow();
    expect(() => TtsAudioChunkSchema.parse({ ...valid, pcmHash: "a".repeat(64) })).toThrow();
    expect(() => TtsAudioChunkSchema.parse({ ...valid, chunkBasisHash: "b".repeat(64) })).toThrow();
    expect(() => TtsAudioChunkSchema.parse({ ...valid, chunkIndex: 1 })).toThrow();
    expect(() => TtsAudioChunkSchema.parse({ ...valid, segmentIndex: 1 })).toThrow();
    expect(() => TtsAudioChunkSchema.parse({ ...valid, finalInSegment: false })).toThrow();
    expect(() => TtsAudioChunkSchema.parse({ ...valid, sequence: 2 })).toThrow();
    expect(() => TtsAudioChunkSchema.parse({ ...valid, sampleRate: 22_050 })).toThrow();
    expect(() => TtsAudioChunkSchema.parse({
      ...valid,
      chunkIndex: TTS_LIMITS.maxChunks
    })).toThrow();
  });
});

describe("TTS cancellation and late-result suppression", () => {
  it("rejects cancellation for unknown, completed, and failed requests without inventing runtime work", async () => {
    const manager = new TtsRequestManager(new TinySynthesizer());
    const unknownId = newRequestId();
    expect(await manager.cancel(cancelRequest(unknownId))).toEqual({
      protocolVersion: 1,
      type: "CANCEL_RESULT",
      requestId: unknownId,
      accepted: false,
      runtimeCancellation: "NOT_NEEDED"
    });

    const completed = request();
    expect((await manager.run(completed, () => undefined)).outcome).toBe("DONE");
    expect(await manager.cancel(cancelRequest(completed.requestId))).toEqual({
      protocolVersion: 1,
      type: "CANCEL_RESULT",
      requestId: completed.requestId,
      accepted: false,
      runtimeCancellation: "NOT_NEEDED"
    });

    const failingManager = new TtsRequestManager(new ThrowingSynthesizer());
    const failed = request({ language: "en-US" });
    await expect(failingManager.run(failed, () => undefined))
      .rejects.toMatchObject({ code: "SYNTHESIS_FAILED" });
    expect(await failingManager.cancel(cancelRequest(failed.requestId))).toEqual({
      protocolVersion: 1,
      type: "CANCEL_RESULT",
      requestId: failed.requestId,
      accepted: false,
      runtimeCancellation: "NOT_NEEDED"
    });
  });

  it("cancels before synthesis starts without emitting audio", async () => {
    const synth = new TinySynthesizer();
    const manager = new TtsRequestManager(synth);
    const synthesisRequest = request();
    const messages: TtsStreamMessage[] = [];
    const completion = manager.run(synthesisRequest, (message) => { messages.push(message); });
    const cancellation = await manager.cancel(cancelRequest(synthesisRequest.requestId));
    const summary = await completion;
    expect(cancellation).toMatchObject({ accepted: true, runtimeCancellation: "NOT_NEEDED" });
    expect(summary.outcome).toBe("CANCELLED");
    expect(messages).toEqual([]);
    expect(synth.calls).toBe(0);
    expect(synth.cancelCalls).toBe(0);
  });

  it("cancels during synthesis, resolves promptly, and drops a late model result", async () => {
    const synth = new DeferredSynthesizer();
    const manager = new TtsRequestManager(synth);
    const synthesisRequest = request();
    const messages: TtsStreamMessage[] = [];
    const completion = manager.run(synthesisRequest, (message) => { messages.push(message); });
    await waitFor(() => synth.pending.length === 1);
    expect(messages.map((message) => message.type)).toEqual(["AUDIO_BEGIN"]);

    await manager.cancel(cancelRequest(synthesisRequest.requestId));
    const summary = await completion;
    expect(summary.outcome).toBe("CANCELLED");
    expect(manager.inspect().runtimeReservations).toBe(1);

    synth.resolveNext();
    await waitFor(() => manager.inspect().runtimeReservations === 0);
    expect(messages.map((message) => message.type)).toEqual(["AUDIO_BEGIN"]);
  });

  it("cancels between segments and never starts the next segment", async () => {
    const synth = new TinySynthesizer();
    const manager = new TtsRequestManager(synth);
    const synthesisRequest = request({
      text: `${"a".repeat(560)} ${"b".repeat(20)}`,
      speed: 2
    });
    const messages: TtsStreamMessage[] = [];
    const sink: TtsMessageSink = async (message) => {
      messages.push(message);
      if (message.type === "AUDIO_CHUNK"
          && message.segmentIndex === 0
          && message.finalInSegment) {
        await manager.cancel(cancelRequest(synthesisRequest.requestId));
      }
    };
    const summary = await manager.run(synthesisRequest, sink);
    expect(summary.outcome).toBe("CANCELLED");
    expect(synth.calls).toBe(1);
    expect(messages.some((message) => message.type === "AUDIO_END")).toBe(false);
    expect(messages.some((message) => message.type === "AUDIO_CHUNK" && message.segmentIndex === 1)).toBe(false);
  });

  it("suppresses output when cancellation wins after the runtime promise resolves but before admission", async () => {
    const synth = new DeferredSynthesizer();
    const manager = new TtsRequestManager(synth);
    const synthesisRequest = request();
    const messages: TtsStreamMessage[] = [];
    const completion = manager.run(synthesisRequest, (message) => { messages.push(message); });
    await waitFor(() => synth.pending.length === 1);
    synth.resolveNext();
    const cancellationPromise = manager.cancel(cancelRequest(synthesisRequest.requestId));
    await cancellationPromise;
    const summary = await completion;
    expect(summary.outcome).toBe("CANCELLED");
    expect(messages.map((message) => message.type)).toEqual(["AUDIO_BEGIN"]);
  });

  it("makes duplicate cancellation idempotent", async () => {
    const synth = new DeferredSynthesizer();
    const manager = new TtsRequestManager(synth);
    const synthesisRequest = request();
    const completion = manager.run(synthesisRequest, () => undefined);
    await waitFor(() => synth.pending.length === 1);
    const first = await manager.cancel(cancelRequest(synthesisRequest.requestId));
    const summary = await completion;
    const second = await manager.cancel(cancelRequest(synthesisRequest.requestId));
    expect(summary.outcome).toBe("CANCELLED");
    expect(first.accepted).toBe(true);
    expect(second).toEqual({
      protocolVersion: 1,
      type: "CANCEL_RESULT",
      requestId: synthesisRequest.requestId,
      accepted: true,
      runtimeCancellation: "NOT_NEEDED"
    });
    synth.resolveNext();
  });

  it("shuts down while synthesizing without admitting later chunks", async () => {
    const synth = new DeferredSynthesizer();
    const manager = new TtsRequestManager(synth);
    const synthesisRequest = request();
    const messages: TtsStreamMessage[] = [];
    const completion = manager.run(synthesisRequest, (message) => { messages.push(message); });
    await waitFor(() => synth.pending.length === 1);
    await manager.shutdown();
    const summary = await completion;
    expect(summary.outcome).toBe("CANCELLED");
    expect(manager.inspect().shutdown).toBe(true);
    synth.resolveNext();
    await waitFor(() => manager.inspect().runtimeReservations === 0);
    expect(messages.map((message) => message.type)).toEqual(["AUDIO_BEGIN"]);
    await expect(manager.run(request(), () => undefined)).rejects.toMatchObject({ code: "SHUTDOWN" });
  });

  it("normalizes malformed synthesizer cancellation results to UNSUPPORTED", async () => {
    let resolveSynthesis: (() => void) | undefined;
    const synth = {
      identity: {
        engine: "test",
        modelId: "invalid-cancel-result",
        modelVersion: "1",
        runtimeVersion: "test",
        waveformDeterminism: "NOT_GUARANTEED"
      },
      supportedVoices: new Set(["fake-neutral"]),
      supportedLanguages: new Set<TtsLanguage>(["en-US"]),
      supportedSampleRates: new Set<TtsSampleRate>([24_000]),
      synthesize: async (synthesisRequest: TtsSegmentSynthesisRequest) =>
        new Promise<SynthesizedPcm>((resolvePromise) => {
          resolveSynthesis = () => resolvePromise(tinyPcm(synthesisRequest));
        }),
      cancel: async () => "BOGUS"
    };
    const manager = new TtsRequestManager(synth);
    const synthesisRequest = request();
    const completion = manager.run(synthesisRequest, () => undefined);
    await waitFor(() => resolveSynthesis !== undefined);
    const cancellation = await manager.cancel(cancelRequest(synthesisRequest.requestId));
    expect(cancellation.runtimeCancellation).toBe("UNSUPPORTED");
    expect((await completion).outcome).toBe("CANCELLED");
    resolveSynthesis?.();
    await waitFor(() => manager.inspect().runtimeReservations === 0);
  });

  it("coalesces duplicate active cancellation into one runtime cancellation request", async () => {
    const synth = new HangingCancellationSynthesizer();
    const manager = new TtsRequestManager(synth);
    const synthesisRequest = request();
    const completion = manager.run(synthesisRequest, () => undefined);
    await waitFor(() => synth.pending.length === 1);

    const startedAt = Date.now();
    const [first, second] = await Promise.all([
      manager.cancel(cancelRequest(synthesisRequest.requestId)),
      manager.cancel(cancelRequest(synthesisRequest.requestId))
    ]);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(true);
    expect(first.runtimeCancellation).toBe("REQUESTED");
    expect(second.runtimeCancellation).toBe("REQUESTED");
    expect(synth.cancelCalls).toBe(1);
    expect((await completion).outcome).toBe("CANCELLED");

    synth.resolveNext();
    await waitFor(() => manager.inspect().retiredInFlightCount === 1);
    expect(manager.inspect().runtimeReservations).toBe(1);

    synth.resolveCancellation();
    await waitFor(() => manager.inspect().runtimeReservations === 0);
    expect(manager.inspect().retiredInFlightCount).toBe(0);
  });

  it("logical cancellation is not blocked by a hung output sink and retains capacity until the sink settles", async () => {
    const synth = new TinySynthesizer();
    const manager = new TtsRequestManager(synth);
    const synthesisRequest = request();
    let chunkEntered = false;
    let resolveSink: (() => void) | undefined;
    const invokedTypes: TtsStreamMessage["type"][] = [];
    const sinkGate = new Promise<void>((resolvePromise) => {
      resolveSink = resolvePromise;
    });
    const completion = manager.run(synthesisRequest, (message) => {
      invokedTypes.push(message.type);
      if (message.type !== "AUDIO_CHUNK") return;
      chunkEntered = true;
      return sinkGate;
    });
    await waitFor(() => chunkEntered);

    const summary = await withTimeout(
      manager.cancel(cancelRequest(synthesisRequest.requestId)).then(async () => completion),
      2_000,
      "Cancellation was blocked by output sink"
    );
    expect(summary.outcome).toBe("CANCELLED");
    expect(summary.emittedChunks).toBe(0);
    expect(manager.inspect()).toMatchObject({
      retiredInFlightCount: 1,
      runtimeReservations: 1
    });

    resolveSink?.();
    await waitFor(() => manager.inspect().runtimeReservations === 0);
    expect(manager.inspect().retiredInFlightCount).toBe(0);
    await new Promise<void>((resolvePromise) => queueMicrotask(resolvePromise));
    expect(invokedTypes).toEqual(["AUDIO_BEGIN", "AUDIO_CHUNK"]);
  });

  it("coalesces concurrent shutdown calls onto one completion barrier", async () => {
    const synth = new HangingCancellationSynthesizer();
    const manager = new TtsRequestManager(synth);
    const synthesisRequest = request();
    const completion = manager.run(synthesisRequest, () => undefined);
    await waitFor(() => synth.pending.length === 1);

    const firstShutdown = manager.shutdown();
    const secondShutdown = manager.shutdown();
    expect(secondShutdown).toBe(firstShutdown);
    expect(manager.inspect().shutdown).toBe(true);
    await expect(manager.run(request(), () => undefined)).rejects.toMatchObject({ code: "SHUTDOWN" });

    await Promise.all([firstShutdown, secondShutdown]);
    expect((await completion).outcome).toBe("CANCELLED");
    expect(synth.cancelCalls).toBe(1);
    expect(manager.inspect().runtimeReservations).toBe(1);

    synth.resolveNext();
    expect(manager.inspect().runtimeReservations).toBe(1);
    synth.resolveCancellation();
    await waitFor(() => manager.inspect().runtimeReservations === 0);
  });

  it("shutdown is bounded by logical cancellation and does not assume synthesizer lifecycle ownership", async () => {
    const synth = new HangingCloseSynthesizer();
    const manager = new TtsRequestManager(synth);
    const synthesisRequest = request();
    const completion = manager.run(synthesisRequest, () => undefined);
    await waitFor(() => synth.pending.length === 1);

    await withTimeout(
      manager.shutdown(),
      2_000,
      "Shutdown did not remain bounded"
    );
    expect((await completion).outcome).toBe("CANCELLED");
    expect(synth.closeCalls).toBe(0);

    synth.resolveNext();
    await waitFor(() => manager.inspect().runtimeReservations === 0);
  });

  it("keeps cancelled uninterruptible model work inside the hard concurrency reservation", async () => {
    const synth = new DeferredSynthesizer();
    const manager = new TtsRequestManager(synth);
    const first = request();
    const second = request();
    const third = request();
    const firstCompletion = manager.run(first, () => undefined);
    const secondCompletion = manager.run(second, () => undefined);
    await waitFor(() => synth.pending.length === 2);

    await manager.cancel(cancelRequest(first.requestId));
    await manager.cancel(cancelRequest(second.requestId));
    expect((await firstCompletion).outcome).toBe("CANCELLED");
    expect((await secondCompletion).outcome).toBe("CANCELLED");
    expect(manager.inspect().runtimeReservations).toBe(TTS_LIMITS.maxConcurrentRequests);
    await expect(manager.run(third, () => undefined)).rejects.toMatchObject({ code: "RESOURCE_LIMIT" });

    synth.resolveNext();
    synth.resolveNext();
    await waitFor(() => manager.inspect().runtimeReservations === 0);

    const thirdCompletion = manager.run(third, () => undefined);
    await waitFor(() => synth.pending.length === 1);
    synth.resolveNext();
    expect((await thirdCompletion).outcome).toBe("DONE");
  });
});

describe("TTS idempotency, conflicts, and bounded caches", () => {
  it("deduplicates an identical in-flight request without invoking the model twice", async () => {
    const synth = new DeferredSynthesizer();
    const manager = new TtsRequestManager(synth);
    const synthesisRequest = request();
    const firstMessages: TtsStreamMessage[] = [];
    const secondMessages: TtsStreamMessage[] = [];
    const first = manager.run(synthesisRequest, (message) => { firstMessages.push(message); });
    const second = manager.run(synthesisRequest, (message) => { secondMessages.push(message); });
    expect(second).toBe(first);
    await waitFor(() => synth.pending.length === 1);
    expect(synth.calls).toBe(1);
    synth.resolveNext();
    expect((await first).outcome).toBe("DONE");
    expect(await second).toEqual(await first);
    expect(secondMessages).toEqual([]);
  });

  it("treats normalization-equivalent but byte-different payloads as an ID conflict", async () => {
    const synth = new DeferredSynthesizer();
    const manager = new TtsRequestManager(synth);
    const synthesisRequest = request({ text: "same   spoken text" });
    const first = manager.run(synthesisRequest, () => undefined);
    await waitFor(() => synth.pending.length === 1);
    await expect(manager.run({ ...synthesisRequest, text: "same spoken text" }, () => undefined))
      .rejects.toMatchObject({ code: "REQUEST_ID_CONFLICT" });
    await manager.cancel(cancelRequest(synthesisRequest.requestId));
    await first;
    synth.resolveNext();
  });

  it("rejects a conflicting duplicate requestId while the original is active", async () => {
    const synth = new DeferredSynthesizer();
    const manager = new TtsRequestManager(synth);
    const synthesisRequest = request();
    const first = manager.run(synthesisRequest, () => undefined);
    await waitFor(() => synth.pending.length === 1);
    await expect(manager.run({ ...synthesisRequest, text: "different content" }, () => undefined))
      .rejects.toMatchObject({ code: "REQUEST_ID_CONFLICT" });
    await manager.cancel(cancelRequest(synthesisRequest.requestId));
    await first;
    synth.resolveNext();
  });

  it("returns the remembered result for an identical completed retry without replaying PCM", async () => {
    const synth = new TinySynthesizer();
    const manager = new TtsRequestManager(synth);
    const synthesisRequest = request();
    const first = await runAndCollect(manager, synthesisRequest);
    const replayedMessages: TtsStreamMessage[] = [];
    const replayed = await manager.run(synthesisRequest, (message) => { replayedMessages.push(message); });
    expect(replayed).toEqual(first.summary);
    expect(replayedMessages).toEqual([]);
    expect(synth.calls).toBe(first.summary.segmentCount);
  });

  it("rejects a conflicting requestId after completion while its tombstone is retained", async () => {
    const manager = new TtsRequestManager(new TinySynthesizer());
    const synthesisRequest = request();
    await manager.run(synthesisRequest, () => undefined);
    await expect(manager.run({ ...synthesisRequest, text: "conflicting retry" }, () => undefined))
      .rejects.toMatchObject({ code: "REQUEST_ID_CONFLICT" });
  });

  it("continues acknowledging duplicate cancellation for retired live compute after its tombstone is evicted", async () => {
    const synth = new SelectiveDeferredSynthesizer();
    const manager = new TtsRequestManager(synth);
    const held = request({ text: "hold-runtime-open" });
    const heldCompletion = manager.run(held, () => undefined);
    await waitFor(() => synth.pending.length === 1);
    await manager.cancel(cancelRequest(held.requestId));
    const heldSummary = await heldCompletion;
    expect(heldSummary.outcome).toBe("CANCELLED");
    expect(manager.inspect().retiredInFlightCount).toBe(1);

    for (let index = 0; index <= TTS_LIMITS.maxRememberedRequests; index += 1) {
      await manager.run(request({ text: `evict-${String(index)}` }), () => undefined);
    }
    expect(manager.inspect().rememberedRequestCount).toBe(TTS_LIMITS.maxRememberedRequests);

    const replayedMessages: TtsStreamMessage[] = [];
    const retiredRetry = await manager.run(held, (message) => {
      replayedMessages.push(message);
    });
    expect(retiredRetry).toEqual(heldSummary);
    expect(replayedMessages).toEqual([]);
    await expect(manager.run({
      ...held,
      text: "conflicting retired payload"
    }, () => undefined)).rejects.toMatchObject({ code: "REQUEST_ID_CONFLICT" });

    const duplicateCancellation = await manager.cancel(cancelRequest(held.requestId));
    expect(duplicateCancellation).toEqual({
      protocolVersion: 1,
      type: "CANCEL_RESULT",
      requestId: held.requestId,
      accepted: true,
      runtimeCancellation: "NOT_NEEDED"
    });

    synth.resolveHeld();
    await waitFor(() => manager.inspect().retiredInFlightCount === 0);
  });

  it("bounds remembered request identities and permits ID reuse only after eviction", async () => {
    const synth = new TinySynthesizer();
    const manager = new TtsRequestManager(synth);
    const first = request({ text: "first payload" });
    await manager.run(first, () => undefined);
    for (let index = 0; index < TTS_LIMITS.maxRememberedRequests; index += 1) {
      await manager.run(request({ text: `payload-${String(index)}` }), () => undefined);
    }
    expect(manager.inspect().rememberedRequestCount).toBe(TTS_LIMITS.maxRememberedRequests);
    const reused = await manager.run({ ...first, text: "reused after tombstone eviction" }, () => undefined);
    expect(reused.outcome).toBe("DONE");
  });
});

describe("TTS resource and diagnostic hardening", () => {
  it("snapshots synthesizer identity/capability metadata instead of trusting later mutation", async () => {
    const synth = new TinySynthesizer();
    const manager = new TtsRequestManager(synth);
    synth.identity.modelId = "mutated";
    synth.supportedVoices.clear();
    (synth.supportedLanguages as Set<TtsLanguage>).clear();
    (synth.supportedSampleRates as Set<TtsSampleRate>).clear();

    const { messages, summary } = await runAndCollect(manager, request());
    expect(summary.outcome).toBe("DONE");
    const begin = messages.find((message) => message.type === "AUDIO_BEGIN");
    const end = messages.find((message) => message.type === "AUDIO_END");
    expect(begin?.model.modelId).toBe("tiny");
    expect(end?.model.modelId).toBe("tiny");
    expect(manager.inspect().diagnostics.every((item) => item.modelId === "tiny")).toBe(true);
  });

  it("rejects Unix-absolute and URI-like model identity metadata", () => {
    const base = new TinySynthesizer();
    const unixPath = ["", "home", "user", "private", "model"].join("/");
    const fileUri = ["file:", unixPath].join("");
    for (const modelId of [
      unixPath,
      fileUri,
      "https://example.test/model"
    ]) {
      expect(() => new TtsRequestManager({
        identity: {
          ...base.identity,
          modelId
        },
        supportedVoices: base.supportedVoices,
        supportedLanguages: base.supportedLanguages,
        supportedSampleRates: base.supportedSampleRates,
        synthesize: async (synthesisRequest: TtsSegmentSynthesisRequest) => tinyPcm(synthesisRequest)
      })).toThrow(expect.objectContaining({ code: "MODEL_UNAVAILABLE" }));
    }
  });

  it("rejects invalid or oversized generic synthesizer metadata at construction", () => {
    const base = new TinySynthesizer();
    expect(() => new TtsRequestManager({
      identity: base.identity,
      supportedVoices: ["fake-neutral"],
      supportedLanguages: base.supportedLanguages,
      supportedSampleRates: base.supportedSampleRates,
      synthesize: async (synthesisRequest: TtsSegmentSynthesisRequest) => tinyPcm(synthesisRequest)
    })).toThrow(expect.objectContaining({ code: "MODEL_UNAVAILABLE" }));

    expect(() => new TtsRequestManager({
      identity: {
        engine: "test",
        modelId: ["C:", "local", "model"].join("/"),
        modelVersion: "1",
        runtimeVersion: "test",
        waveformDeterminism: "NOT_GUARANTEED"
      },
      supportedVoices: new Set(["fake-neutral"]),
      supportedLanguages: new Set(["en-US"]),
      supportedSampleRates: new Set<TtsSampleRate>([24_000]),
      synthesize: async (synthesisRequest: TtsSegmentSynthesisRequest) => tinyPcm(synthesisRequest)
    })).toThrow(expect.objectContaining({ code: "MODEL_UNAVAILABLE" }));

    expect(() => new TtsRequestManager({
      identity: base.identity,
      supportedVoices: new Set(
        Array.from({ length: TTS_LIMITS.maxSupportedVoices + 1 }, (_value, index) => `voice-${String(index)}`)
      ),
      supportedLanguages: new Set<TtsLanguage>(["en-US"]),
      supportedSampleRates: new Set<TtsSampleRate>([24_000]),
      synthesize: async (synthesisRequest: TtsSegmentSynthesisRequest) => tinyPcm(synthesisRequest)
    })).toThrow(expect.objectContaining({ code: "MODEL_UNAVAILABLE" }));

    expect(() => new TtsRequestManager({
      identity: base.identity,
      supportedVoices: new Set(["fake-neutral"]),
      supportedLanguages: new Set<TtsLanguage>(["en-US"]),
      supportedSampleRates: new Set([16_000]),
      synthesize: async (synthesisRequest: TtsSegmentSynthesisRequest) => tinyPcm(synthesisRequest)
    })).toThrow(expect.objectContaining({ code: "MODEL_UNAVAILABLE" }));
  });

  it("rejects a third concurrent synthesis before model execution", async () => {
    const synth = new DeferredSynthesizer();
    const manager = new TtsRequestManager(synth);
    const first = request();
    const second = request();
    const third = request();
    const p1 = manager.run(first, () => undefined);
    const p2 = manager.run(second, () => undefined);
    await waitFor(() => synth.pending.length === 2);
    await expect(manager.run(third, () => undefined)).rejects.toMatchObject({ code: "RESOURCE_LIMIT" });
    expect(synth.calls).toBe(2);
    await manager.cancel(cancelRequest(first.requestId));
    await manager.cancel(cancelRequest(second.requestId));
    await p1;
    await p2;
    synth.resolveNext();
    synth.resolveNext();
  });

  it("rejects hostile aggregate PCM before an AUDIO_END can be emitted", async () => {
    const synth = new HostileOutputSynthesizer((synthesisRequest) => {
      const frames = Math.floor(TTS_LIMITS.maxPcmBytes / 4) + 1;
      const samples = new Float32Array(frames);
      return {
        sampleRate: synthesisRequest.sampleRate,
        channels: 1,
        durationMs: (frames / synthesisRequest.sampleRate) * 1_000,
        samples
      };
    });
    const manager = new TtsRequestManager(synth);
    const messages: TtsStreamMessage[] = [];
    await expect(manager.run(request({ sampleRate: 48_000 }), (message) => { messages.push(message); }))
      .rejects.toMatchObject({ code: "RESOURCE_LIMIT" });
    expect(messages.filter((message) => message.type === "AUDIO_END")).toHaveLength(0);
  });

  it("keeps diagnostics metadata-only and bounds the diagnostic window", async () => {
    const synth = new TinySynthesizer();
    const manager = new TtsRequestManager(synth);
    const secretText = "interviewer-private-text-should-not-enter-diagnostics";
    await manager.run(request({ text: secretText }), () => undefined);
    for (let index = 0; index < 30; index += 1) {
      await manager.run(request({ text: `short-${String(index)}` }), () => undefined);
    }
    const inspection = manager.inspect();
    const serialized = JSON.stringify(inspection);
    expect(serialized).not.toContain(secretText);
    expect(serialized).not.toMatch(/audioBase64|pcmHash/u);
    expect(inspection.diagnostics.length).toBeLessThanOrEqual(TTS_LIMITS.maxDiagnostics);
    expect(Object.isFrozen(inspection)).toBe(true);
    expect(Object.isFrozen(inspection.diagnostics)).toBe(true);
  });

  it("sanitizes even backend-thrown TtsWorkerError messages for direct manager callers", async () => {
    const manager = new TtsRequestManager(new SecretTypedErrorSynthesizer());
    try {
      await manager.run(request(), () => undefined);
      throw new Error("Expected typed backend failure");
    } catch (error) {
      expect(error).toBeInstanceOf(TtsWorkerError);
      expect(error).toMatchObject({
        code: "SYNTHESIS_FAILED",
        message: "TTS synthesis failed"
      });
      expect(String(error)).not.toContain("should-not-escape");
      expect(String(error)).not.toContain(resolve("fixtures/hidden-runtime/model.onnx"));
    }
  });

  it("does not let a synthesizer forge application-owned error classifications", async () => {
    const manager = new TtsRequestManager(new SpoofedApplicationErrorSynthesizer());
    await expect(manager.run(request(), () => undefined)).rejects.toMatchObject({
      code: "SYNTHESIS_FAILED",
      message: "TTS synthesis failed"
    });
    expect(manager.inspect().diagnostics.at(-1)).toMatchObject({
      state: "ERROR",
      errorCode: "SYNTHESIS_FAILED"
    });
  });

  it("fails closed when a backend corrupts the runtime TtsWorkerError code", async () => {
    const manager = new TtsRequestManager(new InvalidCodeSynthesizer());
    await expect(manager.run(request(), () => undefined)).rejects.toMatchObject({
      code: "SYNTHESIS_FAILED",
      message: "TTS synthesis failed"
    });
    const inspection = manager.inspect();
    expect(inspection.diagnostics.at(-1)).toMatchObject({
      state: "ERROR",
      errorCode: "SYNTHESIS_FAILED"
    });
  });

  it("never exposes raw synthesizer exceptions, local paths, or secret-like text", async () => {
    const manager = new TtsRequestManager(new ThrowingSynthesizer());
    const synthesisRequest = request();
    await expect(manager.run(synthesisRequest, () => undefined))
      .rejects.toMatchObject({ code: "SYNTHESIS_FAILED" });
    const serialized = JSON.stringify(manager.inspect());
    expect(serialized).not.toContain(resolve("fixtures/private-model/kokoro.onnx"));
    expect(serialized).not.toContain("secret-value");
  });

  it("inspection is side-effect free while synthesis is active", async () => {
    const synth = new DeferredSynthesizer();
    const manager = new TtsRequestManager(synth);
    const synthesisRequest = request();
    const completion = manager.run(synthesisRequest, () => undefined);
    await waitFor(() => synth.pending.length === 1);
    const before = manager.inspect();
    const after = manager.inspect();
    expect(after.activeRequestIds).toEqual(before.activeRequestIds);
    expect(synth.calls).toBe(1);
    await manager.cancel(cancelRequest(synthesisRequest.requestId));
    await completion;
    synth.resolveNext();
  });
});

describe("Kokoro adapter seam", () => {
  it("requires explicit absolute model/config paths and never resolves or downloads them itself", async () => {
    const initialize = vi.fn(async () => ({
      modelId: "hexgrad/Kokoro-82M",
      modelVersion: "1",
      runtimeVersion: "onnx-1",
      supportedVoices: ["af_heart"],
      supportedLanguages: ["en-US"] as const,
      supportedSampleRates: [24_000] as const,
      synthesize: async (input: { readonly sampleRate: TtsSampleRate }) => ({
        samples: new Float32Array([0, 0]),
        sampleRate: input.sampleRate,
        channels: 1,
        durationMs: (2 / input.sampleRate) * 1_000
      })
    }));
    const runtime: KokoroRuntime = { initialize };
    await expect(KokoroSpeechSynthesizer.create({
      runtime,
      modelPath: "relative/model.onnx"
    })).rejects.toMatchObject({ code: "MODEL_UNAVAILABLE" });
    expect(initialize).not.toHaveBeenCalled();
    await expect(KokoroSpeechSynthesizer.create({
      runtime,
      modelPath: resolve("x".repeat(TTS_LIMITS.maxModelPathCharacters + 1))
    })).rejects.toMatchObject({ code: "MODEL_UNAVAILABLE" });
    expect(initialize).not.toHaveBeenCalled();

    const modelPath = resolve("fixtures/kokoro/model.onnx");
    const configPath = resolve("fixtures/kokoro/config.json");
    const adapter = await KokoroSpeechSynthesizer.create({ runtime, modelPath, configPath });
    expect(initialize).toHaveBeenCalledWith({ modelPath, configPath });
    expect(adapter.identity).toMatchObject({
      engine: "kokoro",
      modelId: "hexgrad/Kokoro-82M",
      modelVersion: "1",
      waveformDeterminism: "NOT_GUARANTEED"
    });
    expect(adapter.supportedVoices.has("af_heart")).toBe(true);
  });

  it("does not let callers mutate Kokoro capability views used for later admission", async () => {
    const runtimeSynthesize = vi.fn(async (input: { readonly sampleRate: TtsSampleRate }) => ({
      samples: new Float32Array([0]),
      sampleRate: input.sampleRate,
      channels: 1,
      durationMs: (1 / input.sampleRate) * 1_000
    }));
    const runtime: KokoroRuntime = {
      initialize: async () => ({
        modelId: "hexgrad/Kokoro-82M",
        modelVersion: "1",
        runtimeVersion: "onnx-1",
        supportedVoices: ["af_heart"],
        supportedLanguages: ["en-US"],
        supportedSampleRates: [24_000],
        synthesize: runtimeSynthesize
      })
    };
    const adapter = await KokoroSpeechSynthesizer.create({
      runtime,
      modelPath: resolve("fixtures/kokoro/model.onnx")
    });

    const exposedVoices = adapter.supportedVoices;
    const exposedLanguages = adapter.supportedLanguages;
    const exposedSampleRates = adapter.supportedSampleRates;
    if (!(exposedVoices instanceof Set)
        || !(exposedLanguages instanceof Set)
        || !(exposedSampleRates instanceof Set)) {
      throw new Error("Expected defensive Set capability views");
    }
    exposedVoices.add("mutated-voice");
    exposedVoices.delete("af_heart");
    exposedLanguages.clear();
    exposedSampleRates.clear();

    expect(adapter.supportedVoices.has("af_heart")).toBe(true);
    expect(adapter.supportedVoices.has("mutated-voice")).toBe(false);
    expect(adapter.supportedLanguages.has("en-US")).toBe(true);
    expect(adapter.supportedSampleRates.has(24_000)).toBe(true);

    const manager = new TtsRequestManager(adapter);
    const messages: TtsStreamMessage[] = [];
    await expect(manager.run(request({
      voice: "mutated-voice",
      language: "en-US",
      sampleRate: 24_000
    }), (message) => {
      messages.push(message);
    })).rejects.toMatchObject({ code: "UNSUPPORTED_VOICE" });
    expect(messages).toEqual([]);
    expect(runtimeSynthesize).not.toHaveBeenCalled();
  });

  it("bounds runtime voice metadata and rejects hostile capability expansion", async () => {
    const runtime: KokoroRuntime = {
      initialize: async () => ({
        modelId: "kokoro-82m",
        modelVersion: "1",
        runtimeVersion: "onnx-1",
        supportedVoices: Array.from({ length: 257 }, () => "af_heart"),
        supportedLanguages: ["en-US"],
        supportedSampleRates: [24_000],
        synthesize: async () => ({
          samples: new Float32Array([0]),
          sampleRate: 24_000,
          channels: 1,
          durationMs: 1 / 24
        })
      })
    };
    await expect(KokoroSpeechSynthesizer.create({
      runtime,
      modelPath: resolve("fixtures/kokoro/model.onnx")
    })).rejects.toMatchObject({ code: "MODEL_UNAVAILABLE" });
  });

  it("reports cancellation no stronger than runtime support", async () => {
    const runtime: KokoroRuntime = {
      initialize: async () => ({
        modelId: "kokoro-82m",
        modelVersion: "1",
        runtimeVersion: "onnx-1",
        supportedVoices: ["af_heart"],
        supportedLanguages: ["en-US"],
        supportedSampleRates: [24_000],
        synthesize: async (input) => ({
          samples: new Float32Array([0]),
          sampleRate: input.sampleRate,
          channels: 1,
          durationMs: (1 / input.sampleRate) * 1_000
        })
      })
    };
    const adapter = await KokoroSpeechSynthesizer.create({
      runtime,
      modelPath: resolve("fixtures/kokoro/model.onnx")
    });
    expect(await adapter.cancel(newRequestId())).toBe("UNSUPPORTED");
  });

  it("binds validated Kokoro runtime methods so post-initialization mutation cannot change synthesis behavior", async () => {
    let originalCalls = 0;
    const session: KokoroRuntimeSession = {
      modelId: "hexgrad/Kokoro-82M",
      modelVersion: "1",
      runtimeVersion: "onnx-1",
      supportedVoices: ["af_heart"],
      supportedLanguages: ["en-US"],
        supportedSampleRates: [24_000],
      synthesize: async (input) => {
        originalCalls += 1;
        return {
          samples: new Float32Array([0.1, -0.1]),
          sampleRate: input.sampleRate,
          channels: 1,
          durationMs: (2 / input.sampleRate) * 1_000
        };
      }
    };
    const runtime: KokoroRuntime = { initialize: async () => session };
    const adapter = await KokoroSpeechSynthesizer.create({
      runtime,
      modelPath: resolve("fixtures/kokoro/model.onnx")
    });
    (session as { synthesize: KokoroRuntimeSession["synthesize"] }).synthesize = async () => {
      throw new Error("mutated runtime method");
    };

    const output = await adapter.synthesize({
      requestId: newRequestId(),
      segmentIndex: 0,
      text: "stable method",
      voice: "af_heart",
      speed: 1,
      language: "en-US",
      sampleRate: 24_000
    });
    expect(originalCalls).toBe(1);
    expect(Array.from(output.samples)).toEqual([
      expect.closeTo(0.1, 5),
      expect.closeTo(-0.1, 5)
    ]);
  });

  it("lets the manager bound Kokoro cancellation while retaining capacity until the runtime cancel settles", async () => {
    let cancelCalls = 0;
    let synthesisStarted = false;
    let resolveSynthesis: ((result: {
      readonly samples: Float32Array;
      readonly sampleRate: number;
      readonly channels: number;
      readonly durationMs: number;
    }) => void) | undefined;
    let resolveRuntimeCancellation: (() => void) | undefined;
    const runtime: KokoroRuntime = {
      initialize: async () => ({
        modelId: "hexgrad/Kokoro-82M",
        modelVersion: "1",
        runtimeVersion: "onnx-1",
        supportedVoices: ["af_heart"],
        supportedLanguages: ["en-US"],
        supportedSampleRates: [24_000],
        synthesize: async () => {
          synthesisStarted = true;
          return new Promise((resolvePromise) => {
            resolveSynthesis = resolvePromise;
          });
        },
        cancel: async () => {
          cancelCalls += 1;
          await new Promise<void>((resolvePromise) => {
            resolveRuntimeCancellation = resolvePromise;
          });
        }
      })
    };
    const adapter = await KokoroSpeechSynthesizer.create({
      runtime,
      modelPath: resolve("fixtures/kokoro/model.onnx")
    });
    const manager = new TtsRequestManager(adapter);
    const synthesisRequest = request({
      voice: "af_heart",
      language: "en-US",
      sampleRate: 24_000
    });
    const completion = manager.run(synthesisRequest, () => undefined);
    await waitFor(() => synthesisStarted);

    const startedAt = Date.now();
    const cancellation = await manager.cancel(cancelRequest(synthesisRequest.requestId));
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(cancellation.runtimeCancellation).toBe("REQUESTED");
    expect(cancelCalls).toBe(1);
    expect((await completion).outcome).toBe("CANCELLED");

    resolveSynthesis?.({
      samples: new Float32Array([0]),
      sampleRate: 24_000,
      channels: 1,
      durationMs: (1 / 24_000) * 1_000
    });
    await waitFor(() => manager.inspect().retiredInFlightCount === 1);
    expect(manager.inspect().runtimeReservations).toBe(1);

    resolveRuntimeCancellation?.();
    await waitFor(() => manager.inspect().runtimeReservations === 0);
    expect(manager.inspect().retiredInFlightCount).toBe(0);
  });

  it("sanitizes Kokoro runtime TtsWorkerError messages instead of trusting the error class", async () => {
    const hiddenPath = resolve("fixtures/kokoro-private/model.onnx");
    const runtime: KokoroRuntime = {
      initialize: async () => {
        throw new TtsWorkerError("MODEL_UNAVAILABLE", `private runtime path ${hiddenPath}`);
      }
    };
    try {
      await KokoroSpeechSynthesizer.create({
        runtime,
        modelPath: resolve("fixtures/kokoro/model.onnx")
      });
      throw new Error("Expected Kokoro initialization failure");
    } catch (error) {
      expect(error).toBeInstanceOf(TtsWorkerError);
      expect(error).toMatchObject({
        code: "MODEL_UNAVAILABLE",
        message: "Kokoro runtime initialization failed"
      });
      expect(String(error)).not.toContain(hiddenPath);
    }
  });

  it("defers malformed Kokoro PCM property access to the central OUTPUT_INVALID trust boundary", async () => {
    const runtime: KokoroRuntime = {
      initialize: async () => ({
        modelId: "hexgrad/Kokoro-82M",
        modelVersion: "1",
        runtimeVersion: "onnx-1",
        supportedVoices: ["af_heart"],
        supportedLanguages: ["en-US"],
        supportedSampleRates: [24_000],
        synthesize: async () => {
          const output: Record<string, unknown> = {
            sampleRate: 24_000,
            channels: 1,
            durationMs: 1
          };
          Object.defineProperty(output, "samples", {
            enumerable: true,
            get: () => {
              throw new Error("secret-kokoro-pcm-getter");
            }
          });
          return output as unknown as KokoroRuntimeSynthesisResult;
        }
      })
    };
    const adapter = await KokoroSpeechSynthesizer.create({
      runtime,
      modelPath: resolve("fixtures/kokoro/model.onnx")
    });
    const manager = new TtsRequestManager(adapter);
    try {
      await manager.run(request({
        voice: "af_heart",
        language: "en-US",
        sampleRate: 24_000
      }), () => undefined);
      throw new Error("Expected malformed Kokoro PCM to fail");
    } catch (error) {
      expect(error).toMatchObject({
        code: "OUTPUT_INVALID",
        message: "TTS model returned invalid audio"
      });
      expect(String(error)).not.toContain("secret-kokoro-pcm-getter");
    }
  });

  it("maps initialization failures to a stable bounded error without leaking paths", async () => {
    const sensitiveRuntimePath = resolve("fixtures/sensitive-runtime/kokoro.onnx");
    const runtime: KokoroRuntime = {
      initialize: async () => {
        throw new Error(`failed opening ${sensitiveRuntimePath}`);
      }
    };
    try {
      await KokoroSpeechSynthesizer.create({
        runtime,
        modelPath: resolve("fixtures/kokoro/model.onnx")
      });
      throw new Error("Expected Kokoro initialization to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(TtsWorkerError);
      expect(error).toMatchObject({ code: "MODEL_UNAVAILABLE" });
      expect(String(error)).not.toContain(sensitiveRuntimePath);
    }
  });
});

describe("transport-neutral TTS worker authority boundary", () => {
  it("runtime-validates outgoing errors and does not leak raw model exceptions", async () => {
    const worker = new TtsWorkerCore(new ThrowingSynthesizer());
    const messages: unknown[] = [];
    await expect(worker.handle(request(), (message) => {
      messages.push(message);
    })).rejects.toMatchObject({ code: "SYNTHESIS_FAILED" });
    const error = messages.find((message) =>
      typeof message === "object" && message !== null && "type" in message && message.type === "TTS_ERROR"
    );
    expect(error).toMatchObject({ code: "SYNTHESIS_FAILED", message: "TTS synthesis failed" });
    expect(JSON.stringify(messages)).not.toContain(resolve("fixtures/private-model"));
    expect(JSON.stringify(messages)).not.toContain("secret-value");
  });

  it("never emits a schema-invalid error code from a corrupted backend error instance", async () => {
    const worker = new TtsWorkerCore(new InvalidCodeSynthesizer());
    const messages: unknown[] = [];
    await expect(worker.handle(request(), (message) => {
      messages.push(message);
    })).rejects.toMatchObject({ code: "SYNTHESIS_FAILED" });
    expect(messages).toContainEqual(expect.objectContaining({
      type: "TTS_ERROR",
      code: "SYNTHESIS_FAILED",
      message: "TTS synthesis failed"
    }));
  });

  it("preserves the original bounded synthesis error if emitting TTS_ERROR also fails", async () => {
    const worker = new TtsWorkerCore(new ThrowingSynthesizer());
    await expect(worker.handle(request(), (message) => {
      if (message.type === "TTS_ERROR") {
        throw new Error("transport unavailable");
      }
    })).rejects.toMatchObject({ code: "SYNTHESIS_FAILED" });
  });

  it("contains hostile incoming-message getters before any output", async () => {
    const worker = new TtsWorkerCore(new TinySynthesizer());
    const messages: unknown[] = [];
    const hostile: Record<string, unknown> = { protocolVersion: 1 };
    Object.defineProperty(hostile, "type", {
      enumerable: true,
      get: () => {
        throw new Error("secret-worker-getter");
      }
    });
    try {
      await worker.handle(hostile, (message) => {
        messages.push(message);
      });
      throw new Error("Expected hostile worker input to fail");
    } catch (error) {
      expect(error).toMatchObject({
        code: "INVALID_REQUEST",
        message: "TTS request was rejected"
      });
      expect(String(error)).not.toContain("secret-worker-getter");
    }
    expect(messages).toEqual([]);
  });

  it("rejects malformed incoming messages before any output", async () => {
    const worker = new TtsWorkerCore(new TinySynthesizer());
    const messages: unknown[] = [];
    await expect(worker.handle({ ...request(), unknownField: true }, (message) => {
      messages.push(message);
    })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(messages).toEqual([]);
  });

  it("contains no authoritative delivery-state or persistence dependency in the TTS implementation", async () => {
    const paths = [
      resolve("packages/local-compute/src/tts-protocol.ts"),
      resolve("packages/local-compute/src/tts-core.ts"),
      resolve("packages/local-compute/src/tts-request-manager.ts"),
      resolve("packages/local-compute/src/tts-worker.ts")
    ];
    const source = (await Promise.all(paths.map(async (path) => readFile(path, "utf8")))).join("\n");
    expect(source).not.toMatch(/\bEXPOSED\b|\bPOSSIBLY_EXPOSED\b|\bCOMPLETED\b/u);
    expect(source).not.toMatch(/packages\/(?:events|persistence|delivery)|SessionWriter|SqliteEventStore/u);
  });
});

describe("TTS property invariants", () => {
  const safeText = fc.array(
    fc.constantFrom("a", "b", "c", " ", ".", "?", "!", ",", ";", ":", "\n", "x", "^", "2", "(", ")", "|"),
    { minLength: 1, maxLength: 160 }
  ).map((characters) => characters.join(""))
    .filter((text) => text.trim().length > 0);

  it("repeated normalization and segmentation are deterministic", () => {
    fc.assert(fc.property(safeText, fc.double({ min: 0.5, max: 2, noNaN: true }), (text, speed) => {
      const normalizedFirst = normalizeTtsText(text);
      const normalizedSecond = normalizeTtsText(text);
      expect(normalizedSecond).toBe(normalizedFirst);
      const first = planTtsSegments(normalizedFirst, speed);
      const second = planTtsSegments(normalizedFirst, speed);
      expect(second).toEqual(first);
    }), { numRuns: 100 });
  });

  it("every accepted fake-synth stream validates, sequences strictly, and stays under hard byte bounds", async () => {
    await fc.assert(fc.asyncProperty(safeText, async (text) => {
      const manager = new TtsRequestManager(new TinySynthesizer());
      const messages: TtsStreamMessage[] = [];
      const summary = await manager.run(request({ text }), (message) => { messages.push(message); });
      expect(summary.outcome).toBe("DONE");
      expect(summary.totalBytes).toBeLessThanOrEqual(TTS_LIMITS.maxPcmBytes);
      expect(messages.map((message) => message.sequence)).toEqual(
        Array.from({ length: messages.length }, (_, index) => index)
      );
      for (const message of messages) {
        expect(() => TtsStreamMessageSchema.parse(message)).not.toThrow();
      }
    }), { numRuns: 50 });
  });
});
