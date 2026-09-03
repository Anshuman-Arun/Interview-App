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
    const controller = new AbortController();
    const result = await executor.execute({
      args: ["-p", "/usage", "--output-format", "json"],
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
      throw new Error("Antigravity account readiness probe failed");
    }
  } finally {
    await source.drain();
  }

  process.stdout.write(
    "Antigravity readiness smoke passed: supervised launch, isolated profile, cached authentication, and quota lookup are usable.\n"
  );
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
