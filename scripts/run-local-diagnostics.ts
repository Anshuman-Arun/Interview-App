import { spawn } from "node:child_process";
import type { Dirent } from "node:fs";
import { access, mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  newGenerationId,
  newSessionId,
  type InterviewerProposal,
  type SessionId
} from "../packages/domain/src/index.js";
import {
  MAX_SPEECH_FRAME_DURATION_MS,
  TtsOutgoingMessageSchema,
  TtsSynthesizeRequestSchema,
  type TtsAudioChunk
} from "../packages/local-compute/src/index.js";
import {
  ANTIGRAVITY_CLI_MODEL_ID,
  ANTIGRAVITY_CLI_MODEL_IDS,
  ANTIGRAVITY_CLI_PROVIDER_ID
} from "../packages/providers/src/index.js";
import { DesktopLocalRuntimeComposition } from "../apps/desktop/src/runtime/index.js";
import { defaultAntigravityCliExecutablePath } from "../packages/local-runtime/src/index.js";
import {
  createApplicationProviderAdapterRuntimeSource
} from "../apps/server/src/antigravity-cli-runtime.js";
import { ProviderRuntimeResolver } from "../apps/server/src/provider-runtime.js";
import { createAndStartServer } from "../apps/server/src/server.js";
import { BrowserCommandClient } from "../apps/web/src/command-client.js";
import {
  RendererClient,
  type AudioPlayer,
  type TextPresenter,
  type WhiteboardPresenter
} from "../apps/web/src/renderer-client.js";
import {
  consumeAuthenticatedRendererStream,
  createLoopbackAcknowledgementSender
} from "../apps/web/src/renderer-stream.js";
import { runAntigravityIsolationMatrix } from "./antigravity-isolation-matrix.js";

type CheckStatus = "PASS" | "FAIL" | "WARN" | "SKIP";

interface CheckResult {
  readonly id: string;
  readonly category: string;
  readonly status: CheckStatus;
  readonly reasonCode: string;
  readonly detail: string;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly data?: unknown;
  readonly error?: Readonly<{
    name: string;
    code?: string;
    message: string;
  }>;
}

interface DiagnosticReport {
  readonly schemaVersion: 1;
  readonly createdAt: string;
  readonly platform: string;
  readonly arch: string;
  readonly nodeVersion: string;
  readonly selectedModel: string;
  readonly allModels: boolean;
  readonly skipRemote: boolean;
  readonly appDataRoot?: string;
  readonly resourcesPath?: string;
  readonly checks: readonly CheckResult[];
}

interface CheckOutcome {
  readonly status?: CheckStatus;
  readonly reasonCode?: string;
  readonly detail?: string;
  readonly data?: unknown;
}

interface CliOptions {
  readonly appDataRoot?: string;
  readonly resourcesPath?: string;
  readonly outputRoot?: string;
  readonly model: string;
  readonly allModels: boolean;
  readonly skipRemote: boolean;
  readonly skipContracts: boolean;
}

const checks: CheckResult[] = [];
const repoRoot = path.resolve(import.meta.dirname, "..");
const runStamp = new Date().toISOString().replace(/[:.]/gu, "-");
let homeReplacement = process.env["USERPROFILE"] ?? "";
let appDataReplacement = process.env["APPDATA"] ?? "";
let localAppDataReplacement = process.env["LOCALAPPDATA"] ?? "";

function parseCli(): CliOptions {
  const args = process.argv.slice(2);
  let appDataRoot: string | undefined;
  let resourcesPath: string | undefined;
  let outputRoot: string | undefined;
  let model = ANTIGRAVITY_CLI_MODEL_ID;
  let allModels = false;
  let skipRemote = false;
  let skipContracts = false;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--app-data") {
      appDataRoot = requiredArgument(args, ++index, "--app-data");
    } else if (value === "--resources") {
      resourcesPath = requiredArgument(args, ++index, "--resources");
    } else if (value === "--output") {
      outputRoot = requiredArgument(args, ++index, "--output");
    } else if (value === "--model") {
      model = requiredArgument(args, ++index, "--model");
    } else if (value === "--all-models") {
      allModels = true;
    } else if (value === "--skip-remote") {
      skipRemote = true;
    } else if (value === "--skip-contracts") {
      skipContracts = true;
    } else {
      throw new Error(`Unknown diagnostic argument: ${String(value)}`);
    }
  }
  if (!ANTIGRAVITY_CLI_MODEL_IDS.includes(model as (typeof ANTIGRAVITY_CLI_MODEL_IDS)[number])) {
    throw new Error(`Unsupported diagnostic model: ${model}`);
  }
  return {
    ...(appDataRoot === undefined ? {} : { appDataRoot: path.resolve(appDataRoot) }),
    ...(resourcesPath === undefined ? {} : { resourcesPath: path.resolve(resourcesPath) }),
    ...(outputRoot === undefined ? {} : { outputRoot: path.resolve(outputRoot) }),
    model,
    allModels,
    skipRemote,
    skipContracts
  };
}

