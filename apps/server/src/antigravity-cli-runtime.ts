import { win32 as win32Path } from "node:path";
import process from "node:process";
import type { ProviderSelectionReference } from "../../../packages/domain/src/index.js";
import {
  SupervisedProcessRunner,
  defaultAntigravityCliExecutablePath
} from "../../../packages/local-runtime/src/index.js";
import {
  ANTIGRAVITY_CLI_ADAPTER_VERSION,
  ANTIGRAVITY_CLI_MODEL_ID,
  ANTIGRAVITY_CLI_PROVIDER_ID,
  type SupervisedCliExecutionRequest,
  type SupervisedCliExecutor
} from "../../../packages/providers/src/index.js";

const ANTIGRAVITY_EXECUTABLE_ID = "antigravity-cli";
const ANTIGRAVITY_SAFE_SETTINGS = Object.freeze({
  toolPermission: "strict",
  artifactReviewPolicy: "asks-for-review",
  allowNonWorkspaceAccess: false,
  useG1Credits: false,
  enableTelemetry: false,
  notifications: false,
  showFeedbackSurvey: false,
  permissions: {
    allow: [],
    ask: [],
    deny: [
      "read_file(*)",
      "write_file(*)",
      "read_url(*)",
      "execute_url(*)",
      "command(*)",
      "unsandboxed(*)",
      "mcp(*)"
    ]
  }
});
export const ANTIGRAVITY_SUPERVISED_SETTINGS_JSON =
  JSON.stringify(ANTIGRAVITY_SAFE_SETTINGS) + "\n";
export const ANTIGRAVITY_REALIZER_AGENT_MARKDOWN = `---
name: interview-realizer
description: Stateless interviewer proposal realization engine.
tools: []
mainAgent: true
subagent: false
---

# System Prompt

You are a fallible, stateless interviewer-response realization engine.
Use only the user message supplied for the current turn.
Return only the structured interviewer proposal requested by the caller.
Do not use tools, files, commands, URLs, MCP, plugins, skills, subagents, or prior conversations.
`;

export interface ApplicationProviderAdapterRuntimeSource {
  readonly resolveRuntime: (
    selection: ProviderSelectionReference
  ) => unknown;
  readonly drain: () => Promise<void>;
}

export function createApplicationProviderAdapterRuntimeSource(): ApplicationProviderAdapterRuntimeSource {
  if (process.platform !== "win32") {
    return Object.freeze({
      resolveRuntime(): undefined {
        return undefined;
      },
      async drain(): Promise<void> {
        // The concrete Antigravity runtime is intentionally unavailable on
        // platforms where this PR cannot provide kernel-owned tree containment.
      }
    });
  }

  let runner: SupervisedProcessRunner | undefined;

  const getRunner = (): SupervisedProcessRunner => {
    if (runner !== undefined) return runner;
    const environment = antigravityEnvironment();
    assertNoMeteredAntigravityProfile(environment);
    const created = new SupervisedProcessRunner([{
      id: ANTIGRAVITY_EXECUTABLE_ID,
      executable: defaultAntigravityCliExecutablePath("win32"),
      environment,
      isolatedWorkingDirectory: true,
      isolatedHomeFiles: {
        ".gemini/antigravity-cli/settings.json":
          ANTIGRAVITY_SUPERVISED_SETTINGS_JSON,
        ".gemini/config/agents/interview-realizer/agent.md":
          ANTIGRAVITY_REALIZER_AGENT_MARKDOWN
      }
    }]);
    runner = created;
    return created;
  };

  const executor: SupervisedCliExecutor = Object.freeze({
    execute: async (request: SupervisedCliExecutionRequest) => {
      return await getRunner().execute({
        executableId: ANTIGRAVITY_EXECUTABLE_ID,
        args: request.args,
        stdin: request.stdin,
        timeoutMs: request.timeoutMs,
        maxStdoutBytes: request.maxStdoutBytes,
        maxStderrBytes: request.maxStderrBytes,
        signal: request.signal,
        onProcessStart: request.onProcessStart
      });
    }
  });
  const billingVerificationFactory = (now: Date): unknown => {
    // resolveRuntime() calls getRunner() before exposing this factory, so this
    // proof is available only after the trusted host has validated the exact
    // isolated profile/environment used by the supervised process.
    return Object.freeze({
      billingClass: "ACCOUNT_QUOTA" as const,
      enforcementMechanism:
        "Isolated Antigravity account profile forces useG1Credits=false and excludes API-key/custom-endpoint authentication from the child environment",
      verifiedAt: now.toISOString(),
      adapterVersion: ANTIGRAVITY_CLI_ADAPTER_VERSION,
      spendImpossible: true
    });
  };
  const runtime = Object.freeze({ executor, billingVerificationFactory });

  return Object.freeze({
    resolveRuntime(selection: ProviderSelectionReference): unknown {
      if (
        selection.providerId === ANTIGRAVITY_CLI_PROVIDER_ID
        && selection.modelId === ANTIGRAVITY_CLI_MODEL_ID
      ) {
        // Acquire only for the selected provider. Construction failures are
        // allowed to be retried later and must not affect unrelated providers.
        getRunner();
        return runtime;
      }
      return undefined;
    },
    async drain(): Promise<void> {
      if (runner !== undefined) await runner.drain();
    }
  });
}

