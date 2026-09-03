import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, createReadStream, lstatSync, realpathSync, rmSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path, { win32 as win32Path } from "node:path";
import process from "node:process";
import { TextDecoder, types as utilTypes } from "node:util";
import {
  buildLocalEnvironment,
  snapshotParentEnvironmentRecord
} from "./environment.js";
import type { LocalEnvironmentDefinition } from "./types.js";
import {
  WINDOWS_JOB_SUPERVISOR_CSHARP_SOURCE,
  WINDOWS_JOB_SUPERVISOR_SCRIPT
} from "./windows-job-supervisor.js";

const MAX_EXECUTABLES = 32;
const MAX_ACTIVE_EXECUTIONS = 4;
const MAX_ARGUMENTS = 64;
const MAX_ARGUMENT_BYTES = 128 * 1024;
const MAX_WINDOWS_PROVIDER_COMMAND_LINE_CHARACTERS = 24_000;
const MAX_WINDOWS_SUPERVISOR_COMMAND_LINE_CHARACTERS = 4_096;
const MAX_WINDOWS_SUPERVISOR_ENVIRONMENT_CHARACTERS = 30_000;
const MAX_WINDOWS_SUPERVISOR_ASSEMBLY_BYTES = 5 * 1024 * 1024;
const WINDOWS_SUPERVISOR_COMPILE_TIMEOUT_MS = 30_000;
const MAX_STDIN_BYTES = 256 * 1024;
const MAX_STDOUT_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 512 * 1024;
const MAX_EXECUTION_MS = 5 * 60_000;
const MAX_EXECUTABLE_BYTES = 512n * 1024n * 1024n;
const EXECUTABLE_HASH_TIMEOUT_MS = 30_000;
const DRAIN_TIMEOUT_MS = 5_000;
const MAX_ISOLATED_HOME_FILES = 16;
const MAX_ISOLATED_HOME_FILE_BYTES = 64 * 1024;
const MAX_ISOLATED_HOME_TOTAL_BYTES = 128 * 1024;
const MAX_ISOLATED_HOME_PATH_BYTES = 1_024;
const MAX_ISOLATED_HOME_PATH_SEGMENTS = 32;
const TREE_GRACE_MS = 250;
const TREE_FORCE_MS = 1_000;

const EXECUTABLE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u;
const ISOLATED_HOME_PATH_SEGMENT =
  /^(?:\.[A-Za-z0-9](?:[A-Za-z0-9._-]{0,125}[A-Za-z0-9])?|[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?)$/u;
const WINDOWS_RESERVED_PATH_SEGMENT =
  /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/iu;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const REFLECT_APPLY_INTRINSIC = Reflect.apply;
/* eslint-disable @typescript-eslint/unbound-method -- Captured intrinsics are invoked only through Reflect.apply. */
const ABORT_SIGNAL_ADD_EVENT_LISTENER_INTRINSIC =
  AbortSignal.prototype.addEventListener;
const ABORT_SIGNAL_REMOVE_EVENT_LISTENER_INTRINSIC =
  AbortSignal.prototype.removeEventListener;
const ABORT_SIGNAL_ABORTED_GETTER_INTRINSIC =
  Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get;
/* eslint-enable @typescript-eslint/unbound-method */

export type SupervisedProcessErrorCode =
  | "INVALID_DEFINITION"
  | "UNKNOWN_EXECUTABLE"
  | "INVALID_REQUEST"
  | "CAPACITY_EXCEEDED"
  | "EXECUTABLE_UNAVAILABLE"
  | "EXECUTABLE_UNSAFE"
  | "SPAWN_FAILED"
  | "EXECUTION_TIMEOUT"
  | "EXECUTION_CANCELLED"
  | "OUTPUT_LIMIT_EXCEEDED"
  | "INVALID_STDOUT_UTF8"
  | "PROCESS_TREE_CLEANUP_FAILED";

export class SupervisedProcessError extends Error {
  public constructor(public readonly code: SupervisedProcessErrorCode) {
    super(supervisedProcessErrorMessage(code));
    this.name = "SupervisedProcessError";
  }
}

export interface SupervisedExecutableDefinition {
  readonly id: string;
  readonly executable: string;
  readonly fixedArgs?: readonly string[];
  readonly environment?: LocalEnvironmentDefinition;
  readonly isolatedWorkingDirectory?: boolean;
  readonly isolatedHomeFiles?: Readonly<Record<string, string>>;
}

export interface SupervisedProcessExecutionRequest {
  readonly executableId: string;
  readonly args?: readonly string[];
  readonly stdin?: string;
  readonly timeoutMs: number;
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
  readonly signal?: AbortSignal;
  readonly onProcessStart?: () => void;
}

export interface SupervisedProcessExecutionResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
}

export interface SupervisedProcessRunnerOptions {
  readonly parentEnvironment?: NodeJS.ProcessEnv;
}

interface ExecutableDefinitionSnapshot {
  readonly id: string;
  readonly executable: string;
  readonly fixedArgs: readonly string[];
  readonly environment?: LocalEnvironmentDefinition;
  readonly isolatedWorkingDirectory: boolean;
  readonly isolatedHomeFiles?: readonly IsolatedHomeFile[];
}

interface RegisteredExecutable {
  readonly id: string;
  readonly executable: string;
  readonly fixedArgs: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly isolatedWorkingDirectory: boolean;
  readonly isolatedHomeFiles?: readonly IsolatedHomeFile[];
}

interface IsolatedHomeFile {
  readonly relativePath: string;
  readonly content: string;
}

interface ExecutionIsolation {
  readonly environment: NodeJS.ProcessEnv;
  readonly workingDirectory?: string;
  readonly homeDirectory?: string;
  readonly controlDirectory?: string;
}

interface ExecutableIdentity {
  readonly device: bigint;
  readonly inode: bigint;
  readonly linkCount: bigint;
  readonly size: bigint;
  readonly modifiedNanoseconds: bigint;
  readonly canonicalPath: string;
  readonly contentSha256?: string;
}

interface WindowsSupervisorLaunch {
  readonly executable: string;
  readonly args: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly identity: ExecutableIdentity;
  readonly bootstrapStdin: string;
}

interface WindowsSupervisorAssembly {
  readonly path: string;
  readonly sha256: string;
}

interface WindowsSupervisorAssemblyEntry {
  promise: Promise<WindowsSupervisorAssembly>;
  readonly controller: AbortController;
  consumers: number;
  settled: boolean;
}

interface WindowsSupervisorAssemblyLease {
  readonly entry: WindowsSupervisorAssemblyEntry;
  readonly release: () => void;
}

const SHARED_WINDOWS_SUPERVISOR_ASSEMBLIES =
  new Map<string, WindowsSupervisorAssemblyEntry>();
const WINDOWS_SUPERVISOR_TEMP_DIRECTORIES = new Set<string>();
let windowsSupervisorExitCleanupInstalled = false;

type PendingFailure =
  | "SPAWN_FAILED"
  | "EXECUTION_TIMEOUT"
  | "EXECUTION_CANCELLED"
  | "OUTPUT_LIMIT_EXCEEDED"
  | "EXECUTABLE_UNSAFE"
  | "PROCESS_TREE_CLEANUP_FAILED";

export class SupervisedProcessRunner {
  private readonly definitions = new Map<string, RegisteredExecutable>();
  private readonly parentEnvironment: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private readonly temporaryRoot: string;
  private readonly pinnedIdentities = new Map<string, ExecutableIdentity>();
  private readonly quarantinedExecutableIds = new Set<string>();
  private readonly identityInitializations = new Map<string, Promise<void>>();
  private readonly identityInitializationControllers =
    new Map<string, AbortController>();
  private containmentCompromised = false;
  private windowsSupervisorIdentity: ExecutableIdentity | undefined;
  private readonly activeControllers = new Set<AbortController>();
  private readonly activeOperations = new Set<Promise<SupervisedProcessExecutionResult>>();
  private draining: Promise<void> | undefined;

  public constructor(
    definitions: readonly SupervisedExecutableDefinition[],
    options: SupervisedProcessRunnerOptions = {}
  ) {
    const optionRecord = inspectPlainRecord(
      options,
      new Set(["parentEnvironment"]),
      "INVALID_DEFINITION"
    );
    this.platform = process.platform;
    this.temporaryRoot = this.platform === "win32"
      ? trustedWindowsTemporaryRoot()
      : tmpdir();
    this.parentEnvironment = snapshotParentEnvironmentRecord(
      (optionRecord.parentEnvironment as NodeJS.ProcessEnv | undefined) ?? process.env
    );
    const snapshots = snapshotExecutableDefinitions(definitions, this.platform);
    for (const snapshot of snapshots) {
      if (this.definitions.has(snapshot.id)) {
        throw new SupervisedProcessError("INVALID_DEFINITION");
      }
      let environment: NodeJS.ProcessEnv;
      try {
        environment = buildLocalEnvironment(
          snapshot.environment,
          this.parentEnvironment,
          this.platform
        ).environment;
      } catch {
        throw new SupervisedProcessError("INVALID_DEFINITION");
      }
      this.definitions.set(snapshot.id, Object.freeze({
        id: snapshot.id,
        executable: snapshot.executable,
        fixedArgs: snapshot.fixedArgs,
        environment,
        isolatedWorkingDirectory: snapshot.isolatedWorkingDirectory,
        ...(snapshot.isolatedHomeFiles === undefined
          ? {}
          : { isolatedHomeFiles: snapshot.isolatedHomeFiles })
      }));
      const initialIdentity = tryInspectExecutableSync(
        snapshot.executable,
        this.platform
      );
      // Windows execution uses async inspection plus content hashing on first
      // use. Do not mix sync-stat identity fields into that pin because Node
      // can report Windows file identity metadata differently across sync and
      // async stat APIs.
      if (initialIdentity !== undefined && this.platform !== "win32") {
        this.pinnedIdentities.set(snapshot.id, initialIdentity);
      }
    }
  }