function requiredArgument(args: readonly string[], index: number, flag: string): string {
  const value = args[index];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

function sanitizeText(value: string): string {
  let output = value;
  const replacements: readonly [string, string][] = [
    [homeReplacement, "%USERPROFILE%"],
    [appDataReplacement, "%APPDATA%"],
    [localAppDataReplacement, "%LOCALAPPDATA%"]
  ];
  for (const [needle, replacement] of replacements) {
    if (needle.length > 0) {
      output = output.split(needle).join(replacement);
    }
  }
  output = output.replace(
    /(?:sk[-_][A-Za-z0-9_-]{12,}|AIza[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,})/gu,
    "[REDACTED_SECRET]"
  );
  return output.slice(0, 8_192);
}

function errorSnapshot(error: unknown): NonNullable<CheckResult["error"]> {
  if (error instanceof Error) {
    const code = Reflect.get(error, "code");
    return {
      name: error.name,
      ...(typeof code === "string" ? { code: sanitizeText(code) } : {}),
      message: sanitizeText(error.message)
    };
  }
  return {
    name: "UnknownError",
    message: sanitizeText(String(error))
  };
}

async function check(
  id: string,
  category: string,
  operation: () => Promise<CheckOutcome>
): Promise<CheckResult> {
  const started = performance.now();
  const startedAt = new Date().toISOString();
  let result: CheckResult;
  try {
    const outcome = await operation();
    result = {
      id,
      category,
      status: outcome.status ?? "PASS",
      reasonCode: outcome.reasonCode ?? "OK",
      detail: sanitizeText(outcome.detail ?? "Check completed"),
      startedAt,
      durationMs: Math.round(performance.now() - started),
      ...(outcome.data === undefined ? {} : { data: outcome.data })
    };
  } catch (error) {
    const snapshot = errorSnapshot(error);
    result = {
      id,
      category,
      status: "FAIL",
      reasonCode: snapshot.code ?? snapshot.name,
      detail: snapshot.message,
      startedAt,
      durationMs: Math.round(performance.now() - started),
      error: snapshot
    };
  }
  checks.push(result);
  const marker = result.status === "PASS"
    ? "[PASS]"
    : result.status === "FAIL"
      ? "[FAIL]"
      : result.status === "WARN"
        ? "[WARN]"
        : "[SKIP]";
  process.stdout.write(`${marker} ${result.id}: ${result.detail}\n`);
  return result;
}

async function isDesktopAppDataRoot(candidate: string): Promise<boolean> {
  return (
    await exists(path.join(candidate, "runtime-models"))
    || await exists(path.join(candidate, "model-assets"))
    || await exists(path.join(candidate, "python-runtime"))
    || await exists(path.join(candidate, "interview-session.sqlite"))
  );
}

async function normalizeDesktopAppDataRoot(candidate: string): Promise<string | undefined> {
  const resolved = path.resolve(candidate);
  const dataChild = path.join(resolved, "data");
  // Packaged Electron always passes resolveDesktopPaths(...).appDataRoot,
  // which is <userData>/data. Prefer that authoritative child when both
  // it and a stale pre-migration parent contain runtime-looking files.
  if (await isDesktopAppDataRoot(dataChild)) return dataChild;
  if (await isDesktopAppDataRoot(resolved)) return resolved;
  return undefined;
}

async function locateAppData(explicit?: string): Promise<string | undefined> {
  if (explicit !== undefined) {
    return await normalizeDesktopAppDataRoot(explicit);
  }
  const base = process.env["APPDATA"];
  if (base === undefined) return undefined;

  for (const name of ["Interview App", "technical-interview-app"]) {
    const normalized = await normalizeDesktopAppDataRoot(path.join(base, name));
    if (normalized !== undefined) return normalized;
  }

  let entries: Dirent[];
  try {
    entries = await readdir(base, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries.slice(0, 256)) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const normalized = await normalizeDesktopAppDataRoot(
      path.join(base, entry.name)
    );
    if (normalized !== undefined) return normalized;
  }
  return undefined;
}

async function locateResources(explicit?: string): Promise<string | undefined> {
  if (explicit !== undefined) return explicit;
  const candidates: string[] = [];
  const local = process.env["LOCALAPPDATA"];
  const programFiles = process.env["ProgramFiles"];
  const programFilesX86 = process.env["ProgramFiles(x86)"];
  if (local !== undefined) {
    candidates.push(
      path.join(local, "Programs", "Interview App", "resources"),
      path.join(local, "Interview App", "resources")
    );
  }
  if (programFiles !== undefined) {
    candidates.push(path.join(programFiles, "Interview App", "resources"));
  }
  if (programFilesX86 !== undefined) {
    candidates.push(path.join(programFilesX86, "Interview App", "resources"));
  }
  for (const candidate of candidates) {
    if (await exists(path.join(candidate, "workers", "python", "local_model_worker.py"))) {
      return candidate;
    }
  }
  if (local !== undefined) {
    const programs = path.join(local, "Programs");
    try {
      const entries = await readdir(programs, { withFileTypes: true });
      for (const entry of entries.slice(0, 128)) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const candidate = path.join(programs, entry.name, "resources");
        if (await exists(path.join(candidate, "workers", "python", "local_model_worker.py"))) {
          return candidate;
        }
      }
    } catch {
      // Explicit path override remains available.
    }
  }
  return undefined;
}

