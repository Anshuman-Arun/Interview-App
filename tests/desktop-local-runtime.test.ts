import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  SpeechRequestIdSchema,
  SpeechUtteranceIdSchema,
  TtsRequestIdSchema
} from "../packages/local-compute/src/index.js";
import {
  LocalRuntimeManager,
  type LocalComponentDefinition
} from "../packages/local-runtime/src/index.js";
import { DesktopLocalRuntimeComposition } from "../apps/desktop/src/runtime/composition.js";
import { ManagedModelWorkerClient } from "../apps/desktop/src/runtime/managed-worker-client.js";
import {
  ManagedKokoroRuntime,
  ManagedMoonshineRuntime,
  ManagedSileroVadRuntime
} from "../apps/desktop/src/runtime/runtime-adapters.js";
import { cleanupStaleRuntimeAssetViews } from "../apps/desktop/src/runtime/runtime-asset-view.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/local-model-http-worker.mjs", import.meta.url));
const PRODUCTION_WORKER = fileURLToPath(
  new URL("../workers/python/local_model_worker.py", import.meta.url)
);
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
  it("keeps the production Python worker syntax-valid in CI", () => {
    const result = spawnSync("python", [
      "-c",
      [
        "import ast, pathlib, sys",
        "source = pathlib.Path(sys.argv[1]).read_text(encoding='utf-8')",
        "ast.parse(source, filename=sys.argv[1])"
      ].join("; "),
      PRODUCTION_WORKER
    ], {
      encoding: "utf8",
      windowsHide: true
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });


  it("does not delete a verified runtime view owned by this live desktop process", async () => {
    const root = temporaryRoot("desktop-runtime-view-owner-");
    const liveView = join(root, `run-${String(process.pid)}-live`);
    mkdirSync(liveView, { recursive: true });

    await cleanupStaleRuntimeAssetViews(root);

    expect(existsSync(liveView)).toBe(true);
  });

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

  it("coalesces concurrent composition shutdown instead of double-closing worker cores", async () => {
    const composition = new DesktopLocalRuntimeComposition({
      appDataRoot: temporaryRoot("desktop-stop-coalesce-"),
      cwd: process.cwd(),
      resourcesPath: process.cwd(),
      isPackaged: false,
      pythonExecutable: process.execPath
    });
    compositions.push(composition);

    let shutdownCalls = 0;
    let releaseShutdown: (() => void) | undefined;
    const shutdownGate = new Promise<void>((resolve) => {
      releaseShutdown = resolve;
    });
    const mutable = composition as unknown as {
      speechWorker?: { shutdown(): Promise<void> };
    };
    mutable.speechWorker = {
      shutdown: async () => {
        shutdownCalls += 1;
        await shutdownGate;
      }
    };

    const first = composition.stopWorkers();
    const second = composition.stopWorkers();
    expect(second).toBe(first);
    await Promise.resolve();
    expect(shutdownCalls).toBe(1);
    releaseShutdown?.();
    await expect(first).resolves.toBeUndefined();
    expect(shutdownCalls).toBe(1);
  });

  it("retains and retries a runtime view whose deletion failed during shutdown", async () => {
    const composition = new DesktopLocalRuntimeComposition({
      appDataRoot: temporaryRoot("desktop-stop-view-retry-"),
      cwd: process.cwd(),
      resourcesPath: process.cwd(),
      isPackaged: false,
      pythonExecutable: process.execPath
    });
    compositions.push(composition);

    let disposeCalls = 0;
    const mutable = composition as unknown as {
      speechView?: {
        readonly root: string;
        readonly paths: ReadonlyMap<string, string>;
        dispose(): Promise<void>;
      };
    };
    mutable.speechView = {
      root: temporaryRoot("desktop-stop-view-"),
      paths: new Map(),
      dispose: async () => {
        disposeCalls += 1;
        if (disposeCalls === 1) throw new Error("synthetic view cleanup failure");
      }
    };

    await expect(composition.stopWorkers()).rejects.toThrow(
      "Desktop local model runtime shutdown failed"
    );
    expect(disposeCalls).toBe(1);

    await expect(composition.start()).rejects.toThrow(
      "Desktop local runtime cannot start after shutdown"
    );
    await expect(composition.stopWorkers()).resolves.toBeUndefined();
    expect(disposeCalls).toBe(2);
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
      requestId: SpeechRequestIdSchema.parse("request-1"),
      utteranceId: SpeechUtteranceIdSchema.parse("utterance-1"),
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

    const requestId = TtsRequestIdSchema.parse("tts-request-1");
    const result = await session.synthesize({
      requestId,
      text: "Exact admitted text.",
      voice: "kokoro_af_heart",
      language: "en-US",
      speed: 1,
      sampleRate: 24_000
    });
    expect(result.sampleRate).toBe(24_000);
    expect(result.channels).toBe(1);
    expect(result.samples[0]).toBe(0);
    expect(result.samples[1]).toBeCloseTo(0.05, 6);
    expect(result.samples[2]).toBeCloseTo(-0.05, 6);
    expect(result.samples[3]).toBe(0);
  });

  it("cancels the exact active Kokoro request through the supervised worker", async () => {
    const token = "e".repeat(64);
    const runtime = fixtureManager(
      "tts-cancel-fixture",
      "tts",
      "fixture-tts-1",
      token,
      "blocking-tts"
    );
    await runtime.start("tts-cancel-fixture");
    const client = new ManagedModelWorkerClient(
      runtime,
      "tts-cancel-fixture",
      "tts",
      token
    );
    const adapter = new ManagedKokoroRuntime(
      client,
      "/verified/model.ort",
      "/verified/config.json"
    );
    const session = await adapter.initialize({
      modelPath: "/verified/model.ort",
      configPath: "/verified/config.json"
    });
    const requestId = TtsRequestIdSchema.parse("tts-cancel-active");
    const synthesis = session.synthesize({
      requestId,
      text: "Cancel this exact admitted text.",
      voice: "kokoro_af_heart",
      language: "en-US",
      speed: 1,
      sampleRate: 24_000
    });
    await waitForStatus(runtime, "tts-cancel-fixture", (status) =>
      status.stdout.lines.includes(`TTS_STARTED:${requestId}`)
    );

    if (session.cancel === undefined) throw new Error("Expected Kokoro runtime cancellation");
    await expect(session.cancel(requestId)).resolves.toBeUndefined();
    await expect(synthesis).rejects.toThrow("rejected");
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

    if (process.platform === "win32") {
      await waitForStatus(runtime, "restart-fixture", (status) =>
        status.state === "FAILED"
        && status.failure?.code === "TERMINATION_FAILED"
        && status.restartCount === 0
      );
      return;
    }

    await waitForStatus(runtime, "restart-fixture", (status) =>
      status.state === "READY" && status.restartCount === 1
    );
    await expect(client.postJson("/v1/vad", {
      pcmF32Base64: "AAAAAA==",
      sampleRate: 16_000,
      streamId: "stream-1"
    })).resolves.toEqual({ speechProbability: 0.875 });
  }, 15_000);
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
      workerType: component,
      runtimeVersion: "fixture-runtime-1",
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
