import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { DIAGNOSTIC_SANITIZATION_LIMITS, sanitizeDiagnosticRecord, sanitizeDiagnosticText } from "../../diagnostics/src/index.js";
import { BoundedLineBuffer, BoundedLineFramer } from "./buffer.js";
import { buildLocalEnvironment, type BuiltLocalEnvironment } from "./environment.js";
import type {
  LocalComponentDefinition,
  LocalComponentHandshake,
  LocalComponentState,
  LocalComponentStatus,
  LocalExpectedHandshake,
  LocalFailureSnapshot,
  LocalReadinessContext,
  LocalReadinessDecision,
  LocalReadinessSnapshot,
  LocalRestartPolicy,
  LocalRuntimeManagerOptions,
  LocalShutdownControl,
  LocalStopResult
} from "./types.js";

const DEFAULT_RESTART_POLICY: LocalRestartPolicy = Object.freeze({ mode: "NEVER" });
const DEFAULT_OUTPUT_MAX_LINES = 200;
const DEFAULT_OUTPUT_MAX_BYTES = 64 * 1024;
const DEFAULT_OUTPUT_MAX_LINE_BYTES = 64 * 1024;
const DEFAULT_POLL_INTERVAL_MS = 50;
const MAX_TIMER_MS = 2_147_483_647;
const PROCESS_TREE_POLL_INTERVAL_MS = 10;
const MAX_CAPABILITIES = 128;
const MAX_STDERR_TAIL_LINES = 20;
const MAX_OUTPUT_LINES = 10_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_OUTPUT_LINE_BYTES = 256 * 1024;
const MAX_RESTART_RETRIES = 100;
const COMPONENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export type LocalRuntimeErrorCode =
  | "DUPLICATE_COMPONENT"
  | "UNKNOWN_COMPONENT"
  | "INVALID_DEFINITION"
  | "SPAWN_FAILED"
  | "START_CANCELLED"
  | "READINESS_TIMEOUT"
  | "READINESS_FAILED"
  | "PROCESS_EXITED"
  | "HANDSHAKE_MISMATCH"
  | "TERMINATION_FAILED"
  | "INVALID_STATE";

export class LocalRuntimeError extends Error {
  public constructor(public readonly code: LocalRuntimeErrorCode, message: string) {
    super(message);
  }
}

interface InternalExitRecord {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timestamp: string;
  readonly previousState: LocalComponentState;
  readonly unexpected: boolean;
  readonly stderrTail: readonly string[];
}

interface ComponentRecord {
  readonly definition: LocalComponentDefinition;
  readonly environment: BuiltLocalEnvironment;
  readonly registrationIndex: number;
  stdout: BoundedLineBuffer;
  stderr: BoundedLineBuffer;
  readonly stdoutListeners: Set<(line: string) => void>;
  readonly exitListeners: Set<(exit: InternalExitRecord) => void>;
  state: LocalComponentState;
  child: ChildProcessWithoutNullStreams | undefined;
  residualProcess: ChildProcessWithoutNullStreams | undefined;
  startedAt: string | undefined;
  readyAt: string | undefined;
  readinessDetail: string | undefined;
  handshake: LocalComponentHandshake | undefined;
  lastExit: InternalExitRecord | undefined;
  lastExitProcess: ChildProcessWithoutNullStreams | undefined;
  failure: LocalFailureSnapshot | undefined;
  restartCount: number;
  restartBudgetUsed: number;
  expectedStop: boolean;
  operationAbort: AbortController | undefined;
  startPromise: Promise<LocalComponentStatus> | undefined;
  stopPromise: Promise<LocalStopResult> | undefined;
  cleanupPromise: Promise<void> | undefined;
}

export class LocalRuntimeManager {
  private readonly components = new Map<string, ComponentRecord>();
  private registrationSequence = 0;
  private readonly parentEnvironment: NodeJS.ProcessEnv;
  private readonly now: () => Date;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly platform: NodeJS.Platform;
  private stopAllPromise: Promise<readonly LocalStopResult[]> | undefined;

  public constructor(options: LocalRuntimeManagerOptions = {}) {
    this.parentEnvironment = options.parentEnvironment ?? process.env;
    this.now = options.now ?? (() => new Date());
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.platform = process.platform;
    this.stopAllPromise = undefined;
  }

  public register(definition: LocalComponentDefinition): LocalComponentStatus {
    if (this.stopAllPromise !== undefined) {
      throw new LocalRuntimeError("INVALID_STATE", "Cannot register a component while stopAll() is in progress");
    }
    const inspectedDefinition = inspectDefinition(definition);
    validateDefinition(inspectedDefinition);
    if (this.components.has(inspectedDefinition.id)) {
      throw new LocalRuntimeError("DUPLICATE_COMPONENT", `Component ${inspectedDefinition.id} is already registered`);
    }

    let environment: BuiltLocalEnvironment;
    try {
      environment = buildLocalEnvironment(inspectedDefinition.environment, this.parentEnvironment, this.platform);
    } catch (error) {
      throw new LocalRuntimeError(
        "INVALID_DEFINITION",
        `Invalid environment configuration: ${safeErrorMessage(error)}`
      );
    }

    const normalizedDefinition = freezeDefinition(inspectedDefinition);
    const maxLines = normalizedDefinition.output?.maxLines ?? DEFAULT_OUTPUT_MAX_LINES;
    const maxBytes = normalizedDefinition.output?.maxBytes ?? DEFAULT_OUTPUT_MAX_BYTES;
    const record: ComponentRecord = {
      definition: normalizedDefinition,
      environment,
      registrationIndex: this.registrationSequence,
      stdout: new BoundedLineBuffer(maxLines, maxBytes, environment.secretValues),
      stderr: new BoundedLineBuffer(maxLines, maxBytes, environment.secretValues),
      stdoutListeners: new Set(),
      exitListeners: new Set(),
      state: "STOPPED",
      child: undefined,
      residualProcess: undefined,
      startedAt: undefined,
      readyAt: undefined,
      readinessDetail: undefined,
      handshake: undefined,
      lastExit: undefined,
      lastExitProcess: undefined,
      failure: undefined,
      operationAbort: undefined,
      startPromise: undefined,
      stopPromise: undefined,
      cleanupPromise: undefined,
      restartCount: 0,
      restartBudgetUsed: 0,
      expectedStop: false
    };
    this.registrationSequence += 1;
    this.components.set(normalizedDefinition.id, record);
    return this.snapshot(record);
  }

  public start(componentId: string, options: { readonly signal?: AbortSignal } = {}): Promise<LocalComponentStatus> {
    const record = this.requireRecord(componentId);
    if (this.stopAllPromise !== undefined) {
      return Promise.reject(new LocalRuntimeError(
        "INVALID_STATE",
        "Cannot start a component while stopAll() is in progress"
      ));
    }
    if (record.stopPromise !== undefined) {
      return record.stopPromise.then(() => this.start(componentId, options));
    }
    if (record.cleanupPromise !== undefined) {
      return record.cleanupPromise.then(() => this.start(componentId, options));
    }
    if (record.startPromise !== undefined) return record.startPromise;
    if (record.state === "READY" || record.state === "DEGRADED") return Promise.resolve(this.snapshot(record));
    if (record.residualProcess !== undefined) {
      if (isOwnedProcessTreeAlive(record.residualProcess, this.platform)) {
        return Promise.reject(new LocalRuntimeError(
          "INVALID_STATE",
          `Cannot start ${componentId} while a residual managed process tree is still alive`
        ));
      }
      record.residualProcess = undefined;
    }
    if (record.child !== undefined && isChildAlive(record.child)) {
      return Promise.reject(new LocalRuntimeError(
        "INVALID_STATE",
        `Cannot start ${componentId} while its previous managed process is still alive`
      ));
    }
    if (options.signal?.aborted === true) {
      return Promise.reject(new LocalRuntimeError("START_CANCELLED", `Start cancelled for ${componentId}`));
    }

    record.expectedStop = false;
    record.restartBudgetUsed = 0;
    const controller = new AbortController();
    record.operationAbort = controller;
    const unlink = linkAbortSignal(options.signal, controller);
    const promise = this.runStartSequence(record, controller.signal, 0);
    record.startPromise = promise;
    void promise.then(
      () => this.clearStartOperation(record, promise, controller, unlink),
      () => this.clearStartOperation(record, promise, controller, unlink)
    );
    return promise;
  }

  public stop(componentId: string): Promise<LocalStopResult> {
    const record = this.requireRecord(componentId);
    if (record.stopPromise !== undefined) return record.stopPromise;
    const promise = Promise.resolve().then(() => this.runStop(record));
    record.stopPromise = promise;
    void promise.then(
      () => {
        if (record.stopPromise === promise) record.stopPromise = undefined;
      },
      () => {
        if (record.stopPromise === promise) record.stopPromise = undefined;
      }
    );
    return promise;
  }

