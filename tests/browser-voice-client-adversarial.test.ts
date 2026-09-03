import { describe, expect, it, vi } from "vitest";
import { newDeliveryId, newSessionId, newUtteranceId } from "../packages/domain/src/index.js";
import {
  BrowserVoiceClient,
  BrowserVoiceStream,
  deriveDefaultVoiceBaseUrl
} from "../apps/web/src/voice-client.js";
import type { AudioFrame } from "../apps/web/src/audio/types.js";

const BASE_URL = "http://127.0.0.1:43125";

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function jsonBody(init: RequestInit): unknown {
  if (typeof init.body !== "string") return undefined;
  return JSON.parse(init.body) as unknown;
}

function frame(sampleRate: number, sampleCount = 1): AudioFrame {
  return {
    sequence: 0,
    sampleRate,
    channelCount: 1,
    capturedAtMs: 0,
    offsetMs: 0,
    samples: new Float32Array(sampleCount)
  };
}

function decodePcmBody(init: RequestInit): Float32Array {
  if (!(init.body instanceof ArrayBuffer)) {
    throw new Error("Expected voice PCM request body to be an ArrayBuffer");
  }
  const view = new DataView(init.body);
  const samples = new Float32Array(init.body.byteLength / 4);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = view.getFloat32(index * 4, true);
  }
  return samples;
}

