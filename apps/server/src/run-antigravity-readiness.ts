import process from "node:process";
import { isDeepStrictEqual } from "node:util";
import {
  createApplicationProviderAdapterRuntimeSource
} from "./antigravity-cli-runtime.js";
import {
  ANTIGRAVITY_CLI_AGENT_ID,
  ANTIGRAVITY_CLI_MODEL_ID,
  ANTIGRAVITY_CLI_PROPOSAL_SCHEMA_ARGUMENT,
  ANTIGRAVITY_CLI_PROVIDER_ID,
  ANTIGRAVITY_CLI_TURN_ARGUMENTS,
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

    const protocol = await executeReadinessProtocolPreflight(executor);
    assertZeroTurnProtocolPreflight(protocol);

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

async function executeReadinessProtocolPreflight(
  executor: SupervisedCliExecutor
): Promise<string> {
  const controller = new AbortController();
  const result = await executor.execute({
    args: ANTIGRAVITY_CLI_TURN_ARGUMENTS,
    stdin: '{"event":"control_request"}\n',
    timeoutMs: READINESS_TIMEOUT_MS,
    maxStdoutBytes: READINESS_STDOUT_BYTES,
    maxStderrBytes: READINESS_STDERR_BYTES,
    signal: controller.signal,
    onProcessStart: () => undefined
  });
  if (
    result.exitCode === 0
    || result.stdoutBytes <= 0
    || result.stdout.trim().length === 0
  ) {
    throw new Error("Antigravity zero-turn protocol preflight did not fail as expected");
  }
  return result.stdout;
}

function assertZeroTurnProtocolPreflight(stdout: string): void {
  const lines = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length < 2 || lines.length > 16) {
    throw new Error("Antigravity zero-turn protocol preflight returned an invalid event count");
  }

  const expectedSchema = JSON.parse(
    ANTIGRAVITY_CLI_PROPOSAL_SCHEMA_ARGUMENT
  ) as unknown;
  let conversationId: string | undefined;
  let sawInit = false;
  let sawResult = false;

  for (let index = 0; index < lines.length; index += 1) {
    let value: unknown;
    try {
      value = JSON.parse(lines[index] ?? "") as unknown;
    } catch {
      throw new Error("Antigravity zero-turn protocol preflight returned malformed JSON");
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("Antigravity zero-turn protocol preflight returned an invalid event");
    }
    const event = value as Record<string, unknown>;
    if (event.event === "init") {
      if (sawInit || index !== 0) {
        throw new Error("Antigravity zero-turn protocol preflight returned an invalid init");
      }
      const init = event.init;
      if (typeof init !== "object" || init === null || Array.isArray(init)) {
        throw new Error("Antigravity zero-turn protocol preflight returned an invalid init");
      }
      const initRecord = init as Record<string, unknown>;
      const tools = initRecord.tools;
      const rawConversationId = event.conversation_id;
      if (
        typeof rawConversationId !== "string"
        || rawConversationId.length === 0
        || !Array.isArray(tools)
        || tools.length !== 0
        || initRecord.permission_mode !== "strict"
        || initRecord.model !== ANTIGRAVITY_CLI_MODEL_ID
        || initRecord.agent !== ANTIGRAVITY_CLI_AGENT_ID
        || !isDeepStrictEqual(initRecord.json_schema, expectedSchema)
      ) {
        throw new Error("Antigravity zero-turn protocol preflight violated the pinned runtime profile");
      }
      conversationId = rawConversationId;
      sawInit = true;
      continue;
    }

    if (event.event === "result") {
      if (!sawInit || sawResult) {
        throw new Error("Antigravity zero-turn protocol preflight returned an invalid result order");
      }
      const result = event.result;
      if (typeof result !== "object" || result === null || Array.isArray(result)) {
        throw new Error("Antigravity zero-turn protocol preflight returned an invalid result");
      }
      const resultRecord = result as Record<string, unknown>;
      if (
        resultRecord.conversation_id !== conversationId
        || resultRecord.status !== "ERROR"
        || resultRecord.num_turns !== 0
      ) {
        throw new Error("Antigravity zero-turn protocol preflight unexpectedly executed a turn");
      }
      sawResult = true;
      continue;
    }

    throw new Error("Antigravity zero-turn protocol preflight returned an unexpected event");
  }

  if (!sawInit || !sawResult) {
    throw new Error("Antigravity zero-turn protocol preflight was incomplete");
  }
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