async function runCommand(
  command: string,
  args: readonly string[],
  timeoutMs: number
): Promise<Readonly<{ exitCode: number | null; stdout: string; stderr: string }>> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: repoRoot,
      env: process.env,
      windowsHide: true,
      shell: false
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Command timed out after ${String(timeoutMs)}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = (stdout + chunk.toString("utf8")).slice(-1_000_000);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-1_000_000);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({
        exitCode,
        stdout: sanitizeText(stdout),
        stderr: sanitizeText(stderr)
      });
    });
  });
}

async function runContractTests(): Promise<CheckOutcome> {
  const vitestEntry = path.join(repoRoot, "node_modules", "vitest", "vitest.mjs");
  if (!await exists(vitestEntry)) {
    return {
      status: "FAIL",
      reasonCode: "VITEST_ENTRY_MISSING",
      detail: "Installed repository dependencies do not contain Vitest"
    };
  }
  const result = await runCommand(process.execPath, [
    vitestEntry,
    "run",
    "tests/antigravity-cli-provider.test.ts",
    "tests/antigravity-cli-runtime-profile.test.ts",
    "tests/e2e-voice-interview.test.ts",
    "tests/desktop-local-runtime.test.ts",
    "--maxWorkers=1",
    "--testTimeout=30000"
  ], 15 * 60_000);
  return {
    status: result.exitCode === 0 ? "PASS" : "FAIL",
    reasonCode: result.exitCode === 0 ? "CONTRACTS_GREEN" : "CONTRACTS_FAILED",
    detail: result.exitCode === 0
      ? "Provider, voice, desktop-runtime, and adversarial contract suites passed"
      : `Focused contract suite exited with code ${String(result.exitCode)}`,
    data: {
      exitCode: result.exitCode,
      stdoutTail: result.stdout.slice(-20_000),
      stderrTail: result.stderr.slice(-20_000)
    }
  };
}

async function synthesizePcm(
  runtime: NonNullable<DesktopLocalRuntimeComposition["voiceRuntime"]>,
  text: string,
  sampleRate: 24_000 | 48_000
): Promise<Readonly<{
  bytes: Uint8Array;
  chunks: number;
  model?: unknown;
  summary: unknown;
}>> {
  const requestId = `diagtts.${crypto.randomUUID().replaceAll("-", "")}`;
  const request = TtsSynthesizeRequestSchema.parse({
    protocolVersion: 1,
    type: "SYNTHESIZE",
    requestId,
    text,
    voice: runtime.tts.voice,
    speed: runtime.tts.speed ?? 1,
    language: runtime.tts.language,
    sampleRate,
    outputFormat: "PCM_F32LE"
  });
  const chunks: TtsAudioChunk[] = [];
  let model: unknown;
  const summary = await runtime.tts.worker.handle(request, async (messageInput) => {
    const message = TtsOutgoingMessageSchema.parse(messageInput);
    if (message.type === "AUDIO_BEGIN") model = message.model;
    if (message.type === "AUDIO_CHUNK") chunks.push(message);
    if (message.type === "TTS_ERROR") {
      throw new Error(`TTS worker error: ${message.code}`);
    }
  });
  if (chunks.length === 0) throw new Error("TTS produced no PCM chunks");
  const buffers = chunks.map((chunk) => Buffer.from(chunk.audioBase64, "base64"));
  const combined = Buffer.concat(buffers);
  if (combined.byteLength === 0) throw new Error("TTS produced an empty PCM payload");
  return {
    bytes: new Uint8Array(combined.buffer, combined.byteOffset, combined.byteLength),
    chunks: chunks.length,
    ...(model === undefined ? {} : { model }),
    summary
  };
}

function upsamplePcmF32Le24kTo48k(input: Uint8Array): Uint8Array {
  if (input.byteLength === 0 || input.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
    throw new Error("24 kHz TTS PCM is malformed");
  }
  const sourceFrames = input.byteLength / Float32Array.BYTES_PER_ELEMENT;
  const output = new Uint8Array(sourceFrames * 2 * Float32Array.BYTES_PER_ELEMENT);
  const sourceView = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const outputView = new DataView(output.buffer);
  for (let index = 0; index < sourceFrames; index += 1) {
    const sample = sourceView.getFloat32(
      index * Float32Array.BYTES_PER_ELEMENT,
      true
    );
    const offset = index * 2 * Float32Array.BYTES_PER_ELEMENT;
    outputView.setFloat32(offset, sample, true);
    outputView.setFloat32(offset + Float32Array.BYTES_PER_ELEMENT, sample, true);
  }
  return output;
}

