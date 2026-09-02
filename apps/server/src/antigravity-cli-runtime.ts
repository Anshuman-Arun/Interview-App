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

export interface ApplicationProviderAdapterRuntimeSource {
  readonly resolveRuntime: (
    selection: ProviderSelectionReference
  ) => unknown;
}

export function createApplicationProviderAdapterRuntimeSource(): ApplicationProviderAdapterRuntimeSource {
  const runner = new SupervisedProcessRunner([{
    id: ANTIGRAVITY_EXECUTABLE_ID,
    executable: defaultAntigravityCliExecutablePath(),
    environment: {
      inherit: antigravityEnvironmentKeys()
    },
    isolatedWorkingDirectory: true
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

function antigravityEnvironmentKeys(): readonly string[] {
  if (process.platform === "win32") {
    return Object.freeze(["USERPROFILE", "LOCALAPPDATA", "APPDATA"]);
  }
  return Object.freeze([
    "HOME",
    "USER",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME"
  ]);
}
