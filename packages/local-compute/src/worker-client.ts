import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname } from "node:path";
import {
  LocalComputeRequestSchema,
  LocalComputeResponseSchema,
  type LocalComputeRequest,
  type LocalComputeResponse,
  type LocalComputeSuccessResponse,
  type LocalProcessInterruption
} from "./protocol.js";
import { redactSecrets, type RequestId } from "../../domain/src/index.js";

export type LocalComputeWorkerState = "NEW" | "STARTING" | "RUNNING" | "INTERRUPTING" | "STOPPED";

export interface LocalComputeWorkerOptions {
  readonly executable: string;
  readonly scriptPath: string;
  readonly requestTimeoutMs?: number;
  readonly maxResponseLineBytes?: number;
  readonly additionalArguments?: readonly string[];
}

interface PendingRequest {
  readonly request: LocalComputeRequest;
  readonly fingerprint: string;
  readonly promise: Promise<LocalComputeSuccessResponse>;
  readonly resolve: (response: LocalComputeSuccessResponse) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface CompletedRequest {
  readonly fingerprint: string;
  readonly response: LocalComputeResponse;
}

export class LocalComputeWorkerError extends Error {
  public constructor(
    public readonly code: "NOT_RUNNING" | "REQUEST_ID_CONFLICT" | "TIMEOUT" | "INTERRUPTED" | "PROCESS_EXITED" | "PROTOCOL_ERROR" | "WORKER_ERROR",
    message: string
  ) {
    super(message);
  }
}

export class LocalComputeWorkerClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private state: LocalComputeWorkerState = "NEW";
  private responseBuffer = Buffer.alloc(0);
  private readonly maxResponseLineBytes: number;
  private readonly pending = new Map<RequestId, PendingRequest>();
  private readonly completed = new Map<RequestId, CompletedRequest>();
  private readonly ignored = new Set<RequestId>();
  private readonly diagnostics: string[] = [];

  public constructor(private readonly options: LocalComputeWorkerOptions) {
    this.maxResponseLineBytes = options.maxResponseLineBytes ?? 128 * 1024;
    if (!Number.isSafeInteger(this.maxResponseLineBytes) || this.maxResponseLineBytes <= 0) {
      throw new LocalComputeWorkerError("PROTOCOL_ERROR", "Local compute response line limit must be a positive safe integer");
    }
  }

  public getState(): LocalComputeWorkerState {
    return this.state;
  }

  public getDiagnostics(): readonly string[] {
    return [...this.diagnostics];
  }

