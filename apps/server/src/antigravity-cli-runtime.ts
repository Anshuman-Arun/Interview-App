import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import type { ProviderSelectionReference } from "../../../packages/domain/src/index.js";
import {
  SupervisedProcessRunner,
  defaultAntigravityCliExecutablePath
} from "../../../packages/local-runtime/src/index.js";
import {
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
  enableTerminalSandbox: true,
  useG1Credits: false,
  enableTelemetry: false,
  notifications: false,
  showFeedbackSurvey: false
});
const ANTIGRAVITY_SAFE_SETTINGS_JSON =
  JSON.stringify(ANTIGRAVITY_SAFE_SETTINGS) + "\n";

export interface ApplicationProviderAdapterRuntimeSource {
  readonly resolveRuntime: (
    selection: ProviderSelectionReference
  ) => unknown;
}

export function createApplicationProviderAdapterRuntimeSource(): ApplicationProviderAdapterRuntimeSource {
  const executable = defaultAntigravityCliExecutablePath();

  const executor: SupervisedCliExecutor = Object.freeze({
    execute: async (request: SupervisedCliExecutionRequest) => {
      const profile = await createIsolatedAntigravityProfile();
      try {
        const runner = new SupervisedProcessRunner([{
          id: ANTIGRAVITY_EXECUTABLE_ID,
          executable,
          environment: antigravityEnvironment(profile),
          isolatedWorkingDirectory: true
        }]);
        return await runner.execute({
          executableId: ANTIGRAVITY_EXECUTABLE_ID,
          args: request.args,
          stdin: request.stdin,
          timeoutMs: request.timeoutMs,
          maxStdoutBytes: request.maxStdoutBytes,
          maxStderrBytes: request.maxStderrBytes,
          signal: request.signal,
          onProcessStart: request.onProcessStart
        });
      } finally {
        await rm(profile, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  });
  const runtime = Object.freeze({ executor });

  return Object.freeze({
    resolveRuntime(selection: ProviderSelectionReference): unknown {
      if (
        selection.providerId === ANTIGRAVITY_CLI_PROVIDER_ID
        && selection.modelId === ANTIGRAVITY_CLI_MODEL_ID
      ) {
        return runtime;
      }
      return undefined;
    }
  });
}

async function createIsolatedAntigravityProfile(): Promise<string> {
  const profile = await mkdtemp(path.join(tmpdir(), "interview-antigravity-profile-"));
  if (process.platform !== "win32") {
    await chmod(profile, 0o700);
  }
  const settingsDirectory = path.join(
    profile,
    ".gemini",
    "antigravity-cli"
  );
  await mkdir(settingsDirectory, {
    recursive: true,
    ...(process.platform === "win32" ? {} : { mode: 0o700 })
  });
  await writeFile(
    path.join(settingsDirectory, "settings.json"),
    ANTIGRAVITY_SAFE_SETTINGS_JSON,
    {
      encoding: "utf8",
      flag: "wx",
      ...(process.platform === "win32" ? {} : { mode: 0o600 })
    }
  );
  return profile;
}

function antigravityEnvironment(
  isolatedProfile: string
): {
  readonly inherit: readonly string[];
  readonly values: Readonly<Record<string, string>>;
} {
  if (process.platform === "win32") {
    return Object.freeze({
      inherit: Object.freeze(["USERNAME"]),
      values: Object.freeze({
        USERPROFILE: isolatedProfile,
        APPDATA: path.join(isolatedProfile, "AppData", "Roaming"),
        LOCALAPPDATA: path.join(isolatedProfile, "AppData", "Local"),
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
      HOME: isolatedProfile,
      XDG_CONFIG_HOME: path.join(isolatedProfile, ".config"),
      XDG_DATA_HOME: path.join(isolatedProfile, ".local", "share"),
      XDG_CACHE_HOME: path.join(isolatedProfile, ".cache"),
      AGY_CLI_DISABLE_AUTO_UPDATE: "true"
    })
  });
}
