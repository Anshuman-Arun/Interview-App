import {
  WhiteboardVisionSnapshotResponseSchema,
  WhiteboardVisionSnapshotUploadSchema,
  type WhiteboardVisionSnapshotResponse,
  type WhiteboardVisionSnapshotUpload
} from "../../../../packages/domain/src/index.js";

const MAX_RESPONSE_BYTES = 16 * 1024;

export interface WhiteboardVisionClientOptions {
  readonly baseUrl: string;
  readonly authenticationHeaderValue: string;
  readonly fetchImpl?: typeof fetch;
}

export class WhiteboardVisionClient {
  readonly #endpoint: string;
  readonly #authenticationHeaderValue: string;
  readonly #fetchImpl: typeof fetch;

  public constructor(options: WhiteboardVisionClientOptions) {
    const origin = exactLoopbackOrigin(options.baseUrl);
    if (
      typeof options.authenticationHeaderValue !== "string"
      || options.authenticationHeaderValue.length === 0
      || /[\r\n]/u.test(options.authenticationHeaderValue)
    ) {
      throw new Error("Whiteboard vision authentication is invalid");
    }
    this.#endpoint = `${origin}/v1/whiteboard-vision`;
    this.#authenticationHeaderValue = options.authenticationHeaderValue;
    this.#fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  public async submit(
    uploadInput: WhiteboardVisionSnapshotUpload,
    signal?: AbortSignal
  ): Promise<WhiteboardVisionSnapshotResponse> {
    const upload = WhiteboardVisionSnapshotUploadSchema.parse(uploadInput);
    const body = JSON.stringify(upload);
    let lastError: unknown;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (isAborted(signal)) throw new Error("Whiteboard vision request was aborted");
      try {
        const response = await this.#fetchImpl(this.#endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-interview-client-token": this.#authenticationHeaderValue
          },
          body,
          cache: "no-store",
          credentials: "omit",
          mode: "cors",
          redirect: "error",
          referrerPolicy: "no-referrer",
          ...(signal === undefined ? {} : { signal })
        });
        const contentType = response.headers.get("content-type");
        if (contentType?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
          throw new Error("Whiteboard vision endpoint returned an invalid content type");
        }
        const responseText = await response.text();
        if (new TextEncoder().encode(responseText).byteLength > MAX_RESPONSE_BYTES) {
          throw new Error("Whiteboard vision response exceeded its bounded size");
        }
        if (!response.ok) {
          throw new Error(`Whiteboard vision request failed with HTTP ${String(response.status)}`);
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(responseText) as unknown;
        } catch {
          throw new Error("Whiteboard vision endpoint returned malformed JSON");
        }
        const result = WhiteboardVisionSnapshotResponseSchema.parse(parsed);
        if (result.requestId !== upload.requestId || result.sessionId !== upload.sessionId) {
          throw new Error("Whiteboard vision response correlation mismatch");
        }
        return result;
      } catch (error) {
        if (isAborted(signal)) throw new Error("Whiteboard vision request was aborted");
        lastError = error;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("Whiteboard vision request failed");
  }
}

function exactLoopbackOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Whiteboard vision base URL is invalid");
  }
  if (
    parsed.protocol !== "http:"
    || (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "[::1]")
    || parsed.username.length > 0
    || parsed.password.length > 0
    || parsed.pathname !== "/"
    || parsed.search.length > 0
    || parsed.hash.length > 0
  ) {
    throw new Error("Whiteboard vision base URL must be an exact HTTP loopback origin");
  }
  return parsed.origin;
}


function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}