  public execute(
    input: SupervisedProcessExecutionRequest
  ): Promise<SupervisedProcessExecutionResult> {
    let request: ReturnType<typeof snapshotExecutionRequest>;
    try {
      request = snapshotExecutionRequest(input);
    } catch (error) {
      return Promise.reject(
        error instanceof SupervisedProcessError
          ? error
          : new SupervisedProcessError("INVALID_REQUEST")
      );
    }
    if (this.containmentCompromised) {
      return Promise.reject(
        new SupervisedProcessError("PROCESS_TREE_CLEANUP_FAILED")
      );
    }
    if (this.draining !== undefined) {
      return Promise.reject(new SupervisedProcessError("EXECUTION_CANCELLED"));
    }
    if (this.activeOperations.size >= MAX_ACTIVE_EXECUTIONS) {
      return Promise.reject(new SupervisedProcessError("CAPACITY_EXCEEDED"));
    }

    const controller = new AbortController();
    const externalSignal = request.signal;
    const forwardAbort = (): void => {
      controller.abort(new SupervisedProcessError("EXECUTION_CANCELLED"));
    };
    let removeExternalAbortListener = (): void => undefined;
    if (externalSignal !== undefined) {
      if (abortSignalAborted(externalSignal)) {
        forwardAbort();
      } else {
        addAbortSignalListener(externalSignal, forwardAbort);
        removeExternalAbortListener = () => {
          removeAbortSignalListener(externalSignal, forwardAbort);
        };
      }
    }

    const trackedRequest = Object.freeze({
      ...request,
      signal: controller.signal
    });
    this.activeControllers.add(controller);
    const operation = this.executeSnapshot(trackedRequest);
    this.activeOperations.add(operation);

    let interruptionError =
      new SupervisedProcessError("EXECUTION_CANCELLED");
    const deadlineTimer = setTimeout(() => {
      interruptionError = new SupervisedProcessError("EXECUTION_TIMEOUT");
      controller.abort(interruptionError);
    }, request.timeoutMs);
    let removeInterruptListener = (): void => undefined;
    const interrupted = new Promise<never>((_resolve, reject) => {
      const onInterrupt = (): void => {
        reject(interruptionError);
      };
      removeInterruptListener = () => {
        removeAbortSignalListener(controller.signal, onInterrupt);
      };
      if (abortSignalAborted(controller.signal)) onInterrupt();
      else addAbortSignalListener(controller.signal, onInterrupt);
    });
    const publicOperation = Promise.race([operation, interrupted]);

    const cleanup = (): void => {
      clearTimeout(deadlineTimer);
      removeInterruptListener();
      removeExternalAbortListener();
      this.activeControllers.delete(controller);
      this.activeOperations.delete(operation);
    };
    void operation.then(cleanup, cleanup);
    return publicOperation;
  }

  public drain(): Promise<void> {
    if (this.draining !== undefined) return this.draining;
    const operation = this.drainActiveOperations();
    this.draining = operation;
    const clear = (): void => {
      if (this.draining === operation) this.draining = undefined;
    };
    void operation.then(clear, clear);
    return operation;
  }

  private quarantineExecutable(executableId: string): void {
    this.quarantinedExecutableIds.add(executableId);
    this.containmentCompromised = true;
    for (const controller of this.activeControllers) {
      controller.abort();
    }
    for (const controller of this.identityInitializationControllers.values()) {
      controller.abort();
    }
  }

  private async drainActiveOperations(): Promise<void> {
    for (const controller of this.activeControllers) controller.abort();
    for (const controller of this.identityInitializationControllers.values()) {
      controller.abort();
    }

    const operations: Promise<unknown>[] = [
      ...this.activeOperations,
      ...this.identityInitializations.values()
    ];
    const results = await settleWithin(operations, DRAIN_TIMEOUT_MS);
    if (results === undefined) {
      this.containmentCompromised = true;
      throw new SupervisedProcessError("PROCESS_TREE_CLEANUP_FAILED");
    }
    if (
      this.containmentCompromised
      || this.quarantinedExecutableIds.size !== 0
      || results.some(
        (result) =>
          result.status === "rejected"
          && isProcessTreeCleanupError(result.reason)
      )
    ) {
      throw new SupervisedProcessError("PROCESS_TREE_CLEANUP_FAILED");
    }
  }

  private async executeSnapshot(
    request: ReturnType<typeof snapshotExecutionRequest>
  ): Promise<SupervisedProcessExecutionResult> {
    const definition = this.definitions.get(request.executableId);
    if (definition === undefined) throw new SupervisedProcessError("UNKNOWN_EXECUTABLE");
    if (this.quarantinedExecutableIds.has(definition.id)) {
      throw new SupervisedProcessError("PROCESS_TREE_CLEANUP_FAILED");
    }
    if (request.signal !== undefined && abortSignalAborted(request.signal)) {
      throw new SupervisedProcessError("EXECUTION_CANCELLED");
    }

    let before = await inspectExecutable(definition.executable, this.platform);
    if (this.platform === "win32" && before.linkCount !== 1n) {
      throw new SupervisedProcessError("EXECUTABLE_UNSAFE");
    }

    if (this.platform === "win32") {
      const initializationInProgress =
        this.identityInitializations.get(definition.id);
      if (initializationInProgress !== undefined) {
        await waitForOperationOrAbort(
          initializationInProgress,
          request.signal
        );
        before = await inspectExecutable(definition.executable, "win32");
        if (before.linkCount !== 1n) {
          throw new SupervisedProcessError("EXECUTABLE_UNSAFE");
        }
      }
    }

    const pinned = this.pinnedIdentities.get(definition.id);
    if (pinned === undefined) {
      this.pinnedIdentities.set(definition.id, before);
    } else if (!sameExecutableIdentity(pinned, before, this.platform)) {
      throw new SupervisedProcessError("EXECUTABLE_UNSAFE");
    }

    if (
      this.platform === "win32"
      && this.pinnedIdentities.get(definition.id)?.contentSha256 === undefined
    ) {
      let initialization = this.identityInitializations.get(definition.id);
      if (initialization === undefined) {
        const initializationController = new AbortController();
        initialization = this.initializeWindowsExecutableIdentity(
          definition,
          before,
          initializationController.signal
        );
        this.identityInitializations.set(definition.id, initialization);
        this.identityInitializationControllers.set(
          definition.id,
          initializationController
        );
        const captured = initialization;
        void captured.finally(() => {
          if (this.identityInitializations.get(definition.id) === captured) {
            this.identityInitializations.delete(definition.id);
            this.identityInitializationControllers.delete(definition.id);
          }
        }).catch(() => undefined);
      }
      await waitForOperationOrAbort(initialization, request.signal);
    }

    const pinnedAfterInitialization = this.pinnedIdentities.get(definition.id);
    const currentIdentity = await inspectExecutable(
      definition.executable,
      this.platform
    );
    if (
      pinnedAfterInitialization === undefined
      || !sameExecutableIdentity(
        pinnedAfterInitialization,
        currentIdentity,
        this.platform
      )
    ) {
      throw new SupervisedProcessError("EXECUTABLE_UNSAFE");
    }

    if (request.signal !== undefined && abortSignalAborted(request.signal)) {
      throw new SupervisedProcessError("EXECUTION_CANCELLED");
    }

    if (
      this.platform === "win32"
      && !windowsCommandLineWithinBudget(
        pinnedAfterInitialization.canonicalPath,
        [...definition.fixedArgs, ...request.args]
      )
    ) {
      throw new SupervisedProcessError("INVALID_REQUEST");
    }

    let isolation: ExecutionIsolation;
    try {
      isolation = await createExecutionIsolation(
        definition,
        this.platform,
        this.temporaryRoot
      );
    } catch (error) {
      if (isProcessTreeCleanupError(error)) {
        this.quarantineExecutable(definition.id);
      }
      throw error;
    }

    const expectedIdentity = this.pinnedIdentities.get(definition.id);
    if (expectedIdentity === undefined) {
      await this.cleanupIsolationOrQuarantine(definition.id, isolation);
      throw new SupervisedProcessError("EXECUTABLE_UNSAFE");
    }
    if (request.signal !== undefined && abortSignalAborted(request.signal)) {
      await this.cleanupIsolationOrQuarantine(definition.id, isolation);
      throw new SupervisedProcessError("EXECUTION_CANCELLED");
    }

    let result: SupervisedProcessExecutionResult | undefined;
    let failed = false;
    let failure: unknown;
    try {
      result = await this.runChild(
        definition,
        request,
        expectedIdentity,
        isolation.environment,
        isolation.workingDirectory,
        isolation.controlDirectory
      );
    } catch (error) {
      failed = true;
      failure = error;
      if (isProcessTreeCleanupError(error)) {
        this.quarantineExecutable(definition.id);
      }
    }

    await this.cleanupIsolationOrQuarantine(definition.id, isolation);

    if (failed) throw failure;
    if (result === undefined) {
      throw new SupervisedProcessError("SPAWN_FAILED");
    }
    return result;
  }

  private async cleanupIsolationOrQuarantine(
    executableId: string,
    isolation: ExecutionIsolation
  ): Promise<void> {
    try {
      await cleanupExecutionIsolation(isolation);
    } catch {
      this.quarantineExecutable(executableId);
      throw new SupervisedProcessError("PROCESS_TREE_CLEANUP_FAILED");
    }
  }

  private async initializeWindowsExecutableIdentity(
    definition: RegisteredExecutable,
    baseline: ExecutableIdentity,
    signal: AbortSignal
  ): Promise<void> {
    const contentSha256 = await sha256Executable(
      baseline.canonicalPath,
      signal
    );
    const afterHash = await inspectExecutable(definition.executable, "win32");
    const pinned = this.pinnedIdentities.get(definition.id);
    if (
      pinned === undefined
      || !sameExecutableIdentity(pinned, baseline, "win32")
      || !sameExecutableIdentity(baseline, afterHash, "win32")
    ) {
      throw new SupervisedProcessError("EXECUTABLE_UNSAFE");
    }
    this.pinnedIdentities.set(definition.id, Object.freeze({
      ...afterHash,
      contentSha256
    }));
  }

  private async runChild(
    definition: RegisteredExecutable,
    request: ReturnType<typeof snapshotExecutionRequest>,
    before: ExecutableIdentity,
    environment: NodeJS.ProcessEnv,
    workingDirectory: string | undefined,
    controlDirectory: string | undefined
  ): Promise<SupervisedProcessExecutionResult> {
    let launchExecutable = definition.executable;
    let launchArgs: readonly string[] = [...definition.fixedArgs, ...request.args];
    let launchEnvironment = environment;
    let launchIdentity = before;
    let launchStdin = request.stdin;

    if (this.platform === "win32") {
      const launch = await this.prepareWindowsSupervisorLaunch(
        definition,
        request,
        before,
        environment,
        workingDirectory,
        controlDirectory
      );
      launchExecutable = launch.executable;
      launchArgs = launch.args;
      launchEnvironment = launch.environment;
      launchIdentity = launch.identity;
      launchStdin = launch.bootstrapStdin;
    }

    if (request.signal !== undefined && abortSignalAborted(request.signal)) {
      throw new SupervisedProcessError("EXECUTION_CANCELLED");
    }

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(
        launchExecutable,
        [...launchArgs],
        {
          ...(workingDirectory === undefined ? {} : { cwd: workingDirectory }),
          env: launchEnvironment,
          shell: false,
          detached: this.platform !== "win32",
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true
        }
      );
    } catch {
      throw new SupervisedProcessError("SPAWN_FAILED");
    }

