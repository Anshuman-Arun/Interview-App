import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { LocalRuntimeManager, type LocalComponentDefinition } from "../packages/local-runtime/src/index.js";
import { DesktopLocalRuntimeComposition } from "../apps/desktop/src/runtime/composition.js";
import { ManagedModelWorkerClient } from "../apps/desktop/src/runtime/managed-worker-client.js";
import {
  ManagedKokoroRuntime,
  ManagedMoonshineRuntime,
  ManagedSileroVadRuntime
} from "../apps/desktop/src/runtime/runtime-adapters.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/local-model-http-worker.mjs", import.meta.url));
const temporaryRoots: string[] = [];
const managers: LocalRuntimeManager[] = [];
const compositions: DesktopLocalRuntimeComposition[] = [];

afterEach(async () => {
  for (const composition of compositions.splice(0)) {
    await composition.stopWorkers().catch(() => undefined);
  }
  for (const manager of managers.splice(0)) {
    await manager.stopAll().catch(() => undefined);
  }
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("desktop local model runtime", () => {
  it("keeps typed desktop startup usable when production model assets are absent", async () => {
    const appDataRoot = temporaryRoot("desktop-local-models-");
    const composition = new DesktopLocalRuntimeComposition({
      appDataRoot,
      cwd: process.cwd(),
      resourcesPath: process.cwd(),
      isPackaged: false,
      pythonExecutable: process.execPath
    });
    compositions.push(composition);

    await composition.start();

    expect(composition.voiceRuntime).toBeUndefined();
    expect(composition.getCapabilityStatus()).toEqual({
      speech: {
        state: "MISSING_ASSET",
        reasonCode: "SPEECH_ASSET_MISSING"
      },
      tts: {
        state: "MISSING_ASSET",
        reasonCode: "TTS_ASSET_MISSING"
      },
      vision: {
        state: "UNAVAILABLE",
        reasonCode: "NO_PRODUCTION_BACKEND_CONFIGURED"
      }
    });
  });

  it("authenticates a supervised loopback speech worker and preserves bounded adapter output", async () => {
    const token = "a".repeat(64);
    const runtime = fixtureManager("speech-fixture", "speech", "fixture-speech-1", token);
    await runtime.start("speech-fixture");
    const client = new ManagedModelWorkerClient(runtime, "speech-fixture", "speech", token);

    const vad = new ManagedSileroVadRuntime(client, "/verified/silero.onnx");
    await expect(vad.score({
      pcmBytes: new Uint8Array(new Float32Array([0, 0.1, 0.2, 0.1]).buffer),
      sampleRate: 16_000,
      streamId: "stream-1",
      modelPath: "/verified/silero.onnx"
    })).resolves.toBe(0.875);

    const stt = new ManagedMoonshineRuntime(client, "/verified/moonshine");
    await expect(stt.transcribe({
      requestId: "request-1",
      utteranceId: "utterance-1",
      pcmBytes: new Uint8Array(new Float32Array([0, 0.1, 0]).buffer),
      sampleRate: 16_000,
      modelPath: "/verified/moonshine"
    })).resolves.toEqual({
      text: "fixture transcript",
      confidence: 0.9
    });

    const wrongTokenClient = new ManagedModelWorkerClient(
      runtime,
      "speech-fixture",
      "speech",
      "b".repeat(64)
    );
    await expect(wrongTokenClient.postJson("/v1/vad", {
      pcmF32Base64: "AAAAAA==",
      sampleRate: 16_000,
      streamId: "stream-1"
    })).rejects.toThrow("rejected");
  });

  it("adapts supervised Kokoro PCM without permitting semantic regeneration", async () => {
    const token = "c".repeat(64);
    const runtime = fixtureManager("tts-fixture", "tts", "fixture-tts-1", token);
    await runtime.start("tts-fixture");
    const client = new ManagedModelWorkerClient(runtime, "tts-fixture", "tts", token);
    const adapter = new ManagedKokoroRuntime(client, "/verified/model.ort", "/verified/config.json");
    const session = await adapter.initialize({
      modelPath: "/verified/model.ort",
      configPath: "/verified/config.json"
    });

    const result = await session.synthesize({
      text: "Exact admitted text.",
      voice: "kokoro_af_heart",
      language: "en-US",
      speed: 1,
      sampleRate: 24_000
    });
    expect(result.sampleRate).toBe(24_000);
    expect(result.channels).toBe(1);
    expect(Array.from(result.samples)).toEqual([0, 0.05, -0.05, 0]);
  });

  it("recovers through LocalRuntimeManager after a worker dies during inference", async () => {
    const root = temporaryRoot("desktop-model-restart-");
    const marker = join(root, "crashed.once");
    const token = "d".repeat(64);
    const runtime = fixtureManager(
      "restart-fixture",
      "speech",
      "fixture-speech-1",
      token,
      "crash-on-first-request",
      marker
    );
    await runtime.start("restart-fixture");
    const client = new ManagedModelWorkerClient(runtime, "restart-fixture", "speech", token);

    await expect(client.postJson("/v1/vad", {
      pcmF32Base64: "AAAAAA==",
      sampleRate: 16_000,
      streamId: "stream-1"
    })).rejects.toThrow();

    await waitForStatus(runtime, "restart-fixture", (status) =>
      status.state === "READY" && status.restartCount === 1
    );
    await expect(client.postJson("/v1/vad", {
      pcmF32Base64: "AAAAAA==",
      sampleRate: 16_000,
      streamId: "stream-1"
    })).resolves.toEqual({ speechProbability: 0.875 });
  });
});

function fixtureManager(
  id: string,
  component: "speech" | "tts",
  modelIdentity: string,
  token: string,
  behavior = "ready",
  markerPath?: string
): LocalRuntimeManager {
  const runtime = new LocalRuntimeManager();
  managers.push(runtime);
  const capabilities = component === "speech" ? ["vad", "stt"] : ["tts"];
  const definition: LocalComponentDefinition = {
    id,
    executable: process.execPath,
    args: [
      FIXTURE,
      component,
      modelIdentity,
      behavior,
      ...(markerPath === undefined ? [] : [markerPath])
    ],
    cwd: dirname(FIXTURE),
    environment: {
      secrets: {
        INTERVIEW_LOCAL_WORKER_TOKEN: token
      }
    },
    startupTimeoutMs: 2_000,
    shutdownTimeoutMs: 300,
    terminationTimeoutMs: process.platform === "win32" ? 1_000 : 300,
    readiness: {
      kind: "STDOUT_JSON",
      evaluate: (message) => {
        if (typeof message !== "object" || message === null) return false;
        const value = message as Record<string, unknown>;
        if (value["ready"] !== true) return false;
        return {
          ready: true,
          handshake: value["handshake"] as NonNullable<LocalComponentDefinition["expectedHandshake"]>
        };
      }
    },
    expectedHandshake: {
      componentVersion: "1",
      protocolVersion: 1,
      modelVersionOrHash: modelIdentity,
      capabilities
    },
    restartPolicy: {
      mode: "ON_FAILURE",
      maxRetries: 2,
      backoffMs: 20,
      maxBackoffMs: 50
    },
    output: {
      maxLines: 32,
      maxBytes: 32 * 1024,
      maxLineBytes: 8 * 1024
    },
    gracefulShutdown: async (control) => {
      await control.writeStdin("shutdown\n");
      control.endStdin();
    }
  };
  runtime.register(definition);
  return runtime;
}

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

async function waitForStatus(
  runtime: LocalRuntimeManager,
  componentId: string,
  predicate: (status: ReturnType<LocalRuntimeManager["getStatus"]>) => boolean
): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (performance.now() < deadline) {
    if (predicate(runtime.getStatus(componentId))) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  expect(predicate(runtime.getStatus(componentId))).toBe(true);
}