  public async restart(componentId: string): Promise<LocalComponentStatus> {
    await this.stop(componentId);
    return this.start(componentId);
  }

  public getStatus(componentId: string): LocalComponentStatus {
    return this.snapshot(this.requireRecord(componentId));
  }

  public listStatuses(): readonly LocalComponentStatus[] {
    return Object.freeze(
      [...this.components.values()]
        .sort((left, right) => left.registrationIndex - right.registrationIndex)
        .map((record) => this.snapshot(record))
    );
  }

  public markDegraded(componentId: string, detail: string): LocalComponentStatus {
    const record = this.requireRecord(componentId);
    if (record.state !== "READY" && record.state !== "DEGRADED") {
      throw new LocalRuntimeError("INVALID_STATE", `Cannot mark ${componentId} degraded from ${record.state}`);
    }
    record.state = "DEGRADED";
    record.readinessDetail = sanitizeStatusText(detail, record.environment.secretValues);
    return this.snapshot(record);
  }

  public markReady(componentId: string, detail?: string): LocalComponentStatus {
    const record = this.requireRecord(componentId);
    if (record.state !== "READY" && record.state !== "DEGRADED") {
      throw new LocalRuntimeError("INVALID_STATE", `Cannot mark ${componentId} ready from ${record.state}`);
    }
    record.state = "READY";
    record.readinessDetail = detail === undefined
      ? undefined
      : sanitizeStatusText(detail, record.environment.secretValues);
    return this.snapshot(record);
  }

  public stopAll(): Promise<readonly LocalStopResult[]> {
    if (this.stopAllPromise !== undefined) return this.stopAllPromise;
    const promise = Promise.resolve().then(() => this.runStopAll());
    this.stopAllPromise = promise;
    void promise.then(
      () => {
        if (this.stopAllPromise === promise) this.stopAllPromise = undefined;
      },
      () => {
        if (this.stopAllPromise === promise) this.stopAllPromise = undefined;
      }
    );
    return promise;
  }

  private async runStopAll(): Promise<readonly LocalStopResult[]> {
    const records = [...this.components.values()].sort((left, right) => right.registrationIndex - left.registrationIndex);
    const results: LocalStopResult[] = [];
    const failures: unknown[] = [];
    for (const record of records) {
      try {
        results.push(await this.stop(record.definition.id));
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "One or more managed local components failed to stop");
    }
    return Object.freeze(results);
  }

  private async runStartSequence(
    record: ComponentRecord,
    signal: AbortSignal,
    initialBackoffMs: number
  ): Promise<LocalComponentStatus> {
    let delayMs = initialBackoffMs;
    for (;;) {
      if (delayMs > 0) await abortableDelay(delayMs, signal, record.definition.id);
      try {
        await this.spawnAndAwaitReadiness(record, signal);
        return this.snapshot(record);
      } catch (error) {
        const runtimeError = normalizeRuntimeError(error, record.definition.id);
        if (runtimeError.code === "TERMINATION_FAILED") {
          record.state = "FAILED";
          record.failure = this.failure(
            runtimeError.code,
            runtimeError.message,
            record.environment.secretValues
          );
          throw runtimeError;
        }
        if (isCancellation(runtimeError) || record.expectedStop || signal.aborted) {
          if (record.state !== "STOPPING") record.state = "STOPPED";
          throw new LocalRuntimeError("START_CANCELLED", `Start cancelled for ${record.definition.id}`);
        }
        record.state = "FAILED";
        record.failure = this.failure(
          runtimeError.code,
          runtimeError.message,
          record.environment.secretValues
        );
        if (!isRetryableStartFailure(runtimeError) || !this.reserveRestart(record)) throw runtimeError;
        delayMs = restartBackoff(record.definition.restartPolicy ?? DEFAULT_RESTART_POLICY, record.restartBudgetUsed);
      }
    }
  }

  private async spawnAndAwaitReadiness(record: ComponentRecord, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new LocalRuntimeError("START_CANCELLED", `Start cancelled for ${record.definition.id}`);
    const attemptStartedAt = performance.now();
    record.state = "STARTING";
    record.failure = undefined;
    record.readyAt = undefined;
    record.handshake = undefined;
    record.readinessDetail = undefined;
    record.startedAt = this.timestamp();

    const limits = outputLimitsFor(record.definition);
    const stdout = new BoundedLineBuffer(limits.maxLines, limits.maxBytes, record.environment.secretValues);
    const stderr = new BoundedLineBuffer(limits.maxLines, limits.maxBytes, record.environment.secretValues);
    record.stdout = stdout;
    record.stderr = stderr;

    const child = this.spawnChild(record);
    record.child = child;
    this.attachChild(record, child, stdout, stderr, limits.maxLineBytes);

    const attemptController = new AbortController();
    const unlinkAttempt = linkAbortSignal(signal, attemptController);
    const earlyReadiness = isStdoutReadiness(record.definition.readiness)
      ? this.waitForReadiness(
          record,
          child,
          attemptController.signal,
          record.definition.startupTimeoutMs
        )
      : undefined;
    if (earlyReadiness !== undefined) void earlyReadiness.catch(() => undefined);

    try {
      await waitForSpawn(
        child,
        attemptController.signal,
        record.definition.id,
        record.definition.startupTimeoutMs
      );
      if (child.pid === undefined) {
        throw new LocalRuntimeError("SPAWN_FAILED", `Component ${record.definition.id} did not receive a process id`);
      }
      const remainingMs = remainingStartupTimeout(record.definition.startupTimeoutMs, attemptStartedAt);
      const readiness = earlyReadiness
        ?? await this.waitForReadiness(record, child, attemptController.signal, remainingMs);
      if (child.exitCode !== null || child.signalCode !== null || record.child !== child) {
        throw new LocalRuntimeError("PROCESS_EXITED", `Component ${record.definition.id} exited during startup`);
      }
      if (readiness.handshake !== undefined) {
        validateReportedHandshake(readiness.handshake, record.definition.id);
      }
      validateExpectedHandshake(record.definition.expectedHandshake, readiness.handshake, record.definition.id);
      record.handshake = readiness.handshake === undefined
        ? undefined
        : sanitizeHandshake(readiness.handshake, record.environment.secretValues);
      record.readinessDetail = readiness.detail;
      record.readyAt = this.timestamp();
      record.state = "READY";
    } catch (error) {
      attemptController.abort();
      if (earlyReadiness !== undefined) {
        await earlyReadiness.catch(() => undefined);
      }
      if (!record.expectedStop) await this.cleanupFailedAttempt(record, child);
      throw error;
    } finally {
      unlinkAttempt?.();
      attemptController.abort();
    }
  }

  private spawnChild(record: ComponentRecord): ChildProcessWithoutNullStreams {
    const definition = record.definition;
    try {
      return spawn(definition.executable, [...(definition.args ?? [])], {
        ...(definition.cwd === undefined ? {} : { cwd: definition.cwd }),
        env: record.environment.environment,
        shell: false,
        detached: this.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true
      });
    } catch {
      throw new LocalRuntimeError("SPAWN_FAILED", `Could not spawn component ${definition.id}`);
    }
  }