    const closePromise = waitForClose(child);
    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let pendingFailure: PendingFailure | undefined;
    let cleanupStarted: Promise<boolean> | undefined;
    let signalFailureRequested: (() => void) | undefined;
    const failureRequested = new Promise<void>((resolve) => {
      signalFailureRequested = resolve;
    });
    let settled = false;

    const requestCleanup = (failure: PendingFailure): void => {
      if (pendingFailure === undefined) pendingFailure = failure;
      signalFailureRequested?.();
      cleanupStarted ??= terminateProcessTree(child, this.platform, launchEnvironment);
    };

    const throwPendingFailure = async (): Promise<never> => {
      const failure = pendingFailure ?? "PROCESS_TREE_CLEANUP_FAILED";
      const cleaned = cleanupStarted === undefined
        ? true
        : await cleanupStarted;
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      if (!cleaned) {
        throw new SupervisedProcessError("PROCESS_TREE_CLEANUP_FAILED");
      }
      throw new SupervisedProcessError(failure);
    };

    child.stdout.on("data", (value: Buffer) => {
      if (!Buffer.isBuffer(value) || settled) return;
      if (stdoutBytes + value.length > request.maxStdoutBytes) {
        requestCleanup("OUTPUT_LIMIT_EXCEEDED");
        return;
      }
      stdoutBytes += value.length;
      stdoutChunks.push(Buffer.from(value));
    });
    child.stderr.on("data", (value: Buffer) => {
      if (!Buffer.isBuffer(value) || settled) return;
      if (
        this.platform === "win32"
        && process.env["INTERVIEW_SUPERVISOR_STAGE_DEBUG"] === "1"
      ) {
        const diagnosticText = value.toString("utf8");
        for (const match of diagnosticText.matchAll(
          /INTERVIEW_SUPERVISOR_STAGE:[A-Z_]+/gu
        )) {
          process.stderr.write(match[0] + "\n");
        }
      }
      if (stderrBytes + value.length > request.maxStderrBytes) {
        requestCleanup("OUTPUT_LIMIT_EXCEEDED");
        return;
      }
      stderrBytes += value.length;
    });
    child.stdin.on("error", () => {
      if (!settled && pendingFailure === undefined) requestCleanup("SPAWN_FAILED");
    });
    child.stdout.on("error", () => {
      if (!settled && pendingFailure === undefined) requestCleanup("OUTPUT_LIMIT_EXCEEDED");
    });
    child.stderr.on("error", () => {
      if (!settled && pendingFailure === undefined) requestCleanup("OUTPUT_LIMIT_EXCEEDED");
    });

    const timeout = setTimeout(
      () => requestCleanup("EXECUTION_TIMEOUT"),
      request.timeoutMs
    );
    const onAbort = (): void => requestCleanup("EXECUTION_CANCELLED");
    if (request.signal !== undefined && abortSignalAborted(request.signal)) {
      requestCleanup("EXECUTION_CANCELLED");
    } else {
      if (request.signal !== undefined) addAbortSignalListener(request.signal, onAbort);
    }

    try {
      const spawnOutcome = await Promise.race([
        waitForSpawn(child).then(() => "SPAWNED" as const),
        failureRequested.then(() => "FAILED" as const)
      ]);
      if (spawnOutcome === "FAILED" || pendingFailure !== undefined) {
        return await throwPendingFailure();
      }

      if (request.onProcessStart !== undefined) {
        try {
          request.onProcessStart();
        } catch {
          requestCleanup("EXECUTION_CANCELLED");
          return await throwPendingFailure();
        }
      }

      const identityOutcome = await Promise.race([
        inspectExecutable(launchExecutable, this.platform).then(
          (identity) => ({ kind: "IDENTITY" as const, identity })
        ),
        failureRequested.then(() => ({ kind: "FAILED" as const }))
      ]);
      if (identityOutcome.kind === "FAILED") {
        return await throwPendingFailure();
      }
      if (!sameExecutableIdentity(launchIdentity, identityOutcome.identity, this.platform)) {
        requestCleanup("EXECUTABLE_UNSAFE");
        return await throwPendingFailure();
      }
      if (request.signal !== undefined && abortSignalAborted(request.signal)) {
        requestCleanup("EXECUTION_CANCELLED");
        return await throwPendingFailure();
      }

      const stdinOutcome = await Promise.race([
        writeBoundedStdin(child, launchStdin).then(() => "WRITTEN" as const),
        failureRequested.then(() => "FAILED" as const)
      ]);
      if (stdinOutcome === "FAILED") {
        return await throwPendingFailure();
      }

      const closeOutcome = await Promise.race([
        closePromise.then((exit) => ({ kind: "CLOSE" as const, exit })),
        failureRequested.then(() => ({ kind: "FAILED" as const }))
      ]);
      if (closeOutcome.kind === "FAILED") {
        return await throwPendingFailure();
      }
      const exit = closeOutcome.exit;

      if (this.platform !== "win32") {
        const residualCleaned = await cleanupResidualPosixGroup(child.pid);
        if (!residualCleaned) {
          throw new SupervisedProcessError("PROCESS_TREE_CLEANUP_FAILED");
        }
      }

      if (exit.code === null) {
        throw new SupervisedProcessError("PROCESS_TREE_CLEANUP_FAILED");
      }

      let stdout: string;
      try {
        stdout = UTF8_DECODER.decode(Buffer.concat(stdoutChunks, stdoutBytes));
      } catch {
        throw new SupervisedProcessError("INVALID_STDOUT_UTF8");
      }
      return Object.freeze({
        exitCode: exit.code,
        stdout,
        stdoutBytes,
        stderrBytes
      });
    } catch (error) {
      if (error instanceof SupervisedProcessError) {
        if (isProcessAlive(child)) {
          const cleaned = await terminateProcessTree(child, this.platform, launchEnvironment);
          if (!cleaned) {
            throw new SupervisedProcessError("PROCESS_TREE_CLEANUP_FAILED");
          }
        }
        throw error;
      }
      if (isProcessAlive(child)) {
        const cleaned = await terminateProcessTree(child, this.platform, launchEnvironment);
        if (!cleaned) {
          throw new SupervisedProcessError("PROCESS_TREE_CLEANUP_FAILED");
        }
      }
      throw new SupervisedProcessError("SPAWN_FAILED");
    } finally {
      settled = true;
      clearTimeout(timeout);
      if (request.signal !== undefined) removeAbortSignalListener(request.signal, onAbort);
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    }
  }

  private async prepareWindowsSupervisorLaunch(
    definition: RegisteredExecutable,
    request: ReturnType<typeof snapshotExecutionRequest>,
    expectedIdentity: ExecutableIdentity,
    environment: NodeJS.ProcessEnv,
    workingDirectory: string | undefined,
    controlDirectory: string | undefined
  ): Promise<WindowsSupervisorLaunch> {
    if (
      expectedIdentity.contentSha256 === undefined
      || controlDirectory === undefined
    ) {
      throw new SupervisedProcessError("EXECUTABLE_UNSAFE");
    }

    if (request.signal !== undefined && abortSignalAborted(request.signal)) {
      throw new SupervisedProcessError("EXECUTION_CANCELLED");
    }
    const powershell = windowsPowerShellExecutablePath(environment);
    const identity = await inspectExecutable(powershell, "win32");
    if (request.signal !== undefined && abortSignalAborted(request.signal)) {
      throw new SupervisedProcessError("EXECUTION_CANCELLED");
    }
    if (this.windowsSupervisorIdentity === undefined) {
      this.windowsSupervisorIdentity = identity;
    } else if (
      !sameExecutableIdentity(this.windowsSupervisorIdentity, identity, "win32")
    ) {
      throw new SupervisedProcessError("EXECUTABLE_UNSAFE");
    }

    traceWindowsSupervisorStage("NODE_HELPER_ACQUIRE");
    let assemblyLease = acquireSharedWindowsSupervisorAssembly(
      identity.canonicalPath,
      this.temporaryRoot,
      environment
    );
    let assembly: WindowsSupervisorAssembly;
    try {
      assembly = await waitForOperationOrAbort(
        assemblyLease.entry.promise,
        request.signal
      );
      traceWindowsSupervisorStage("NODE_HELPER_READY");
      if (request.signal !== undefined && abortSignalAborted(request.signal)) {
        throw new SupervisedProcessError("EXECUTION_CANCELLED");
      }
      if (!await verifyWindowsSupervisorAssembly(assembly, request.signal)) {
        invalidateSharedWindowsSupervisorAssembly(
          identity.canonicalPath,
          this.temporaryRoot,
          assemblyLease.entry
        );
        assemblyLease.release();
        assemblyLease = acquireSharedWindowsSupervisorAssembly(
          identity.canonicalPath,
          this.temporaryRoot,
          environment
        );
        assembly = await waitForOperationOrAbort(
          assemblyLease.entry.promise,
          request.signal
        );
        if (!await verifyWindowsSupervisorAssembly(assembly, request.signal)) {
          throw new SupervisedProcessError("EXECUTABLE_UNSAFE");
        }
      }
    } finally {
      assemblyLease.release();
    }

    const stdinBytes = Buffer.from(request.stdin, "utf8");
    if (stdinBytes.byteLength > MAX_STDIN_BYTES) {
      throw new SupervisedProcessError("INVALID_REQUEST");
    }
    const stdinPath = path.join(controlDirectory, "stdin.bin");
    await writeFile(stdinPath, stdinBytes, { flag: "wx" });
    const stdinSha256 = createHash("sha256")
      .update(stdinBytes)
      .digest("hex");

    const providerArguments = [...definition.fixedArgs, ...request.args];
    const packedArguments = packWindowsSupervisorArguments(providerArguments);
    if (request.signal !== undefined && abortSignalAborted(request.signal)) {
      throw new SupervisedProcessError("EXECUTION_CANCELLED");
    }

    const args = Object.freeze([
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "& ([ScriptBlock]::Create($env:INTERVIEW_SUPERVISED_BOOTSTRAP))"
    ]);
    const commandCharacters =
      powershell.length + 1 + args.reduce(
        (total, argument) => total + argument.length + 3,
        0
      );
    if (commandCharacters > MAX_WINDOWS_SUPERVISOR_COMMAND_LINE_CHARACTERS) {
      throw new SupervisedProcessError("INVALID_DEFINITION");
    }

    const supervisorEnvironment = Object.create(null) as NodeJS.ProcessEnv;
    for (const [key, value] of Object.entries(environment)) {
      if (typeof value === "string") supervisorEnvironment[key] = value;
    }
    const reservedControlNames = new Set([
      "INTERVIEW_SUPERVISED_EXECUTABLE",
      "INTERVIEW_SUPERVISED_ARGUMENTS",
      "INTERVIEW_SUPERVISED_CWD",
      "INTERVIEW_SUPERVISED_EXPECTED_SHA256",
      "INTERVIEW_SUPERVISED_STDIN_PATH",
      "INTERVIEW_SUPERVISED_STDIN_BYTES",
      "INTERVIEW_SUPERVISED_STDIN_SHA256",
      "INTERVIEW_SUPERVISED_ASSEMBLY_PATH",
      "INTERVIEW_SUPERVISED_ASSEMBLY_SHA256",
      "INTERVIEW_SUPERVISED_BOOTSTRAP",
      "INTERVIEW_SUPERVISOR_STAGE_DEBUG_FILE"
    ]);
    if (
      Object.keys(supervisorEnvironment).some(
        (key) => reservedControlNames.has(key.toUpperCase())
      )
    ) {
      throw new SupervisedProcessError("INVALID_DEFINITION");
    }
    supervisorEnvironment.INTERVIEW_SUPERVISED_EXECUTABLE =
      expectedIdentity.canonicalPath;
    supervisorEnvironment.INTERVIEW_SUPERVISED_ARGUMENTS = packedArguments;
    supervisorEnvironment.INTERVIEW_SUPERVISED_CWD = workingDirectory ?? "";
    supervisorEnvironment.INTERVIEW_SUPERVISED_EXPECTED_SHA256 =
      expectedIdentity.contentSha256;
    supervisorEnvironment.INTERVIEW_SUPERVISED_STDIN_PATH = stdinPath;
    supervisorEnvironment.INTERVIEW_SUPERVISED_STDIN_BYTES =
      String(stdinBytes.byteLength);
    supervisorEnvironment.INTERVIEW_SUPERVISED_STDIN_SHA256 = stdinSha256;
    supervisorEnvironment.INTERVIEW_SUPERVISED_ASSEMBLY_PATH = assembly.path;
    supervisorEnvironment.INTERVIEW_SUPERVISED_ASSEMBLY_SHA256 = assembly.sha256;
    supervisorEnvironment.INTERVIEW_SUPERVISED_BOOTSTRAP =
      WINDOWS_JOB_SUPERVISOR_SCRIPT;
    if (
      process.env["INTERVIEW_SUPERVISOR_STAGE_DEBUG"] === "1"
      && typeof process.env["INTERVIEW_SUPERVISOR_STAGE_DEBUG_FILE"] === "string"
    ) {
      supervisorEnvironment.INTERVIEW_SUPERVISOR_STAGE_DEBUG_FILE =
        process.env["INTERVIEW_SUPERVISOR_STAGE_DEBUG_FILE"];
    }
    if (
      windowsEnvironmentBlockCharacters(supervisorEnvironment)
      > MAX_WINDOWS_SUPERVISOR_ENVIRONMENT_CHARACTERS
    ) {
      throw new SupervisedProcessError("INVALID_REQUEST");
    }

    return Object.freeze({
      executable: identity.canonicalPath,
      args,
      environment: Object.freeze(supervisorEnvironment),
      identity,
      bootstrapStdin: ""
    });
  }
}

