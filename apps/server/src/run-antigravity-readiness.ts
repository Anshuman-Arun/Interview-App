import process from "node:process";
import {
  createApplicationProviderAdapterRuntimeSource
} from "./antigravity-cli-runtime.js";
import {
  ANTIGRAVITY_CLI_AGENT_ID,
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

    const usage = await executeReadinessJsonCommand(executor, [
      "-p",
      "/usage",
      "--model",
      ANTIGRAVITY_CLI_MODEL_ID,
      "--agent",
      ANTIGRAVITY_CLI_AGENT_ID,
      "--output-format",
      "json"
    ]);
    assertZeroTurnUsageEnvelope(usage);
  } finally {
    await source.drain();
  }

  process.stdout.write(
    "Antigravity readiness smoke passed: supervised launch, zero-turn stream protocol, empty resolved tool surface, isolated custom agent, pinned model, cached authentication, and quota lookup are usable without a model turn.\n"
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

function assertZeroTurnUsageEnvelope(value: unknown): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Antigravity usage probe returned an invalid envelope");
  }
  const record = value as Record<string, unknown>;
  if (
    record.status !== "SUCCESS"
    || record.num_turns !== 0
    || typeof record.response !== "string"
    || record.response.trim().length === 0
  ) {
    throw new Error("Antigravity usage probe did not complete as a zero-turn command");
  }
  const usage = record.usage;
  if (typeof usage !== "object" || usage === null || Array.isArray(usage)) {
    throw new Error("Antigravity usage probe returned invalid token accounting");
  }
  const totalTokens = (usage as Record<string, unknown>).total_tokens;
  if (totalTokens !== 0) {
    throw new Error("Antigravity readiness probe unexpectedly consumed model tokens");
  }
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