  private attachChild(
    record: ComponentRecord,
    child: ChildProcessWithoutNullStreams,
    stdout: BoundedLineBuffer,
    stderr: BoundedLineBuffer,
    maxLineBytes: number
  ): void {
    const stdoutFramer = new BoundedLineFramer(
      maxLineBytes,
      (line) => {
        stdout.push(line);
        if (record.child === child) {
          for (const listener of [...record.stdoutListeners]) listener(line);
        }
      },
      () => stdout.markMalformed()
    );
    const stderrFramer = new BoundedLineFramer(
      maxLineBytes,
      (line) => stderr.push(line),
      () => stderr.markMalformed()
    );

    child.stdin.on("error", () => {
      stderr.push("Managed component stdin stream error");
    });
    child.stdout.on("error", () => {
      stderr.push("Managed component stdout stream error");
    });
    child.stderr.on("error", () => {
      stderr.push("Managed component stderr stream error");
    });
    child.stdout.on("data", (chunk: Buffer) => stdoutFramer.append(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrFramer.append(chunk));
    let exitObserved = false;
    child.once("exit", (code, signal) => {
      exitObserved = true;
      this.handleProcessExit(record, child, stderr, code, signal);
    });
    child.once("close", (code, signal) => {
      stdoutFramer.flush();
      stderrFramer.flush();
      if (!exitObserved) this.handleProcessExit(record, child, stderr, code, signal);
      this.handleProcessClose(record, child, stderr);
    });
    child.on("error", () => {
      if (record.child !== child) return;
      if (record.state === "READY" || record.state === "DEGRADED") {
        record.failure = this.failure(
          "PROCESS_EXITED",
          `Managed component ${record.definition.id} reported a process error`,
          record.environment.secretValues
        );
      }
    });
  }

  private handleProcessExit(
    record: ComponentRecord,
    child: ChildProcessWithoutNullStreams,
    stderr: BoundedLineBuffer,
    code: number | null,
    signal: NodeJS.Signals | null
  ): void {
    if (record.child !== child) return;
    const previousState = record.state;
    const unexpected = !record.expectedStop && previousState !== "STOPPING" && previousState !== "STOPPED";
    const exit = this.createExitRecord(stderr, code, signal, previousState, unexpected);
    record.lastExit = exit;
    record.lastExitProcess = child;
    for (const listener of [...record.exitListeners]) listener(exit);

    if (!unexpected || previousState === "STARTING") return;
    record.residualProcess = child;
    record.state = "FAILED";
    record.failure = this.failure(
      "PROCESS_EXITED",
      `Managed component ${record.definition.id} exited unexpectedly`,
      record.environment.secretValues
    );
    const cleanup = this.cleanupUnexpectedExit(record, child);
    record.cleanupPromise = cleanup;
    void cleanup.then(
      () => {
        if (record.cleanupPromise === cleanup) record.cleanupPromise = undefined;
      },
      (error: unknown) => {
        record.failure = this.failure(
          "TERMINATION_FAILED",
          `Residual process-tree cleanup failed: ${safeErrorMessage(error, record.environment.secretValues)}`,
          record.environment.secretValues
        );
        if (record.cleanupPromise === cleanup) record.cleanupPromise = undefined;
      }
    );
  }

  private handleProcessClose(
    record: ComponentRecord,
    child: ChildProcessWithoutNullStreams,
    stderr: BoundedLineBuffer
  ): void {
    if (record.lastExitProcess === child && record.lastExit !== undefined) {
      const stderrLines = stderr.snapshot().lines.filter((line) => line !== "[TRUNCATED]");
      record.lastExit = Object.freeze({
        ...record.lastExit,
        stderrTail: Object.freeze(stderrLines.slice(-MAX_STDERR_TAIL_LINES))
      });
    }
    if (record.child === child) record.child = undefined;
  }

  private createExitRecord(
    stderr: BoundedLineBuffer,
    code: number | null,
    signal: NodeJS.Signals | null,
    previousState: LocalComponentState,
    unexpected: boolean
  ): InternalExitRecord {
    const stderrLines = stderr.snapshot().lines.filter((line) => line !== "[TRUNCATED]");
    return Object.freeze({
      code,
      signal,
      timestamp: this.timestamp(),
      previousState,
      unexpected,
      stderrTail: Object.freeze(stderrLines.slice(-MAX_STDERR_TAIL_LINES))
    });
  }

  private async cleanupUnexpectedExit(
    record: ComponentRecord,
    child: ChildProcessWithoutNullStreams
  ): Promise<void> {
    const timeoutMs = terminationTimeout(record.definition);
    await terminateChildTree(child, this.platform, "SIGTERM", timeoutMs);
    if (!(await waitForManagedTreeExit(record, child, this.platform, timeoutMs))) {
      await forceKillChildTree(child, this.platform, timeoutMs);
      if (!(await waitForManagedTreeExit(record, child, this.platform, timeoutMs))) {
        throw new LocalRuntimeError(
          "TERMINATION_FAILED",
          `Could not clean up residual process tree for ${record.definition.id}`
        );
      }
    }
    record.residualProcess = undefined;
    if (!record.expectedStop && this.reserveRestart(record)) {
      this.beginAutomaticRestart(record);
    }
  }

  private beginAutomaticRestart(record: ComponentRecord): void {
    const controller = new AbortController();
    record.operationAbort = controller;
    const delayMs = restartBackoff(record.definition.restartPolicy ?? DEFAULT_RESTART_POLICY, record.restartBudgetUsed);
    const promise = this.runStartSequence(record, controller.signal, delayMs);
    record.startPromise = promise;
    void promise.then(
      () => this.clearStartOperation(record, promise, controller),
      () => this.clearStartOperation(record, promise, controller)
    );
  }

  private clearStartOperation(
    record: ComponentRecord,
    promise: Promise<LocalComponentStatus>,
    controller: AbortController,
    unlink?: () => void
  ): void {
    unlink?.();
    if (record.startPromise === promise) record.startPromise = undefined;
    if (record.operationAbort === controller) record.operationAbort = undefined;
  }

  private reserveRestart(record: ComponentRecord): boolean {
    const policy = record.definition.restartPolicy ?? DEFAULT_RESTART_POLICY;
    if (policy.mode !== "ON_FAILURE" || record.expectedStop || this.stopAllPromise !== undefined) return false;
    if (record.restartBudgetUsed >= policy.maxRetries) return false;
    record.restartBudgetUsed += 1;
    record.restartCount += 1;
    return true;
  }

  private async waitForReadiness(
    record: ComponentRecord,
    child: ChildProcessWithoutNullStreams,
    signal: AbortSignal,
    timeoutMs: number
  ): Promise<{ readonly detail?: string; readonly handshake?: LocalComponentHandshake }> {
    if (timeoutMs <= 0) {
      throw new LocalRuntimeError("READINESS_TIMEOUT", `Readiness timed out for ${record.definition.id}`);
    }
    const controller = new AbortController();
    const unlink = linkAbortSignal(signal, controller);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const readinessPromise = this.runReadinessStrategy(record, child, controller.signal);
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new LocalRuntimeError("READINESS_TIMEOUT", `Readiness timed out for ${record.definition.id}`));
        controller.abort();
      }, timeoutMs);
    });
    try {
      return await Promise.race([readinessPromise, timeoutPromise]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      unlink?.();
      controller.abort();
    }
  }

  private async runReadinessStrategy(
    record: ComponentRecord,
    child: ChildProcessWithoutNullStreams,
    signal: AbortSignal
  ): Promise<{ readonly detail?: string; readonly handshake?: LocalComponentHandshake }> {
    const strategy = record.definition.readiness;
    switch (strategy.kind) {
      case "STABLE_PROCESS":
        await waitForProcessStability(record, child, strategy.stableMs, signal);
        return {};
      case "STDOUT_LINE":
        return this.waitForStdoutDecision(record, child, signal, (line) => strategy.evaluate(line));
      case "STDOUT_JSON":
        return this.waitForStdoutDecision(record, child, signal, (line) => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(line) as unknown;
          } catch {
            return false;
          }
          try {
            return strategy.evaluate(parsed);
          } catch {
            return false;
          }
        });
      case "HTTP_LOOPBACK":
        return this.pollHttpReadiness(record, child, signal);
      case "CUSTOM_LOCAL":
        return this.pollCustomReadiness(record, child, signal);
    }
  }

  private waitForStdoutDecision(
    record: ComponentRecord,
    child: ChildProcessWithoutNullStreams,
    signal: AbortSignal,
    evaluate: (line: string) => LocalReadinessDecision
  ): Promise<{ readonly detail?: string; readonly handshake?: LocalComponentHandshake }> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => {
        record.stdoutListeners.delete(onLine);
        record.exitListeners.delete(onExit);
        signal.removeEventListener("abort", onAbort);
      };
      const finish = (decision: LocalReadinessDecision): void => {
        const normalized = normalizeReadinessDecision(decision);
        if (!normalized.ready || settled) return;
        settled = true;
        cleanup();
        resolve(sanitizeReadyResult(normalized, record.environment.secretValues));
      };
      const onLine = (line: string): void => {
        let decision: LocalReadinessDecision;
        try {
          decision = evaluate(line);
        } catch {
          // A trusted evaluator may treat one malformed/unexpected line as not ready.
          return;
        }
        try {
          finish(decision);
        } catch (error) {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error instanceof LocalRuntimeError
            ? error
            : new LocalRuntimeError("READINESS_FAILED", "Readiness callback returned an invalid decision"));
        }
      };
      const onExit = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new LocalRuntimeError("PROCESS_EXITED", `Component ${record.definition.id} exited before readiness`));
      };
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new LocalRuntimeError("START_CANCELLED", `Start cancelled for ${record.definition.id}`));
      };
      record.stdoutListeners.add(onLine);
      record.exitListeners.add(onExit);
      signal.addEventListener("abort", onAbort, { once: true });
      if (child.exitCode !== null || child.signalCode !== null) onExit();
      else if (signal.aborted) onAbort();
    });
  }

  private async pollHttpReadiness(
    record: ComponentRecord,
    child: ChildProcessWithoutNullStreams,
    signal: AbortSignal
  ): Promise<{ readonly detail?: string; readonly handshake?: LocalComponentHandshake }> {
    const strategy = record.definition.readiness;
    if (strategy.kind !== "HTTP_LOOPBACK") throw new LocalRuntimeError("READINESS_FAILED", "Invalid HTTP readiness strategy");
    const url = parseLoopbackUrl(strategy.url);
    const intervalMs = strategy.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    for (;;) {
      ensureProcessAlive(record, child);
      throwIfAborted(signal, record.definition.id);
      try {
        const response = await this.fetchImpl(url, { method: "GET", redirect: "error", signal });
        try {
          const decision = strategy.evaluate === undefined
            ? response.ok
            : await awaitWithAbort(
                Promise.resolve().then(() => strategy.evaluate?.(response) ?? false),
                signal,
                record.definition.id
              );
          const normalized = normalizeReadinessDecision(decision);
          if (normalized.ready) {
            return sanitizeReadyResult(normalized, record.environment.secretValues);
          }
        } finally {
          disposeResponseBody(response);
        }
      } catch (error) {
        if (signal.aborted) throw new LocalRuntimeError("START_CANCELLED", `Start cancelled for ${record.definition.id}`);
        if (error instanceof LocalRuntimeError) throw error;
      }
      await abortableDelay(intervalMs, signal, record.definition.id);
    }
  }

  private async pollCustomReadiness(
    record: ComponentRecord,
    child: ChildProcessWithoutNullStreams,
    signal: AbortSignal
  ): Promise<{ readonly detail?: string; readonly handshake?: LocalComponentHandshake }> {
    const strategy = record.definition.readiness;
    if (strategy.kind !== "CUSTOM_LOCAL") throw new LocalRuntimeError("READINESS_FAILED", "Invalid custom readiness strategy");
    const intervalMs = strategy.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    for (;;) {
      ensureProcessAlive(record, child);
      throwIfAborted(signal, record.definition.id);
      const context: LocalReadinessContext = Object.freeze({
        componentId: record.definition.id,
        pid: child.pid as number,
        signal
      });
      try {
        const decision = await awaitWithAbort(
          Promise.resolve().then(() => strategy.probe(context)),
          signal,
          record.definition.id
        );
        const normalized = normalizeReadinessDecision(decision);
        if (normalized.ready) {
          return sanitizeReadyResult(normalized, record.environment.secretValues);
        }
      } catch (error) {
        if (signal.aborted) throw new LocalRuntimeError("START_CANCELLED", `Start cancelled for ${record.definition.id}`);
        if (error instanceof LocalRuntimeError) throw error;
      }
      await abortableDelay(intervalMs, signal, record.definition.id);
    }
  }

  private async cleanupFailedAttempt(record: ComponentRecord, child: ChildProcessWithoutNullStreams): Promise<void> {
    if (record.child !== child && !isOwnedProcessTreeAlive(child, this.platform)) return;
    record.residualProcess = child;
    const previousExpectedStop = record.expectedStop;
    record.expectedStop = true;
    const timeoutMs = terminationTimeout(record.definition);
    let cleaned = false;
    try {
      await terminateChildTree(child, this.platform, "SIGTERM", timeoutMs);
      if (!(await waitForManagedTreeExit(record, child, this.platform, timeoutMs))) {
        await forceKillChildTree(child, this.platform, timeoutMs);
        if (!(await waitForManagedTreeExit(record, child, this.platform, timeoutMs))) {
          record.state = "FAILED";
          record.failure = this.failure(
            "TERMINATION_FAILED",
            `Could not terminate failed startup for ${record.definition.id}`,
            record.environment.secretValues
          );
          throw new LocalRuntimeError(
            "TERMINATION_FAILED",
            `Could not terminate failed startup for ${record.definition.id}`
          );
        }
      }
      record.residualProcess = undefined;
      cleaned = true;
    } finally {
      if (cleaned) record.expectedStop = previousExpectedStop;
    }
  }

  private async runStop(record: ComponentRecord): Promise<LocalStopResult> {
    record.expectedStop = true;
    record.operationAbort?.abort();
    const child = record.child;
    if (child === undefined) {
      if (record.cleanupPromise !== undefined) {
        try {
          await record.cleanupPromise;
        } catch {
          // Failure is reflected in status; stop still checks for any surviving managed process below.
        }
      }
      if (record.startPromise !== undefined) {
        try {
          await record.startPromise;
        } catch {
          // Cancellation is expected when stopping a pending start or retry backoff.
        }
      }
      const survivingChild = record.child;
      if (survivingChild !== undefined && isOwnedProcessTreeAlive(survivingChild, this.platform)) {
        return this.runStop(record);
      }
      const residual = record.residualProcess;
      if (residual !== undefined && isOwnedProcessTreeAlive(residual, this.platform)) {
        record.state = "STOPPING";
        const timeoutMs = terminationTimeout(record.definition);
        await terminateChildTree(residual, this.platform, "SIGTERM", timeoutMs);
        if (await waitForManagedTreeExit(record, residual, this.platform, timeoutMs)) {
          record.residualProcess = undefined;
          record.state = "STOPPED";
          return Object.freeze({ componentId: record.definition.id, disposition: "TERMINATED" });
        }
        await forceKillChildTree(residual, this.platform, timeoutMs);
        if (!(await waitForManagedTreeExit(record, residual, this.platform, timeoutMs))) {
          record.state = "FAILED";
          record.failure = this.failure(
            "TERMINATION_FAILED",
            `Could not terminate residual managed process tree for ${record.definition.id}`,
            record.environment.secretValues
          );
          throw new LocalRuntimeError(
            "TERMINATION_FAILED",
            `Could not terminate residual managed process tree for ${record.definition.id}`
          );
        }
        record.residualProcess = undefined;
        record.state = "STOPPED";
        return Object.freeze({ componentId: record.definition.id, disposition: "FORCED" });
      }
      record.residualProcess = undefined;
      record.state = "STOPPED";
      return Object.freeze({ componentId: record.definition.id, disposition: "ALREADY_STOPPED" });
    }

    record.residualProcess = child;
    record.state = "STOPPING";
    let disposition: LocalStopResult["disposition"] = "GRACEFUL";
    void this.requestGracefulShutdown(record, child).catch(() => undefined);
    if (!(await waitForManagedTreeExit(record, child, this.platform, record.definition.shutdownTimeoutMs))) {
      disposition = "TERMINATED";
      const terminationTimeoutMs = terminationTimeout(record.definition);
      await terminateChildTree(child, this.platform, "SIGTERM", terminationTimeoutMs);
      if (!(await waitForManagedTreeExit(record, child, this.platform, terminationTimeoutMs))) {
        disposition = "FORCED";
        await forceKillChildTree(child, this.platform, terminationTimeoutMs);
        if (!(await waitForManagedTreeExit(record, child, this.platform, terminationTimeoutMs))) {
          record.state = "FAILED";
          record.failure = this.failure(
            "TERMINATION_FAILED",
            `Could not terminate managed component ${record.definition.id}`,
            record.environment.secretValues
          );
          throw new LocalRuntimeError("TERMINATION_FAILED", `Could not terminate managed component ${record.definition.id}`);
        }
      }
    }

    if (record.startPromise !== undefined) {
      try {
        await record.startPromise;
      } catch {
        // Expected if stop interrupted STARTING or retry backoff.
      }
    }
    record.residualProcess = undefined;
    record.state = "STOPPED";
    record.readyAt = undefined;
    record.readinessDetail = undefined;
    return Object.freeze({ componentId: record.definition.id, disposition });
  }

  private async requestGracefulShutdown(record: ComponentRecord, child: ChildProcessWithoutNullStreams): Promise<void> {
    const pid = child.pid;
    if (pid === undefined) return;
    try {
      if (record.definition.gracefulShutdown === undefined) {
        child.stdin.end();
        return;
      }
      const control: LocalShutdownControl = Object.freeze({
        componentId: record.definition.id,
        pid,
        writeStdin: (data: string) => writeToStdin(child, data),
        endStdin: () => child.stdin.end()
      });
      await record.definition.gracefulShutdown(control);
    } catch (error) {
      if (record.child === child) {
        record.failure = this.failure(
          "TERMINATION_FAILED",
          `Graceful shutdown hook failed: ${safeErrorMessage(error, record.environment.secretValues)}`,
          record.environment.secretValues
        );
      }
    }
  }

  private snapshot(record: ComponentRecord): LocalComponentStatus {
    const readiness: LocalReadinessSnapshot = Object.freeze({
      kind: record.definition.readiness.kind,
      ready: record.state === "READY" || record.state === "DEGRADED",
      ...(record.readinessDetail === undefined ? {} : { detail: record.readinessDetail })
    });
    const childPid = record.child?.pid;
    const includePid = childPid !== undefined
      && record.child !== undefined
      && isChildAlive(record.child);
    const lastExit = record.lastExit === undefined ? undefined : Object.freeze({
      ...record.lastExit,
      stderrTail: Object.freeze([...record.lastExit.stderrTail])
    });
    const handshake = record.handshake === undefined ? undefined : cloneHandshake(record.handshake);
    const status: LocalComponentStatus = Object.freeze({
      componentId: record.definition.id,
      state: record.state,
      ...(includePid ? { pid: childPid } : {}),
      ...(record.startedAt === undefined ? {} : { startedAt: record.startedAt }),
      ...(record.readyAt === undefined ? {} : { readyAt: record.readyAt }),
      readiness,
      ...(lastExit === undefined ? {} : { lastExit }),
      restartCount: record.restartCount,
      ...(handshake === undefined ? {} : { handshake }),
      ...(record.failure === undefined ? {} : { failure: Object.freeze({ ...record.failure }) }),
      stdout: record.stdout.snapshot(),
      stderr: record.stderr.snapshot()
    });
    return status;
  }

  private requireRecord(componentId: string): ComponentRecord {
    const record = this.components.get(componentId);
    if (record === undefined) throw new LocalRuntimeError("UNKNOWN_COMPONENT", `Unknown local component ${componentId}`);
    return record;
  }

  private failure(code: string, message: string, secretValues: readonly string[] = []): LocalFailureSnapshot {
    return Object.freeze({
      code,
      message: sanitizeDiagnosticText(redactKnownSecrets(message, secretValues)),
      timestamp: this.timestamp()
    });
  }

  private timestamp(): string {
    try {
      const observed = this.now();
      if (!(observed instanceof Date) || !Number.isFinite(observed.getTime())) {
        throw new TypeError("Invalid diagnostic clock value");
      }
      return observed.toISOString();
    } catch {
      return new Date().toISOString();
    }
  }
}

