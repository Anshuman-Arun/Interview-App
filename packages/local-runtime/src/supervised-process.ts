import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
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

const MAX_EXECUTABLES = 32;
const MAX_ARGUMENTS = 64;
const MAX_ARGUMENT_BYTES = 128 * 1024;
const MAX_STDIN_BYTES = 256 * 1024;
const MAX_STDOUT_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 512 * 1024;
const MAX_EXECUTION_MS = 5 * 60_000;
const MAX_ISOLATED_HOME_FILES = 16;
const MAX_ISOLATED_HOME_FILE_BYTES = 64 * 1024;
const MAX_ISOLATED_HOME_TOTAL_BYTES = 128 * 1024;
const TREE_GRACE_MS = 250;
const TREE_FORCE_MS = 1_000;

const EXECUTABLE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u;
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

interface ExecutableIdentity {
  readonly device: bigint;
  readonly inode: bigint;
  readonly size: bigint;
  readonly modifiedNanoseconds: bigint;
  readonly canonicalPath: string;
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

  public async execute(
    input: SupervisedProcessExecutionRequest
  ): Promise<SupervisedProcessExecutionResult> {
    const request = snapshotExecutionRequest(input);
    const definition = this.definitions.get(request.executableId);
    if (definition === undefined) throw new SupervisedProcessError("UNKNOWN_EXECUTABLE");
    if (request.signal?.aborted) {
      throw new SupervisedProcessError("EXECUTION_CANCELLED");
    }

    const before = await inspectExecutable(definition.executable, this.platform);
    const pinned = this.pinnedIdentities.get(definition.id);
    if (pinned === undefined) {
      this.pinnedIdentities.set(definition.id, before);
    } else if (!sameExecutableIdentity(pinned, before, this.platform)) {
      throw new SupervisedProcessError("EXECUTABLE_UNSAFE");
    }
    if (request.signal?.aborted) {
      throw new SupervisedProcessError("EXECUTION_CANCELLED");
    }

    const isolation = await createExecutionIsolation(definition, this.platform);
    const expectedIdentity = this.pinnedIdentities.get(definition.id);
    if (expectedIdentity === undefined) {
      await cleanupExecutionIsolation(isolation);
      throw new SupervisedProcessError("EXECUTABLE_UNSAFE");
    }

    try {
      return await this.runChild(
        definition,
        request,
        expectedIdentity,
        isolation.environment,
        isolation.workingDirectory
      );
    } finally {
      await cleanupExecutionIsolation(isolation);
    }
  }