async function runSpeechLoopback(
  runtime: NonNullable<DesktopLocalRuntimeComposition["voiceRuntime"]>,
  pcm: Uint8Array
): Promise<CheckOutcome> {
  const streamId = `diag.${crypto.randomUUID().replaceAll("-", "")}`;
  const sampleRate = 48_000;
  const maxSamplesPerFrame = Math.floor(
    sampleRate * MAX_SPEECH_FRAME_DURATION_MS / 1_000
  );
  const bytesPerFrame = maxSamplesPerFrame * Float32Array.BYTES_PER_ELEMENT;
  const events: unknown[] = [];
  let sequence = 0;
  let timestampMs = 0;
  for (let offset = 0; offset < pcm.byteLength; offset += bytesPerFrame) {
    const end = Math.min(pcm.byteLength, offset + bytesPerFrame);
    const byteLength = end - offset;
    const alignedLength = byteLength - (byteLength % Float32Array.BYTES_PER_ELEMENT);
    if (alignedLength <= 0) continue;
    const payload = pcm.slice(offset, offset + alignedLength);
    const frameSamples = payload.byteLength / Float32Array.BYTES_PER_ELEMENT;
    const requestId = `diagframe.${String(sequence)}.${crypto.randomUUID().replaceAll("-", "")}`;
    const frameEvents = await runtime.speechWorker.submitFrame({
      protocolVersion: 1,
      requestId,
      streamId,
      sequence,
      sampleRate,
      channels: 1,
      sampleFormat: "F32LE",
      frameSamples,
      payloadByteLength: payload.byteLength,
      timestampMs
    }, payload);
    events.push(...frameEvents);
    sequence += 1;
    timestampMs += frameSamples / sampleRate * 1_000;
  }
  const flushEvents = await runtime.speechWorker.flush({
    protocolVersion: 1,
    requestId: `diagflush.${crypto.randomUUID().replaceAll("-", "")}`,
    streamId,
    type: "FLUSH_SPEECH"
  });
  events.push(...flushEvents);
  const transcript = events.find((event) =>
    typeof event === "object"
    && event !== null
    && Reflect.get(event, "type") === "TRANSCRIPT_CANDIDATE"
  );
  const diagnostics = runtime.speechWorker.getDiagnostics();
  if (transcript === undefined) {
    return {
      status: "FAIL",
      reasonCode: "NO_TRANSCRIPT_CANDIDATE",
      detail: "Kokoro-to-Moonshine loopback produced no transcript candidate",
      data: {
        eventTypes: events.map((event) =>
          typeof event === "object" && event !== null
            ? String(Reflect.get(event, "type"))
            : typeof event
        ),
        workerDiagnostics: diagnostics
      }
    };
  }
  return {
    status: "PASS",
    reasonCode: "STT_LOOPBACK_OK",
    detail: "Moonshine recognized speech synthesized by the actual Kokoro worker",
    data: {
      transcriptText: sanitizeText(String(Reflect.get(transcript, "text"))),
      eventTypes: events.map((event) =>
        typeof event === "object" && event !== null
          ? String(Reflect.get(event, "type"))
          : typeof event
      ),
      workerDiagnostics: diagnostics
    }
  };
}

async function runAntigravityReadiness(model: string): Promise<CheckOutcome> {
  const source = createApplicationProviderAdapterRuntimeSource();
  try {
    const verify = source.verifyRuntimeReadiness;
    if (verify === undefined) {
      return {
        status: "FAIL",
        reasonCode: "READINESS_UNAVAILABLE",
        detail: "Antigravity readiness verifier is unavailable",
        data: { trace: source.inspectDiagnostics?.() ?? [] }
      };
    }
    try {
      await verify({
        providerId: ANTIGRAVITY_CLI_PROVIDER_ID,
        modelId: model
      });
      return {
        status: "PASS",
        reasonCode: "ZERO_TURN_READY",
        detail: `Supervised Antigravity zero-turn readiness passed for ${model}`,
        data: { trace: source.inspectDiagnostics?.() ?? [] }
      };
    } catch (error) {
      const snapshot = errorSnapshot(error);
      return {
        status: "FAIL",
        reasonCode: snapshot.code ?? snapshot.name,
        detail: snapshot.message,
        data: {
          error: snapshot,
          trace: source.inspectDiagnostics?.() ?? []
        }
      };
    }
  } finally {
    await source.drain();
  }
}

async function runDirectAntigravityInference(model: string): Promise<CheckOutcome> {
  const source = createApplicationProviderAdapterRuntimeSource();
  const resolver = new ProviderRuntimeResolver({ adapterRuntimeSource: source });
  let session: Awaited<ReturnType<InterviewerProposalProvider["createSession"]>> | undefined;
  try {
    try {
      const resolved = await resolver.resolve({
        selection: {
          providerId: ANTIGRAVITY_CLI_PROVIDER_ID,
          modelId: model
        }
      });
      const provider = resolved.provider as InterviewerProposalProvider;
      session = await provider.createSession();
      const proposals: InterviewerProposal[] = [];
      for await (const proposal of session.sendTurn({
        generationId: newGenerationId(),
        context: {
          diagnostic: true,
          selectedAction: "CLARIFY",
          maximumDisclosureLevel: 0,
          authorizedDisclosureIds: [],
          studentText: "I would start by checking a simple case.",
          instruction:
            "Return one brief clarifying interviewer question. Do not use a board action."
        }
      })) {
        proposals.push(proposal);
      }
      if (proposals.length !== 1) {
        return {
          status: "FAIL",
          reasonCode: "PROPOSAL_COUNT_MISMATCH",
          detail: `Expected exactly one proposal, received ${String(proposals.length)}`,
          data: {
            proposalCount: proposals.length,
            trace: source.inspectDiagnostics?.() ?? []
          }
        };
      }
      return {
        status: "PASS",
        reasonCode: "REAL_INFERENCE_OK",
        detail: `Real supervised Antigravity inference produced one valid proposal for ${model}`,
        data: {
          proposal: proposals[0],
          trace: source.inspectDiagnostics?.() ?? []
        }
      };
    } catch (error) {
      const snapshot = errorSnapshot(error);
      return {
        status: "FAIL",
        reasonCode: snapshot.code ?? snapshot.name,
        detail: snapshot.message,
        data: {
          error: snapshot,
          trace: source.inspectDiagnostics?.() ?? []
        }
      };
    }
  } finally {
    await session?.close().catch(() => undefined);
    await resolver.drain().catch(() => undefined);
  }
}