interface EffectiveOutputLimits {
  readonly maxLines: number;
  readonly maxBytes: number;
  readonly maxLineBytes: number;
}

function outputLimitsFor(definition: LocalComponentDefinition): EffectiveOutputLimits {
  return outputLimitsForValues(definition.output);
}

function outputLimitsForValues(output: LocalComponentDefinition["output"]): EffectiveOutputLimits {
  const maxLines = output?.maxLines ?? DEFAULT_OUTPUT_MAX_LINES;
  const maxBytes = output?.maxBytes ?? DEFAULT_OUTPUT_MAX_BYTES;
  const configuredLineBytes = output?.maxLineBytes ?? DEFAULT_OUTPUT_MAX_LINE_BYTES;
  return Object.freeze({
    maxLines,
    maxBytes,
    maxLineBytes: Math.min(configuredLineBytes, maxBytes)
  });
}

function remainingStartupTimeout(totalMs: number, startedAt: number): number {
  const elapsedMs = performance.now() - startedAt;
  return Math.max(0, Math.ceil(totalMs - elapsedMs));
}

function isRetryableStartFailure(error: LocalRuntimeError): boolean {
  return error.code === "SPAWN_FAILED"
    || error.code === "READINESS_TIMEOUT"
    || error.code === "READINESS_FAILED"
    || error.code === "PROCESS_EXITED";
}