function packWindowsSupervisorArguments(
  arguments_: readonly string[]
): string {
  let output = "";
  for (const argument of arguments_) {
    output += `${String(argument.length)}:${argument}`;
  }
  return output;
}

function traceWindowsSupervisorStage(stage: string): void {
  if (
    process.platform !== "win32"
    || process.env["INTERVIEW_SUPERVISOR_STAGE_DEBUG"] !== "1"
  ) {
    return;
  }
  const target = process.env["INTERVIEW_SUPERVISOR_STAGE_DEBUG_FILE"];
  if (typeof target !== "string" || target.length === 0) return;
  try {
    appendFileSync(
      target,
      `INTERVIEW_SUPERVISOR_STAGE:${stage}\n`,
      { encoding: "utf8" }
    );
  } catch {
    // Temporary diagnostic only; never affect supervised execution semantics.
  }
}

function registerWindowsSupervisorTempDirectory(
  directory: string
): void {
  WINDOWS_SUPERVISOR_TEMP_DIRECTORIES.add(directory);
  if (windowsSupervisorExitCleanupInstalled) return;
  windowsSupervisorExitCleanupInstalled = true;
  process.once("exit", () => {
    for (const candidate of WINDOWS_SUPERVISOR_TEMP_DIRECTORIES) {
      try {
        rmSync(candidate, { recursive: true, force: true });
      } catch {
        // Process-exit cleanup is best effort. Every use revalidates the
        // helper bytes before execution.
      }
    }
    WINDOWS_SUPERVISOR_TEMP_DIRECTORIES.clear();
  });
}

function acquireSharedWindowsSupervisorAssembly(
  powershell: string,
  temporaryRoot: string,
  environment: NodeJS.ProcessEnv
): WindowsSupervisorAssemblyLease {
  const key = windowsSupervisorAssemblyKey(powershell, temporaryRoot);
  let entry = SHARED_WINDOWS_SUPERVISOR_ASSEMBLIES.get(key);
  if (entry === undefined) {
    const controller = new AbortController();
    const promise = compileWindowsSupervisorAssembly(
      temporaryRoot,
      environment,
      controller.signal
    );
    const created: WindowsSupervisorAssemblyEntry = {
      promise,
      controller,
      consumers: 0,
      settled: false
    };
    entry = created;
    SHARED_WINDOWS_SUPERVISOR_ASSEMBLIES.set(key, entry);
    void created.promise.finally(() => {
      created.settled = true;
    }).catch(() => undefined);
    void created.promise.catch(() => {
      if (SHARED_WINDOWS_SUPERVISOR_ASSEMBLIES.get(key) === created) {
        SHARED_WINDOWS_SUPERVISOR_ASSEMBLIES.delete(key);
      }
    });
  }

  entry.consumers += 1;
  let released = false;
  return Object.freeze({
    entry,
    release(): void {
      if (released) return;
      released = true;
      entry.consumers -= 1;
      if (entry.consumers === 0 && !entry.settled) {
        if (SHARED_WINDOWS_SUPERVISOR_ASSEMBLIES.get(key) === entry) {
          SHARED_WINDOWS_SUPERVISOR_ASSEMBLIES.delete(key);
        }
        entry.controller.abort();
      }
    }
  });
}

function windowsSupervisorAssemblyKey(
  powershell: string,
  temporaryRoot: string
): string {
  return `${normalizeWindowsIdentityPath(powershell)}\n${normalizeWindowsIdentityPath(temporaryRoot)}`;
}

function invalidateSharedWindowsSupervisorAssembly(
  powershell: string,
  temporaryRoot: string,
  entry: WindowsSupervisorAssemblyEntry
): void {
  const key = windowsSupervisorAssemblyKey(powershell, temporaryRoot);
  if (SHARED_WINDOWS_SUPERVISOR_ASSEMBLIES.get(key) === entry) {
    SHARED_WINDOWS_SUPERVISOR_ASSEMBLIES.delete(key);
  }
}

async function verifyWindowsSupervisorAssembly(
  assembly: WindowsSupervisorAssembly,
  signal: AbortSignal | undefined
): Promise<boolean> {
  const controller = new AbortController();
  const forwardAbort = (): void => controller.abort();
  if (signal !== undefined) {
    if (abortSignalAborted(signal)) {
      forwardAbort();
    } else {
      addAbortSignalListener(signal, forwardAbort);
    }
  }
  try {
    const [info, canonical] = await Promise.all([
      lstat(assembly.path, { bigint: true }),
      realpath(assembly.path)
    ]);
    const canonicalInfo = await lstat(canonical, { bigint: true });
    if (
      !info.isFile()
      || info.isSymbolicLink()
      || info.size <= 0n
      || info.size > BigInt(MAX_WINDOWS_SUPERVISOR_ASSEMBLY_BYTES)
      || !canonicalInfo.isFile()
      || canonicalInfo.isSymbolicLink()
      || canonicalInfo.dev !== info.dev
      || canonicalInfo.ino !== info.ino
      || canonicalInfo.size !== info.size
    ) {
      return false;
    }
    const digest = await sha256Executable(canonical, controller.signal);
    return digest === assembly.sha256;
  } catch (error) {
    if (
      error instanceof SupervisedProcessError
      && error.code === "EXECUTION_CANCELLED"
    ) {
      throw error;
    }
    return false;
  } finally {
    if (signal !== undefined) {
      removeAbortSignalListener(signal, forwardAbort);
    }
  }
}