function antigravityEnvironment(): {
  readonly inherit: readonly string[];
  readonly values: Readonly<Record<string, string>>;
} {
  if (process.platform === "win32") {
    const systemRoot = trustedWindowsSystemRoot();
    return Object.freeze({
      inherit: Object.freeze([]),
      values: Object.freeze({
        SYSTEMROOT: systemRoot,
        WINDIR: systemRoot,
        PATH: win32Path.join(systemRoot, "System32"),
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
        AGY_CLI_DISABLE_AUTO_UPDATE: "true"
      })
    });
  }

  return Object.freeze({
    inherit: Object.freeze([
      "USER",
      "LOGNAME",
      "DBUS_SESSION_BUS_ADDRESS",
      "XDG_RUNTIME_DIR"
    ]),
    values: Object.freeze({
      AGY_CLI_DISABLE_AUTO_UPDATE: "true"
    })
  });
}


function assertNoMeteredAntigravityProfile(environment: {
  readonly inherit: readonly string[];
  readonly values: Readonly<Record<string, string>>;
}): void {
  const settings = ANTIGRAVITY_SAFE_SETTINGS as Readonly<Record<string, unknown>>;
  if (
    settings["useG1Credits"] !== false
    || Object.prototype.hasOwnProperty.call(settings, "modelProvider")
  ) {
    throw new Error("Antigravity no-metered profile is not pinned");
  }

  const forbiddenEnvironmentKeys = new Set([
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_GEMINI_BASE_URL"
  ]);
  for (const key of environment.inherit) {
    if (forbiddenEnvironmentKeys.has(key.toUpperCase())) {
      throw new Error("Antigravity no-metered environment is not isolated");
    }
  }
  for (const key of Object.keys(environment.values)) {
    if (forbiddenEnvironmentKeys.has(key.toUpperCase())) {
      throw new Error("Antigravity no-metered environment is not isolated");
    }
  }
}

function trustedWindowsSystemRoot(): string {
  const candidate = process.env["SystemRoot"] ?? process.env["SYSTEMROOT"];
  if (
    candidate === undefined
    || candidate.length === 0
    || candidate.includes("\0")
    || !win32Path.isAbsolute(candidate)
    || candidate.startsWith("\\\\")
  ) {
    throw new Error("Windows SystemRoot is unavailable or unsafe");
  }
  const normalized = win32Path.normalize(candidate);
  const parsed = win32Path.parse(normalized);
  if (
    win32Path.basename(normalized).toLowerCase() !== "windows"
    || win32Path.dirname(normalized).toLowerCase()
      !== parsed.root.toLowerCase()
  ) {
    throw new Error("Windows SystemRoot is not a root-level Windows directory");
  }
  return normalized;
}