function inspectDefinition(definition: LocalComponentDefinition): LocalComponentDefinition {
  const top = inspectKnownDataObject(definition, "Component definition", new Set([
    "id",
    "executable",
    "args",
    "cwd",
    "environment",
    "startupTimeoutMs",
    "shutdownTimeoutMs",
    "terminationTimeoutMs",
    "readiness",
    "restartPolicy",
    "expectedHandshake",
    "output",
    "gracefulShutdown"
  ]));

  const args = top.args === undefined
    ? undefined
    : inspectDefinitionArguments(top.args);
  const readiness = top.readiness === undefined
    ? undefined
    : inspectKnownDataObject(top.readiness, "readiness", new Set([
        "kind",
        "stableMs",
        "evaluate",
        "url",
        "intervalMs",
        "probe"
      ]));
  const restartPolicy = top.restartPolicy === undefined
    ? undefined
    : inspectKnownDataObject(top.restartPolicy, "restartPolicy", new Set([
        "mode",
        "maxRetries",
        "backoffMs",
        "maxBackoffMs"
      ]));
  const expectedHandshake = top.expectedHandshake === undefined
    ? undefined
    : inspectKnownDataObject(top.expectedHandshake, "expectedHandshake", new Set([
        "componentVersion",
        "protocolVersion"
      ]));
  const output = top.output === undefined
    ? undefined
    : inspectKnownDataObject(top.output, "output", new Set([
        "maxLines",
        "maxBytes",
        "maxLineBytes"
      ]));

  return Object.freeze({
    ...(top.id === undefined ? {} : { id: top.id }),
    ...(top.executable === undefined ? {} : { executable: top.executable }),
    ...(args === undefined ? {} : { args }),
    ...(top.cwd === undefined ? {} : { cwd: top.cwd }),
    ...(top.environment === undefined ? {} : { environment: top.environment }),
    ...(top.startupTimeoutMs === undefined ? {} : { startupTimeoutMs: top.startupTimeoutMs }),
    ...(top.shutdownTimeoutMs === undefined ? {} : { shutdownTimeoutMs: top.shutdownTimeoutMs }),
    ...(top.terminationTimeoutMs === undefined ? {} : { terminationTimeoutMs: top.terminationTimeoutMs }),
    ...(readiness === undefined ? {} : { readiness }),
    ...(restartPolicy === undefined ? {} : { restartPolicy }),
    ...(expectedHandshake === undefined ? {} : { expectedHandshake }),
    ...(output === undefined ? {} : { output }),
    ...(top.gracefulShutdown === undefined ? {} : { gracefulShutdown: top.gracefulShutdown })
  }) as unknown as LocalComponentDefinition;
}

function inspectKnownDataObject(
  value: unknown,
  label: string,
  allowedKeys: ReadonlySet<string>
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(`${label} must be an object`);
  }

  let descriptors: Readonly<Record<string, PropertyDescriptor>>;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    invalid(`${label} could not be inspected`);
  }

  const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!allowedKeys.has(key)) {
      if (descriptor.enumerable === true) invalid(`${label} contains unsupported field ${key}`);
      continue;
    }
    if (!("value" in descriptor)) invalid(`${label} field ${key} may not be an accessor`);
    copy[key] = descriptor.value;
  }
  return Object.freeze(copy);
}

function inspectDefinitionArguments(value: unknown): readonly string[] {
  if (!Array.isArray(value)) invalid("args must be an array");

  let descriptors: Readonly<Record<string, PropertyDescriptor>>;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    invalid("args could not be inspected");
  }

  const rawLength = descriptors.length?.value as unknown;
  if (typeof rawLength !== "number" || !Number.isSafeInteger(rawLength) || rawLength < 0) {
    invalid("args has an invalid length");
  }

  const indexed: { readonly index: number; readonly value: string }[] = [];
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (key === "length" || descriptor.enumerable !== true) continue;
    if (!/^(?:0|[1-9][0-9]*)$/u.test(key)) {
      invalid("args may not contain extra enumerable properties");
    }
    if (!("value" in descriptor)) invalid("args may not contain accessors");
    const index = Number(key);
    if (!Number.isSafeInteger(index) || index < 0 || index >= rawLength) {
      invalid("args contains an invalid array index");
    }
    if (typeof descriptor.value !== "string") invalid("Invalid argument");
    validateCommandPart(descriptor.value, "argument");
    indexed.push({ index, value: descriptor.value });
  }

  if (indexed.length !== rawLength) invalid("args must be a dense data-only array");
  indexed.sort((left, right) => left.index - right.index);
  for (let index = 0; index < indexed.length; index += 1) {
    if (indexed[index]?.index !== index) invalid("args must be a dense data-only array");
  }
  return Object.freeze(indexed.map((entry) => entry.value));
}

function freezeDefinition(definition: LocalComponentDefinition): LocalComponentDefinition {
  const readiness = Object.freeze({ ...definition.readiness }) as LocalComponentDefinition["readiness"];
  const restartPolicy = definition.restartPolicy === undefined
    ? undefined
    : Object.freeze({ ...definition.restartPolicy }) as LocalRestartPolicy;
  const expectedHandshake = definition.expectedHandshake === undefined
    ? undefined
    : Object.freeze({ ...definition.expectedHandshake });
  const output = definition.output === undefined
    ? undefined
    : Object.freeze({ ...definition.output });

  return Object.freeze({
    id: definition.id,
    executable: definition.executable,
    ...(definition.args === undefined ? {} : { args: Object.freeze([...definition.args]) }),
    ...(definition.cwd === undefined ? {} : { cwd: definition.cwd }),
    startupTimeoutMs: definition.startupTimeoutMs,
    shutdownTimeoutMs: definition.shutdownTimeoutMs,
    ...(definition.terminationTimeoutMs === undefined
      ? {}
      : { terminationTimeoutMs: definition.terminationTimeoutMs }),
    readiness,
    ...(restartPolicy === undefined ? {} : { restartPolicy }),
    ...(expectedHandshake === undefined ? {} : { expectedHandshake }),
    ...(output === undefined ? {} : { output }),
    ...(definition.gracefulShutdown === undefined
      ? {}
      : { gracefulShutdown: definition.gracefulShutdown })
  });
}