async function compileWindowsSupervisorAssembly(
  temporaryRoot: string,
  environment: NodeJS.ProcessEnv,
  signal: AbortSignal
): Promise<WindowsSupervisorAssembly> {
  if (abortSignalAborted(signal)) {
    throw new SupervisedProcessError("EXECUTION_CANCELLED");
  }

  const directory = await mkdtemp(
    path.join(temporaryRoot, "interview-job-supervisor-")
  );
  const output = path.join(directory, "InterviewJobSupervisor.dll");
  const source = path.join(directory, "InterviewJobSupervisor.cs");
  let child: ChildProcessWithoutNullStreams | undefined;
  let succeeded = false;
  try {
    await writeFile(source, WINDOWS_JOB_SUPERVISOR_CSHARP_SOURCE, {
      encoding: "utf8",
      flag: "wx"
    });
    const sourceHash = createHash("sha256")
      .update(WINDOWS_JOB_SUPERVISOR_CSHARP_SOURCE, "utf8")
      .digest("hex");
    if (await sha256Executable(source, signal) !== sourceHash) {
      throw new SupervisedProcessError("EXECUTABLE_UNSAFE");
    }

    const compiler = await windowsCSharpCompilerExecutablePath(environment);
    const compilerEnvironment = windowsSupervisorCompilerEnvironment(
      environment,
      temporaryRoot,
      compiler
    );
    const args = [
      "/nologo",
      "/target:library",
      "/optimize+",
      `/out:${output}`,
      source
    ];

    child = spawn(compiler, args, {
      env: compilerEnvironment,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const compilerChild = child;
    compilerChild.stdin.on("error", () => undefined);
    compilerChild.stdout.on("error", () => undefined);
    compilerChild.stderr.on("error", () => undefined);
    compilerChild.stdin.end();
    compilerChild.stdout.resume();
    compilerChild.stderr.resume();

    const close = Promise.race([
      waitForClose(compilerChild),
      new Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>(
        (resolve) => {
          compilerChild.once("error", () => resolve(
            Object.freeze({ code: null, signal: null })
          ));
        }
      )
    ]);
    let removeAbortListener = (): void => undefined;
    const abortRequested = new Promise<"ABORT">((resolve) => {
      const onAbort = (): void => resolve("ABORT");
      if (abortSignalAborted(signal)) {
        onAbort();
      } else {
        addAbortSignalListener(signal, onAbort);
        removeAbortListener = () => {
          removeAbortSignalListener(signal, onAbort);
        };
      }
    });
    let resolveTimeout = (): void => undefined;
    const timedOut = new Promise<"TIMEOUT">((resolve) => {
      resolveTimeout = () => resolve("TIMEOUT");
    });
    const timeout = setTimeout(
      resolveTimeout,
      WINDOWS_SUPERVISOR_COMPILE_TIMEOUT_MS
    );
    const outcome = await Promise.race([
      close.then((result) => ({ kind: "CLOSE" as const, result })),
      abortRequested.then(() => ({ kind: "ABORT" as const })),
      timedOut.then(() => ({ kind: "TIMEOUT" as const }))
    ]);
    clearTimeout(timeout);
    removeAbortListener();

    if (outcome.kind !== "CLOSE") {
      const cleaned = await terminateProcessTree(
        child,
        "win32",
        compilerEnvironment
      );
      if (!cleaned) {
        throw new SupervisedProcessError("PROCESS_TREE_CLEANUP_FAILED");
      }
      throw new SupervisedProcessError(
        outcome.kind === "ABORT"
          ? "EXECUTION_CANCELLED"
          : "EXECUTION_TIMEOUT"
      );
    }
    if (outcome.result.code === null) {
      throw new SupervisedProcessError("SPAWN_FAILED");
    }
    if (outcome.result.code !== 0) {
      throw new SupervisedProcessError("EXECUTABLE_UNSAFE");
    }

    if (await sha256Executable(source, signal) !== sourceHash) {
      throw new SupervisedProcessError("EXECUTABLE_UNSAFE");
    }

    const info = await lstat(output, { bigint: true });
    const canonical = await realpath(output);
    const canonicalInfo = await lstat(canonical, { bigint: true });
    if (
      !info.isFile()
      || info.isSymbolicLink()
      || info.size <= 0n
      || info.size > BigInt(MAX_WINDOWS_SUPERVISOR_ASSEMBLY_BYTES)
      || !canonicalInfo.isFile()
      || canonicalInfo.isSymbolicLink()
      || canonicalInfo.dev !== info.dev
      || canonicalInfo.ino !== info.ino
      || canonicalInfo.size !== info.size
    ) {
      throw new SupervisedProcessError("EXECUTABLE_UNSAFE");
    }

    const hashController = new AbortController();
    const forwardAbort = (): void => {
      hashController.abort();
    };
    if (abortSignalAborted(signal)) {
      forwardAbort();
    } else {
      addAbortSignalListener(signal, forwardAbort);
    }
    let sha256: string;
    try {
      sha256 = await sha256Executable(canonical, hashController.signal);
    } finally {
      removeAbortSignalListener(signal, forwardAbort);
    }

    registerWindowsSupervisorTempDirectory(directory);
    succeeded = true;
    return Object.freeze({
      path: canonical,
      sha256
    });
  } catch (error) {
    if (error instanceof SupervisedProcessError) throw error;
    throw new SupervisedProcessError("EXECUTABLE_UNSAFE");
  } finally {
    child?.stdin.destroy();
    child?.stdout.destroy();
    child?.stderr.destroy();
    if (!succeeded) {
      try {
        await rm(directory, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 50
        });
      } catch {
        // No provider/session data is written here. The failed compiler
        // directory is untrusted and will not be reused by the cache.
      }
    }
  }
}

function windowsSupervisorCompilerEnvironment(
  environment: NodeJS.ProcessEnv,
  temporaryRoot: string,
  compiler: string
): NodeJS.ProcessEnv {
  const result = Object.create(null) as NodeJS.ProcessEnv;
  const system32 = windowsSystem32ExecutablePath(environment);
  const systemRoot = win32Path.dirname(system32);
  result.SYSTEMROOT = systemRoot;
  result.WINDIR = systemRoot;
  result.PATH = `${win32Path.dirname(compiler)};${system32}`;
  result.PATHEXT = ".COM;.EXE;.BAT;.CMD";
  result.TEMP = temporaryRoot;
  result.TMP = temporaryRoot;
  if (
    windowsEnvironmentBlockCharacters(result)
    > MAX_WINDOWS_SUPERVISOR_ENVIRONMENT_CHARACTERS
  ) {
    throw new SupervisedProcessError("INVALID_DEFINITION");
  }
  return Object.freeze(result);
}

async function windowsCSharpCompilerExecutablePath(
  environment: NodeJS.ProcessEnv
): Promise<string> {
  const system32 = windowsSystem32ExecutablePath(environment);
  const systemRoot = win32Path.dirname(system32);
  const candidates = [
    win32Path.join(
      systemRoot,
      "Microsoft.NET",
      "Framework64",
      "v4.0.30319",
      "csc.exe"
    ),
    win32Path.join(
      systemRoot,
      "Microsoft.NET",
      "Framework",
      "v4.0.30319",
      "csc.exe"
    )
  ];
  for (const candidate of candidates) {
    try {
      // Windows servicing commonly hard-links protected framework binaries
      // into the component store. The compiler is selected only from these
      // fixed SystemRoot locations and still passes canonical-path/reparse/
      // file-identity validation; do not apply the provider-image single-link
      // rule to this trusted OS tool.
      const identity = await inspectExecutable(candidate, "win32");
      return identity.canonicalPath;
    } catch {
      // Try the next application-owned framework location.
    }
  }
  throw new SupervisedProcessError("EXECUTABLE_UNAVAILABLE");
}

function snapshotExecutableDefinitions(
  value: unknown,
  platform: NodeJS.Platform
): readonly ExecutableDefinitionSnapshot[] {
  if (
    typeof value !== "object"
    || value === null
    || utilTypes.isProxy(value)
    || !Array.isArray(value)
  ) {
    throw new SupervisedProcessError("INVALID_DEFINITION");
  }
  let descriptors: Readonly<Record<string, PropertyDescriptor>>;
  let symbols: readonly symbol[];
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
    symbols = Object.getOwnPropertySymbols(value);
  } catch {
    throw new SupervisedProcessError("INVALID_DEFINITION");
  }
  const rawLength = Object.getOwnPropertyDescriptor(value, "length")?.value as unknown;
  if (
    symbols.length !== 0
    || typeof rawLength !== "number"
    || !Number.isSafeInteger(rawLength)
    || rawLength <= 0
    || rawLength > MAX_EXECUTABLES
  ) {
    throw new SupervisedProcessError("INVALID_DEFINITION");
  }

  const allowedKeys = new Set<string>(["length"]);
  const output: ExecutableDefinitionSnapshot[] = [];
  for (let index = 0; index < rawLength; index += 1) {
    const key = String(index);
    allowedKeys.add(key);
    const descriptor = descriptors[key];
    if (
      descriptor === undefined
      || descriptor.enumerable !== true
      || !("value" in descriptor)
    ) {
      throw new SupervisedProcessError("INVALID_DEFINITION");
    }
    output.push(snapshotExecutableDefinition(
      descriptor.value as SupervisedExecutableDefinition,
      platform
    ));
  }
  for (const key of Object.keys(descriptors)) {
    if (!allowedKeys.has(key)) {
      throw new SupervisedProcessError("INVALID_DEFINITION");
    }
  }
  return Object.freeze(output);
}

function snapshotExecutableDefinition(
  input: SupervisedExecutableDefinition,
  platform: NodeJS.Platform
): ExecutableDefinitionSnapshot {
  const record = inspectPlainRecord(input, new Set([
    "id",
    "executable",
    "fixedArgs",
    "environment",
    "isolatedWorkingDirectory",
    "isolatedHomeFiles"
  ]), "INVALID_DEFINITION");
  if (
    typeof record.id !== "string"
    || !EXECUTABLE_ID.test(record.id)
    || typeof record.executable !== "string"
    || record.executable.includes("\0")
    || !path.isAbsolute(record.executable)
  ) {
    throw new SupervisedProcessError("INVALID_DEFINITION");
  }
  const fixedArgs = snapshotArguments(record.fixedArgs, "INVALID_DEFINITION");
  const canonicalConfiguredPath = path.normalize(record.executable);
  if (
    platform === "win32"
    && !windowsCommandLineWithinBudget(canonicalConfiguredPath, fixedArgs)
  ) {
    throw new SupervisedProcessError("INVALID_DEFINITION");
  }
  if (
    platform === "win32"
      ? canonicalConfiguredPath.startsWith("\\\\")
      : canonicalConfiguredPath.length === 0
  ) {
    throw new SupervisedProcessError("INVALID_DEFINITION");
  }
  const isolatedWorkingDirectory = record.isolatedWorkingDirectory === undefined
    ? false
    : record.isolatedWorkingDirectory;
  if (typeof isolatedWorkingDirectory !== "boolean") {
    throw new SupervisedProcessError("INVALID_DEFINITION");
  }
  const environment = record.environment as LocalEnvironmentDefinition | undefined;
  const isolatedHomeFiles = snapshotIsolatedHomeFiles(record.isolatedHomeFiles);
  return Object.freeze({
    id: record.id,
    executable: canonicalConfiguredPath,
    fixedArgs,
    ...(environment === undefined ? {} : { environment }),
    isolatedWorkingDirectory,
    ...(isolatedHomeFiles === undefined ? {} : { isolatedHomeFiles })
  });
}

