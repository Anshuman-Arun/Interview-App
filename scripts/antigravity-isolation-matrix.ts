import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ANTIGRAVITY_CLI_MODEL_IDS,
  ANTIGRAVITY_CLI_PROPOSAL_SCHEMA_ARGUMENT
} from "../packages/providers/src/index.js";
import { defaultAntigravityCliExecutablePath } from "../packages/local-runtime/src/index.js";
import { ANTIGRAVITY_REALIZER_AGENT_MARKDOWN } from "../apps/server/src/antigravity-cli-runtime.js";

export interface AntigravityMatrixCaseResult {
  readonly id: string;
  readonly exitCode: number | null;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly terminalStatus?: string;
  readonly terminalError?: string;
  readonly responseChars?: number;
  readonly structuredOutputPresent: boolean;
  readonly eventTypes: readonly string[];
  readonly stepSummaries: readonly Readonly<{
    readonly stepIndex?: number;
    readonly state?: string;
    readonly stepType?: string;
    readonly textDeltaChars?: number;
    readonly durationSeconds?: number;
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly thinkingTokens?: number;
    readonly toolPresent: boolean;
    readonly subagentPresent: boolean;
  }>[];
}

export interface AntigravityMatrixResult {
  readonly model: string;
  readonly cases: readonly AntigravityMatrixCaseResult[];
  readonly firstFailureId?: string;
}

interface RawCommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function effortForModel(model: string): "low" | "medium" | "high" {
  if (model.endsWith("-high")) return "high";
  if (model.endsWith("-low")) return "low";
  return "medium";
}

function safeText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, "")
    .replace(
      /(?:AIza[A-Za-z0-9_-]{20,}|sk[-_][A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,})/gu,
      "[REDACTED_SECRET]"
    )
    .slice(0, 2048);
}

async function runCommand(
  executable: string,
  args: readonly string[],
  stdin: string,
  cwd: string
): Promise<RawCommandResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      cwd,
      env: process.env,
      windowsHide: true,
      shell: false
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Antigravity matrix probe timed out"));
    }, 150000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = (stdout + chunk.toString("utf8")).slice(-1000000);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-1000000);
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      resolve({ exitCode, stdout, stderr });
    });
    if (stdin.length > 0) child.stdin.write(stdin, "utf8");
    child.stdin.end();
  });
}

function summarize(
  id: string,
  result: RawCommandResult
): AntigravityMatrixCaseResult {
  const eventTypes: string[] = [];
  const stepSummaries: Array<Readonly<{
    stepIndex?: number;
    state?: string;
    stepType?: string;
    textDeltaChars?: number;
    durationSeconds?: number;
    inputTokens?: number;
    outputTokens?: number;
    thinkingTokens?: number;
    toolPresent: boolean;
    subagentPresent: boolean;
  }>> = [];
  let terminalStatus: string | undefined;
  let terminalError: string | undefined;
  let responseChars: number | undefined;
  let structuredOutputPresent = false;

  const inspectResult = (value: unknown): void => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return;
    const status = safeText(Reflect.get(value, "status"));
    const error = safeText(Reflect.get(value, "error"));
    const response = Reflect.get(value, "response");
    if (status !== undefined) terminalStatus = status;
    if (error !== undefined) terminalError = error;
    if (typeof response === "string") responseChars = Array.from(response).length;
    if (Reflect.get(value, "structured_output") !== undefined) {
      structuredOutputPresent = true;
    }
  };

  for (const raw of result.stdout.split(/\r?\n/u).slice(0, 256)) {
    if (raw.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      eventTypes.push("INVALID_JSON");
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      eventTypes.push("NON_OBJECT");
      continue;
    }
    const event = Reflect.get(parsed, "event");
    if (typeof event !== "string") {
      eventTypes.push("JSON_RESULT");
      inspectResult(parsed);
      continue;
    }
    eventTypes.push(event.slice(0, 128));
    if (event === "result") inspectResult(Reflect.get(parsed, "result"));
    if (event !== "step_update") continue;
    const step = Reflect.get(parsed, "step_update");
    if (typeof step !== "object" || step === null || Array.isArray(step)) continue;
    const usage = Reflect.get(step, "usage");
    const usageRecord =
      typeof usage === "object" && usage !== null && !Array.isArray(usage)
        ? usage
        : undefined;
    const stepIndex = Reflect.get(step, "step_index");
    const state = safeText(Reflect.get(step, "state"));
    const stepType = safeText(Reflect.get(step, "step_type"));
    const textDelta = Reflect.get(step, "text_delta");
    const durationSeconds = Reflect.get(step, "duration_seconds");
    const inputTokens = usageRecord === undefined
      ? undefined
      : Reflect.get(usageRecord, "input_tokens");
    const outputTokens = usageRecord === undefined
      ? undefined
      : Reflect.get(usageRecord, "output_tokens");
    const thinkingTokens = usageRecord === undefined
      ? undefined
      : Reflect.get(usageRecord, "thinking_tokens");
    stepSummaries.push(Object.freeze({
      ...(typeof stepIndex === "number" && Number.isSafeInteger(stepIndex)
        ? { stepIndex }
        : {}),
      ...(state === undefined ? {} : { state }),
      ...(stepType === undefined ? {} : { stepType }),
      ...(typeof textDelta === "string"
        ? { textDeltaChars: Array.from(textDelta).length }
        : {}),
      ...(typeof durationSeconds === "number" && Number.isFinite(durationSeconds)
        ? { durationSeconds }
        : {}),
      ...(typeof inputTokens === "number" && Number.isSafeInteger(inputTokens)
        ? { inputTokens }
        : {}),
      ...(typeof outputTokens === "number" && Number.isSafeInteger(outputTokens)
        ? { outputTokens }
        : {}),
      ...(typeof thinkingTokens === "number" && Number.isSafeInteger(thinkingTokens)
        ? { thinkingTokens }
        : {}),
      toolPresent:
        Reflect.get(step, "tool_name") !== undefined
        || Reflect.get(step, "tool_info") !== undefined,
      subagentPresent: Reflect.get(step, "subagent_info") !== undefined
    }));
  }

  return Object.freeze({
    id,
    exitCode: result.exitCode,
    stdoutBytes: Buffer.byteLength(result.stdout, "utf8"),
    stderrBytes: Buffer.byteLength(result.stderr, "utf8"),
    ...(terminalStatus === undefined ? {} : { terminalStatus }),
    ...(terminalError === undefined ? {} : { terminalError }),
    ...(responseChars === undefined ? {} : { responseChars }),
    structuredOutputPresent,
    eventTypes: Object.freeze(eventTypes),
    stepSummaries: Object.freeze(stepSummaries)
  });
}