  public async start(): Promise<void> {
    if (this.state !== "NEW") throw new LocalComputeWorkerError("NOT_RUNNING", `Cannot start worker in ${this.state}`);
    this.state = "STARTING";
    const child = spawn(this.options.executable, [
      "-I",
      "-u",
      this.options.scriptPath,
      ...(this.options.additionalArguments ?? [])
    ], {
      cwd: dirname(this.options.scriptPath),
      env: buildRestrictedWorkerEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    this.child = child;
    this.attachProcessHandlers(child);
    await new Promise<void>((resolve, reject) => {
      const onSpawn = (): void => {
        cleanup();
        this.state = "RUNNING";
        resolve();
      };
      const onError = (): void => {
        cleanup();
        this.state = "STOPPED";
        reject(new LocalComputeWorkerError("PROCESS_EXITED", "Local compute worker could not start"));
      };
      const cleanup = (): void => {
        child.off("spawn", onSpawn);
        child.off("error", onError);
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });
  }

  public request(input: unknown): Promise<LocalComputeSuccessResponse> {
    if (this.state !== "RUNNING" || this.child === undefined) {
      return Promise.reject(new LocalComputeWorkerError("NOT_RUNNING", "Local compute worker is not running"));
    }
    const request = LocalComputeRequestSchema.parse(input);
    const fingerprint = JSON.stringify(request);
    const completed = this.completed.get(request.requestId);
    if (completed !== undefined) {
      if (completed.fingerprint !== fingerprint) return Promise.reject(requestIdConflict());
      return responseToPromise(completed.response);
    }
    const pending = this.pending.get(request.requestId);
    if (pending !== undefined) {
      return pending.fingerprint === fingerprint ? pending.promise : Promise.reject(requestIdConflict());
    }

    let resolvePromise: ((response: LocalComputeSuccessResponse) => void) | undefined;
    let rejectPromise: ((error: Error) => void) | undefined;
    const promise = new Promise<LocalComputeSuccessResponse>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const timer = setTimeout(() => {
      const current = this.pending.get(request.requestId);
      if (current === undefined) return;
      this.pending.delete(request.requestId);
      this.rememberIgnored(request.requestId);
      current.reject(new LocalComputeWorkerError("TIMEOUT", "Local compute request timed out"));
      void this.interrupt("Request timeout");
    }, this.options.requestTimeoutMs ?? 5_000);
    const tracked: PendingRequest = {
      request,
      fingerprint,
      promise,
      resolve: resolvePromise as (response: LocalComputeSuccessResponse) => void,
      reject: rejectPromise as (error: Error) => void,
      timer
    };
    this.pending.set(request.requestId, tracked);
    this.child.stdin.write(`${JSON.stringify(request)}\n`, "utf8", (error) => {
      if (error !== null && error !== undefined) this.failProtocol("Could not write request to local compute worker");
    });
    return promise;
  }

  public async interrupt(reason: string): Promise<LocalProcessInterruption> {
    const sanitizedReason = redactSecrets(reason).trim().slice(0, 200);
    if (sanitizedReason.length > 0) this.rememberDiagnostic(`Interrupted: ${sanitizedReason}`);
    const child = this.child;
    if (child === undefined || child.exitCode !== null || this.state === "STOPPED") {
      this.state = "STOPPED";
      return { semantics: "INTERRUPT_LOCAL_PROCESS", signalSent: false };
    }
    this.state = "INTERRUPTING";
    this.responseBuffer = Buffer.alloc(0);
    this.rejectAll(new LocalComputeWorkerError("INTERRUPTED", "Local compute worker was interrupted"));
    return { semantics: "INTERRUPT_LOCAL_PROCESS", signalSent: child.kill() };
  }

  public async stop(): Promise<void> {
    const child = this.child;
    if (child === undefined || child.exitCode !== null || this.state === "STOPPED") {
      this.state = "STOPPED";
      return;
    }
    child.stdin.end();
    await new Promise<void>((resolve) => {
      const fallback = setTimeout(() => {
        child.kill();
        resolve();
      }, 1_000);
      child.once("exit", () => {
        clearTimeout(fallback);
        resolve();
      });
    });
  }

  private attachProcessHandlers(child: ChildProcessWithoutNullStreams): void {
    child.stdout.on("data", (chunk: Buffer) => this.handleResponseChunk(chunk));
    child.stdout.once("end", () => {
      if (this.responseBuffer.length > 0 && this.state !== "STOPPED" && this.state !== "INTERRUPTING") {
        this.failProtocol("Local compute worker ended with an unterminated response");
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.rememberDiagnostic(redactSecrets(chunk).trim().slice(0, 500));
    });
    child.once("exit", (code) => {
      this.state = "STOPPED";
      this.responseBuffer = Buffer.alloc(0);
      this.rejectAll(new LocalComputeWorkerError("PROCESS_EXITED", `Local compute worker exited with code ${String(code)}`));
    });
    child.on("error", () => {
      if (this.state === "STARTING") return;
      this.failProtocol("Local compute worker process error");
    });
  }

  private handleResponseChunk(chunk: Buffer): void {
    if (this.shouldIgnoreOutput()) return;
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline === -1 ? chunk.length : newline;
      const fragment = chunk.subarray(offset, end);
      if (this.responseBuffer.length + fragment.length > this.maxResponseLineBytes) {
        this.failProtocol("Local compute response exceeded the line limit");
        return;
      }
      if (fragment.length > 0) {
        this.responseBuffer = this.responseBuffer.length === 0
          ? Buffer.from(fragment)
          : Buffer.concat([this.responseBuffer, fragment], this.responseBuffer.length + fragment.length);
      }
      if (newline === -1) return;

      const line = this.responseBuffer;
      this.responseBuffer = Buffer.alloc(0);
      this.handleResponseLine(line);
      if (this.shouldIgnoreOutput()) return;
      offset = newline + 1;
    }
  }

  private shouldIgnoreOutput(): boolean {
    return this.state === "STOPPED" || this.state === "INTERRUPTING";
  }

  private handleResponseLine(line: Buffer): void {
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(line);
    } catch {
      this.failProtocol("Local compute worker emitted invalid UTF-8");
      return;
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(text) as unknown;
    } catch {
      this.failProtocol("Local compute worker emitted malformed JSON");
      return;
    }
    const parsed = LocalComputeResponseSchema.safeParse(decoded);
    if (!parsed.success) {
      this.failProtocol("Local compute worker emitted an invalid response envelope");
      return;
    }
    const response = parsed.data;
    const tracked = this.pending.get(response.requestId);
    if (tracked === undefined) {
      if (this.completed.has(response.requestId) || this.ignored.has(response.requestId)) return;
      this.failProtocol("Local compute worker emitted an unsolicited response");
      return;
    }
    if (!responseMatchesRequest(response, tracked.request)) {
      this.failProtocol("Local compute response does not match its request basis");
      return;
    }
    clearTimeout(tracked.timer);
    this.pending.delete(response.requestId);
    this.rememberCompleted(response.requestId, { fingerprint: tracked.fingerprint, response });
    if (response.type === "WORKER_ERROR") {
      tracked.reject(new LocalComputeWorkerError("WORKER_ERROR", `Worker rejected request: ${response.code}`));
    } else {
      tracked.resolve(response);
    }
  }

  private failProtocol(message: string): void {
    if (this.state === "STOPPED") return;
    const error = new LocalComputeWorkerError("PROTOCOL_ERROR", message);
    this.rejectAll(error);
    this.state = "INTERRUPTING";
    this.responseBuffer = Buffer.alloc(0);
    this.child?.kill();
  }

  private rejectAll(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }

  private rememberCompleted(requestId: RequestId, completed: CompletedRequest): void {
    this.completed.set(requestId, completed);
    if (this.completed.size <= 1_024) return;
    const oldest = this.completed.keys().next().value;
    if (oldest !== undefined) this.completed.delete(oldest);
  }

  private rememberIgnored(requestId: RequestId): void {
    this.ignored.add(requestId);
    if (this.ignored.size <= 1_024) return;
    const oldest = this.ignored.values().next().value;
    if (oldest !== undefined) this.ignored.delete(oldest);
  }

  private rememberDiagnostic(message: string): void {
    if (message.length === 0) return;
    this.diagnostics.push(message);
    if (this.diagnostics.length > 20) this.diagnostics.shift();
  }
}

export function buildRestrictedWorkerEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const allowedKeys = ["PATH", "Path", "PATHEXT", "SYSTEMROOT", "SystemRoot", "WINDIR", "TEMP", "TMP"] as const;
  const environment: NodeJS.ProcessEnv = {};
  for (const key of allowedKeys) {
    const value = source[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

function requestIdConflict(): LocalComputeWorkerError {
  return new LocalComputeWorkerError("REQUEST_ID_CONFLICT", "RequestId was reused with different content");
}

function responseToPromise(response: LocalComputeResponse): Promise<LocalComputeSuccessResponse> {
  return response.type === "WORKER_ERROR"
    ? Promise.reject(new LocalComputeWorkerError("WORKER_ERROR", `Worker rejected request: ${response.code}`))
    : Promise.resolve(response);
}

function responseMatchesRequest(response: LocalComputeResponse, request: LocalComputeRequest): boolean {
  if (response.type === "WORKER_ERROR") return true;
  if (request.type === "HEALTH_CHECK") return response.type === "HEALTH_RESULT";
  return response.type === "TRANSCRIPT_ANALYSIS_RESULT" && response.sourceRevision === request.sourceRevision;
}