interface InterviewerProposalSession {
  readonly sendTurn: (input: {
    readonly generationId: ReturnType<typeof newGenerationId>;
    readonly context: unknown;
  }) => AsyncIterable<InterviewerProposal>;
  readonly close: () => Promise<void>;
}

interface InterviewerProposalProvider {
  readonly createSession: () => Promise<InterviewerProposalSession>;
}

async function runFullTurn(
  runtime: NonNullable<DesktopLocalRuntimeComposition["voiceRuntime"]>,
  model: string
): Promise<CheckOutcome> {
  const clientToken = crypto.randomUUID().replaceAll("-", "")
    + crypto.randomUUID().replaceAll("-", "");
  const origin = "http://127.0.0.1:5173";
  const providerRuntimeResolver = new ProviderRuntimeResolver();
  const server = await createAndStartServer({
    host: "127.0.0.1",
    commandPort: 0,
    rendererStreamPort: 0,
    voicePort: 0,
    clientToken,
    allowedOrigins: [origin],
    databasePath: ":memory:",
    voiceRuntime: runtime,
    providerRuntimeResolver
  });
  const rendererAbort = new AbortController();
  let rendererPromise: Promise<void> | undefined;
  try {
    const authenticatedFetch: typeof fetch = async (input, init = {}) => {
      const headers = new Headers(init.headers);
      headers.set("Origin", origin);
      headers.set("x-interview-client-token", clientToken);
      return fetch(input, { ...init, headers });
    };
    const command = new BrowserCommandClient({
      baseUrl: server.bound.command.url,
      clientToken,
      fetchImpl: authenticatedFetch
    });
    const providerOptions = await command.listProviderOptions();
    const selectedOption = providerOptions.find((option) =>
      option.providerId === ANTIGRAVITY_CLI_PROVIDER_ID
      && option.modelId === model
    );
    if (selectedOption === undefined) {
      return {
        status: "FAIL",
        reasonCode: "PROVIDER_OPTION_MISSING",
        detail: "Selected Antigravity model is missing from the app launch options",
        data: { providerOptions }
      };
    }
    if (selectedOption.availability !== "AVAILABLE") {
      return {
        status: "FAIL",
        reasonCode: selectedOption.reason ?? "PROVIDER_UNAVAILABLE",
        detail: `Selected provider option is ${selectedOption.availability}`,
        data: { selectedOption }
      };
    }

    const catalog = await command.listInterviewCatalog();
    const problem = catalog.find((entry) => entry.mode === "OXFORD_MATHEMATICS");
    if (problem === undefined) {
      throw new Error("No Oxford Mathematics problem exists in the interview catalog");
    }
    const sessionId: SessionId = newSessionId();
    await command.startConfiguredSession(sessionId, {
      configurationVersion: 1,
      mode: "OXFORD_MATHEMATICS",
      problem: { id: problem.id, version: problem.version },
      difficulty: problem.difficulty,
      interventionPolicy: "BALANCED",
      providerSelection: {
        providerId: ANTIGRAVITY_CLI_PROVIDER_ID,
        modelId: model
      }
    });

    const textDeliveries: Array<{ text: string; deliveryId: string }> = [];
    const boardDeliveries: Array<{ type: string; deliveryId: string }> = [];
    const audioDeliveries: Array<{
      deliveryId: string;
      bytes: number;
      contentType: string | null;
    }> = [];

    const textPresenter: TextPresenter = {
      presentText: (text, deliveryId) => {
        textDeliveries.push({ text: sanitizeText(text), deliveryId });
      }
    };
    const whiteboardPresenter: WhiteboardPresenter = {
      presentWhiteboard: (action, deliveryId) => {
        boardDeliveries.push({ type: action.operation, deliveryId });
      }
    };
    const audioPlayer: AudioPlayer = {
      playAudio: async ({ deliveryId, audioRef, callbacks }) => {
        const response = await authenticatedFetch(
          `${server.bound.voice.url}/v1/voice/audio/${encodeURIComponent(audioRef)}`,
          {
            method: "GET",
            headers: {
              "x-interview-session-id": sessionId
            }
          }
        );
        const bytes = new Uint8Array(await response.arrayBuffer());
        audioDeliveries.push({
          deliveryId,
          bytes: bytes.byteLength,
          contentType: response.headers.get("content-type")
        });
        if (!response.ok || bytes.byteLength <= 44) {
          throw new Error(`Audio delivery fetch failed with HTTP ${String(response.status)}`);
        }
        await callbacks.onStarted();
        await callbacks.onCompleted();
      }
    };
    const renderer = new RendererClient({
      sessionId,
      acknowledgementSender: createLoopbackAcknowledgementSender({
        commandUrl: `${server.bound.command.url}/v1/commands`,
        authenticatedFetch
      }),
      textPresenter,
      audioPlayer,
      whiteboardPresenter
    });
    rendererPromise = consumeAuthenticatedRendererStream({
      streamUrl: server.bound.rendererStream.streamUrl,
      sessionId,
      authenticatedFetch,
      signal: rendererAbort.signal
    }, renderer);

    await waitForCondition(
      () => rendererPromise !== undefined,
      1_000
    );
    const committed = await command.commitTypedInput(
      sessionId,
      "I am ready. I would start by testing a simple example and looking for an invariant."
    );

    const delivered = await waitForCondition(
      () => textDeliveries.length > 0 || boardDeliveries.length > 0,
      90_000
    );
    const state = server.runtime.sessions.getWriter(sessionId).getState();
    const observability = server.observability.read(sessionId);
    const stateSummary = {
      status: state.status,
      turnCount: Object.keys(state.turns).length,
      generationStates: Object.values(state.generations).map((generation) => ({
        generationId: generation.generationId,
        status: generation.status
      })),
      deliveryStates: Object.values(state.deliveries).map((delivery) => ({
        deliveryId: delivery.deliveryId,
        medium: delivery.content.medium,
        status: delivery.status
      }))
    };
    if (!delivered) {
      return {
        status: "FAIL",
        reasonCode: "FULL_TURN_NO_DELIVERY",
        detail: "Committed student input produced no interviewer delivery within 90 seconds",
        data: {
          committed,
          selectedOption,
          state: stateSummary,
          observability
        }
      };
    }

    await waitForCondition(
      () => textDeliveries.length === 0 || audioDeliveries.length > 0,
      45_000
    );
    return {
      status: "PASS",
      reasonCode: "FULL_TURN_OK",
      detail: "Actual app turn path produced an interviewer delivery",
      data: {
        committed,
        selectedOption,
        textDeliveries,
        boardDeliveries,
        audioDeliveries,
        state: stateSummary,
        observability
      }
    };
  } finally {
    rendererAbort.abort();
    await rendererPromise?.catch(() => undefined);
    await server.stop().catch(() => undefined);
    await providerRuntimeResolver.drain().catch(() => undefined);
  }
}