function isStdoutReadiness(
  readiness: LocalComponentDefinition["readiness"]
): boolean {
  return readiness.kind === "STDOUT_LINE" || readiness.kind === "STDOUT_JSON";
}

function validateDefinition(definition: LocalComponentDefinition): void {
  if (typeof definition !== "object" || definition === null || Array.isArray(definition)) {
    invalid("Component definition must be an object");
  }
  if (typeof definition.id !== "string" || !COMPONENT_ID.test(definition.id)) {
    invalid("Component id must be stable and contain only letters, numbers, dot, underscore, or dash");
  }
  validateCommandPart(definition.executable, "executable");
  if (definition.args !== undefined && !Array.isArray(definition.args)) invalid("args must be an array");
  for (const argument of definition.args ?? []) validateCommandPart(argument, "argument");
  if (definition.cwd !== undefined) {
    if (typeof definition.cwd !== "string" || definition.cwd.length === 0 || definition.cwd.includes("\0")) {
      invalid("Working directory must be a non-empty path without NUL bytes");
    }
  }
  positiveTimer(definition.startupTimeoutMs, "startupTimeoutMs");
  positiveTimer(definition.shutdownTimeoutMs, "shutdownTimeoutMs");
  if (definition.terminationTimeoutMs !== undefined) positiveTimer(definition.terminationTimeoutMs, "terminationTimeoutMs");
  validateReadiness(definition);
  validateRestartPolicy(definition.restartPolicy ?? DEFAULT_RESTART_POLICY);
  validateExpectedHandshakeDefinition(definition.expectedHandshake);
  validateOutputLimits(definition.output);
  if (definition.gracefulShutdown !== undefined && typeof definition.gracefulShutdown !== "function") {
    invalid("gracefulShutdown must be a function");
  }
}

function validateReadiness(definition: LocalComponentDefinition): void {
  const readiness = definition.readiness;
  if (typeof readiness !== "object" || readiness === null || Array.isArray(readiness)) {
    invalid("readiness must be an object");
  }
  switch (readiness.kind) {
    case "STABLE_PROCESS":
      validateOnlyFields(readiness, "readiness", new Set(["kind", "stableMs"]));
      positiveTimer(readiness.stableMs, "readiness.stableMs");
      if (readiness.stableMs > definition.startupTimeoutMs) {
        invalid("readiness.stableMs may not exceed startupTimeoutMs");
      }
      break;
    case "HTTP_LOOPBACK":
      validateOnlyFields(readiness, "readiness", new Set(["kind", "url", "intervalMs", "evaluate"]));
      parseLoopbackUrl(readiness.url);
      if (readiness.intervalMs !== undefined) positiveTimer(readiness.intervalMs, "readiness.intervalMs");
      if (readiness.evaluate !== undefined && typeof readiness.evaluate !== "function") {
        invalid("HTTP readiness evaluate must be a function");
      }
      break;
    case "CUSTOM_LOCAL":
      validateOnlyFields(readiness, "readiness", new Set(["kind", "intervalMs", "probe"]));
      if (readiness.intervalMs !== undefined) positiveTimer(readiness.intervalMs, "readiness.intervalMs");
      if (typeof readiness.probe !== "function") invalid("Custom readiness probe must be a function");
      break;
    case "STDOUT_LINE":
    case "STDOUT_JSON":
      validateOnlyFields(readiness, "readiness", new Set(["kind", "evaluate"]));
      if (typeof readiness.evaluate !== "function") invalid("Stdout readiness evaluate must be a function");
      break;
    default:
      invalid("Unsupported readiness strategy");
  }
}

function validateRestartPolicy(policy: LocalRestartPolicy): void {
  if (typeof policy !== "object" || policy === null || Array.isArray(policy)) {
    invalid("restartPolicy must be an object");
  }
  if (policy.mode === "NEVER") {
    validateOnlyFields(policy, "restartPolicy", new Set(["mode"]));
    return;
  }
  if (policy.mode !== "ON_FAILURE") invalid("Unsupported restart policy");
  validateOnlyFields(policy, "restartPolicy", new Set(["mode", "maxRetries", "backoffMs", "maxBackoffMs"]));
  if (!Number.isSafeInteger(policy.maxRetries)
      || policy.maxRetries < 0
      || policy.maxRetries > MAX_RESTART_RETRIES) {
    invalid(`restartPolicy.maxRetries must be a nonnegative safe integer no greater than ${String(MAX_RESTART_RETRIES)}`);
  }
  if (policy.backoffMs !== undefined) nonnegativeTimer(policy.backoffMs, "restartPolicy.backoffMs");
  if (policy.maxBackoffMs !== undefined) nonnegativeTimer(policy.maxBackoffMs, "restartPolicy.maxBackoffMs");
  if (policy.backoffMs !== undefined && policy.maxBackoffMs !== undefined && policy.maxBackoffMs < policy.backoffMs) {
    invalid("restartPolicy.maxBackoffMs must be at least restartPolicy.backoffMs");
  }
}

function validateExpectedHandshakeDefinition(expected: LocalExpectedHandshake | undefined): void {
  if (expected === undefined) return;
  if (typeof expected !== "object" || expected === null || Array.isArray(expected)) {
    invalid("expectedHandshake must be an object");
  }
  if (expected.componentVersion !== undefined) {
    if (typeof expected.componentVersion !== "string"
        || expected.componentVersion.length === 0
        || expected.componentVersion.length > DIAGNOSTIC_SANITIZATION_LIMITS.maxStringLength) {
      invalid("expectedHandshake.componentVersion must be a non-empty bounded string");
    }
  }
  if (expected.protocolVersion !== undefined) {
    validateVersionValue(expected.protocolVersion, "expectedHandshake.protocolVersion", invalid);
  }
}

function validateOutputLimits(output: LocalComponentDefinition["output"]): void {
  if (output === undefined) return;
  if (typeof output !== "object" || output === null || Array.isArray(output)) {
    invalid("output must be an object");
  }
  if (output.maxLines !== undefined) {
    positiveInteger(output.maxLines, "output.maxLines");
    if (output.maxLines > MAX_OUTPUT_LINES) invalid(`output.maxLines may not exceed ${String(MAX_OUTPUT_LINES)}`);
  }
  if (output.maxBytes !== undefined) {
    positiveInteger(output.maxBytes, "output.maxBytes");
    if (output.maxBytes > MAX_OUTPUT_BYTES) invalid(`output.maxBytes may not exceed ${String(MAX_OUTPUT_BYTES)}`);
  }
  if (output.maxLineBytes !== undefined) {
    positiveInteger(output.maxLineBytes, "output.maxLineBytes");
    if (output.maxLineBytes > MAX_OUTPUT_LINE_BYTES) {
      invalid(`output.maxLineBytes may not exceed ${String(MAX_OUTPUT_LINE_BYTES)}`);
    }
  }
  if (output.maxLineBytes !== undefined
      && output.maxBytes !== undefined
      && output.maxLineBytes > output.maxBytes) {
    invalid("output.maxLineBytes may not exceed output.maxBytes");
  }
}

function validateOnlyFields(
  value: object,
  label: string,
  allowedKeys: ReadonlySet<string>
): void {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) invalid(`${label} field ${key} is not valid for the selected mode`);
  }
}

function validateCommandPart(value: string, label: string): void {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) invalid(`Invalid ${label}`);
}

function positiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) invalid(`${label} must be a positive safe integer`);
}

function positiveTimer(value: number, label: string): void {
  positiveInteger(value, label);
  if (value > MAX_TIMER_MS) invalid(`${label} exceeds the maximum supported timer delay`);
}

function nonnegativeTimer(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_TIMER_MS) {
    invalid(`${label} must be a nonnegative timer delay no greater than ${String(MAX_TIMER_MS)}`);
  }
}

function invalid(message: string): never {
  throw new LocalRuntimeError("INVALID_DEFINITION", message);
}

function parseLoopbackUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    invalid("HTTP readiness URL must be valid");
  }
  if (url.protocol !== "http:") invalid("HTTP readiness URL must use http://");
  const host = url.hostname.toLowerCase();
  if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1" && host !== "[::1]") {
    invalid("HTTP readiness URL must target loopback only");
  }
  if (url.username.length > 0 || url.password.length > 0) invalid("HTTP readiness URL must not contain credentials");
  if (host === "localhost") url.hostname = "127.0.0.1";
  return url;
}

function normalizeReadinessDecision(decision: LocalReadinessDecision): {
  readonly ready: boolean;
  readonly detail?: string;
  readonly handshake?: LocalComponentHandshake;
} {
  if (typeof decision === "boolean") return { ready: decision };
  if (typeof decision !== "object" || decision === null || Array.isArray(decision)
      || typeof decision.ready !== "boolean") {
    throw new LocalRuntimeError("READINESS_FAILED", "Readiness callback returned an invalid decision");
  }
  if (decision.detail !== undefined && typeof decision.detail !== "string") {
    throw new LocalRuntimeError("READINESS_FAILED", "Readiness detail must be a string");
  }
  return decision;
}

