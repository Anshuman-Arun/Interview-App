import { describe, expect, it } from "vitest";
import {
  ANTIGRAVITY_REALIZER_AGENT_MARKDOWN,
  ANTIGRAVITY_SUPERVISED_SETTINGS_JSON
} from "../apps/server/src/antigravity-cli-runtime.js";

describe("supervised Antigravity runtime profile", () => {
  it("pins a no-tool, no-credit, no-telemetry CLI settings profile", () => {
    const settings = JSON.parse(ANTIGRAVITY_SUPERVISED_SETTINGS_JSON) as {
      readonly toolPermission?: unknown;
      readonly useG1Credits?: unknown;
      readonly enableTelemetry?: unknown;
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

  it("pins a primary-only custom agent with an empty toolset", () => {
    expect(ANTIGRAVITY_REALIZER_AGENT_MARKDOWN).toContain(
      "name: interview-realizer"
    );
    expect(ANTIGRAVITY_REALIZER_AGENT_MARKDOWN).toContain("tools: []");
    expect(ANTIGRAVITY_REALIZER_AGENT_MARKDOWN).toContain("mainAgent: true");
    expect(ANTIGRAVITY_REALIZER_AGENT_MARKDOWN).toContain("subagent: false");
    expect(ANTIGRAVITY_REALIZER_AGENT_MARKDOWN).not.toContain("run_command");
    expect(ANTIGRAVITY_REALIZER_AGENT_MARKDOWN).not.toContain("invoke_subagent");
    expect(ANTIGRAVITY_REALIZER_AGENT_MARKDOWN).not.toContain("commandExecutionPolicy:");
    expect(ANTIGRAVITY_REALIZER_AGENT_MARKDOWN).not.toContain("mcpServers:");
    expect(ANTIGRAVITY_REALIZER_AGENT_MARKDOWN).not.toContain("skills:");
    expect(ANTIGRAVITY_REALIZER_AGENT_MARKDOWN).not.toContain("plugins:");
  });
});