async function waitForCondition(
  condition: () => boolean,
  timeoutMs: number
): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return condition();
}

function renderTextReport(report: DiagnosticReport): string {
  const lines = [
    "Interview App laptop diagnostics",
    `Created: ${report.createdAt}`,
    `Platform: ${report.platform} ${report.arch}`,
    `Node: ${report.nodeVersion}`,
    `Model: ${report.selectedModel}`,
    `App data: ${report.appDataRoot ?? "NOT FOUND"}`,
    `Resources: ${report.resourcesPath ?? "NOT FOUND"}`,
    "",
    "Checks"
  ];
  for (const item of report.checks) {
    lines.push(
      `${item.status.padEnd(4)}  ${item.id.padEnd(36)}  ${item.reasonCode}`,
      `      ${item.detail} (${String(item.durationMs)} ms)`
    );
    if (item.error !== undefined) {
      lines.push(
        `      error=${item.error.name}${item.error.code === undefined ? "" : ` code=${item.error.code}`} ${item.error.message}`
      );
    }
  }
  const failed = report.checks.filter((item) => item.status === "FAIL");
  lines.push(
    "",
    `Summary: ${String(report.checks.length)} checks, ${String(failed.length)} failed.`
  );
  if (failed.length > 0) {
    lines.push("First failing stages:");
    for (const item of failed.slice(0, 10)) {
      lines.push(`- ${item.id}: ${item.reasonCode} — ${item.detail}`);
    }
  }
  return lines.join("\n") + "\n";
}

