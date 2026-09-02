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
import {
  ManagedModelWorkerClient,
  ManagedWorkerRequestTimeoutError,
  ManagedWorkerResponseError
} from "../apps/desktop/src/runtime/managed-worker-client.js";
import {
  ManagedKokoroRuntime,
  ManagedMoonshineRuntime,
  ManagedSileroVadRuntime
} from "../apps/desktop/src/runtime/runtime-adapters.js";
import {
  cleanupStaleRuntimeAssetViews,
  materializeRuntimeAssetView
} from "../apps/desktop/src/runtime/runtime-asset-view.js";
import { ModelAssetManager } from "../packages/model-assets/src/index.js";

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


  it("does not delete a runtime view owned by this exact desktop process instance", async () => {
    const root = temporaryRoot("desktop-runtime-view-owner-");
    const manager = new ModelAssetManager({
      rootDir: temporaryRoot("desktop-runtime-view-assets-"),
      maxArtifactBytes: 1024,
      maxCacheBytes: 4096
    });
    const liveView = await materializeRuntimeAssetView({
      manager,
      assets: [],
      baseRoot: root
    });

    await cleanupStaleRuntimeAssetViews(root);

    expect(existsSync(liveView.root)).toBe(true);
    await liveView.dispose();
  });

  it("deletes an orphaned runtime view even when its PID has been reused", async () => {
    const root = temporaryRoot("desktop-runtime-view-pid-reuse-");
    const orphan = join(root, `run-${String(process.pid)}-${"0".repeat(32)}-orphan`);
    mkdirSync(orphan, { recursive: true });

    await cleanupStaleRuntimeAssetViews(root);

    expect(existsSync(orphan)).toBe(false);
  });

  it("progressively cleans more than the old stale-view limit without permanent lockout", async () => {
    const root = temporaryRoot("desktop-runtime-view-many-stale-");
    for (let index = 0; index < 40; index += 1) {
      mkdirSync(
        join(root, `run-999999-${String(index).padStart(32, "0")}-stale`),
        { recursive: true }
      );
    }

    await cleanupStaleRuntimeAssetViews(root);
    await cleanupStaleRuntimeAssetViews(root);
    await cleanupStaleRuntimeAssetViews(root);

    const remaining = (await import("node:fs/promises")).readdir(root);
    await expect(remaining).resolves.toHaveLength(0);
  });

  it("launches production Python workers in isolated interpreter mode", () => {
    const composition = new DesktopLocalRuntimeComposition({
      appDataRoot: temporaryRoot("desktop-python-isolated-"),
      cwd: process.cwd(),
      resourcesPath: process.cwd(),
      isPackaged: false,
      pythonExecutable: "python"
    });
    compositions.push(composition);

    const mutable = composition as unknown as {
      pythonExecutable?: string;
      workerDefinition(input: {
        readonly componentId: string;
        readonly component: "speech" | "tts";
        readonly token: string;
        readonly modelIdentity: string;
        readonly runtimeVersion: string;
        readonly capabilities: readonly string[];
        readonly args: readonly string[];
      }): LocalComponentDefinition;
    };
    // workerDefinition is an internal post-preflight primitive. Pin the
    // already-known absolute test executable so this test can focus on -I.
    mutable.pythonExecutable = process.execPath;
    const definition = mutable.workerDefinition({
      componentId: "isolated-fixture",
      component: "speech",
      token: "a".repeat(64),
      modelIdentity: "fixture-model",
      runtimeVersion: "fixture-runtime",
      capabilities: ["vad", "stt"],
      args: ["--component", "speech"]
    });

    const args = definition.args;
    if (args === undefined) throw new Error("Expected production worker arguments");
    expect(definition.executable).toBe(process.execPath);
    expect(definition.environment?.values?.["PATH"]).toBe(dirname(process.execPath));
    expect(args[0]).toBe("-I");
    expect(args[1]).toBe(PRODUCTION_WORKER);
  });

  it("degrades voice without spawning when the configured Python runtime cannot be resolved", async () => {
    const composition = new DesktopLocalRuntimeComposition({
      appDataRoot: temporaryRoot("desktop-python-missing-"),
      cwd: process.cwd(),
      resourcesPath: process.cwd(),
      isPackaged: false,
      pythonExecutable: join(
        temporaryRoot("desktop-python-missing-bin-"),
        process.platform === "win32" ? "python.exe" : "python3"
      )
    });
    compositions.push(composition);

    await expect(composition.start()).resolves.toBeUndefined();

    expect(composition.voiceRuntime).toBeUndefined();
    expect(composition.getCapabilityStatus()).toEqual({
      speech: {
        state: "UNAVAILABLE",
        reasonCode: "PYTHON_RUNTIME_UNAVAILABLE"
      },
      tts: {
        state: "UNAVAILABLE",
        reasonCode: "PYTHON_RUNTIME_UNAVAILABLE"
      },
      vision: {
        state: "UNAVAILABLE",
        reasonCode: "NO_PRODUCTION_BACKEND_CONFIGURED"
      }
    });
  });

  it("reports explicit cancellation when optional runtime startup is already aborted", async () => {
    const composition = new DesktopLocalRuntimeComposition({
      appDataRoot: temporaryRoot("desktop-start-cancelled-"),
      cwd: process.cwd(),
      resourcesPath: process.cwd(),
      isPackaged: false,
      pythonExecutable: process.execPath
    });
    compositions.push(composition);
    const controller = new AbortController();
    controller.abort();

    await expect(composition.start({ signal: controller.signal })).resolves.toBeUndefined();

    expect(composition.voiceRuntime).toBeUndefined();
    expect(composition.getCapabilityStatus()).toEqual({
      speech: {
        state: "UNAVAILABLE",
        reasonCode: "START_CANCELLED"
      },
      tts: {
        state: "UNAVAILABLE",
        reasonCode: "START_CANCELLED"
      },
      vision: {
        state: "UNAVAILABLE",
        reasonCode: "NO_PRODUCTION_BACKEND_CONFIGURED"
      }
    });
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

  it("aborts and joins startup before local runtime shutdown can complete", async () => {
    const composition = new DesktopLocalRuntimeComposition({
      appDataRoot: temporaryRoot("desktop-start-stop-race-"),
      cwd: process.cwd(),
      resourcesPath: process.cwd(),
      isPackaged: false,
      pythonExecutable: process.execPath
    });
    compositions.push(composition);

    let releaseCleanup: (() => void) | undefined;
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const mutable = composition as unknown as {
      assetManager: { cleanupTemporary(): Promise<void> };
    };
    mutable.assetManager.cleanupTemporary = async () => cleanupGate;

    const start = composition.start();
    let stopSettled = false;
    const stop = composition.stopWorkers().finally(() => {
      stopSettled = true;
    });
    await Promise.resolve();
    expect(stopSettled).toBe(false);

    releaseCleanup?.();
    await expect(start).resolves.toBeUndefined();
    await expect(stop).resolves.toBeUndefined();
    expect(composition.voiceRuntime).toBeUndefined();
    await expect(composition.start()).rejects.toThrow(
      "Desktop local runtime cannot start after shutdown"
    );
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

  it("recycles the exact supervised worker after an internal model request deadline", async () => {
    const token = "6".repeat(64);
    const runtime = fixtureManager("speech-timeout-recycle", "speech", "fixture-speech-1", token);
    await runtime.start("speech-timeout-recycle");
    const client = new ManagedModelWorkerClient(
      runtime,
      "speech-timeout-recycle",
      "speech",
      token
    );
    const workerInstance = client.workerInstanceIdentity();
    let recycledInstance: string | undefined;
    const mutable = client as unknown as {
      postJson(): Promise<unknown>;
      recycleAfterUncertainRequest(expectedWorkerInstance: string): Promise<void>;
    };
    mutable.postJson = async () => {
      throw new ManagedWorkerRequestTimeoutError();
    };
    mutable.recycleAfterUncertainRequest = async (expectedWorkerInstance) => {
      recycledInstance = expectedWorkerInstance;
    };

    const vad = new ManagedSileroVadRuntime(client, "/verified/silero.onnx");
    await expect(vad.score({
      pcmBytes: new Uint8Array(new Float32Array([0, 0.1, 0]).buffer),
      sampleRate: 16_000,
      streamId: "stream-timeout-recycle",
      modelPath: "/verified/silero.onnx"
    })).rejects.toBeInstanceOf(ManagedWorkerRequestTimeoutError);
    expect(recycledInstance).toBe(workerInstance);
  });

  it("does not respawn a timed-out model worker after desktop lifecycle abort", async () => {
    const token = "5".repeat(64);
    const runtime = fixtureManager("speech-timeout-shutdown", "speech", "fixture-speech-1", token);
    await runtime.start("speech-timeout-shutdown");
    const lifecycle = new AbortController();
    const client = new ManagedModelWorkerClient(
      runtime,
      "speech-timeout-shutdown",
      "speech",
      token,
      lifecycle.signal
    );
    const workerInstance = client.workerInstanceIdentity();
    const before = runtime.getStatus("speech-timeout-shutdown");

    lifecycle.abort();
    await expect(
      client.recycleAfterUncertainRequest(workerInstance)
    ).resolves.toBeUndefined();

    const after = runtime.getStatus("speech-timeout-shutdown");
    expect(after.state).toBe("READY");
    expect(after.pid).toBe(before.pid);
    expect(after.readyAt).toBe(before.readyAt);
  });

  it("recycles on native 5xx failures but not request-level 4xx responses", async () => {
    const token = "4".repeat(64);
    const runtime = fixtureManager("speech-native-failure", "speech", "fixture-speech-1", token);
    await runtime.start("speech-native-failure");
    const client = new ManagedModelWorkerClient(
      runtime,
      "speech-native-failure",
      "speech",
      token
    );
    let recycleCount = 0;
    const mutable = client as unknown as {
      postJson(): Promise<unknown>;
      recycleAfterUncertainRequest(expectedWorkerInstance: string): Promise<void>;
    };
    mutable.recycleAfterUncertainRequest = async () => {
      recycleCount += 1;
    };
    const vad = new ManagedSileroVadRuntime(client, "/verified/silero.onnx");
    const input = {
      pcmBytes: new Uint8Array(new Float32Array([0, 0.1, 0]).buffer),
      sampleRate: 16_000,
      streamId: "stream-native-failure",
      modelPath: "/verified/silero.onnx"
    } as const;

    mutable.postJson = async () => {
      throw new ManagedWorkerResponseError(500, "RUNTIME_FAILURE");
    };
    await expect(vad.score(input)).rejects.toMatchObject({
      statusCode: 500,
      workerErrorCode: "RUNTIME_FAILURE"
    });
    expect(recycleCount).toBe(1);

    mutable.postJson = async () => {
      throw new ManagedWorkerResponseError(409, "CANCELLED");
    };
    await expect(vad.score(input)).rejects.toMatchObject({
      statusCode: 409,
      workerErrorCode: "CANCELLED"
    });
    expect(recycleCount).toBe(1);
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

  it("drops a cancelled Moonshine request while it is queued behind native inference", async () => {
    const token = "7".repeat(64);
    const runtime = fixtureManager(
      "speech-stt-queue-fixture",
      "speech",
      "fixture-speech-1",
      token,
      "delayed-stt"
    );
    await runtime.start("speech-stt-queue-fixture");
    const client = new ManagedModelWorkerClient(
      runtime,
      "speech-stt-queue-fixture",
      "speech",
      token
    );
    const adapter = new ManagedMoonshineRuntime(client, "/verified/moonshine");
    const firstRequestId = SpeechRequestIdSchema.parse("stt-queued-first");
    const secondRequestId = SpeechRequestIdSchema.parse("stt-queued-second");
    const pcmBytes = new Uint8Array(new Float32Array([0, 0.1, 0]).buffer);

    const first = adapter.transcribe({
      requestId: firstRequestId,
      utteranceId: SpeechUtteranceIdSchema.parse("utterance-first"),
      pcmBytes,
      sampleRate: 16_000,
      modelPath: "/verified/moonshine"
    });
    await waitForStatus(runtime, "speech-stt-queue-fixture", (status) =>
      status.stdout.lines.includes(`STT_STARTED:${firstRequestId}`)
    );

    const controller = new AbortController();
    const second = adapter.transcribe({
      requestId: secondRequestId,
      utteranceId: SpeechUtteranceIdSchema.parse("utterance-second"),
      pcmBytes,
      sampleRate: 16_000,
      modelPath: "/verified/moonshine",
      signal: controller.signal
    });
    controller.abort();

    await expect(first).resolves.toEqual({
      text: "fixture transcript",
      confidence: 0.9
    });
    await expect(second).rejects.toMatchObject({ name: "AbortError" });
    expect(runtime.getStatus("speech-stt-queue-fixture").stdout.lines)
      .not.toContain(`STT_STARTED:${secondRequestId}`);
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

  it("fails an active VAD stream if the supervised speech worker restarts between frames", async () => {
    const token = "f".repeat(64);
    const runtime = fixtureManager("speech-restart-boundary", "speech", "fixture-speech-1", token);
    await runtime.start("speech-restart-boundary");
    const client = new ManagedModelWorkerClient(
      runtime,
      "speech-restart-boundary",
      "speech",
      token
    );
    const vad = new ManagedSileroVadRuntime(client, "/verified/silero.onnx");

    await expect(vad.score({
      pcmBytes: new Uint8Array(new Float32Array([0, 0.1, 0]).buffer),
      sampleRate: 16_000,
      streamId: "stream-restart-boundary",
      modelPath: "/verified/silero.onnx"
    })).resolves.toBe(0.875);

    await runtime.restart("speech-restart-boundary");

    await expect(vad.score({
      pcmBytes: new Uint8Array(new Float32Array([0, 0.1, 0]).buffer),
      sampleRate: 16_000,
      streamId: "stream-restart-boundary",
      modelPath: "/verified/silero.onnx"
    })).rejects.toThrow("restarted during an active VAD stream");
  });

  it("cancels queued Moonshine STT before it reaches the single native batch lane", async () => {
    const token = "8".repeat(64);
    const runtime = fixtureManager(
      "stt-serialize-fixture",
      "speech",
      "fixture-speech-1",
      token,
      "delayed-stt"
    );
    await runtime.start("stt-serialize-fixture");
    const client = new ManagedModelWorkerClient(
      runtime,
      "stt-serialize-fixture",
      "speech",
      token
    );
    const adapter = new ManagedMoonshineRuntime(client, "/verified/moonshine");
    const firstController = new AbortController();
    const secondController = new AbortController();
    const firstRequestId = SpeechRequestIdSchema.parse("stt-serialized-1");
    const secondRequestId = SpeechRequestIdSchema.parse("stt-serialized-2");

    const first = adapter.transcribe({
      requestId: firstRequestId,
      utteranceId: SpeechUtteranceIdSchema.parse("utterance-stt-1"),
      pcmBytes: new Uint8Array(new Float32Array([0, 0.1, 0]).buffer),
      sampleRate: 16_000,
      modelPath: "/verified/moonshine",
      signal: firstController.signal
    });
    await waitForStatus(runtime, "stt-serialize-fixture", (status) =>
      status.stdout.lines.includes(`STT_STARTED:${firstRequestId}`)
    );

    const second = adapter.transcribe({
      requestId: secondRequestId,
      utteranceId: SpeechUtteranceIdSchema.parse("utterance-stt-2"),
      pcmBytes: new Uint8Array(new Float32Array([0, 0.1, 0]).buffer),
      sampleRate: 16_000,
      modelPath: "/verified/moonshine",
      signal: secondController.signal
    });
    secondController.abort();

    await expect(first).resolves.toMatchObject({ text: "fixture transcript" });
    await expect(second).rejects.toMatchObject({ name: "AbortError" });
    expect(runtime.getStatus("stt-serialize-fixture").stdout.lines)
      .not.toContain(`STT_STARTED:${secondRequestId}`);
  });

  it("queues the second concrete Kokoro synthesis instead of racing the single native synthesizer", async () => {
    const token = "9".repeat(64);
    const runtime = fixtureManager(
      "tts-serialize-fixture",
      "tts",
      "fixture-tts-1",
      token,
      "blocking-tts"
    );
    await runtime.start("tts-serialize-fixture");
    const client = new ManagedModelWorkerClient(
      runtime,
      "tts-serialize-fixture",
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
    const firstRequestId = TtsRequestIdSchema.parse("tts-serialized-1");
    const secondRequestId = TtsRequestIdSchema.parse("tts-serialized-2");
    const first = session.synthesize({
      requestId: firstRequestId,
      text: "First serialized request.",
      voice: "kokoro_af_heart",
      language: "en-US",
      speed: 1,
      sampleRate: 24_000
    });
    await waitForStatus(runtime, "tts-serialize-fixture", (status) =>
      status.stdout.lines.includes(`TTS_STARTED:${firstRequestId}`)
    );

    const second = session.synthesize({
      requestId: secondRequestId,
      text: "Second serialized request.",
      voice: "kokoro_af_heart",
      language: "en-US",
      speed: 1,
      sampleRate: 24_000
    });
    await Promise.resolve();
    expect(runtime.getStatus("tts-serialize-fixture").stdout.lines)
      .not.toContain(`TTS_STARTED:${secondRequestId}`);

    if (session.cancel === undefined) throw new Error("Expected Kokoro runtime cancellation");
    await session.cancel(secondRequestId);
    await session.cancel(firstRequestId);
    await expect(first).rejects.toThrow("rejected");
    await expect(second).rejects.toMatchObject({ name: "AbortError" });
    expect(runtime.getStatus("tts-serialize-fixture").stdout.lines)
      .not.toContain(`TTS_STARTED:${secondRequestId}`);
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
