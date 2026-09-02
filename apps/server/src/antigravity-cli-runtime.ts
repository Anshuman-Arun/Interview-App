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
  const runner = new SupervisedProcessRunner([{
    id: ANTIGRAVITY_EXECUTABLE_ID,
    executable: defaultAntigravityCliExecutablePath(),
    environment: antigravityEnvironment(),
    isolatedWorkingDirectory: true,
    isolatedHomeFiles: {
      ".gemini/antigravity-cli/settings.json": ANTIGRAVITY_SAFE_SETTINGS_JSON
    }
  }]);

  const executor: SupervisedCliExecutor = Object.freeze({
    execute: async (request: SupervisedCliExecutionRequest) => {
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

function antigravityEnvironment(): {
  readonly inherit: readonly string[];
  readonly values: Readonly<Record<string, string>>;
} {
  if (process.platform === "win32") {
    return Object.freeze({
      inherit: Object.freeze(["USERNAME"]),
      values: Object.freeze({
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