async function main(): Promise<void> {
  const options = parseCli();
  if (process.platform !== "win32") {
    throw new Error("Real laptop diagnostics currently require Windows");
  }
  process.env["INTERVIEW_ALLOW_METERED_REMOTE_REASONING"] ??= "1";

  const outputRoot = options.outputRoot
    ?? path.join(repoRoot, "diagnostics-output", runStamp);
  await mkdir(outputRoot, { recursive: true });

  const appDataRoot = await locateAppData(options.appDataRoot);
  const resourcesPath = await locateResources(options.resourcesPath);
  homeReplacement = process.env["USERPROFILE"] ?? "";
  appDataReplacement = process.env["APPDATA"] ?? "";
  localAppDataReplacement = process.env["LOCALAPPDATA"] ?? "";

  await check("system.environment", "system", async () => ({
    detail: "Windows/Node environment captured",
    data: {
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      cwd: sanitizeText(process.cwd()),
      repoRoot: sanitizeText(repoRoot)
    }
  }));

  await check("desktop.paths", "desktop", async () => {
    if (appDataRoot === undefined || resourcesPath === undefined) {
      return {
        status: "FAIL",
        reasonCode: "DESKTOP_PATHS_NOT_FOUND",
        detail: "Could not locate installed app data and packaged resources",
        data: {
          appDataRoot: appDataRoot === undefined ? null : sanitizeText(appDataRoot),
          resourcesPath: resourcesPath === undefined ? null : sanitizeText(resourcesPath)
        }
      };
    }
    const workerPath = path.join(resourcesPath, "workers", "python", "local_model_worker.py");
    const pythonRoot = path.join(appDataRoot, "python-runtime");
    const assetsRoot = path.join(appDataRoot, "model-assets");
    const workerExists = await exists(workerPath);
    const pythonRuntimeExists = await exists(pythonRoot);
    const modelAssetsExist = await exists(assetsRoot);
    const runtimeViewsExist = await exists(path.join(appDataRoot, "runtime-models"));
    return {
      status: workerExists && (pythonRuntimeExists || runtimeViewsExist)
        ? "PASS"
        : "WARN",
      reasonCode: workerExists
        ? "DESKTOP_RUNTIME_PATHS_LOCATED"
        : "PACKAGED_WORKER_MISSING",
      detail: "Resolved the exact desktop app data root used by runtime composition",
      data: {
        appDataRoot: sanitizeText(appDataRoot),
        resourcesPath: sanitizeText(resourcesPath),
        workerExists,
        pythonRuntimeExists,
        modelAssetsExist,
        runtimeViewsExist
      }
    };
  });

  if (!options.skipContracts) {
    await check("contracts.focused", "contracts", runContractTests);
  } else {
    await check("contracts.focused", "contracts", async () => ({
      status: "SKIP",
      reasonCode: "USER_SKIPPED",
      detail: "Focused adversarial contract tests skipped"
    }));
  }

  let composition: DesktopLocalRuntimeComposition | undefined;
  let loopbackPcm: Uint8Array | undefined;
  if (appDataRoot !== undefined && resourcesPath !== undefined) {
    await check("local.runtime.start", "local-runtime", async () => {
      composition = new DesktopLocalRuntimeComposition({
        appDataRoot,
        cwd: repoRoot,
        resourcesPath,
        isPackaged: true
      });
      const preparedViews = await composition.hasPreparedRuntimeViews();
      const before = {
        python: composition.getPythonRuntimeStatus(),
        capabilities: composition.getCapabilityStatus()
      };
      await composition.start();
      const after = {
        python: composition.getPythonRuntimeStatus(),
        capabilities: composition.getCapabilityStatus(),
        voiceRuntime: composition.voiceRuntime !== undefined,
        visionBackend: composition.visionBackend !== undefined
      };
      return {
        status: composition.voiceRuntime === undefined ? "FAIL" : "PASS",
        reasonCode: composition.voiceRuntime === undefined
          ? "VOICE_RUNTIME_UNAVAILABLE"
          : "VOICE_RUNTIME_READY",
        detail: composition.voiceRuntime === undefined
          ? "Desktop runtime started but the production voice runtime is unavailable"
          : "Production desktop Moonshine + Kokoro voice runtime is ready",
        data: { preparedViews, before, after }
      };
    });

    await check("local.tts.production", "tts", async () => {
      const runtime = composition?.voiceRuntime;
      if (runtime === undefined) {
        return {
          status: "SKIP",
          reasonCode: "VOICE_RUNTIME_UNAVAILABLE",
          detail: "TTS skipped because the production voice runtime is unavailable"
        };
      }
      try {
        const result = await synthesizePcm(
          runtime,
          "Diagnostic audio. The local Kokoro voice is working.",
          24_000
        );
        return {
          detail: "Actual Kokoro worker synthesized production-rate PCM",
          data: {
            bytes: result.bytes.byteLength,
            chunks: result.chunks,
            model: result.model,
            summary: result.summary,
            workerInspection: runtime.tts.worker.inspect()
          }
        };
      } catch (error) {
        const snapshot = errorSnapshot(error);
        return {
          status: "FAIL",
          reasonCode: snapshot.code ?? snapshot.name,
          detail: snapshot.message,
          data: {
            error: snapshot,
            workerInspection: runtime.tts.worker.inspect()
          }
        };
      }
    });

    await check("local.tts.loopback-source", "tts", async () => {
      const runtime = composition?.voiceRuntime;
      if (runtime === undefined) {
        return {
          status: "SKIP",
          reasonCode: "VOICE_RUNTIME_UNAVAILABLE",
          detail: "48 kHz loopback synthesis skipped"
        };
      }
      try {
        const result = await synthesizePcm(
          runtime,
          "Moonshine diagnostic phrase. Please recognize this sentence.",
          24_000
        );
        loopbackPcm = upsamplePcmF32Le24kTo48k(result.bytes);
        return {
          detail: "Actual Kokoro worker synthesized 24 kHz speech and the diagnostic resampled it to 48 kHz for Moonshine loopback",
          data: {
            sourceBytes: result.bytes.byteLength,
            loopbackBytes: loopbackPcm.byteLength,
            chunks: result.chunks,
            model: result.model,
            workerInspection: runtime.tts.worker.inspect()
          }
        };
      } catch (error) {
        const snapshot = errorSnapshot(error);
        return {
          status: "FAIL",
          reasonCode: snapshot.code ?? snapshot.name,
          detail: snapshot.message,
          data: {
            error: snapshot,
            workerInspection: runtime.tts.worker.inspect()
          }
        };
      }
    });

    await check("local.stt.loopback", "stt", async () => {
      const runtime = composition?.voiceRuntime;
      if (runtime === undefined || loopbackPcm === undefined) {
        return {
          status: "SKIP",
          reasonCode: "LOOPBACK_SOURCE_UNAVAILABLE",
          detail: "Moonshine loopback skipped because source audio is unavailable"
        };
      }
      return await runSpeechLoopback(runtime, loopbackPcm);
    });
  } else {
    await check("local.runtime.start", "local-runtime", async () => ({
      status: "SKIP",
      reasonCode: "DESKTOP_PATHS_NOT_FOUND",
      detail: "Local runtime probes skipped because installed desktop paths were not found"
    }));
  }

  const modelsToProbe = options.allModels
    ? ANTIGRAVITY_CLI_MODEL_IDS
    : [options.model];

  await check("provider.cli.version", "provider", async () => {
    const executable = defaultAntigravityCliExecutablePath("win32");
    if (!await exists(executable)) {
      return {
        status: "FAIL",
        reasonCode: "AGY_EXECUTABLE_MISSING",
        detail: "The Antigravity CLI executable expected by the app does not exist",
        data: { executable: sanitizeText(executable) }
      };
    }
    const result = await runCommand(executable, ["--version"], 30_000);
    return {
      status: result.exitCode === 0 ? "PASS" : "FAIL",
      reasonCode: result.exitCode === 0 ? "AGY_VERSION_OK" : "AGY_VERSION_FAILED",
      detail: result.exitCode === 0
        ? `Raw Antigravity CLI version command succeeded: ${result.stdout.trim()}`
        : `Raw Antigravity CLI version command failed with code ${String(result.exitCode)}`,
      data: {
        executable: sanitizeText(executable),
        stdout: result.stdout,
        stderr: result.stderr,
        userGeminiDirectoryExists: process.env["USERPROFILE"] === undefined
          ? false
          : await exists(path.join(process.env["USERPROFILE"], ".gemini")),
        userAntigravitySettingsExist: process.env["USERPROFILE"] === undefined
          ? false
          : await exists(path.join(
            process.env["USERPROFILE"],
            ".gemini",
            "antigravity-cli",
            "settings.json"
          ))
      }
    };
  });

  if (!options.skipRemote) {
    await check(
      `provider.matrix.${options.model}`,
      "provider",
      async () => {
        const matrix = await runAntigravityIsolationMatrix(options.model);
        return {
          status: matrix.firstFailureId === undefined ? "PASS" : "FAIL",
          reasonCode: matrix.firstFailureId === undefined
            ? "MATRIX_ALL_PASS"
            : `MATRIX_BREAK_${matrix.firstFailureId
              .toUpperCase()
              .replaceAll("-", "_")}`,
          detail: matrix.firstFailureId === undefined
            ? "All raw Antigravity isolation probes passed"
            : `First Antigravity isolation failure: ${matrix.firstFailureId}`,
          data: matrix
        };
      }
    );
  }

  if (options.skipRemote) {
    await check("provider.remote", "provider", async () => ({
      status: "SKIP",
      reasonCode: "USER_SKIPPED",
      detail: "Remote Antigravity probes skipped"
    }));
  } else {
    for (const model of modelsToProbe) {
      await check(
        `provider.readiness.${model}`,
        "provider",
        async () => await runAntigravityReadiness(model)
      );
      await check(
        `provider.inference.${model}`,
        "provider",
        async () => await runDirectAntigravityInference(model)
      );
    }

    await check("app.full-turn", "end-to-end", async () => {
      const runtime = composition?.voiceRuntime;
      if (runtime === undefined) {
        return {
          status: "SKIP",
          reasonCode: "VOICE_RUNTIME_UNAVAILABLE",
          detail: "Full app turn skipped because the production voice runtime is unavailable"
        };
      }
      return await runFullTurn(runtime, options.model);
    });
  }

  if (composition !== undefined) {
    await check("local.runtime.stop", "local-runtime", async () => {
      await composition?.stopWorkers();
      return {
        detail: "Desktop local model workers stopped cleanly",
        data: {
          python: composition?.getPythonRuntimeStatus(),
          capabilities: composition?.getCapabilityStatus()
        }
      };
    });
  }

  const report: DiagnosticReport = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    selectedModel: options.model,
    allModels: options.allModels,
    skipRemote: options.skipRemote,
    ...(appDataRoot === undefined ? {} : { appDataRoot: sanitizeText(appDataRoot) }),
    ...(resourcesPath === undefined ? {} : { resourcesPath: sanitizeText(resourcesPath) }),
    checks
  };
  const jsonPath = path.join(outputRoot, "report.json");
  const textPath = path.join(outputRoot, "report.txt");
  await writeFile(jsonPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  await writeFile(textPath, renderTextReport(report), "utf8");

  const failed = checks.filter((item) => item.status === "FAIL").length;
  process.stdout.write("\n");
  process.stdout.write(`Diagnostic report: ${textPath}\n`);
  process.stdout.write(`Raw JSON report:   ${jsonPath}\n`);
  process.stdout.write(`Result: ${String(failed)} failing check(s).\n`);
  process.exitCode = failed === 0 ? 0 : 1;
}

void main().catch(async (error: unknown) => {
  const snapshot = errorSnapshot(error);
  process.stderr.write(`Laptop diagnostics failed to initialize: ${snapshot.message}\n`);
  process.exitCode = 1;
});
