import { describe, expect, it, vi } from "vitest";
import { newDeliveryId, newSessionId } from "../packages/domain/src/index.js";
import {
  BrowserVoiceClient,
  BrowserVoiceStream
} from "../apps/web/src/voice-client.js";
import type { AudioFrame } from "../apps/web/src/audio/types.js";

const BASE_URL = "http://127.0.0.1:43125";

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
      const url = String(input);
      const body = init.body === undefined
        ? undefined
        : JSON.parse(String(init.body)) as unknown;
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
