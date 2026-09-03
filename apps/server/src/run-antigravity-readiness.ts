import process from "node:process";
import {
  createApplicationProviderAdapterRuntimeSource
} from "./antigravity-cli-runtime.js";
import {
  ANTIGRAVITY_CLI_MODEL_ID,
  ANTIGRAVITY_CLI_PROVIDER_ID
} from "../../../packages/providers/src/index.js";

async function main(): Promise<void> {
  if (process.platform !== "win32") {
    throw new Error("Antigravity readiness smoke is supported only on Windows");
  }

  const source = createApplicationProviderAdapterRuntimeSource();
  try {
    const verifyRuntimeReadiness = source.verifyRuntimeReadiness;
    if (verifyRuntimeReadiness === undefined) {
      throw new Error("Antigravity runtime readiness verifier is unavailable");
    }
    await verifyRuntimeReadiness({
      providerId: ANTIGRAVITY_CLI_PROVIDER_ID,
      modelId: ANTIGRAVITY_CLI_MODEL_ID
    });
  } finally {
    await source.drain();
  }

  process.stdout.write(
    "Antigravity readiness smoke passed: exact CLI version, supervised launch, zero-turn stream protocol, empty resolved tool surface, isolated custom agent, and pinned model profile are ready without model inference or quota use.\n"
  );
}

void main().catch(() => {
  process.stderr.write(
    "Antigravity readiness smoke failed. Confirm agy 1.1.25 is installed and retry. Authentication is intentionally not probed by this zero-inference smoke; run agy interactively once before the first real interview turn.\n"
  );
  process.exitCode = 1;
});