function sanitizeReadyResult(
  decision: {
    readonly ready: boolean;
    readonly detail?: string;
    readonly handshake?: LocalComponentHandshake;
  },
  secretValues: readonly string[]
): { readonly detail?: string; readonly handshake?: LocalComponentHandshake } {
  return {
    ...(decision.detail === undefined
      ? {}
      : { detail: sanitizeStatusText(decision.detail, secretValues) }),
    ...(decision.handshake === undefined ? {} : { handshake: decision.handshake })
  };
}

function sanitizeHandshake(
  handshake: LocalComponentHandshake,
  secretValues: readonly string[]
): LocalComponentHandshake {
  const capabilities = handshake.capabilities
    ?.slice(0, MAX_CAPABILITIES)
    .map((value) => sanitizeDiagnosticText(redactKnownSecrets(value, secretValues)));
  const protocolVersion = typeof handshake.protocolVersion === "string"
    ? sanitizeDiagnosticText(redactKnownSecrets(handshake.protocolVersion, secretValues))
    : handshake.protocolVersion;
  return Object.freeze({
    ...(handshake.componentVersion === undefined ? {} : { componentVersion: sanitizeDiagnosticText(redactKnownSecrets(handshake.componentVersion, secretValues)) }),
    ...(protocolVersion === undefined ? {} : { protocolVersion }),
    ...(handshake.modelVersionOrHash === undefined ? {} : { modelVersionOrHash: sanitizeDiagnosticText(redactKnownSecrets(handshake.modelVersionOrHash, secretValues)) }),
    ...(capabilities === undefined ? {} : { capabilities: Object.freeze(capabilities) }),
    ...(handshake.metadata === undefined ? {} : { metadata: sanitizeHandshakeMetadata(handshake.metadata, secretValues) })
  });
}

function cloneHandshake(handshake: LocalComponentHandshake): LocalComponentHandshake {
  return Object.freeze({
    ...(handshake.componentVersion === undefined ? {} : { componentVersion: handshake.componentVersion }),
    ...(handshake.protocolVersion === undefined ? {} : { protocolVersion: handshake.protocolVersion }),
    ...(handshake.modelVersionOrHash === undefined ? {} : { modelVersionOrHash: handshake.modelVersionOrHash }),
    ...(handshake.capabilities === undefined ? {} : { capabilities: Object.freeze([...handshake.capabilities]) }),
    ...(handshake.metadata === undefined ? {} : { metadata: Object.freeze({ ...handshake.metadata }) })
  });
}

function validateVersionValue(
  value: unknown,
  label: string,
  fail: (message: string) => never
): void {
  if (typeof value === "string") {
    if (value.length === 0 || value.length > DIAGNOSTIC_SANITIZATION_LIMITS.maxStringLength) {
      fail(`${label} must be a non-empty bounded string`);
    }
    return;
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return;
  fail(`${label} must be a nonnegative safe integer or non-empty string`);
}

function validateReportedHandshake(handshake: LocalComponentHandshake, componentId: string): void {
  const fail = (message: string): never => {
    throw new LocalRuntimeError(
      "READINESS_FAILED",
      `Invalid version handshake from ${componentId}: ${message}`
    );
  };
  if (typeof handshake !== "object" || handshake === null || Array.isArray(handshake)) {
    fail("handshake must be an object");
  }
  if (handshake.componentVersion !== undefined) {
    if (typeof handshake.componentVersion !== "string"
        || handshake.componentVersion.length === 0
        || handshake.componentVersion.length > DIAGNOSTIC_SANITIZATION_LIMITS.maxStringLength) {
      fail("componentVersion must be a non-empty bounded string");
    }
  }
  if (handshake.protocolVersion !== undefined) {
    validateVersionValue(handshake.protocolVersion, "protocolVersion", fail);
  }
  if (handshake.modelVersionOrHash !== undefined) {
    if (typeof handshake.modelVersionOrHash !== "string"
        || handshake.modelVersionOrHash.length === 0
        || handshake.modelVersionOrHash.length > DIAGNOSTIC_SANITIZATION_LIMITS.maxStringLength) {
      fail("modelVersionOrHash must be a non-empty bounded string");
    }
  }
  if (handshake.capabilities !== undefined) {
    if (!Array.isArray(handshake.capabilities) || handshake.capabilities.length > MAX_CAPABILITIES) {
      fail(`capabilities must contain at most ${String(MAX_CAPABILITIES)} items`);
    }
    for (const capability of handshake.capabilities) {
      if (typeof capability !== "string"
          || capability.length === 0
          || capability.length > DIAGNOSTIC_SANITIZATION_LIMITS.maxStringLength) {
        fail("capabilities must contain only non-empty bounded strings");
      }
    }
  }
  if (handshake.metadata !== undefined
      && (typeof handshake.metadata !== "object" || handshake.metadata === null || Array.isArray(handshake.metadata))) {
    fail("metadata must be an object");
  }
}

function validateExpectedHandshake(
  expected: LocalExpectedHandshake | undefined,
  actual: LocalComponentHandshake | undefined,
  componentId: string
): void {
  if (expected === undefined) return;
  if (actual === undefined) throw new LocalRuntimeError("HANDSHAKE_MISMATCH", `Component ${componentId} did not report its expected version handshake`);
  if (expected.componentVersion !== undefined && actual.componentVersion !== expected.componentVersion) {
    throw new LocalRuntimeError("HANDSHAKE_MISMATCH", `Component ${componentId} reported an unexpected component version`);
  }
  if (expected.protocolVersion !== undefined && actual.protocolVersion !== expected.protocolVersion) {
    throw new LocalRuntimeError("HANDSHAKE_MISMATCH", `Component ${componentId} reported an unexpected protocol version`);
  }
}

function restartBackoff(policy: LocalRestartPolicy, retryNumber: number): number {
  if (policy.mode === "NEVER") return 0;
  const base = policy.backoffMs ?? 100;
  const maximum = policy.maxBackoffMs ?? Math.max(base, 5_000);
  if (base === 0) return 0;
  const exponent = Math.max(0, retryNumber - 1);
  return Math.min(maximum, base * (2 ** exponent));
}

function ensureProcessAlive(record: ComponentRecord, child: ChildProcessWithoutNullStreams): void {
  if (record.child !== child || child.exitCode !== null || child.signalCode !== null) {
    throw new LocalRuntimeError("PROCESS_EXITED", `Component ${record.definition.id} exited before readiness`);
  }
}

function waitForProcessStability(
  record: ComponentRecord,
  child: ChildProcessWithoutNullStreams,
  stableMs: number,
  signal: AbortSignal
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      record.exitListeners.delete(onExit);
      signal.removeEventListener("abort", onAbort);
      clearTimeout(timer);
    };
    const onExit = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new LocalRuntimeError("PROCESS_EXITED", `Component ${record.definition.id} exited before readiness`));
    };
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new LocalRuntimeError("START_CANCELLED", `Start cancelled for ${record.definition.id}`));
    };
    const timer = setTimeout(() => {
      if (settled) return;
      if (record.child !== child || child.exitCode !== null || child.signalCode !== null) {
        settled = true;
        cleanup();
        reject(new LocalRuntimeError("PROCESS_EXITED", `Component ${record.definition.id} exited before readiness`));
        return;
      }
      settled = true;
      cleanup();
      resolve();
    }, stableMs);
    record.exitListeners.add(onExit);
    signal.addEventListener("abort", onAbort, { once: true });
    if (child.exitCode !== null || child.signalCode !== null) onExit();
    else if (signal.aborted) onAbort();
  });
}

function waitForSpawn(
  child: ChildProcessWithoutNullStreams,
  signal: AbortSignal,
  componentId: string,
  timeoutMs: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      child.off("spawn", onSpawn);
      child.off("error", onError);
      signal.removeEventListener("abort", onAbort);
      clearTimeout(timer);
    };
    const onSpawn = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const onError = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new LocalRuntimeError("SPAWN_FAILED", `Could not spawn component ${componentId}`));
    };
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new LocalRuntimeError("START_CANCELLED", `Start cancelled for ${componentId}`));
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new LocalRuntimeError("READINESS_TIMEOUT", `Startup timed out for ${componentId}`));
    }, timeoutMs);
    child.once("spawn", onSpawn);
    child.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

async function waitForManagedTreeExit(
  record: ComponentRecord,
  child: ChildProcessWithoutNullStreams,
  platform: NodeJS.Platform,
  timeoutMs: number
): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const childClosed = record.child !== child;
    if (childClosed && !isOwnedProcessTreeAlive(child, platform)) return true;
    const remaining = deadline - performance.now();
    if (remaining <= 0) return childClosed && !isOwnedProcessTreeAlive(child, platform);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, Math.min(PROCESS_TREE_POLL_INTERVAL_MS, remaining));
    });
  }
}

