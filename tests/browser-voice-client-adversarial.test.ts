import { describe, expect, it, vi } from "vitest";
import { newDeliveryId, newSessionId } from "../packages/domain/src/index.js";
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

  it("carries only a max-duration trigger frame proven outside the finalized audio basis", async () => {
    let frameRequest = 0;
    const streamId = "speech_stream_max_duration_carry";
    const authenticatedFetch: typeof fetch = async (input) => {
      if (!requestUrl(input).endsWith("/v1/voice/frames")) {
        throw new Error("Unexpected browser voice carry test request");
      }
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
              requestId: "request_max_duration",
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
