import type {
  LocalComponentStatus,
  LocalRuntimeManager
} from "../../../../packages/local-runtime/src/index.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 35_000;
const MAX_JSON_RESPONSE_BYTES = 16 * 1024 * 1024;

export class ManagedModelWorkerClient {
  public constructor(
    private readonly manager: LocalRuntimeManager,
    private readonly componentId: string,
    private readonly workerType: "speech" | "tts",
    private readonly token: string
  ) {
    if (!/^[0-9a-f]{64}$/u.test(token)) throw new Error("Invalid managed worker token");
  }

  public runtimeVersion(): string {
    return handshakeMetadata(this.readyStatus()).runtimeVersion;
  }

  public async postJson(
    pathname: "/v1/vad" | "/v1/stt" | "/v1/tts",
    body: unknown,
    options: {
      readonly signal?: AbortSignal;
      readonly timeoutMs?: number;
      readonly maxResponseBytes?: number;
    } = {}
  ): Promise<unknown> {
    const metadata = handshakeMetadata(this.readyStatus());
    const url = `http://127.0.0.1:${String(metadata.port)}${pathname}`;
    const controller = new AbortController();
    const unlink = linkAbort(options.signal, controller);
    const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: "POST",
        redirect: "error",
        cache: "no-store",
        headers: {
          "authorization": `Bearer ${this.token}`,
          "content-type": "application/json"
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      if (response.redirected || (response.status >= 300 && response.status < 400)) {
        throw new Error("Managed local model worker attempted an HTTP redirect");
      }
      const bytes = await readBoundedBody(
        response,
        options.maxResponseBytes ?? MAX_JSON_RESPONSE_BYTES
      );
      if (!response.ok) throw new Error("Managed local model worker rejected the request");
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
      } catch {
        throw new Error("Managed local model worker returned invalid JSON");
      }
      return parsed;
    } catch (error) {
      if (controller.signal.aborted) {
        const aborted = new Error("Managed local model worker request was cancelled");
        aborted.name = "AbortError";
        throw aborted;
      }
      throw error;
    } finally {
      clearTimeout(timer);
      unlink();
    }
  }

  private readyStatus(): LocalComponentStatus {
    const status = this.manager.getStatus(this.componentId);
    if (status.state !== "READY") {
      throw new Error(`Managed local model worker ${this.componentId} is not ready`);
    }
    const metadata = handshakeMetadata(status);
    if (metadata.workerType !== this.workerType) {
      throw new Error("Managed local model worker reported the wrong worker type");
    }
    return status;
  }
}

function handshakeMetadata(status: LocalComponentStatus): {
  readonly workerType: "speech" | "tts";
  readonly runtimeVersion: string;
  readonly port: number;
} {
  const metadata = status.handshake?.metadata;
  if (metadata === undefined || metadata === null || typeof metadata !== "object") {
    throw new Error("Managed local model worker did not report bounded metadata");
  }
  const workerType = metadata["workerType"];
  const runtimeVersion = metadata["runtimeVersion"];
  const port = metadata["port"];
  if ((workerType !== "speech" && workerType !== "tts")
      || typeof runtimeVersion !== "string"
      || runtimeVersion.length === 0
      || runtimeVersion.length > 256
      || !Number.isSafeInteger(port)
      || (port as number) < 1
      || (port as number) > 65_535) {
    throw new Error("Managed local model worker reported invalid bounded metadata");
  }
  return {
    workerType,
    runtimeVersion,
    port: port as number
  };
}

async function readBoundedBody(response: Response, maximumBytes: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
    throw new Error("Managed worker response byte limit is invalid");
  }
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(declaredLength)
        || Number(declaredLength) > maximumBytes) {
      response.body?.cancel().catch(() => undefined);
      throw new Error("Managed local model worker response exceeds its byte limit");
    }
  }
  const body = response.body;
  if (body === null) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("Managed local model worker response exceeds its byte limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function linkAbort(signal: AbortSignal | undefined, controller: AbortController): () => void {
  if (signal === undefined) return () => undefined;
  const abort = (): void => controller.abort();
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  return () => signal.removeEventListener("abort", abort);
}