export async function runAntigravityIsolationMatrix(
  model: string
): Promise<AntigravityMatrixResult> {
  if (!(ANTIGRAVITY_CLI_MODEL_IDS as readonly string[]).includes(model)) {
    throw new Error("Unsupported Antigravity matrix model");
  }
  const executable = defaultAntigravityCliExecutablePath("win32");
  const workspace = await mkdtemp(path.join(os.tmpdir(), "interview-agy-matrix-"));
  const agentDir = path.join(
    workspace,
    ".agents",
    "agents",
    "interview-realizer"
  );
  const simpleSchema = JSON.stringify({
    type: "object",
    properties: {
      ok: { type: "string", const: "diagnostic-ok" }
    },
    required: ["ok"],
    additionalProperties: false
  });
  const effort = effortForModel(model);
  const plainPrompt = "Reply with exactly: diagnostic-ok";
  const jsonPrompt =
    "Return exactly one JSON object with one property: {\"ok\":\"diagnostic-ok\"}";
  const proposalPrompt =
    "Return exactly one interviewer proposal with realizedAction CLARIFY, "
    + "claimedDisclosureLevel 0, claimedDisclosureIds [], and speechText "
    + "\"What simple case would you test first?\".";

  const cases: Array<Readonly<{
    id: string;
    args: readonly string[];
    stdin: string;
  }>> = [
    {
      id: "plain-default-agent",
      args: [
        "-p", plainPrompt,
        "--output-format", "json",
        "--model", model,
        "--effort", effort,
        "--print-timeout", "2m"
      ],
      stdin: ""
    },
    {
      id: "plain-custom-agent",
      args: [
        "-p", jsonPrompt,
        "--output-format", "json",
        "--model", model,
        "--effort", effort,
        "--agent", "interview-realizer",
        "--print-timeout", "2m"
      ],
      stdin: ""
    },
    {
      id: "schema-default-agent",
      args: [
        "-p", jsonPrompt,
        "--output-format", "json",
        "--json-schema", simpleSchema,
        "--model", model,
        "--effort", effort,
        "--print-timeout", "2m"
      ],
      stdin: ""
    },
    {
      id: "schema-custom-agent",
      args: [
        "-p", jsonPrompt,
        "--output-format", "json",
        "--json-schema", simpleSchema,
        "--model", model,
        "--effort", effort,
        "--agent", "interview-realizer",
        "--print-timeout", "2m"
      ],
      stdin: ""
    },
    {
      id: "stream-custom-agent-simple-schema",
      args: [
        "--input-format", "stream-json",
        "--output-format", "stream-json",
        "--json-schema", simpleSchema,
        "--model", model,
        "--effort", effort,
        "--agent", "interview-realizer",
        "--print-timeout", "2m"
      ],
      stdin: JSON.stringify({
        event: "user",
        message: { content: jsonPrompt }
      }) + "\n"
    },
    {
      id: "stream-custom-agent-production-schema",
      args: [
        "--input-format", "stream-json",
        "--output-format", "stream-json",
        "--json-schema", ANTIGRAVITY_CLI_PROPOSAL_SCHEMA_ARGUMENT,
        "--model", model,
        "--effort", effort,
        "--agent", "interview-realizer",
        "--print-timeout", "2m"
      ],
      stdin: JSON.stringify({
        event: "user",
        message: { content: proposalPrompt }
      }) + "\n"
    }
  ];

  try {
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      path.join(agentDir, "agent.md"),
      ANTIGRAVITY_REALIZER_AGENT_MARKDOWN,
      "utf8"
    );
    const results: AntigravityMatrixCaseResult[] = [];
    for (const testCase of cases) {
      const result = await runCommand(
        executable,
        testCase.args,
        testCase.stdin,
        workspace
      );
      results.push(summarize(testCase.id, result));
    }
    const firstFailure = results.find((item) =>
      item.exitCode !== 0 || item.terminalStatus !== "SUCCESS"
    );
    return Object.freeze({
      model,
      cases: Object.freeze(results),
      ...(firstFailure === undefined
        ? {}
        : { firstFailureId: firstFailure.id })
    });
  } finally {
    await rm(workspace, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50
    });
  }
}