function snapshotIsolatedHomeFiles(
  value: unknown
): readonly IsolatedHomeFile[] | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "object"
    || value === null
    || utilTypes.isProxy(value)
    || Array.isArray(value)
  ) {
    throw new SupervisedProcessError("INVALID_DEFINITION");
  }

  let prototype: object | null;
  let descriptors: Readonly<Record<string, PropertyDescriptor>>;
  let symbols: readonly symbol[];
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
    descriptors = Object.getOwnPropertyDescriptors(value);
    symbols = Object.getOwnPropertySymbols(value);
  } catch {
    throw new SupervisedProcessError("INVALID_DEFINITION");
  }
  if (
    (prototype !== Object.prototype && prototype !== null)
    || symbols.length !== 0
  ) {
    throw new SupervisedProcessError("INVALID_DEFINITION");
  }

  const entries = Object.entries(descriptors);
  if (entries.length > MAX_ISOLATED_HOME_FILES) {
    throw new SupervisedProcessError("INVALID_DEFINITION");
  }

  const output: IsolatedHomeFile[] = [];
  let totalBytes = 0;
  for (const [relativePath, descriptor] of entries) {
    if (
      descriptor.enumerable !== true
      || !("value" in descriptor)
      || relativePath.length === 0
      || relativePath.includes("\\")
      || relativePath.startsWith("/")
      || relativePath.includes("\0")
      || Buffer.byteLength(relativePath, "utf8") > MAX_ISOLATED_HOME_PATH_BYTES
    ) {
      throw new SupervisedProcessError("INVALID_DEFINITION");
    }
    const segments = relativePath.split("/");
    if (
      segments.length > MAX_ISOLATED_HOME_PATH_SEGMENTS
      || segments.some((segment) =>
        !ISOLATED_HOME_PATH_SEGMENT.test(segment)
        || WINDOWS_RESERVED_PATH_SEGMENT.test(segment)
      )
    ) {
      throw new SupervisedProcessError("INVALID_DEFINITION");
    }
    const content: unknown = descriptor.value;
    if (typeof content !== "string" || content.includes("\0")) {
      throw new SupervisedProcessError("INVALID_DEFINITION");
    }
    const bytes = Buffer.byteLength(content, "utf8");
    totalBytes += bytes;
    if (
      bytes > MAX_ISOLATED_HOME_FILE_BYTES
      || totalBytes > MAX_ISOLATED_HOME_TOTAL_BYTES
    ) {
      throw new SupervisedProcessError("INVALID_DEFINITION");
    }
    output.push(Object.freeze({ relativePath, content }));
  }

  output.sort((left, right) =>
    left.relativePath < right.relativePath
      ? -1
      : left.relativePath > right.relativePath ? 1 : 0
  );
  for (let index = 1; index < output.length; index += 1) {
    const previous = output[index - 1];
    const current = output[index];
    if (
      previous !== undefined
      && current !== undefined
      && current.relativePath.startsWith(previous.relativePath + "/")
    ) {
      throw new SupervisedProcessError("INVALID_DEFINITION");
    }
  }
  return Object.freeze(output);
}

function snapshotExecutionRequest(input: SupervisedProcessExecutionRequest): {
  readonly executableId: string;
  readonly args: readonly string[];
  readonly stdin: string;
  readonly timeoutMs: number;
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
  readonly signal?: AbortSignal;
  readonly onProcessStart?: () => void;
} {
  const record = inspectPlainRecord(input, new Set([
    "executableId", "args", "stdin", "timeoutMs", "maxStdoutBytes",
    "maxStderrBytes", "signal", "onProcessStart"
  ]), "INVALID_REQUEST");
  if (typeof record.executableId !== "string" || !EXECUTABLE_ID.test(record.executableId)) {
    throw new SupervisedProcessError("INVALID_REQUEST");
  }
  const args = snapshotArguments(record.args, "INVALID_REQUEST");
  const stdin = record.stdin === undefined ? "" : record.stdin;
  if (
    typeof stdin !== "string"
    || Buffer.byteLength(stdin, "utf8") > MAX_STDIN_BYTES
    || stdin.includes("\0")
  ) {
    throw new SupervisedProcessError("INVALID_REQUEST");
  }
  const timeoutMs = boundedPositiveInteger(record.timeoutMs, MAX_EXECUTION_MS);
  const maxStdoutBytes = boundedPositiveInteger(record.maxStdoutBytes, MAX_STDOUT_BYTES);
  const maxStderrBytes = boundedPositiveInteger(record.maxStderrBytes, MAX_STDERR_BYTES);
  if (timeoutMs === undefined || maxStdoutBytes === undefined || maxStderrBytes === undefined) {
    throw new SupervisedProcessError("INVALID_REQUEST");
  }
  const signal = record.signal;
  if (
    signal !== undefined
    && (
      typeof signal !== "object"
      || signal === null
      || utilTypes.isProxy(signal)
      || !(signal instanceof AbortSignal)
      || !isTrustedAbortSignal(signal)
    )
  ) {
    throw new SupervisedProcessError("INVALID_REQUEST");
  }
  const onProcessStart = record.onProcessStart;
  if (onProcessStart !== undefined && typeof onProcessStart !== "function") {
    throw new SupervisedProcessError("INVALID_REQUEST");
  }
  return Object.freeze({
    executableId: record.executableId,
    args,
    stdin,
    timeoutMs,
    maxStdoutBytes,
    maxStderrBytes,
    ...(signal === undefined ? {} : { signal }),
    ...(onProcessStart === undefined ? {} : { onProcessStart: onProcessStart as () => void })
  });
}

function inspectPlainRecord(
  value: unknown,
  allowed: ReadonlySet<string>,
  code: "INVALID_DEFINITION" | "INVALID_REQUEST"
): Readonly<Record<string, unknown>> {
  if (
    typeof value !== "object"
    || value === null
    || utilTypes.isProxy(value)
    || Array.isArray(value)
  ) {
    throw new SupervisedProcessError(code);
  }
  let prototype: object | null;
  let descriptors: Readonly<Record<string, PropertyDescriptor>>;
  let symbols: readonly symbol[];
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
    descriptors = Object.getOwnPropertyDescriptors(value);
    symbols = Object.getOwnPropertySymbols(value);
  } catch {
    throw new SupervisedProcessError(code);
  }
  if ((prototype !== Object.prototype && prototype !== null) || symbols.length !== 0) {
    throw new SupervisedProcessError(code);
  }
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (
      !allowed.has(key)
      || descriptor.enumerable !== true
      || !("value" in descriptor)
    ) {
      throw new SupervisedProcessError(code);
    }
    output[key] = descriptor.value;
  }
  return Object.freeze(output);
}

function snapshotArguments(
  value: unknown,
  code: "INVALID_DEFINITION" | "INVALID_REQUEST"
): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  if (
    typeof value !== "object"
    || value === null
    || utilTypes.isProxy(value)
    || !Array.isArray(value)
  ) {
    throw new SupervisedProcessError(code);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const rawLength = Object.getOwnPropertyDescriptor(value, "length")?.value as unknown;
  if (
    typeof rawLength !== "number"
    || !Number.isSafeInteger(rawLength)
    || rawLength < 0
    || rawLength > MAX_ARGUMENTS
  ) {
    throw new SupervisedProcessError(code);
  }
  const output: string[] = [];
  let bytes = 0;
  for (let index = 0; index < rawLength; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !("value" in descriptor) || typeof descriptor.value !== "string") {
      throw new SupervisedProcessError(code);
    }
    const argument = descriptor.value;
    if (argument.includes("\0")) throw new SupervisedProcessError(code);
    bytes += Buffer.byteLength(argument, "utf8");
    if (bytes > MAX_ARGUMENT_BYTES) throw new SupervisedProcessError(code);
    output.push(argument);
  }
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (key === "length" || descriptor.enumerable !== true) continue;
    if (!/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= rawLength) {
      throw new SupervisedProcessError(code);
    }
  }
  return Object.freeze(output);
}

function isTrustedAbortSignal(signal: AbortSignal): boolean {
  try {
    if (Object.getPrototypeOf(signal) !== AbortSignal.prototype) return false;
    const descriptors: Readonly<Record<string, PropertyDescriptor | undefined>> =
      Object.getOwnPropertyDescriptors(signal);
    return descriptors["aborted"] === undefined
      && descriptors["reason"] === undefined
      && descriptors["addEventListener"] === undefined
      && descriptors["removeEventListener"] === undefined;
  } catch {
    return false;
  }
}

function abortSignalAborted(signal: AbortSignal): boolean {
  if (ABORT_SIGNAL_ABORTED_GETTER_INTRINSIC === undefined) {
    throw new SupervisedProcessError("INVALID_REQUEST");
  }
  let value: unknown;
  try {
    value = REFLECT_APPLY_INTRINSIC(
      ABORT_SIGNAL_ABORTED_GETTER_INTRINSIC,
      signal,
      []
    );
  } catch {
    throw new SupervisedProcessError("INVALID_REQUEST");
  }
  if (typeof value !== "boolean") {
    throw new SupervisedProcessError("INVALID_REQUEST");
  }
  return value;
}

function addAbortSignalListener(
  signal: AbortSignal,
  listener: () => void
): void {
  try {
    REFLECT_APPLY_INTRINSIC(
      ABORT_SIGNAL_ADD_EVENT_LISTENER_INTRINSIC,
      signal,
      ["abort", listener, { once: true }]
    );
  } catch {
    throw new SupervisedProcessError("INVALID_REQUEST");
  }
}

function removeAbortSignalListener(
  signal: AbortSignal,
  listener: () => void
): void {
  try {
    REFLECT_APPLY_INTRINSIC(
      ABORT_SIGNAL_REMOVE_EVENT_LISTENER_INTRINSIC,
      signal,
      ["abort", listener]
    );
  } catch {
    throw new SupervisedProcessError("INVALID_REQUEST");
  }
}

function boundedPositiveInteger(value: unknown, maximum: number): number | undefined {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value > 0
    && value <= maximum
    ? value
    : undefined;
}

async function inspectExecutable(
  executable: string,
  platform: NodeJS.Platform
): Promise<ExecutableIdentity> {
  try {
    if (platform === "win32") {
      await assertNoWindowsParentReparsePoints(executable);
    }
    const [info, canonicalPath] = await Promise.all([
      lstat(executable, { bigint: true }),
      realpath(executable)
    ]);
    if (
      !info.isFile()
      || info.isSymbolicLink()
      || info.size <= 0n
      || info.size > MAX_EXECUTABLE_BYTES
    ) {
      throw new SupervisedProcessError("EXECUTABLE_UNSAFE");
    }
    const configured = path.resolve(executable);
    const actual = path.resolve(canonicalPath);
    if (platform !== "win32" && configured !== actual) {
      throw new SupervisedProcessError("EXECUTABLE_UNSAFE");
    }
    if (platform === "win32") {
      const canonicalInfo = await lstat(actual, { bigint: true });
      if (
        !canonicalInfo.isFile()
        || canonicalInfo.isSymbolicLink()
        || canonicalInfo.dev !== info.dev
        || canonicalInfo.ino !== info.ino
      ) {
        throw new SupervisedProcessError("EXECUTABLE_UNSAFE");
      }
    }
    return Object.freeze({
      device: info.dev,
      inode: info.ino,
      linkCount: info.nlink,
      size: info.size,
      modifiedNanoseconds: info.mtimeNs,
      canonicalPath: actual
    });
  } catch (error) {
    if (error instanceof SupervisedProcessError) throw error;
    throw new SupervisedProcessError("EXECUTABLE_UNAVAILABLE");
  }
}

