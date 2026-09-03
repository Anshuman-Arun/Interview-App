import { win32 as win32Path } from "node:path";
import process from "node:process";
import type { ProviderSelectionReference } from "../../../packages/domain/src/index.js";
import {
  SupervisedProcessRunner,
  defaultAntigravityCliExecutablePath
} from "../../../packages/local-runtime/src/index.js";
import {
  ANTIGRAVITY_CLI_MODEL_ID,
  ANTIGRAVITY_CLI_PROVIDER_ID,
  ANTIGRAVITY_CLI_TURN_ARGUMENTS,
  ANTIGRAVITY_CLI_ZERO_TURN_PREFLIGHT_INPUT,
  assertAntigravityCliZeroTurnPreflightResult,
  type SupervisedCliExecutionRequest,
  type SupervisedCliExecutor
} from "../../../packages/providers/src/index.js";

const ANTIGRAVITY_EXECUTABLE_ID = "antigravity-cli";
const ANTIGRAVITY_SAFE_CLI_VERSION = Object.freeze([1, 1, 25] as const);
// First use also pays cold executable hashing and trusted Windows supervisor
// compilation. Those stages are each independently bounded at 30s, so this
// one-time local preflight must leave room for both plus `agy --version`.
const ANTIGRAVITY_VERSION_CHECK_TIMEOUT_MS = 75_000;
const ANTIGRAVITY_VERSION_STDOUT_BYTES = 256;
const ANTIGRAVITY_VERSION_STDERR_BYTES = 4 * 1024;
const ANTIGRAVITY_PROFILE_PREFLIGHT_TIMEOUT_MS = 75_000;
const ANTIGRAVITY_PROFILE_PREFLIGHT_STDOUT_BYTES = 64 * 1024;
const ANTIGRAVITY_PROFILE_PREFLIGHT_STDERR_BYTES = 16 * 1024;
const ANTIGRAVITY_SAFE_SETTINGS = Object.freeze({
  toolPermission: "strict",
  artifactReviewPolicy: "asks-for-review",
  allowNonWorkspaceAccess: false,
  useG1Credits: false,
  enableTelemetry: false,
  notifications: false,
  showTips: false,
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
inheritCustomizations: false
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
  let versionVerification: Promise<void> | undefined;
  let profileVerification: Promise<void> | undefined;

  const getRunner = (): SupervisedProcessRunner => {
    if (runner !== undefined) return runner;
    const environment = antigravityEnvironment();
    assertRestrictedAntigravityProfile(environment);
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

  const ensureSupportedVersion = async (
    signal: AbortSignal | undefined
  ): Promise<void> => {
    if (signal?.aborted === true) {
      throw new Error("Antigravity runtime verification wait cancelled");
    }
    let check = versionVerification;
    if (check === undefined) {
      check = (async () => {
        const result = await getRunner().execute({
          executableId: ANTIGRAVITY_EXECUTABLE_ID,
          args: ["--version"],
          stdin: "",
          timeoutMs: ANTIGRAVITY_VERSION_CHECK_TIMEOUT_MS,
          maxStdoutBytes: ANTIGRAVITY_VERSION_STDOUT_BYTES,
          maxStderrBytes: ANTIGRAVITY_VERSION_STDERR_BYTES
        });
        if (
          result.exitCode !== 0
          || !isSupportedAntigravityCliVersionOutput(result.stdout)
        ) {
          throw new Error("Installed Antigravity CLI version is unsupported");
        }
      })();
      versionVerification = check;
      const captured = check;
      void captured.catch(() => {
        if (versionVerification === captured) versionVerification = undefined;
      });
    }
    await waitForSharedVerificationOrAbort(check, signal);
  };

  const ensureSupportedProfile = async (
    signal: AbortSignal | undefined
  ): Promise<void> => {
    if (signal?.aborted === true) {
      throw new Error("Antigravity runtime verification wait cancelled");
    }
    let check = profileVerification;
    if (check === undefined) {
      check = (async () => {
        const result = await getRunner().execute({
          executableId: ANTIGRAVITY_EXECUTABLE_ID,
          args: ANTIGRAVITY_CLI_TURN_ARGUMENTS,
          stdin: ANTIGRAVITY_CLI_ZERO_TURN_PREFLIGHT_INPUT,
          timeoutMs: ANTIGRAVITY_PROFILE_PREFLIGHT_TIMEOUT_MS,
          maxStdoutBytes: ANTIGRAVITY_PROFILE_PREFLIGHT_STDOUT_BYTES,
          maxStderrBytes: ANTIGRAVITY_PROFILE_PREFLIGHT_STDERR_BYTES
        });
        assertAntigravityCliZeroTurnPreflightResult(result);
      })();
      profileVerification = check;
      const captured = check;
      void captured.catch(() => {
        if (profileVerification === captured) profileVerification = undefined;
      });
    }
    await waitForSharedVerificationOrAbort(check, signal);
  };

  const executor: SupervisedCliExecutor = Object.freeze({
    execute: async (request: SupervisedCliExecutionRequest) => {
      await ensureSupportedVersion(request.signal);
      await ensureSupportedProfile(request.signal);
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
  // Profile isolation disables AI-credit fallback and inherited API-key/custom-endpoint
  // configuration, but cached authentication can still select a subscription, enterprise,
  // or Google Cloud project billing mode. Do not fabricate spend-impossible evidence.
  // The default no-metered policy therefore rejects before remote inference; explicit
  // trusted-host opt-in is required for this provider.
  const runtime = Object.freeze({ executor });
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

async function waitForSharedVerificationOrAbort(
  verification: Promise<void>,
  signal: AbortSignal | undefined
): Promise<void> {
  if (signal === undefined) {
    await verification;
    return;
  }
  if (signal.aborted) throw new Error("Antigravity runtime verification wait cancelled");

  let onAbort = (): void => undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new Error("Antigravity runtime verification wait cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([verification, cancelled]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
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


export function isSupportedAntigravityCliVersionOutput(
  value: string
): boolean {
  if (value.length === 0 || value.length > ANTIGRAVITY_VERSION_STDOUT_BYTES) {
    return false;
  }
  const normalized = value.trim();
  const match = /^(?:(?:agy)(?:\s+version)?\s+)?v?([0-9]+)\.([0-9]+)\.([0-9]+)$/u.exec(
    normalized
  );
  if (match === null) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (
    !Number.isSafeInteger(major)
    || !Number.isSafeInteger(minor)
    || !Number.isSafeInteger(patch)
  ) {
    return false;
  }

  const [safeMajor, safeMinor, safePatch] = ANTIGRAVITY_SAFE_CLI_VERSION;
  // Headless, keyring restoration, profile, auth, stdio, and protocol behavior
  // can change even in a patch release. This runtime depends on the later 1.1.x
  // fixes for keyring/account restoration, stream integrity, and piped stdio
  // shutdown, so admit exactly the release audited for this adapter.
  return major === safeMajor && minor === safeMinor && patch === safePatch;
}

function assertRestrictedAntigravityProfile(environment: {
  readonly inherit: readonly string[];
  readonly values: Readonly<Record<string, string>>;
}): void {
  const settings = ANTIGRAVITY_SAFE_SETTINGS as Readonly<Record<string, unknown>>;
  if (
    settings["useG1Credits"] !== false
    || Object.prototype.hasOwnProperty.call(settings, "modelProvider")
  ) {
    throw new Error("Antigravity restricted profile is not pinned");
  }

  const forbiddenEnvironmentKeys = new Set([
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_GEMINI_BASE_URL"
  ]);
  for (const key of environment.inherit) {
    if (forbiddenEnvironmentKeys.has(key.toUpperCase())) {
      throw new Error("Antigravity restricted environment is not isolated");
    }
  }
  for (const key of Object.keys(environment.values)) {
    if (forbiddenEnvironmentKeys.has(key.toUpperCase())) {
      throw new Error("Antigravity restricted environment is not isolated");
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
