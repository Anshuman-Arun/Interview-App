import process from "node:process";
import { describe, expect, it } from "vitest";
import {
  ANTIGRAVITY_REALIZER_AGENT_MARKDOWN,
  ANTIGRAVITY_SUPERVISED_SETTINGS_JSON,
  createApplicationProviderAdapterRuntimeSource
} from "../apps/server/src/antigravity-cli-runtime.js";
import {
  ANTIGRAVITY_CLI_MODEL_ID,
  ANTIGRAVITY_CLI_PROVIDER_ID
} from "../packages/providers/src/index.js";

describe("supervised Antigravity runtime profile", () => {
  it("pins a no-tool, no-credit, no-telemetry CLI settings profile", () => {
    const settings = JSON.parse(ANTIGRAVITY_SUPERVISED_SETTINGS_JSON) as {
      readonly toolPermission?: unknown;
      readonly useG1Credits?: unknown;
      readonly enableTelemetry?: unknown;
      readonly enableTerminalSandbox?: unknown;
      readonly allowNonWorkspaceAccess?: unknown;
      readonly permissions?: {
        readonly allow?: unknown;
        readonly ask?: unknown;
        readonly deny?: unknown;
      };
      readonly modelProvider?: unknown;
    };

    expect(settings.toolPermission).toBe("strict");
    expect(settings.useG1Credits).toBe(false);
    expect(settings.enableTelemetry).toBe(false);
    expect(settings.enableTerminalSandbox).toBeUndefined();
    expect(settings.allowNonWorkspaceAccess).toBe(false);
    expect(settings.modelProvider).toBeUndefined();
    expect(settings.permissions?.allow).toEqual([]);
    expect(settings.permissions?.ask).toEqual([]);
    expect(settings.permissions?.deny).toEqual([
      "read_file(*)",
      "write_file(*)",
      "read_url(*)",
      "execute_url(*)",
      "command(*)",
      "unsandboxed(*)",
      "mcp(*)"
    ]);
    expect(ANTIGRAVITY_SUPERVISED_SETTINGS_JSON).not.toContain("GEMINI_API_KEY");
  });

  it.runIf(process.platform === "win32")(
    "isolates Antigravity acquisition failure from other providers and retries cleanly",
    () => {
      const source = createApplicationProviderAdapterRuntimeSource();
      const originalSystemRoot: string | undefined =
        process.env["SystemRoot"];
      const originalUpperSystemRoot: string | undefined =
        process.env["SYSTEMROOT"];
      try {
        process.env["SystemRoot"] = "\\\\hostile-server\\share\\Windows";
        process.env["SYSTEMROOT"] = "\\\\hostile-server\\share\\Windows";

        expect(source.resolveRuntime({
          providerId: "mock-model",
          modelId: "mock-default"
        })).toBeUndefined();
        expect(() => source.resolveRuntime({
          providerId: ANTIGRAVITY_CLI_PROVIDER_ID,
          modelId: ANTIGRAVITY_CLI_MODEL_ID
        })).toThrow();
      } finally {
        if (originalSystemRoot === undefined) delete process.env["SystemRoot"];
        else process.env["SystemRoot"] = originalSystemRoot;
        if (originalUpperSystemRoot === undefined) delete process.env["SYSTEMROOT"];
        else process.env["SYSTEMROOT"] = originalUpperSystemRoot;
      }

      expect(hasRuntimeExecutor(source.resolveRuntime({
        providerId: ANTIGRAVITY_CLI_PROVIDER_ID,
        modelId: ANTIGRAVITY_CLI_MODEL_ID
      }))).toBe(true);
    }
  );

  it("pins a primary-only custom agent using only documented capability fields", () => {
    expect(ANTIGRAVITY_REALIZER_AGENT_MARKDOWN).toContain(
      "name: interview-realizer"
    );
    expect(ANTIGRAVITY_REALIZER_AGENT_MARKDOWN).toContain("tools: []");
    expect(ANTIGRAVITY_REALIZER_AGENT_MARKDOWN).toContain("mainAgent: true");
    expect(ANTIGRAVITY_REALIZER_AGENT_MARKDOWN).toContain("subagent: false");
    expect(ANTIGRAVITY_REALIZER_AGENT_MARKDOWN).not.toContain("run_command");
    expect(ANTIGRAVITY_REALIZER_AGENT_MARKDOWN).not.toContain("invoke_subagent");
    expect(ANTIGRAVITY_REALIZER_AGENT_MARKDOWN).not.toContain(
      "commandExecutionPolicy:"
    );
    expect(ANTIGRAVITY_REALIZER_AGENT_MARKDOWN).not.toContain("mcpServers:");
    expect(ANTIGRAVITY_REALIZER_AGENT_MARKDOWN).not.toContain("skills:");
    expect(ANTIGRAVITY_REALIZER_AGENT_MARKDOWN).not.toContain("plugins:");
  });

  it("fails closed for the concrete Antigravity runtime outside Windows", async () => {
    const source = createApplicationProviderAdapterRuntimeSource();
    const runtime = source.resolveRuntime({
      providerId: ANTIGRAVITY_CLI_PROVIDER_ID,
      modelId: ANTIGRAVITY_CLI_MODEL_ID
    });

    if (process.platform === "win32") {
      expect(hasRuntimeExecutor(runtime)).toBe(true);
    } else {
      expect(runtime).toBeUndefined();
    }

    expect(source.resolveRuntime({
      providerId: ANTIGRAVITY_CLI_PROVIDER_ID,
      modelId: "unexpected-model"
    })).toBeUndefined();
    expect(source.resolveRuntime({
      providerId: "unexpected-provider",
      modelId: ANTIGRAVITY_CLI_MODEL_ID
    })).toBeUndefined();

    await expect(source.drain()).resolves.toBeUndefined();
  });
});


function hasRuntimeExecutor(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const executorDescriptor = Object.getOwnPropertyDescriptor(value, "executor");
  if (
    executorDescriptor === undefined
    || !("value" in executorDescriptor)
    || typeof executorDescriptor.value !== "object"
    || executorDescriptor.value === null
  ) {
    return false;
  }
  const executeDescriptor = Object.getOwnPropertyDescriptor(
    executorDescriptor.value,
    "execute"
  );
  return executeDescriptor !== undefined
    && "value" in executeDescriptor
    && typeof executeDescriptor.value === "function";
}
