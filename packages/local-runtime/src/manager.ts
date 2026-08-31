import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { sanitizeDiagnosticRecord, sanitizeDiagnosticText } from "../../diagnostics/src/index.js";
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
  readonly stdout: BoundedLineBuffer;
  readonly stderr: BoundedLineBuffer;
  readonly stdoutListeners: Set<(line: string) => void>;
  readonly exitListeners: Set<(exit: InternalExitRecord) => void>;
  state: LocalComponentState;
  child: ChildProcessWithoutNullStreams | undefined;
  residualProcess: ChildProcessWithoutNullStreams | undefined;
  stdoutFramer?: BoundedLineFramer;
  stderrFramer?: BoundedLineFramer;
  startedAt?: string;
  readyAt: string | undefined;
  readinessDetail: string | undefined;
  handshake: LocalComponentHandshake | undefined;
  lastExit?: InternalExitRecord;
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

  public constructor(options: LocalRuntimeManagerOptions = {}) {
    this.parentEnvironment = options.parentEnvironment ?? process.env;
    this.now = options.now ?? (() => new Date());
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.platform = process.platform;
  }

  public register(definition: LocalComponentDefinition): LocalComponentStatus {
    validateDefinition(definition);
    if (this.components.has(definition.id)) {
      throw new LocalRuntimeError("DUPLICATE_COMPONENT", `Component ${definition.id} is already registered`);
    }

    let environment: BuiltLocalEnvironment;
    try {
      environment = buildLocalEnvironment(definition.environment, this.parentEnvironment, this.platform);
    } catch (error) {
      throw new LocalRuntimeError(
        "INVALID_DEFINITION",
        `Invalid environment configuration: ${safeErrorMessage(error)}`
      );
    }

    const normalizedDefinition = freezeDefinition(definition);
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
      readyAt: undefined,
      readinessDetail: undefined,
      handshake: undefined,
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

  public async stop(componentId: string): Promise<LocalStopResult> {
    const record = this.requireRecord(componentId);
    if (record.stopPromise !== undefined) return record.stopPromise;
    const promise = this.runStop(record);
    record.stopPromise = promise;
    try {
      return await promise;
    } finally {
      if (record.stopPromise === promise) record.stopPromise = undefined;
    }
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

  public async stopAll(): Promise<readonly LocalStopResult[]> {
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
        if (isCancellation(error) || record.expectedStop || signal.aborted) {
          if (record.state !== "STOPPING") record.state = "STOPPED";
          throw new LocalRuntimeError("START_CANCELLED", `Start cancelled for ${record.definition.id}`);
        }
        const runtimeError = normalizeRuntimeError(error, record.definition.id);
        record.state = "FAILED";
        record.failure = this.failure(
          runtimeError.code,
          runtimeError.message,
          record.environment.secretValues
        );
        if (runtimeError.code === "TERMINATION_FAILED" || !this.reserveRestart(record)) throw runtimeError;
        delayMs = restartBackoff(record.definition.restartPolicy ?? DEFAULT_RESTART_POLICY, record.restartBudgetUsed);
      }
    }
  }

  private async spawnAndAwaitReadiness(record: ComponentRecord, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new LocalRuntimeError("START_CANCELLED", `Start cancelled for ${record.definition.id}`);
    record.state = "STARTING";
    record.failure = undefined;
    record.readyAt = undefined;
    record.handshake = undefined;
    record.readinessDetail = undefined;
    record.startedAt = this.timestamp();
    record.stdout.clear();
    record.stderr.clear();

    const child = this.spawnChild(record);
    record.child = child;
    this.attachChild(record, child);

    const attemptController = new AbortController();
    const unlinkAttempt = linkAbortSignal(signal, attemptController);
    const earlyReadiness = isStdoutReadiness(record.definition.readiness)
      ? this.waitForReadiness(record, child, attemptController.signal)
      : undefined;

    try {
      await waitForSpawn(child, attemptController.signal, record.definition.id);
      if (child.pid === undefined) throw new LocalRuntimeError("SPAWN_FAILED", `Component ${record.definition.id} did not receive a process id`);
      const readiness = earlyReadiness
        ?? await this.waitForReadiness(record, child, attemptController.signal);
      if (child.exitCode !== null || child.signalCode !== null || record.child !== child) {
        throw new LocalRuntimeError("PROCESS_EXITED", `Component ${record.definition.id} exited during startup`);
      }
      const handshake = readiness.handshake === undefined
        ? undefined
        : sanitizeHandshake(readiness.handshake, record.environment.secretValues);
      validateExpectedHandshake(record.definition.expectedHandshake, handshake, record.definition.id);
      record.handshake = handshake;
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

  private attachChild(record: ComponentRecord, child: ChildProcessWithoutNullStreams): void {
    const maxLineBytes = record.definition.output?.maxLineBytes ?? DEFAULT_OUTPUT_MAX_LINE_BYTES;
    const stdoutFramer = new BoundedLineFramer(
      maxLineBytes,
      (line) => {
        record.stdout.push(line);
        for (const listener of [...record.stdoutListeners]) listener(line);
      },
      () => record.stdout.markMalformed()
    );
    const stderrFramer = new BoundedLineFramer(
      maxLineBytes,
      (line) => record.stderr.push(line),
      () => record.stderr.markMalformed()
    );
    record.stdoutFramer = stdoutFramer;
    record.stderrFramer = stderrFramer;

    child.stdin.on("error", () => {
      if (record.child === child) record.stderr.push("Managed component stdin stream error");
    });
    child.stdout.on("error", () => {
      if (record.child === child) record.stderr.push("Managed component stdout stream error");
    });
    child.stderr.on("error", () => {
      if (record.child === child) record.stderr.push("Managed component stderr stream error");
    });
    child.stdout.on("data", (chunk: Buffer) => stdoutFramer.append(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrFramer.append(chunk));
    let exitObserved = false;
    child.once("exit", (code, signal) => {
      exitObserved = true;
      this.handleProcessExit(record, child, code, signal);
    });
    child.once("close", (code, signal) => {
      stdoutFramer.flush();
      stderrFramer.flush();
      if (!exitObserved) this.handleProcessExit(record, child, code, signal);
      this.handleProcessClose(record, child);
    });
    child.on("error", () => {
      if (record.child !== child) return;
      if (record.state === "READY" || record.state === "DEGRADED") {
        record.failure = this.failure("PROCESS_EXITED", `Managed component ${record.definition.id} reported a process error`);
      }
    });
  }

  private handleProcessExit(
    record: ComponentRecord,
    child: ChildProcessWithoutNullStreams,
    code: number | null,
    signal: NodeJS.Signals | null
  ): void {
    if (record.child !== child) return;
    const previousState = record.state;
    const unexpected = !record.expectedStop && previousState !== "STOPPING" && previousState !== "STOPPED";
    const exit = this.createExitRecord(record, code, signal, previousState, unexpected);
    record.lastExit = exit;
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
          `Residual process-tree cleanup failed: ${safeErrorMessage(error)}`,
          record.environment.secretValues
        );
        if (record.cleanupPromise === cleanup) record.cleanupPromise = undefined;
      }
    );
  }

  private handleProcessClose(
    record: ComponentRecord,
    child: ChildProcessWithoutNullStreams
  ): void {
    if (record.child !== child && record.residualProcess !== child) return;
    const lastExit = record.lastExit;
    if (lastExit !== undefined) {
      const stderrLines = record.stderr.snapshot().lines.filter((line) => line !== "[TRUNCATED]");
      record.lastExit = Object.freeze({
        ...lastExit,
        stderrTail: Object.freeze(stderrLines.slice(-MAX_STDERR_TAIL_LINES))
      });
    }
    if (record.child === child) record.child = undefined;
  }

  private createExitRecord(
    record: ComponentRecord,
    code: number | null,
    signal: NodeJS.Signals | null,
    previousState: LocalComponentState,
    unexpected: boolean
  ): InternalExitRecord {
    const stderrLines = record.stderr.snapshot().lines.filter((line) => line !== "[TRUNCATED]");
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
    if (policy.mode !== "ON_FAILURE" || record.expectedStop) return false;
    if (record.restartBudgetUsed >= policy.maxRetries) return false;
    record.restartBudgetUsed += 1;
    record.restartCount += 1;
    return true;
  }

  private async waitForReadiness(
    record: ComponentRecord,
    child: ChildProcessWithoutNullStreams,
    signal: AbortSignal
  ): Promise<{ readonly detail?: string; readonly handshake?: LocalComponentHandshake }> {
    const controller = new AbortController();
    const unlink = linkAbortSignal(signal, controller);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const readinessPromise = this.runReadinessStrategy(record, child, controller.signal);
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new LocalRuntimeError("READINESS_TIMEOUT", `Readiness timed out for ${record.definition.id}`));
        controller.abort();
      }, record.definition.startupTimeoutMs);
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
        try {
          finish(evaluate(line));
        } catch {
          // Treat callback failures as a non-ready observation; untrusted output cannot crash the manager.
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
      } catch {
        if (signal.aborted) throw new LocalRuntimeError("START_CANCELLED", `Start cancelled for ${record.definition.id}`);
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
    } finally {
      record.expectedStop = previousExpectedStop;
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
    void this.requestGracefulShutdown(record, child);
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
    try {
      await record.definition.gracefulShutdown(control);
    } catch (error) {
      if (record.child === child) {
        record.failure = this.failure(
          "TERMINATION_FAILED",
          `Graceful shutdown hook failed: ${safeErrorMessage(error)}`,
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
    return this.now().toISOString();
  }
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
  if (definition.output?.maxLines !== undefined) positiveInteger(definition.output.maxLines, "output.maxLines");
  if (definition.output?.maxBytes !== undefined) positiveInteger(definition.output.maxBytes, "output.maxBytes");
  if (definition.output?.maxLineBytes !== undefined) positiveInteger(definition.output.maxLineBytes, "output.maxLineBytes");
}

function validateReadiness(definition: LocalComponentDefinition): void {
  const readiness = definition.readiness;
  switch (readiness.kind) {
    case "STABLE_PROCESS":
      positiveTimer(readiness.stableMs, "readiness.stableMs");
      break;
    case "HTTP_LOOPBACK":
      parseLoopbackUrl(readiness.url);
      if (readiness.intervalMs !== undefined) positiveTimer(readiness.intervalMs, "readiness.intervalMs");
      if (readiness.evaluate !== undefined && typeof readiness.evaluate !== "function") {
        invalid("HTTP readiness evaluate must be a function");
      }
      break;
    case "CUSTOM_LOCAL":
      if (readiness.intervalMs !== undefined) positiveTimer(readiness.intervalMs, "readiness.intervalMs");
      if (typeof readiness.probe !== "function") invalid("Custom readiness probe must be a function");
      break;
    case "STDOUT_LINE":
    case "STDOUT_JSON":
      if (typeof readiness.evaluate !== "function") invalid("Stdout readiness evaluate must be a function");
      break;
    default:
      invalid("Unsupported readiness strategy");
  }
}

function validateRestartPolicy(policy: LocalRestartPolicy): void {
  if (policy.mode === "NEVER") return;
  if (policy.mode !== "ON_FAILURE") invalid("Unsupported restart policy");
  if (!Number.isSafeInteger(policy.maxRetries) || policy.maxRetries < 0) invalid("restartPolicy.maxRetries must be a nonnegative safe integer");
  if (policy.backoffMs !== undefined) nonnegativeTimer(policy.backoffMs, "restartPolicy.backoffMs");
  if (policy.maxBackoffMs !== undefined) nonnegativeTimer(policy.maxBackoffMs, "restartPolicy.maxBackoffMs");
  if (policy.backoffMs !== undefined && policy.maxBackoffMs !== undefined && policy.maxBackoffMs < policy.backoffMs) {
    invalid("restartPolicy.maxBackoffMs must be at least restartPolicy.backoffMs");
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
  return url;
}

function normalizeReadinessDecision(decision: LocalReadinessDecision): {
  readonly ready: boolean;
  readonly detail?: string;
  readonly handshake?: LocalComponentHandshake;
} {
  return typeof decision === "boolean" ? { ready: decision } : decision;
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
    ...(handshake.metadata === undefined ? {} : { metadata: redactKnownSecretsFromRecord(sanitizeDiagnosticRecord(handshake.metadata), secretValues) })
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
  const maximum = policy.maxBackoffMs ?? 5_000;
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

function waitForSpawn(child: ChildProcessWithoutNullStreams, signal: AbortSignal, componentId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      child.off("spawn", onSpawn);
      child.off("error", onError);
      signal.removeEventListener("abort", onAbort);
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
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const childClosed = record.child !== child;
    if (childClosed && !isOwnedProcessTreeAlive(child, platform)) return true;
    const remaining = deadline - Date.now();
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
    let task: ReturnType<typeof spawn>;
    try {
      task = spawn("taskkill", [
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
      task.kill();
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

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return sanitizeDiagnosticText(error.message);
  return "unknown error";
}

function redactKnownSecrets(value: string, secretValues: readonly string[]): string {
  let output = value;
  for (const secret of secretValues) {
    if (secret.length > 0) output = output.split(secret).join("[REDACTED]");
  }
  return output;
}

function redactKnownSecretsFromRecord(
  record: Readonly<Record<string, unknown>>,
  secretValues: readonly string[]
): Readonly<Record<string, unknown>> {
  const visit = (value: unknown): unknown => {
    if (typeof value === "string") return redactKnownSecrets(value, secretValues);
    if (Array.isArray(value)) return Object.freeze(value.map((item) => visit(item)));
    if (typeof value !== "object" || value === null) return value;
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) output[key] = visit(item);
    return Object.freeze(output);
  };
  return visit(record) as Readonly<Record<string, unknown>>;
}
