import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, lstatSync, realpathSync } from "node:fs";
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
import { WINDOWS_JOB_SUPERVISOR_SCRIPT } from "./windows-job-supervisor.js";

const MAX_EXECUTABLES = 32;
const MAX_ARGUMENTS = 64;
const MAX_ARGUMENT_BYTES = 128 * 1024;
const MAX_WINDOWS_PROVIDER_COMMAND_LINE_CHARACTERS = 24_000;
const MAX_WINDOWS_SUPERVISOR_COMMAND_LINE_CHARACTERS = 4_096;
const MAX_WINDOWS_SUPERVISOR_ENVIRONMENT_CHARACTERS = 30_000;
const MAX_STDIN_BYTES = 256 * 1024;
const MAX_STDOUT_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 512 * 1024;
const MAX_EXECUTION_MS = 5 * 60_000;
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

export type SupervisedProcessErrorCode =
  | "INVALID_DEFINITION"
  | "UNKNOWN_EXECUTABLE"
  | "INVALID_REQUEST"
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
}

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
  private readonly pinnedIdentities = new Map<string, ExecutableIdentity>();
  private readonly quarantinedExecutableIds = new Set<string>();
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
      const initialIdentity = tryInspectExecutableSync(snapshot.executable, this.platform);
      if (initialIdentity !== undefined) {
        this.pinnedIdentities.set(snapshot.id, initialIdentity);
      }
    }
  }

  public execute(
    input: SupervisedProcessExecutionRequest
  ): Promise<SupervisedProcessExecutionResult> {
    const request = snapshotExecutionRequest(input);
    if (this.draining !== undefined) {
      return Promise.reject(new SupervisedProcessError("EXECUTION_CANCELLED"));
    }

    const controller = new AbortController();
    const externalSignal = request.signal;
    const forwardAbort = (): void => controller.abort();
    if (externalSignal?.aborted) controller.abort();
    else externalSignal?.addEventListener("abort", forwardAbort, { once: true });

    const trackedRequest = Object.freeze({
      ...request,
      signal: controller.signal
    });
    this.activeControllers.add(controller);
    const operation = this.executeSnapshot(trackedRequest);
    this.activeOperations.add(operation);

    const cleanup = (): void => {
      externalSignal?.removeEventListener("abort", forwardAbort);
      this.activeControllers.delete(controller);
      this.activeOperations.delete(operation);
    };
    void operation.then(cleanup, cleanup);
    return operation;
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

  private async drainActiveOperations(): Promise<void> {
    if (this.quarantinedExecutableIds.size !== 0) {
      throw new SupervisedProcessError("PROCESS_TREE_CLEANUP_FAILED");
    }
    for (const controller of this.activeControllers) controller.abort();
    const operations = [...this.activeOperations];
    const results = await Promise.allSettled(operations);
    if (
      this.quarantinedExecutableIds.size !== 0
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
    if (request.signal?.aborted) {
      throw new SupervisedProcessError("EXECUTION_CANCELLED");
    }

    const before = await inspectExecutable(definition.executable, this.platform);
    if (this.platform === "win32" && before.linkCount !== 1n) {
      throw new SupervisedProcessError("EXECUTABLE_UNSAFE");
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
      const contentSha256 = await sha256Executable(
        definition.executable,
        request.signal
      );
      const afterHash = await inspectExecutable(definition.executable, this.platform);
      if (!sameExecutableIdentity(before, afterHash, this.platform)) {
        throw new SupervisedProcessError("EXECUTABLE_UNSAFE");
      }
      this.pinnedIdentities.set(definition.id, Object.freeze({
        ...afterHash,
        contentSha256
      }));
    }

    if (request.signal?.aborted) {
      throw new SupervisedProcessError("EXECUTION_CANCELLED");
    }

    if (
      this.platform === "win32"
      && !windowsCommandLineWithinBudget(
        definition.executable,
        [...definition.fixedArgs, ...request.args]
      )
    ) {
      throw new SupervisedProcessError("INVALID_REQUEST");
    }

    const isolation = await createExecutionIsolation(definition, this.platform);
    const expectedIdentity = this.pinnedIdentities.get(definition.id);
    if (expectedIdentity === undefined) {
      await cleanupExecutionIsolation(isolation);
      throw new SupervisedProcessError("EXECUTABLE_UNSAFE");
    }
    if (request.signal?.aborted) {
      await cleanupExecutionIsolation(isolation);
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
        this.quarantinedExecutableIds.add(definition.id);
      }
    }

    try {
      await cleanupExecutionIsolation(isolation);
    } catch {
      this.quarantinedExecutableIds.add(definition.id);
      throw new SupervisedProcessError("PROCESS_TREE_CLEANUP_FAILED");
    }

    if (failed) throw failure;
    if (result === undefined) {
      throw new SupervisedProcessError("SPAWN_FAILED");
    }
    return result;
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
    }

    if (request.signal?.aborted) {
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
      cleanupStarted ??= terminateProcessTree(child, this.platform);
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
    if (request.signal?.aborted) {
      requestCleanup("EXECUTION_CANCELLED");
    } else {
      request.signal?.addEventListener("abort", onAbort, { once: true });
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
      if (request.signal?.aborted) {
        requestCleanup("EXECUTION_CANCELLED");
        return await throwPendingFailure();
      }

      const stdinOutcome = await Promise.race([
        writeBoundedStdin(child, request.stdin).then(() => "WRITTEN" as const),
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
          const cleaned = await terminateProcessTree(child, this.platform);
          if (!cleaned) {
            throw new SupervisedProcessError("PROCESS_TREE_CLEANUP_FAILED");
          }
        }
        throw error;
      }
      if (isProcessAlive(child)) {
        const cleaned = await terminateProcessTree(child, this.platform);
        if (!cleaned) {
          throw new SupervisedProcessError("PROCESS_TREE_CLEANUP_FAILED");
        }
      }
      throw new SupervisedProcessError("SPAWN_FAILED");
    } finally {
      settled = true;
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", onAbort);
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
      controlDirectory === undefined
      || expectedIdentity.contentSha256 === undefined
    ) {
      throw new SupervisedProcessError("EXECUTABLE_UNSAFE");
    }

    if (request.signal?.aborted) {
      throw new SupervisedProcessError("EXECUTION_CANCELLED");
    }
    const powershell = windowsPowerShellExecutablePath(environment);
    const identity = await inspectExecutable(powershell, "win32");
    if (request.signal?.aborted) {
      throw new SupervisedProcessError("EXECUTION_CANCELLED");
    }
    if (this.windowsSupervisorIdentity === undefined) {
      this.windowsSupervisorIdentity = identity;
    } else if (
      !sameExecutableIdentity(this.windowsSupervisorIdentity, identity, "win32")
    ) {
      throw new SupervisedProcessError("EXECUTABLE_UNSAFE");
    }

    const configPath = path.join(controlDirectory, "launch.json");
    const configuration = JSON.stringify({
      executable: definition.executable,
      arguments: [...definition.fixedArgs, ...request.args],
      cwd: workingDirectory ?? null,
      expectedSha256: expectedIdentity.contentSha256,
      environmentKeys: Object.keys(environment)
    });
    await writeFile(configPath, configuration, {
      encoding: "utf8",
      flag: "wx"
    });
    if (request.signal?.aborted) {
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
    supervisorEnvironment.INTERVIEW_SUPERVISED_CONFIG = configPath;
    supervisorEnvironment.INTERVIEW_SUPERVISED_BOOTSTRAP =
      WINDOWS_JOB_SUPERVISOR_SCRIPT;
    if (
      windowsEnvironmentBlockCharacters(supervisorEnvironment)
      > MAX_WINDOWS_SUPERVISOR_ENVIRONMENT_CHARACTERS
    ) {
      throw new SupervisedProcessError("INVALID_REQUEST");
    }

    return Object.freeze({
      executable: powershell,
      args,
      environment: Object.freeze(supervisorEnvironment),
      identity
    });
  }
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
    const [info, canonicalPath] = await Promise.all([
      lstat(executable, { bigint: true }),
      realpath(executable)
    ]);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new SupervisedProcessError("EXECUTABLE_UNSAFE");
    }
    const configured = path.resolve(executable);
    const actual = path.resolve(canonicalPath);
    if (
      platform === "win32"
        ? normalizeWindowsIdentityPath(configured)
          !== normalizeWindowsIdentityPath(actual)
        : configured !== actual
    ) {
      throw new SupervisedProcessError("EXECUTABLE_UNSAFE");
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
    const info = lstatSync(executable, { bigint: true });
    const canonicalPath = realpathSync(executable);
    if (!info.isFile() || info.isSymbolicLink()) return undefined;
    const configured = path.resolve(executable);
    const actual = path.resolve(canonicalPath);
    if (
      platform === "win32"
        ? normalizeWindowsIdentityPath(configured)
          !== normalizeWindowsIdentityPath(actual)
        : configured !== actual
    ) {
      return undefined;
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
  signal: AbortSignal | undefined
): Promise<string> {
  if (signal?.aborted) {
    throw new SupervisedProcessError("EXECUTION_CANCELLED");
  }
  const hash = createHash("sha256");
  const stream = createReadStream(executable);
  const onAbort = (): void => {
    stream.destroy();
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    for await (const chunk of stream) {
      if (signal?.aborted) {
        throw new SupervisedProcessError("EXECUTION_CANCELLED");
      }
      const chunkValue: unknown = chunk;
      if (!Buffer.isBuffer(chunkValue)) {
        throw new SupervisedProcessError("EXECUTABLE_UNSAFE");
      }
      hash.update(chunkValue);
    }
    if (signal?.aborted) {
      throw new SupervisedProcessError("EXECUTION_CANCELLED");
    }
    return hash.digest("hex");
  } catch (error) {
    if (
      error instanceof SupervisedProcessError
      && error.code === "EXECUTION_CANCELLED"
    ) {
      throw error;
    }
    if (signal?.aborted) {
      throw new SupervisedProcessError("EXECUTION_CANCELLED");
    }
    throw new SupervisedProcessError("EXECUTABLE_UNSAFE");
  } finally {
    signal?.removeEventListener("abort", onAbort);
    stream.destroy();
  }
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
  return win32Path.join(
    normalizedRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
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
    ? normalizeWindowsIdentityPath(left.canonicalPath)
      === normalizeWindowsIdentityPath(right.canonicalPath)
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
  platform: NodeJS.Platform
): Promise<ExecutionIsolation> {
  let workingDirectory: string | undefined;
  let homeDirectory: string | undefined;
  let controlDirectory: string | undefined;
  try {
    if (platform === "win32") {
      controlDirectory = await mkdtemp(
        path.join(tmpdir(), "interview-provider-control-")
      );
    }
    const environment = Object.create(null) as NodeJS.ProcessEnv;
    for (const [key, value] of Object.entries(definition.environment)) {
      if (typeof value === "string") environment[key] = value;
    }

    if (definition.isolatedHomeFiles !== undefined) {
      homeDirectory = await mkdtemp(path.join(tmpdir(), "interview-provider-home-"));
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
      workingDirectory = await createIsolatedWorkingDirectory();
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
      await rm(isolation.workingDirectory, { recursive: true, force: true });
    } catch {
      failed = true;
    }
  }
  if (isolation.homeDirectory !== undefined) {
    try {
      await rm(isolation.homeDirectory, { recursive: true, force: true });
    } catch {
      failed = true;
    }
  }
  if (isolation.controlDirectory !== undefined) {
    try {
      await rm(isolation.controlDirectory, { recursive: true, force: true });
    } catch {
      failed = true;
    }
  }
  if (failed) {
    throw new SupervisedProcessError("PROCESS_TREE_CLEANUP_FAILED");
  }
}

async function createIsolatedWorkingDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "interview-provider-"));
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
  platform: NodeJS.Platform
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
    try {
      child.kill();
    } catch {
      return !isProcessAlive(child);
    }
    return await waitForChildExit(child, TREE_FORCE_MS);
  }

  signalPosixGroup(child, "SIGTERM");
  if (await waitForPosixGroupExit(pid, TREE_GRACE_MS)) return true;
  signalPosixGroup(child, "SIGKILL");
  return await waitForPosixGroupExit(pid, TREE_FORCE_MS);
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
