import process from "node:process";
import {
  createApplicationProviderAdapterRuntimeSource
} from "./antigravity-cli-runtime.js";
import {
  ANTIGRAVITY_CLI_MODEL_ID,
  ANTIGRAVITY_CLI_PROVIDER_ID,
  type SupervisedCliExecutor
} from "../../../packages/providers/src/index.js";

const READINESS_TIMEOUT_MS = 75_000;
const READINESS_STDOUT_BYTES = 64 * 1024;
const READINESS_STDERR_BYTES = 16 * 1024;

async function main(): Promise<void> {
  if (process.platform !== "win32") {
    throw new Error("Antigravity readiness smoke is supported only on Windows");
  }

  const source = createApplicationProviderAdapterRuntimeSource();
  try {
    const runtime = source.resolveRuntime({
      providerId: ANTIGRAVITY_CLI_PROVIDER_ID,
      modelId: ANTIGRAVITY_CLI_MODEL_ID
    });
    const executor = readExecutor(runtime);

    const agents = await executeReadinessJsonCommand(executor, [
      "agents",
      "--output-format",
      "json"
    ]);
    if (!jsonContainsExactString(agents, "interview-realizer")) {
      throw new Error("Antigravity isolated custom agent was not discovered");
    }

    const models = await executeReadinessJsonCommand(executor, [
      "models",
      "--output-format",
      "json"
    ]);
    if (!jsonContainsExactString(models, ANTIGRAVITY_CLI_MODEL_ID)) {
      throw new Error("Pinned Antigravity model is unavailable");
    }

    await executeReadinessJsonCommand(executor, [
      "-p",
      "/usage",
      "--output-format",
      "json"
    ]);
  } finally {
    await source.drain();
  }

  process.stdout.write(
    "Antigravity readiness smoke passed: supervised launch, isolated custom agent discovery, pinned model availability, cached authentication, and quota lookup are usable.\n"
  );
}

async function executeReadinessJsonCommand(
  executor: SupervisedCliExecutor,
  args: readonly string[]
): Promise<unknown> {
  const controller = new AbortController();
  const result = await executor.execute({
    args,
    stdin: "",
    timeoutMs: READINESS_TIMEOUT_MS,
    maxStdoutBytes: READINESS_STDOUT_BYTES,
    maxStderrBytes: READINESS_STDERR_BYTES,
    signal: controller.signal,
    onProcessStart: () => undefined
  });
  if (
    result.exitCode !== 0
    || result.stdoutBytes <= 0
    || result.stdout.trim().length === 0
  ) {
    throw new Error("Antigravity readiness command failed");
  }
  try {
    return JSON.parse(result.stdout) as unknown;
  } catch {
    throw new Error("Antigravity readiness command returned malformed JSON");
  }
}

function jsonContainsExactString(value: unknown, expected: string): boolean {
  const pending: Array<{ readonly value: unknown; readonly depth: number }> = [
    { value, depth: 0 }
  ];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    nodes += 1;
    if (nodes > 4_096 || current.depth > 16) {
      throw new Error("Antigravity readiness JSON exceeded inspection bounds");
    }
    if (typeof current.value === "string") {
      if (current.value === expected) return true;
      continue;
    }
    if (current.value === null || typeof current.value !== "object") continue;
    if (Array.isArray(current.value)) {
      for (const item of current.value) {
        pending.push({ value: item, depth: current.depth + 1 });
      }
      continue;
    }
    for (const item of Object.values(current.value as Record<string, unknown>)) {
      pending.push({ value: item, depth: current.depth + 1 });
    }
  }
  return false;
}

function readExecutor(value: unknown): SupervisedCliExecutor {
  if (typeof value !== "object" || value === null) {
    throw new Error("Antigravity runtime is unavailable");
  }
  const runtimeDescriptor = Object.getOwnPropertyDescriptor(value, "executor");
  if (
    runtimeDescriptor === undefined
    || !("value" in runtimeDescriptor)
    || typeof runtimeDescriptor.value !== "object"
    || runtimeDescriptor.value === null
  ) {
    throw new Error("Antigravity runtime executor is unavailable");
  }
  const executeDescriptor = Object.getOwnPropertyDescriptor(
    runtimeDescriptor.value,
    "execute"
  );
  if (
    executeDescriptor === undefined
    || !("value" in executeDescriptor)
    || typeof executeDescriptor.value !== "function"
  ) {
    throw new Error("Antigravity runtime executor is unavailable");
  }
  return runtimeDescriptor.value as SupervisedCliExecutor;
}

void main().catch(() => {
  process.stderr.write(
    "Antigravity readiness smoke failed. Confirm agy 1.1.25 is installed, run agy interactively once to sign in, and retry.\n"
  );
  process.exitCode = 1;
});