function tryInspectExecutableSync(
  executable: string,
  platform: NodeJS.Platform
): ExecutableIdentity | undefined {
  try {
    if (
      platform === "win32"
      && windowsParentPathContainsReparsePointSync(executable)
    ) {
      return undefined;
    }
    const info = lstatSync(executable, { bigint: true });
    const canonicalPath = realpathSync(executable);
    if (
      !info.isFile()
      || info.isSymbolicLink()
      || info.size <= 0n
      || info.size > MAX_EXECUTABLE_BYTES
    ) return undefined;
    const configured = path.resolve(executable);
    const actual = path.resolve(canonicalPath);
    if (platform !== "win32" && configured !== actual) return undefined;
    if (platform === "win32") {
      const canonicalInfo = lstatSync(actual, { bigint: true });
      if (
        !canonicalInfo.isFile()
        || canonicalInfo.isSymbolicLink()
        || canonicalInfo.dev !== info.dev
        || canonicalInfo.ino !== info.ino
      ) {
        return undefined;
      }
    }
    return Object.freeze({
      device: info.dev,
      inode: info.ino,
      linkCount: info.nlink,
      size: info.size,
      modifiedNanoseconds: info.mtimeNs,
      canonicalPath: actual
    });
  } catch {
    return undefined;
  }
}

async function sha256Executable(
  executable: string,
  signal: AbortSignal
): Promise<string> {
  if (abortSignalAborted(signal)) {
    throw new SupervisedProcessError("EXECUTION_CANCELLED");
  }
  const hash = createHash("sha256");
  const stream = createReadStream(executable);
  const onAbort = (): void => {
    stream.destroy(new SupervisedProcessError("EXECUTION_CANCELLED"));
  };
  addAbortSignalListener(signal, onAbort);
  const timer = setTimeout(() => {
    stream.destroy(new SupervisedProcessError("EXECUTION_TIMEOUT"));
  }, EXECUTABLE_HASH_TIMEOUT_MS);
  try {
    for await (const chunk of stream) {
      const chunkValue: unknown = chunk;
      if (!Buffer.isBuffer(chunkValue)) {
        throw new SupervisedProcessError("EXECUTABLE_UNSAFE");
      }
      hash.update(chunkValue);
    }
    return hash.digest("hex");
  } catch (error) {
    if (error instanceof SupervisedProcessError) throw error;
    throw new SupervisedProcessError("EXECUTABLE_UNSAFE");
  } finally {
    clearTimeout(timer);
    removeAbortSignalListener(signal, onAbort);
    stream.destroy();
  }
}

async function settleWithin(
  operations: readonly Promise<unknown>[],
  timeoutMs: number
): Promise<readonly PromiseSettledResult<unknown>[] | undefined> {
  if (operations.length === 0) return [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), timeoutMs);
  });
  const settled = Promise.allSettled(operations);
  const result = await Promise.race([settled, timeout]);
  if (timer !== undefined) clearTimeout(timer);
  return result;
}

function waitForOperationOrAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined
): Promise<T> {
  if (signal === undefined) return operation;
  if (abortSignalAborted(signal)) {
    return Promise.reject(new SupervisedProcessError("EXECUTION_CANCELLED"));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = (): boolean => {
      if (settled) return false;
      settled = true;
      removeAbortSignalListener(signal, onAbort);
      return true;
    };
    const onAbort = (): void => {
      if (!cleanup()) return;
      reject(new SupervisedProcessError("EXECUTION_CANCELLED"));
    };
    addAbortSignalListener(signal, onAbort);
    void operation.then(
      (value) => {
        if (!cleanup()) return;
        resolve(value);
      },
      (error: unknown) => {
        if (!cleanup()) return;
        reject(error instanceof Error
          ? error
          : new SupervisedProcessError("EXECUTABLE_UNSAFE"));
      }
    );
  });
}

function windowsCommandLineWithinBudget(
  executable: string,
  args: readonly string[]
): boolean {
  let upperBound = executable.length * 2 + 2;
  for (const argument of args) {
    upperBound += argument.length * 2 + 3;
    if (upperBound > MAX_WINDOWS_PROVIDER_COMMAND_LINE_CHARACTERS) return false;
  }
  return upperBound <= MAX_WINDOWS_PROVIDER_COMMAND_LINE_CHARACTERS;
}

function windowsEnvironmentBlockCharacters(
  environment: NodeJS.ProcessEnv
): number {
  let characters = 1;
  for (const [key, value] of Object.entries(environment)) {
    if (typeof value !== "string") continue;
    characters += key.length + 1 + value.length + 1;
    if (characters > MAX_WINDOWS_SUPERVISOR_ENVIRONMENT_CHARACTERS) {
      return characters;
    }
  }
  return characters;
}

function windowsPowerShellExecutablePath(
  environment: NodeJS.ProcessEnv
): string {
  const system32 = windowsSystem32ExecutablePath(environment);
  return win32Path.join(
    system32,
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
}

function windowsSystem32ExecutablePath(
  environment: NodeJS.ProcessEnv,
  executable?: string
): string {
  let systemRoot: string | undefined;
  for (const [key, value] of Object.entries(environment)) {
    if (key.toUpperCase() !== "SYSTEMROOT" || typeof value !== "string") continue;
    if (systemRoot !== undefined && systemRoot !== value) {
      throw new SupervisedProcessError("EXECUTABLE_UNSAFE");
    }
    systemRoot = value;
  }
  if (
    systemRoot === undefined
    || systemRoot.length === 0
    || systemRoot.includes("\0")
    || !win32Path.isAbsolute(systemRoot)
    || systemRoot.startsWith("\\\\")
  ) {
    throw new SupervisedProcessError("EXECUTABLE_UNSAFE");
  }
  const normalizedRoot = win32Path.normalize(systemRoot);
  const parsedRoot = win32Path.parse(normalizedRoot);
  if (
    win32Path.basename(normalizedRoot).toLowerCase() !== "windows"
    || win32Path.dirname(normalizedRoot).toLowerCase()
      !== parsedRoot.root.toLowerCase()
  ) {
    throw new SupervisedProcessError("EXECUTABLE_UNSAFE");
  }
  const system32 = win32Path.join(normalizedRoot, "System32");
  return executable === undefined
    ? system32
    : win32Path.join(system32, executable);
}

function trustedWindowsTemporaryRoot(): string {
  const configured = win32Path.normalize(tmpdir());
  if (
    configured.length === 0
    || !win32Path.isAbsolute(configured)
    || configured.startsWith("\\\\")
  ) {
    throw new SupervisedProcessError("INVALID_DEFINITION");
  }

  try {
    if (windowsParentPathContainsReparsePointSync(configured)) {
      throw new SupervisedProcessError("INVALID_DEFINITION");
    }
    const info = lstatSync(configured, { bigint: true });
    const canonical = realpathSync(configured);
    const canonicalInfo = lstatSync(canonical, { bigint: true });
    if (
      !info.isDirectory()
      || info.isSymbolicLink()
      || !canonicalInfo.isDirectory()
      || canonicalInfo.isSymbolicLink()
      || canonicalInfo.dev !== info.dev
      || canonicalInfo.ino !== info.ino
    ) {
      throw new SupervisedProcessError("INVALID_DEFINITION");
    }
  } catch (error) {
    if (error instanceof SupervisedProcessError) throw error;
    throw new SupervisedProcessError("INVALID_DEFINITION");
  }
  return configured;
}

async function assertNoWindowsParentReparsePoints(
  executable: string
): Promise<void> {
  const parent = win32Path.dirname(win32Path.resolve(executable));
  const root = win32Path.parse(parent).root;
  const relative = win32Path.relative(root, parent);
  let current = root;
  if (relative.length === 0) return;
  for (const segment of relative.split(win32Path.sep)) {
    current = win32Path.join(current, segment);
    const info = await lstat(current, { bigint: true });
    if (info.isSymbolicLink()) {
      throw new SupervisedProcessError("EXECUTABLE_UNSAFE");
    }
  }
}

function windowsParentPathContainsReparsePointSync(
  executable: string
): boolean {
  const parent = win32Path.dirname(win32Path.resolve(executable));
  const root = win32Path.parse(parent).root;
  const relative = win32Path.relative(root, parent);
  let current = root;
  if (relative.length === 0) return false;
  for (const segment of relative.split(win32Path.sep)) {
    current = win32Path.join(current, segment);
    if (lstatSync(current, { bigint: true }).isSymbolicLink()) return true;
  }
  return false;
}

function normalizeWindowsIdentityPath(value: string): string {
  let normalized = win32Path.resolve(value).replaceAll("/", "\\");
  if (normalized.toLowerCase().startsWith("\\\\?\\unc\\")) {
    normalized = "\\\\" + normalized.slice(8);
  } else if (normalized.startsWith("\\\\?\\")) {
    normalized = normalized.slice(4);
  }
  return normalized.toLowerCase();
}

function sameExecutableIdentity(
  left: ExecutableIdentity,
  right: ExecutableIdentity,
  platform: NodeJS.Platform
): boolean {
  const samePath = platform === "win32"
    ? true
    : left.canonicalPath === right.canonicalPath;
  return samePath
    && left.device === right.device
    && left.inode === right.inode
    && left.linkCount === right.linkCount
    && left.size === right.size
    && left.modifiedNanoseconds === right.modifiedNanoseconds;
}

async function createExecutionIsolation(
  definition: RegisteredExecutable,
  platform: NodeJS.Platform,
  temporaryRoot: string
): Promise<ExecutionIsolation> {
  let workingDirectory: string | undefined;
  let homeDirectory: string | undefined;
  let controlDirectory: string | undefined;
  try {
    if (platform === "win32") {
      controlDirectory = await mkdtemp(
        path.join(temporaryRoot, "interview-provider-control-")
      );
    }
    const environment = Object.create(null) as NodeJS.ProcessEnv;
    for (const [key, value] of Object.entries(definition.environment)) {
      if (typeof value === "string") environment[key] = value;
    }

    if (definition.isolatedHomeFiles !== undefined) {
      homeDirectory = await mkdtemp(
        path.join(temporaryRoot, "interview-provider-home-")
      );
      if (platform !== "win32") await chmod(homeDirectory, 0o700);
      await populateIsolatedHome(
        homeDirectory,
        definition.isolatedHomeFiles,
        platform
      );
      const isolatedTempDirectory = path.join(homeDirectory, "tmp");
      await mkdir(isolatedTempDirectory, {
        recursive: true,
        ...(platform === "win32" ? {} : { mode: 0o700 })
      });
      applyIsolatedHomeEnvironment(
        environment,
        homeDirectory,
        isolatedTempDirectory,
        platform
      );
    }

    if (definition.isolatedWorkingDirectory) {
      workingDirectory = await createIsolatedWorkingDirectory(temporaryRoot);
    }

    return Object.freeze({
      environment: Object.freeze(environment),
      ...(workingDirectory === undefined ? {} : { workingDirectory }),
      ...(homeDirectory === undefined ? {} : { homeDirectory }),
      ...(controlDirectory === undefined ? {} : { controlDirectory })
    });
  } catch (error) {
    try {
      await cleanupExecutionIsolation({
        environment: Object.freeze(Object.create(null) as NodeJS.ProcessEnv),
        ...(workingDirectory === undefined ? {} : { workingDirectory }),
        ...(homeDirectory === undefined ? {} : { homeDirectory }),
        ...(controlDirectory === undefined ? {} : { controlDirectory })
      });
    } catch {
      throw new SupervisedProcessError("PROCESS_TREE_CLEANUP_FAILED");
    }
    if (error instanceof SupervisedProcessError) throw error;
    throw new SupervisedProcessError("INVALID_DEFINITION");
  }
}

async function populateIsolatedHome(
  homeDirectory: string,
  files: readonly IsolatedHomeFile[],
  platform: NodeJS.Platform
): Promise<void> {
  for (const file of files) {
    const segments = file.relativePath.split("/");
    const target = path.join(homeDirectory, ...segments);
    const parent = path.dirname(target);
    await mkdir(parent, {
      recursive: true,
      ...(platform === "win32" ? {} : { mode: 0o700 })
    });
    await writeFile(target, file.content, {
      encoding: "utf8",
      flag: "wx",
      ...(platform === "win32" ? {} : { mode: 0o600 })
    });
  }
}

function applyIsolatedHomeEnvironment(
  environment: NodeJS.ProcessEnv,
  homeDirectory: string,
  tempDirectory: string,
  platform: NodeJS.Platform
): void {
  if (platform === "win32") {
    environment.USERPROFILE = homeDirectory;
    environment.APPDATA = path.join(homeDirectory, "AppData", "Roaming");
    environment.LOCALAPPDATA = path.join(homeDirectory, "AppData", "Local");
    environment.TEMP = tempDirectory;
    environment.TMP = tempDirectory;
    return;
  }

  environment.HOME = homeDirectory;
  environment.XDG_CONFIG_HOME = path.join(homeDirectory, ".config");
  environment.XDG_DATA_HOME = path.join(homeDirectory, ".local", "share");
  environment.XDG_CACHE_HOME = path.join(homeDirectory, ".cache");
  environment.TMPDIR = tempDirectory;
  environment.TMP = tempDirectory;
  environment.TEMP = tempDirectory;
}

async function cleanupExecutionIsolation(
  isolation: ExecutionIsolation
): Promise<void> {
  let failed = false;
  if (isolation.workingDirectory !== undefined) {
    try {
      await rm(isolation.workingDirectory, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 50
      });
    } catch {
      failed = true;
    }
  }
  if (isolation.homeDirectory !== undefined) {
    try {
      await rm(isolation.homeDirectory, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 50
      });
    } catch {
      failed = true;
    }
  }
  if (isolation.controlDirectory !== undefined) {
    try {
      await rm(isolation.controlDirectory, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 50
      });
    } catch {
      failed = true;
    }
  }
  if (failed) {
    throw new SupervisedProcessError("PROCESS_TREE_CLEANUP_FAILED");
  }
}