  private async runChild(
    definition: RegisteredExecutable,
    request: ReturnType<typeof snapshotExecutionRequest>,
    before: ExecutableIdentity,
    environment: NodeJS.ProcessEnv,
    workingDirectory: string | undefined
  ): Promise<SupervisedProcessExecutionResult> {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(
        definition.executable,
        [...definition.fixedArgs, ...request.args],
        {
          ...(workingDirectory === undefined ? {} : { cwd: workingDirectory }),
          env: environment,
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
    let settled = false;

    const requestCleanup = (failure: PendingFailure): void => {
      if (pendingFailure === undefined) pendingFailure = failure;
      cleanupStarted ??= terminateProcessTree(child, this.platform);
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

    const timeout = setTimeout(() => requestCleanup("EXECUTION_TIMEOUT"), request.timeoutMs);
    const onAbort = (): void => requestCleanup("EXECUTION_CANCELLED");
    request.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      await waitForSpawn(child);
      const after = await inspectExecutable(definition.executable, this.platform);
      if (!sameExecutableIdentity(before, after, this.platform)) {
        requestCleanup("EXECUTABLE_UNSAFE");
      }
      if (request.signal?.aborted) {
        requestCleanup("EXECUTION_CANCELLED");
      }
      if (pendingFailure === undefined && request.onProcessStart !== undefined) {
        try {
          request.onProcessStart();
        } catch {
          requestCleanup("EXECUTION_CANCELLED");
        }
      }

      if (pendingFailure === undefined) {
        await writeBoundedStdin(child, request.stdin);
      } else {
        child.stdin.destroy();
      }

      const exit = await closePromise;
      if (cleanupStarted !== undefined) {
        const cleaned = await cleanupStarted;
        if (!cleaned && pendingFailure !== "OUTPUT_LIMIT_EXCEEDED") {
          pendingFailure = "PROCESS_TREE_CLEANUP_FAILED";
        }
      }

      if (this.platform !== "win32") {
        const residualCleaned = await cleanupResidualPosixGroup(child.pid);
        if (!residualCleaned) pendingFailure = "PROCESS_TREE_CLEANUP_FAILED";
      }

      if (pendingFailure !== undefined) {
        throw new SupervisedProcessError(pendingFailure);
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
          if (!cleaned) throw new SupervisedProcessError("PROCESS_TREE_CLEANUP_FAILED");
        }
        throw error;
      }
      if (isProcessAlive(child)) {
        const cleaned = await terminateProcessTree(child, this.platform);
        if (!cleaned) throw new SupervisedProcessError("PROCESS_TREE_CLEANUP_FAILED");
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
}

function snapshotExecutableDefinitions(
  value: readonly SupervisedExecutableDefinition[],
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
  const record = inspectPlainRecord(
    value,
    new Set(Object.keys(value as object)),
    "INVALID_DEFINITION"
  );
  const entries = Object.entries(record);
  if (entries.length > MAX_ISOLATED_HOME_FILES) {
    throw new SupervisedProcessError("INVALID_DEFINITION");
  }

  const output: IsolatedHomeFile[] = [];
  let totalBytes = 0;
  for (const [relativePath, content] of entries) {
    if (
      relativePath.length === 0
      || relativePath.includes("\\")
      || relativePath.startsWith("/")
      || relativePath.includes("\0")
    ) {
      throw new SupervisedProcessError("INVALID_DEFINITION");
    }
    const segments = relativePath.split("/");
    if (
      segments.some((segment) =>
        segment.length === 0
        || segment === "."
        || segment === ".."
        || segment.includes("\0")
      )
    ) {
      throw new SupervisedProcessError("INVALID_DEFINITION");
    }
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

  output.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
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
        ? configured.toLowerCase() !== actual.toLowerCase()
        : configured !== actual
    ) {
      throw new SupervisedProcessError("EXECUTABLE_UNSAFE");
    }
    return Object.freeze({
      device: info.dev,
      inode: info.ino,
      size: info.size,
      modifiedNanoseconds: info.mtimeNs,
      canonicalPath: actual
    });
  } catch (error) {
    if (error instanceof SupervisedProcessError) throw error;
    throw new SupervisedProcessError("EXECUTABLE_UNAVAILABLE");
  }
}

function sameExecutableIdentity(
  left: ExecutableIdentity,
  right: ExecutableIdentity,
  platform: NodeJS.Platform
): boolean {
  const samePath = platform === "win32"
    ? left.canonicalPath.toLowerCase() === right.canonicalPath.toLowerCase()
    : left.canonicalPath === right.canonicalPath;
  return samePath
    && left.device === right.device
    && left.inode === right.inode
    && left.size === right.size
    && left.modifiedNanoseconds === right.modifiedNanoseconds;
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
    const gracefulRequested = await runTaskkill(pid, false, TREE_FORCE_MS);
    if (
      gracefulRequested
      && await waitForChildExit(child, TREE_GRACE_MS)
    ) {
      return true;
    }
    const forced = await runTaskkill(pid, true, TREE_FORCE_MS);
    return forced && await waitForChildExit(child, TREE_FORCE_MS);
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

function runTaskkill(pid: number, force: boolean, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const systemRoot = process.env["SystemRoot"] ?? process.env["SYSTEMROOT"];
    if (
      systemRoot === undefined
      || systemRoot.length === 0
      || systemRoot.includes("\0")
      || !win32Path.isAbsolute(systemRoot)
      || systemRoot.startsWith("\\\\")
    ) {
      resolve(false);
      return;
    }
    const executable = win32Path.join(systemRoot, "System32", "taskkill.exe");
    let task: ReturnType<typeof spawn>;
    try {
      task = spawn(
        executable,
        ["/pid", String(pid), "/t", ...(force ? ["/f"] : [])],
        { shell: false, windowsHide: true, stdio: "ignore" }
      );
    } catch {
      resolve(false);
      return;
    }

    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (success: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(success);
    };
    task.once("error", () => finish(false));
    task.once("close", (code) => finish(code === 0));
    timer = setTimeout(() => {
      try {
        task.kill();
      } catch {
        // The helper may already have exited.
      }
      task.unref();
      finish(false);
    }, timeoutMs);
  });
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
    return path.join(homeDirectory, "AppData", "Local", "agy", "bin", "agy.exe");
  }
  return path.join(homeDirectory, ".local", "bin", "agy");
}
