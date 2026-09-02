import type {
  LocalComponentStatus,
  LocalRuntimeManager
} from "../../../../packages/local-runtime/src/index.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 35_000;
const MAX_JSON_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_JSON_RESPONSE_CHUNKS = 1_024;

export class ManagedWorkerRequestTimeoutError extends Error {
  public constructor() {
    super("Managed local model worker request exceeded its runtime deadline");
    this.name = "ManagedWorkerRequestTimeoutError";
  }
}

export class ManagedModelWorkerClient {
  private recyclePromise: Promise<void> | undefined;

  public constructor(
    private readonly manager: LocalRuntimeManager,
    private readonly componentId: string,
    private readonly workerType: "speech" | "tts",
    private readonly token: string,
    private readonly lifecycleSignal?: AbortSignal
  ) {
    if (!/^[0-9a-f]{64}$/u.test(token)) throw new Error("Invalid managed worker token");
  }

  public runtimeVersion(): string {
    const status = this.readyStatus();
    const runtimeVersion = status.handshake?.runtimeVersion;
    if (typeof runtimeVersion !== "string" || runtimeVersion.length === 0 || runtimeVersion.length > 256) {
      throw new Error("Managed local model worker did not report a bounded runtime version");
    }
    return runtimeVersion;
  }

  public workerInstanceIdentity(): string {
    const status = this.readyStatus();
    const pid = status.pid;
    const startedAt = status.startedAt;
    const readyAt = status.readyAt;
    const restartCount = status.restartCount;
    if (!Number.isSafeInteger(pid)
        || (pid as number) <= 0
        || typeof startedAt !== "string"
        || startedAt.length === 0
        || startedAt.length > 64
        || typeof readyAt !== "string"
        || readyAt.length === 0
        || readyAt.length > 64
        || !Number.isSafeInteger(restartCount)
        || restartCount < 0) {
      throw new Error("Managed local model worker reported an invalid instance identity");
    }
    return `${String(pid)}:${String(restartCount)}:${startedAt}:${readyAt}`;
  }

  public async postJson(
    pathname: "/v1/vad" | "/v1/stt" | "/v1/tts" | "/v1/tts/cancel",
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
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
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
      if (timedOut) {
        throw new ManagedWorkerRequestTimeoutError();
      }
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

  public recycleAfterUncertainRequest(expectedWorkerInstance: string): Promise<void> {
    if (this.lifecycleSignal?.aborted === true) return Promise.resolve();
    let currentWorkerInstance: string;
    try {
      currentWorkerInstance = this.workerInstanceIdentity();
    } catch {
      return Promise.resolve();
    }
    if (currentWorkerInstance !== expectedWorkerInstance) return Promise.resolve();
    if (this.recyclePromise !== undefined) return this.recyclePromise;

    const operation = (async (): Promise<void> => {
      await this.manager.stop(this.componentId);
      if (this.lifecycleSignal?.aborted === true) return;
      await this.manager.start(
        this.componentId,
        this.lifecycleSignal === undefined ? {} : { signal: this.lifecycleSignal }
      );
    })();
    this.recyclePromise = operation;
    void operation.finally(() => {
      if (this.recyclePromise === operation) this.recyclePromise = undefined;
    }).catch(() => undefined);
    return operation;
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
  if (metadata === undefined) {
    throw new Error("Managed local model worker did not report bounded metadata");
  }
  const workerType = status.handshake?.workerType;
  const runtimeVersion = status.handshake?.runtimeVersion;
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
  let declaredBytes: number | undefined;
  if (declaredLength !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(declaredLength)) {
      response.body?.cancel().catch(() => undefined);
      throw new Error("Managed local model worker response declared an invalid byte length");
    }
    const parsed = Number(declaredLength);
    if (!Number.isSafeInteger(parsed) || parsed > maximumBytes) {
      response.body?.cancel().catch(() => undefined);
      throw new Error("Managed local model worker response exceeds its byte limit");
    }
    declaredBytes = parsed;
  }
  const body = response.body;
  if (body === null) {
    if (declaredBytes !== undefined && declaredBytes !== 0) {
      throw new Error("Managed local model worker response length did not match Content-Length");
    }
    return new Uint8Array();
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let chunkCount = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunkCount += 1;
      total += value.byteLength;
      if (chunkCount > MAX_JSON_RESPONSE_CHUNKS || total > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("Managed local model worker response exceeds its transport bound");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (declaredBytes !== undefined && total !== declaredBytes) {
    throw new Error("Managed local model worker response length did not match Content-Length");
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
