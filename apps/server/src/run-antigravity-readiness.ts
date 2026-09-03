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
    const agents = await executeReadinessCommand(executor, [
      "agents",
      "--output-format",
      "json"
    ]);
    if (!agents.stdout.includes("interview-realizer")) {
      throw new Error("Antigravity isolated custom agent was not discovered");
    }

    const models = await executeReadinessCommand(executor, [
      "models",
      "--output-format",
      "json"
    ]);
    if (!models.stdout.includes(ANTIGRAVITY_CLI_MODEL_ID)) {
      throw new Error("Pinned Antigravity model is unavailable");
    }

    await executeReadinessCommand(executor, [
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

async function executeReadinessCommand(
  executor: SupervisedCliExecutor,
  args: readonly string[]
): Promise<{
  readonly stdout: string;
}> {
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
  return Object.freeze({ stdout: result.stdout });
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