function admittedFrameResponse(init: RequestInit): Response {
  const headers = new Headers(init.headers);
  const requestId = headers.get("x-speech-request-id");
  const streamId = headers.get("x-speech-stream-id");
  if (requestId === null || streamId === null) {
    throw new Error("Expected voice frame identity headers");
  }
  return new Response(JSON.stringify({
    protocolVersion: 1,
    ok: true,
    type: "VOICE_FRAME_RESULT",
    events: [],
    terminal: false
  }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

describe("browser voice client adversarial boundaries", () => {
  it("derives an exact localhost voice origin without weakening loopback validation", () => {
    expect(deriveDefaultVoiceBaseUrl("http://localhost:43123"))
      .toBe("http://localhost:43125");
    expect(() => new BrowserVoiceClient({
      baseUrl: "http://example.com:43125",
      authenticatedFetch: fetch
    })).toThrow(/loopback origin/u);
  });

  it("rejects pathological resampling sizes before issuing a transport request", async () => {
    const authenticatedFetch = vi.fn<typeof fetch>();
    const client = new BrowserVoiceClient({
      baseUrl: BASE_URL,
      authenticatedFetch
    });
    const stream = new BrowserVoiceStream(
      client,
      newSessionId(),
      "speech_stream_pathological_rate"
    );

    await expect(stream.sendFrame(frame(0.000_001, 2_048)))
      .rejects.toThrow(/bounded speech duration|resampling size/u);
    expect(authenticatedFetch).not.toHaveBeenCalled();
  });

  it("preserves 44.1 kHz interpolation phase across microphone callback boundaries", async () => {
    const requests: Array<{
      readonly samples: Float32Array;
      readonly frameSamples: number;
      readonly timestampMs: number;
    }> = [];
    const authenticatedFetch: typeof fetch = async (_input, init = {}) => {
      const headers = new Headers(init.headers);
      requests.push({
        samples: decodePcmBody(init),
        frameSamples: Number(headers.get("x-speech-frame-samples")),
        timestampMs: Number(headers.get("x-speech-timestamp-ms"))
      });
      return admittedFrameResponse(init);
    };
    const stream = new BrowserVoiceStream(
      new BrowserVoiceClient({ baseUrl: BASE_URL, authenticatedFetch }),
      newSessionId(),
      "speech_stream_44100_phase"
    );
    const first = frame(44_100, 4);
    first.samples.set([0, 0.1, 0.2, 0.3]);
    const second = frame(44_100, 4);
    second.samples.set([0.4, 0.5, 0.6, 0.7]);

    await stream.sendFrame(first);
    await stream.sendFrame(second);

    expect(requests).toHaveLength(2);
    expect(requests[0]?.frameSamples).toBe(4);
    expect(requests[1]?.frameSamples).toBe(4);
    expect(requests[1]?.samples[0]).toBeCloseTo(0.3675, 6);
    expect(requests[1]?.timestampMs).toBeCloseTo(4 / 48_000 * 1_000, 6);
  });

  it("does not accumulate per-frame rounding drift while resampling 44.1 kHz capture", async () => {
    const frameSampleCounts: number[] = [];
    const authenticatedFetch: typeof fetch = async (_input, init = {}) => {
      frameSampleCounts.push(Number(
        new Headers(init.headers).get("x-speech-frame-samples")
      ));
      return admittedFrameResponse(init);
    };
    const stream = new BrowserVoiceStream(
      new BrowserVoiceClient({ baseUrl: BASE_URL, authenticatedFetch }),
      newSessionId(),
      "speech_stream_44100_count"
    );

    for (let index = 0; index < 100; index += 1) {
      await stream.sendFrame(frame(44_100, 2_048));
    }

    const total = frameSampleCounts.reduce((sum, count) => sum + count, 0);
    const sourceSamples = 100 * 2_048;
    const exactStreamingCount = Math.floor(
      (sourceSamples - 1) * 48_000 / 44_100
    ) + 1;
    expect(total).toBe(exactStreamingCount);
    expect(new Set(frameSampleCounts).size).toBeGreaterThan(1);
  });

  it("does not consume resampler phase when a voice frame transport fails", async () => {
    const attempts: Array<{
      readonly sequence: string | null;
      readonly timestamp: string | null;
      readonly samples: Float32Array;
    }> = [];
    let failFirst = true;
    const authenticatedFetch: typeof fetch = async (_input, init = {}) => {
      const headers = new Headers(init.headers);
      attempts.push({
        sequence: headers.get("x-speech-sequence"),
        timestamp: headers.get("x-speech-timestamp-ms"),
        samples: decodePcmBody(init)
      });
      if (failFirst) {
        failFirst = false;
        throw new Error("synthetic frame transport failure");
      }
      return admittedFrameResponse(init);
    };
    const stream = new BrowserVoiceStream(
      new BrowserVoiceClient({ baseUrl: BASE_URL, authenticatedFetch }),
      newSessionId(),
      "speech_stream_resample_retry"
    );
    const captured = frame(44_100, 2_048);
    captured.samples[0] = 0.25;

    await expect(stream.sendFrame(captured)).rejects.toThrow(/synthetic frame transport/u);
    await expect(stream.sendFrame(captured)).resolves.toMatchObject({ terminal: false });

    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.sequence).toBe("0");
    expect(attempts[1]?.sequence).toBe("0");
    expect(attempts[0]?.timestamp).toBe("0");
    expect(attempts[1]?.timestamp).toBe("0");
    expect(Array.from(attempts[1]?.samples ?? [])).toEqual(
      Array.from(attempts[0]?.samples ?? [])
    );
  });

  it("rejects microphone sample-rate mutation within one voice stream", async () => {
    let requestCount = 0;
    const authenticatedFetch: typeof fetch = async (_input, init = {}) => {
      requestCount += 1;
      return admittedFrameResponse(init);
    };
    const stream = new BrowserVoiceStream(
      new BrowserVoiceClient({ baseUrl: BASE_URL, authenticatedFetch }),
      newSessionId(),
      "speech_stream_rate_mutation"
    );

    await stream.sendFrame(frame(44_100, 2_048));
    await expect(stream.sendFrame(frame(48_000, 2_048)))
      .rejects.toThrow(/sample rate changed/u);
    expect(requestCount).toBe(1);
  });

  it("retires a known stream identity when an open success response is unusable", async () => {
    const requests: Array<{ readonly url: string; readonly body: unknown }> = [];
    const authenticatedFetch: typeof fetch = async (input, init = {}) => {
      const url = requestUrl(input);
      const body = jsonBody(init);
      requests.push({ url, body });

      if (url.endsWith("/v1/voice/streams")) {
        return new Response("x".repeat(512 * 1024 + 1), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      if (url.endsWith("/v1/voice/cancel")) {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      throw new Error("Unexpected browser voice test request");
    };

    const client = new BrowserVoiceClient({
      baseUrl: BASE_URL,
      authenticatedFetch
    });
    const sessionId = newSessionId();

    await expect(client.openStream(sessionId)).rejects.toThrow(/browser bound/u);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.url).toContain("/v1/voice/streams");
    expect(requests[1]?.url).toContain("/v1/voice/cancel");

    const opened = requests[0]?.body as { streamId?: unknown } | undefined;
    const cancelled = requests[1]?.body as { streamId?: unknown } | undefined;
    expect(typeof opened?.streamId).toBe("string");
    expect(cancelled?.streamId).toBe(opened?.streamId);
  });

  it("rejects a successful open response bound to the wrong stream identity", async () => {
    let requestedStreamId: string | undefined;
    const authenticatedFetch: typeof fetch = async (input, init = {}) => {
      const url = requestUrl(input);
      const body = jsonBody(init) as { sessionId?: string; streamId?: string } | undefined;
      if (url.endsWith("/v1/voice/streams")) {
        requestedStreamId = body?.streamId;
        return new Response(JSON.stringify({
          protocolVersion: 1,
          ok: true,
          type: "VOICE_STREAM_OPENED",
          sessionId: body?.sessionId,
          streamId: "speech_stream_wrong_identity",
          sampleRate: 48_000
        }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      if (url.endsWith("/v1/voice/cancel")) {
        return new Response(JSON.stringify({
          protocolVersion: 1,
          ok: true,
          type: "VOICE_STREAM_CANCELLED",
          streamId: body?.streamId
        }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      throw new Error("Unexpected browser voice identity test request");
    };

    const client = new BrowserVoiceClient({ baseUrl: BASE_URL, authenticatedFetch });
    await expect(client.openStream(newSessionId())).rejects.toThrow();
    expect(requestedStreamId).toMatch(/^speech_stream_/u);
  });

  it("rejects a frame response whose event escapes the admitted stream identity", async () => {
    const expectedStreamId = "speech_stream_expected_response_identity";
    const authenticatedFetch: typeof fetch = async (input, init = {}) => {
      if (!requestUrl(input).endsWith("/v1/voice/frames")) {
        throw new Error("Unexpected frame-response identity test request");
      }
      const headers = new Headers(init.headers);
      const requestId = headers.get("x-speech-request-id");
      if (requestId === null) throw new Error("Expected speech request identity header");
      return new Response(JSON.stringify({
        protocolVersion: 1,
        ok: true,
        type: "VOICE_FRAME_RESULT",
        events: [{
          protocolVersion: 1,
          type: "SPEECH_STARTED",
          requestId,
          streamId: "speech_stream_cross_wired",
          utteranceId: newUtteranceId(),
          atTimestampMs: 0
        }],
        terminal: false
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };

    const client = new BrowserVoiceClient({ baseUrl: BASE_URL, authenticatedFetch });
    const stream = new BrowserVoiceStream(client, newSessionId(), expectedStreamId);
    await expect(stream.sendFrame(frame(48_000, 4_800)))
      .rejects.toThrow(/stream\/request/u);
  });

  it("rejects a frame response whose event escapes the admitted request identity", async () => {
    const expectedStreamId = "speech_stream_expected_request_identity";
    const authenticatedFetch: typeof fetch = async (input) => {
      if (!requestUrl(input).endsWith("/v1/voice/frames")) {
        throw new Error("Unexpected frame-response request identity test request");
      }
      return new Response(JSON.stringify({
        protocolVersion: 1,
        ok: true,
        type: "VOICE_FRAME_RESULT",
        events: [{
          protocolVersion: 1,
          type: "SPEECH_STARTED",
          requestId: "request_cross_wired",
          streamId: expectedStreamId,
          utteranceId: newUtteranceId(),
          atTimestampMs: 0
        }],
        terminal: false
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };

    const client = new BrowserVoiceClient({ baseUrl: BASE_URL, authenticatedFetch });
    const stream = new BrowserVoiceStream(client, newSessionId(), expectedStreamId);
    await expect(stream.sendFrame(frame(48_000, 4_800)))
      .rejects.toThrow(/stream\/request/u);
  });

  it("serializes frame and flush while allowing cancellation to preempt an in-flight frame", async () => {
    let releaseFrame: ((response: Response) => void) | undefined;
    let heldFrameInit: RequestInit | undefined;
    let flushRequests = 0;
    let cancelRequests = 0;
    const streamId = "speech_stream_control_serialization";
    const authenticatedFetch: typeof fetch = async (input, init = {}) => {
      const url = requestUrl(input);
      if (url.endsWith("/v1/voice/frames")) {
        heldFrameInit = init;
        return new Promise<Response>((resolve) => {
          releaseFrame = resolve;
        });
      }
      if (url.endsWith("/v1/voice/flush")) {
        flushRequests += 1;
        throw new Error("Flush must not reach transport while a frame is in flight");
      }
      if (url.endsWith("/v1/voice/cancel")) {
        cancelRequests += 1;
        return new Response(JSON.stringify({
          protocolVersion: 1,
          ok: true,
          type: "VOICE_STREAM_CANCELLED",
          streamId
        }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      throw new Error("Unexpected browser voice control-serialization request");
    };
    const stream = new BrowserVoiceStream(
      new BrowserVoiceClient({ baseUrl: BASE_URL, authenticatedFetch }),
      newSessionId(),
      streamId
    );

    const inFlightFrame = stream.sendFrame(frame(48_000, 4_800));
    await Promise.resolve();
    expect(heldFrameInit).toBeDefined();

    await expect(stream.flush()).rejects.toThrow(/overlapping frame\/flush/u);
    expect(flushRequests).toBe(0);

    await expect(stream.cancel()).resolves.toBeUndefined();
    expect(cancelRequests).toBe(1);
    expect(stream.isClosed).toBe(true);

    if (heldFrameInit === undefined || releaseFrame === undefined) {
      throw new Error("Expected held frame transport request");
    }
    releaseFrame(admittedFrameResponse(heldFrameInit));
    await expect(inFlightFrame).resolves.toMatchObject({ terminal: false });
    expect(stream.isClosed).toBe(true);
  });

  it("allows a bounded retry to retire a stream after the first cancel transport attempt fails", async () => {
    let cancelAttempts = 0;
    const streamId = "speech_stream_retry_cancel";
    const authenticatedFetch: typeof fetch = async (input) => {
      if (!requestUrl(input).endsWith("/v1/voice/cancel")) {
        throw new Error("Unexpected retry-cancel test request");
      }
      cancelAttempts += 1;
      if (cancelAttempts === 1) throw new Error("simulated dropped cancel transport");
      return new Response(JSON.stringify({
        protocolVersion: 1,
        ok: true,
        type: "VOICE_STREAM_CANCELLED",
        streamId
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };
    const client = new BrowserVoiceClient({ baseUrl: BASE_URL, authenticatedFetch });
    const stream = new BrowserVoiceStream(client, newSessionId(), streamId);

    await expect(stream.cancel()).rejects.toThrow(/dropped cancel transport/u);
    expect(stream.isClosed).toBe(true);
    await expect(stream.cancel()).resolves.toBeUndefined();
    expect(cancelAttempts).toBe(2);
  });

  it("carries only a max-duration trigger frame proven outside the finalized audio basis", async () => {
    let frameRequest = 0;
    const streamId = "speech_stream_max_duration_carry";
    const authenticatedFetch: typeof fetch = async (input, init = {}) => {
      if (!requestUrl(input).endsWith("/v1/voice/frames")) {
        throw new Error("Unexpected browser voice carry test request");
      }
      const requestId = new Headers(init.headers).get("x-speech-request-id");
      if (requestId === null) throw new Error("Expected exact speech request identity");
      frameRequest += 1;
      const body = frameRequest === 1
        ? {
            protocolVersion: 1,
            ok: true,
            type: "VOICE_FRAME_RESULT",
            events: [],
            terminal: false
          }
        : {
            protocolVersion: 1,
            ok: true,
            type: "VOICE_FRAME_RESULT",
            events: [{
              protocolVersion: 1,
              type: "UTTERANCE_FINALIZED",
              requestId,
              streamId,
              utteranceId: "utterance_max_duration",
              finalizationReason: "MAX_DURATION",
              speechFrameCount: 1,
              durationMs: 100,
              sourceAudioBasis: {
                streamId,
                firstSequence: 0,
                lastSequence: 0,
                startTimestampMs: 0,
                endTimestampMs: 100,
                sampleRate: 48_000,
                channels: 1,
                sampleCount: 4_800,
                pcmSha256: "0".repeat(64)
              }
            }],
            terminal: true
          };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };
    const client = new BrowserVoiceClient({ baseUrl: BASE_URL, authenticatedFetch });
    const stream = new BrowserVoiceStream(client, newSessionId(), streamId);

    const first = await stream.sendFrame(frame(48_000, 4_800));
    expect(first.carryCurrentFrameToNextStream).not.toBe(true);

    const second = await stream.sendFrame(frame(48_000, 4_800));
    expect(second.terminal).toBe(true);
    expect(second.carryCurrentFrameToNextStream).toBe(true);
    expect(stream.isClosed).toBe(true);
  });

  it("caps audio response bytes even when Content-Length is absent", async () => {
    const oversizedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(5 * 1024 * 1024));
        controller.enqueue(new Uint8Array(4 * 1024 * 1024));
        controller.close();
      }
    });
    const authenticatedFetch: typeof fetch = async () => new Response(oversizedBody, {
      status: 200,
      headers: { "content-type": "audio/wav" }
    });
    const client = new BrowserVoiceClient({
      baseUrl: BASE_URL,
      authenticatedFetch
    });
    const controller = new AbortController();

    await expect(client.resolveAudioSource(
      newSessionId(),
      `audio_v1_${"b".repeat(64)}`,
      newDeliveryId(),
      controller.signal
    )).rejects.toThrow(/browser bound/u);
  });
});