async function createIsolatedWorkingDirectory(
  temporaryRoot: string
): Promise<string> {
  const directory = await mkdtemp(
    path.join(temporaryRoot, "interview-provider-")
  );
  if (process.platform !== "win32") {
    await chmod(directory, 0o700);
  }
  return directory;
}

function waitForSpawn(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.pid !== undefined) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      child.off("spawn", onSpawn);
      child.off("error", onError);
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
      reject(new SupervisedProcessError("SPAWN_FAILED"));
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

function waitForClose(
  child: ChildProcessWithoutNullStreams
): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(Object.freeze({ code: child.exitCode, signal: child.signalCode }));
  }
  return new Promise((resolve) => {
    child.once("close", (code, signal) => resolve(Object.freeze({ code, signal })));
  });
}

function writeBoundedStdin(
  child: ChildProcessWithoutNullStreams,
  value: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    child.stdin.end(value, "utf8", (error?: Error | null) => {
      if (error === undefined || error === null) {
        resolve();
      } else {
        reject(new SupervisedProcessError("SPAWN_FAILED"));
      }
    });
  });
}

function isProcessAlive(child: ChildProcessWithoutNullStreams): boolean {
  return child.pid !== undefined && child.exitCode === null && child.signalCode === null;
}

async function terminateProcessTree(
  child: ChildProcessWithoutNullStreams,
  platform: NodeJS.Platform,
  environment?: NodeJS.ProcessEnv
): Promise<boolean> {
  const pid = child.pid;
  if (pid === undefined) {
    try {
      child.kill();
    } catch {
      return false;
    }
    return true;
  }

  if (platform === "win32") {
    if (!isProcessAlive(child)) {
      // Cleanup is requested only before the child's close event has been
      // accepted. A dead root with an unclosed stdio tree can mean a bootstrap
      // helper still owns inherited handles, so root absence is not proof of
      // descendant absence.
      return false;
    }

    const treeKilled = environment !== undefined
      && await runWindowsTaskkill(pid, environment);
    if (treeKilled) {
      return await waitForChildExit(child, TREE_FORCE_MS);
    }

    // Root-only termination still closes the bootstrap's Job Object, but it
    // cannot prove that application-owned bootstrap helpers (for example a
    // compiler process created before the provider Job exists) were removed.
    // Perform it as best-effort containment, then fail closed.
    try {
      child.kill();
    } catch {
      return false;
    }
    await waitForChildExit(child, TREE_FORCE_MS);
    return false;
  }

  signalPosixGroup(child, "SIGTERM");
  if (await waitForPosixGroupExit(pid, TREE_GRACE_MS)) return true;
  signalPosixGroup(child, "SIGKILL");
  return await waitForPosixGroupExit(pid, TREE_FORCE_MS);
}

async function runWindowsTaskkill(
  pid: number,
  environment: NodeJS.ProcessEnv
): Promise<boolean> {
  let executable: string;
  try {
    executable = windowsSystem32ExecutablePath(environment, "taskkill.exe");
  } catch {
    return false;
  }

  let task: ReturnType<typeof spawn>;
  try {
    task = spawn(
      executable,
      ["/PID", String(pid), "/T", "/F"],
      {
        env: minimalWindowsHelperEnvironment(environment),
        shell: false,
        windowsHide: true,
        stdio: "ignore"
      }
    );
  } catch {
    return false;
  }

  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (success: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(success);
    };
    task.once("error", () => finish(false));
    task.once("close", (code) => finish(code === 0));
    const timer = setTimeout(() => {
      try {
        task.kill();
      } catch {
        // The trusted helper may already have exited.
      }
      finish(false);
    }, TREE_FORCE_MS);
  });
}

function minimalWindowsHelperEnvironment(
  environment: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  const allowed = new Set(["SYSTEMROOT", "WINDIR", "PATH", "PATHEXT"]);
  const output = Object.create(null) as NodeJS.ProcessEnv;
  for (const [key, value] of Object.entries(environment)) {
    const canonical = key.toUpperCase();
    if (
      allowed.has(canonical)
      && typeof value === "string"
      && output[canonical] === undefined
    ) {
      output[canonical] = value;
    }
  }
  return Object.freeze(output);
}

async function waitForChildExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(child)) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  return !isProcessAlive(child);
}

function signalPosixGroup(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals
): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    if (isProcessAlive(child)) {
      try {
        child.kill(signal);
      } catch {
        // The process may have exited between liveness and signal delivery.
      }
    }
  }
}

async function cleanupResidualPosixGroup(pid: number | undefined): Promise<boolean> {
  if (pid === undefined || !isPosixGroupAlive(pid)) return true;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    return !isPosixGroupAlive(pid);
  }
  return await waitForPosixGroupExit(pid, TREE_FORCE_MS);
}

async function waitForPosixGroupExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPosixGroupAlive(pid)) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  return !isPosixGroupAlive(pid);
}

function isPosixGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return !isMissingProcessError(error);
  }
}

function isMissingProcessError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, "code");
    return descriptor !== undefined && "value" in descriptor && descriptor.value === "ESRCH";
  } catch {
    return false;
  }
}

function isProcessTreeCleanupError(
  error: unknown
): error is SupervisedProcessError {
  return error instanceof SupervisedProcessError
    && error.code === "PROCESS_TREE_CLEANUP_FAILED";
}

function supervisedProcessErrorMessage(code: SupervisedProcessErrorCode): string {
  switch (code) {
    case "INVALID_DEFINITION": return "Supervised executable definition is invalid";
    case "UNKNOWN_EXECUTABLE": return "Supervised executable identity is unknown";
    case "INVALID_REQUEST": return "Supervised process request is invalid";
    case "CAPACITY_EXCEEDED": return "Supervised process execution capacity is exhausted";
    case "EXECUTABLE_UNAVAILABLE": return "Supervised executable is unavailable";
    case "EXECUTABLE_UNSAFE": return "Supervised executable identity could not be trusted";
    case "SPAWN_FAILED": return "Supervised process could not be started";
    case "EXECUTION_TIMEOUT": return "Supervised process exceeded its execution deadline";
    case "EXECUTION_CANCELLED": return "Supervised process execution was cancelled";
    case "OUTPUT_LIMIT_EXCEEDED": return "Supervised process exceeded its output budget";
    case "INVALID_STDOUT_UTF8": return "Supervised process stdout was not valid UTF-8";
    case "PROCESS_TREE_CLEANUP_FAILED": return "Supervised process tree cleanup could not be verified";
  }
}

export function defaultAntigravityCliExecutablePath(
  platform: NodeJS.Platform = process.platform,
  homeDirectory: string = homedir()
): string {
  if (platform === "win32") {
    return win32Path.join(
      homeDirectory,
      "AppData",
      "Local",
      "agy",
      "bin",
      "agy.exe"
    );
  }
  return path.join(homeDirectory, ".local", "bin", "agy");
}