function isChildAlive(child: ChildProcessWithoutNullStreams): boolean {
  return child.pid !== undefined && child.exitCode === null && child.signalCode === null;
}

async function terminateChildTree(
  child: ChildProcessWithoutNullStreams,
  platform: NodeJS.Platform,
  signal: NodeJS.Signals,
  commandTimeoutMs: number
): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return;
  if (platform === "win32") {
    await runTaskkill(pid, false, commandTimeoutMs);
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    if (isChildAlive(child)) child.kill(signal);
  }
}

async function forceKillChildTree(
  child: ChildProcessWithoutNullStreams,
  platform: NodeJS.Platform,
  commandTimeoutMs: number
): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return;
  if (platform === "win32") {
    const treeKilled = await runTaskkill(pid, true, commandTimeoutMs);
    if (!treeKilled && isChildAlive(child)) child.kill("SIGKILL");
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

function runTaskkill(
  pid: number,
  force: boolean,
  timeoutMs: number
): Promise<boolean> {
  return new Promise((resolve) => {
    const systemRoot = process.env["SystemRoot"] ?? process.env["SYSTEMROOT"];
    if (systemRoot === undefined || systemRoot.length === 0 || systemRoot.includes("\0")) {
      resolve(false);
      return;
    }
    const executable = join(systemRoot, "System32", "taskkill.exe");
    let task: ReturnType<typeof spawn>;
    try {
      task = spawn(executable, [
        "/pid",
        String(pid),
        "/t",
        ...(force ? ["/f"] : [])
      ], {
        shell: false,
        windowsHide: true,
        stdio: "ignore"
      });
    } catch {
      resolve(false);
      return;
    }

    let settled = false;
    const finish = (success: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      task.removeAllListeners("error");
      task.removeAllListeners("close");
      resolve(success);
    };
    const timer = setTimeout(() => {
      try {
        task.kill();
      } catch {
        // The task may already have exited between the timeout and the kill attempt.
      }
      finish(false);
    }, timeoutMs);
    task.once("error", () => finish(false));
    task.once("close", (code) => finish(code === 0));
  });
}

function isOwnedProcessTreeAlive(
  child: ChildProcessWithoutNullStreams,
  platform: NodeJS.Platform
): boolean {
  const pid = child.pid;
  if (pid === undefined) return false;
  if (platform === "win32") return isChildAlive(child);
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return !isProcessMissingError(error);
  }
}

function isProcessMissingError(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ESRCH";
}

function terminationTimeout(definition: LocalComponentDefinition): number {
  return definition.terminationTimeoutMs ?? Math.min(definition.shutdownTimeoutMs, 1_000);
}

function writeToStdin(child: ChildProcessWithoutNullStreams, data: string): Promise<void> {
  return new Promise((resolve, reject) => {
    child.stdin.write(data, "utf8", (error) => {
      if (error === null || error === undefined) resolve();
      else reject(new LocalRuntimeError("TERMINATION_FAILED", "Could not write graceful shutdown request"));
    });
  });
}

function abortableDelay(ms: number, signal: AbortSignal, componentId: string): Promise<void> {
  if (signal.aborted) return Promise.reject(new LocalRuntimeError("START_CANCELLED", `Start cancelled for ${componentId}`));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(new LocalRuntimeError("START_CANCELLED", `Start cancelled for ${componentId}`));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function awaitWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  componentId: string
): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new LocalRuntimeError("START_CANCELLED", `Start cancelled for ${componentId}`));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new LocalRuntimeError("START_CANCELLED", `Start cancelled for ${componentId}`));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error instanceof Error ? error : new Error("Local readiness callback failed"));
      }
    );
  });
}

function disposeResponseBody(response: Response): void {
  try {
    const cancellation = response.body?.cancel();
    if (cancellation !== undefined) void cancellation.catch(() => undefined);
  } catch {
    // Readiness body disposal is best-effort and must not affect lifecycle state.
  }
}

function throwIfAborted(signal: AbortSignal, componentId: string): void {
  if (signal.aborted) throw new LocalRuntimeError("START_CANCELLED", `Start cancelled for ${componentId}`);
}

function linkAbortSignal(source: AbortSignal | undefined, target: AbortController): (() => void) | undefined {
  if (source === undefined) return undefined;
  const onAbort = (): void => target.abort();
  source.addEventListener("abort", onAbort, { once: true });
  return () => source.removeEventListener("abort", onAbort);
}

function isCancellation(error: unknown): boolean {
  return error instanceof LocalRuntimeError && error.code === "START_CANCELLED";
}

function normalizeRuntimeError(error: unknown, componentId: string): LocalRuntimeError {
  if (error instanceof LocalRuntimeError) return error;
  return new LocalRuntimeError("READINESS_FAILED", `Readiness failed for ${componentId}`);
}

function sanitizeStatusText(value: string, secretValues: readonly string[]): string {
  return sanitizeDiagnosticText(redactKnownSecrets(value, secretValues));
}

function safeErrorMessage(error: unknown, secretValues: readonly string[] = []): string {
  if (error instanceof Error) return sanitizeStatusText(error.message, secretValues);
  return "unknown error";
}

function redactKnownSecrets(value: string, secretValues: readonly string[]): string {
  let output = value;
  for (const secret of secretValues) {
    if (secret.length > 0) output = output.split(secret).join("[REDACTED]");
  }
  return output;
}

function sanitizeHandshakeMetadata(
  metadata: Readonly<Record<string, unknown>>,
  secretValues: readonly string[]
): Readonly<Record<string, unknown>> {
  const preRedacted = preRedactDiagnosticValue(metadata, secretValues, {
    seen: new WeakSet<object>(),
    remainingNodes: DIAGNOSTIC_SANITIZATION_LIMITS.maxNodes
  });
  if (typeof preRedacted !== "object" || preRedacted === null || Array.isArray(preRedacted)) {
    return Object.freeze({});
  }
  return sanitizeDiagnosticRecord(preRedacted as Readonly<Record<string, unknown>>);
}

interface PreRedactionState {
  readonly seen: WeakSet<object>;
  remainingNodes: number;
}

function preRedactDiagnosticValue(
  value: unknown,
  secretValues: readonly string[],
  state: PreRedactionState,
  depth = 0
): unknown {
  if (state.remainingNodes <= 0 || depth >= DIAGNOSTIC_SANITIZATION_LIMITS.maxDepth) {
    return "[TRUNCATED]";
  }
  state.remainingNodes -= 1;
  if (typeof value === "string") return redactKnownSecrets(value, secretValues);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return `${value.toString()}n`;
  if (typeof value !== "object") return undefined;
  if (state.seen.has(value)) return "[CIRCULAR]";
  state.seen.add(value);
  try {
    let descriptors: Readonly<Record<string, PropertyDescriptor>>;
    try {
      descriptors = Object.getOwnPropertyDescriptors(value);
    } catch {
      return "[UNINSPECTABLE_OBJECT]";
    }
    if (Array.isArray(value)) {
      const rawLength = descriptors.length?.value;
      if (typeof rawLength !== "number" || !Number.isSafeInteger(rawLength) || rawLength < 0) {
        return "[UNINSPECTABLE_OBJECT]";
      }
      const output: unknown[] = [];
      const count = Math.min(rawLength, DIAGNOSTIC_SANITIZATION_LIMITS.maxArrayItems);
      for (let index = 0; index < count; index += 1) {
        const descriptor = descriptors[String(index)];
        if (descriptor === undefined) {
          output.push(null);
        } else if (!("value" in descriptor)) {
          output.push("[ACCESSOR_OMITTED]");
        } else {
          output.push(preRedactDiagnosticValue(descriptor.value, secretValues, state, depth + 1));
        }
      }
      if (rawLength > count) output.push("[TRUNCATED]");
      return output;
    }

    let prototype: unknown;
    try {
      prototype = Object.getPrototypeOf(value);
    } catch {
      return "[UNINSPECTABLE_OBJECT]";
    }
    if (prototype !== Object.prototype && prototype !== null && !(value instanceof Error)) {
      return "[UNSUPPORTED_OBJECT]";
    }

    const output: Record<string, unknown> = {};
    const entries = Object.entries(descriptors)
      .filter(([, descriptor]) => descriptor.enumerable === true || value instanceof Error)
      .slice(0, DIAGNOSTIC_SANITIZATION_LIMITS.maxObjectEntries);
    for (const [key, descriptor] of entries) {
      if (key === "__proto__" || key === "prototype" || key === "constructor") continue;
      output[key] = "value" in descriptor
        ? preRedactDiagnosticValue(descriptor.value, secretValues, state, depth + 1)
        : "[ACCESSOR_OMITTED]";
    }
    if (Object.entries(descriptors).length > entries.length) output.diagnosticTruncation = "[TRUNCATED]";
    return output;
  } finally {
    state.seen.delete(value);
  }
}
