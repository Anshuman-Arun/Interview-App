import {
  DeliveryAcknowledgedResponseSchema
} from "../../../packages/domain/src/index.js";
import {
  MAX_RENDERER_STREAM_MESSAGE_BYTES,
  RendererAcknowledgementCommandSchema,
  RendererStreamAttachRequestSchema,
  RendererStreamMessageSchema,
  type RendererAcknowledgementCommand
} from "../../../packages/delivery/src/index.js";
import type { RendererAcknowledgementSender, RendererClient } from "./renderer-client.js";

type FetchLike = typeof fetch;

export interface RendererStreamConsumerOptions {
  readonly streamUrl: string;
  readonly sessionId: string;
  readonly authenticatedFetch: FetchLike;
  readonly signal?: AbortSignal;
}

export interface LoopbackAcknowledgementSenderOptions {
  readonly commandUrl: string;
  readonly authenticatedFetch: FetchLike;
}

export async function consumeAuthenticatedRendererStream(
  options: RendererStreamConsumerOptions,
  renderer: RendererClient
): Promise<void> {
  const fetchImpl = options.authenticatedFetch;
  const attach = RendererStreamAttachRequestSchema.parse({
    protocolVersion: 1,
    type: "ATTACH_RENDERER_STREAM",
    sessionId: options.sessionId
  });

  const requestInit: RequestInit = {
    method: "POST",
    headers: {
      accept: "text/event-stream",
      "content-type": "application/json"
    },
    body: JSON.stringify(attach)
  };
  if (options.signal !== undefined) requestInit.signal = options.signal;

  const response = await fetchImpl(options.streamUrl, requestInit);

  if (!response.ok) throw new Error("Renderer stream connection failed");
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "text/event-stream") throw new Error("Renderer stream returned an invalid content type");
  if (response.body === null) throw new Error("Renderer stream response has no body");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      if (byteLength(buffer) > MAX_RENDERER_STREAM_MESSAGE_BYTES * 2) {
        throw new Error("Renderer stream buffer exceeded its bound");
      }

      let boundary = findEventBoundary(buffer);
      while (boundary !== undefined) {
        const block = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        if (block.length > 0) await handleSseBlock(block, renderer);
        boundary = findEventBoundary(buffer);
      }
    }

    buffer += decoder.decode();
    if (buffer.trim().length > 0) {
      throw new Error("Renderer stream ended with an incomplete event");
    }
  } catch (error) {
    if (options.signal?.aborted === true) return;
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export function createLoopbackAcknowledgementSender(
  options: LoopbackAcknowledgementSenderOptions
): RendererAcknowledgementSender {
  const fetchImpl = options.authenticatedFetch;

  return {
    send: async (input: RendererAcknowledgementCommand): Promise<void> => {
      const command = RendererAcknowledgementCommandSchema.parse(input);
      const response = await fetchImpl(options.commandUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(command)
      });

      if (!response.ok) throw new Error("Renderer acknowledgement was not accepted");
      const parsed = DeliveryAcknowledgedResponseSchema.parse(await response.json() as unknown);
      const expectedAcknowledgement = command.type === "ACK_DELIVERY_EXPOSED" ? "EXPOSED" : "COMPLETED";
      if (
        parsed.requestId !== command.requestId
        || parsed.deliveryId !== command.deliveryId
        || parsed.acknowledgement !== expectedAcknowledgement
      ) {
        throw new Error("Renderer acknowledgement response did not match the request");
      }
    }
  };
}

async function handleSseBlock(block: string, renderer: RendererClient): Promise<void> {
  if (byteLength(block) > MAX_RENDERER_STREAM_MESSAGE_BYTES) {
    throw new Error("Renderer stream message exceeded its bound");
  }

  const lines = block.split(/\r?\n/u);
  let eventType: string | undefined;
  const dataLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("event:")) {
      if (eventType !== undefined) throw new Error("Renderer stream event type was repeated");
      eventType = line.slice("event:".length).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
      continue;
    }
    if (line.trim().length > 0) throw new Error("Renderer stream contained an unsupported SSE field");
  }

  if (eventType !== "delivery" || dataLines.length !== 1) {
    throw new Error("Renderer stream event does not match the delivery contract");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(dataLines[0] ?? "") as unknown;
  } catch {
    throw new Error("Renderer stream delivery data is not valid JSON");
  }

  await renderer.handleMessage(RendererStreamMessageSchema.parse(parsed));
}

function findEventBoundary(buffer: string): { readonly index: number; readonly length: number } | undefined {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");

  if (lf === -1 && crlf === -1) return undefined;
  if (lf === -1) return { index: crlf, length: 4 };
  if (crlf === -1) return { index: lf, length: 2 };
  return lf < crlf
    ? { index: lf, length: 2 }
    : { index: crlf, length: 4 };
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
