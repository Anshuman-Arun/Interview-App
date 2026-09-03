import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createAndStartServer } from "../../server/src/server.js";
import { SessionIdSchema, newSessionId, type SessionId } from "../../../packages/domain/src/index.js";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  type IpcMainEvent,
  type IpcMainInvokeEvent
} from "electron";
import { DesktopBackendController } from "./backend-controller.js";
import { DesktopLocalRuntimeComposition } from "./runtime/index.js";
import { PACKAGED_DESKTOP_PRELOAD_SHA256 } from "./runtime/packaged-resource-integrity.js";
import {
  DESKTOP_BOOTSTRAP_CHANNEL,
  DESKTOP_INSTALL_LOCAL_MODELS_CHANNEL,
  DESKTOP_LOCAL_RUNTIME_STATUS_CHANNEL,
  DESKTOP_ZOOM_CHANGED_CHANNEL,
  DESKTOP_ZOOM_CHANNEL,
  DESKTOP_MAX_ZOOM_FACTOR,
  DESKTOP_MIN_ZOOM_FACTOR,
  createDesktopRendererBootstrap,
  isAuthorizedDesktopBootstrapRequest,
  isDesktopZoomFactor,
  isTrustedDesktopNavigation,
  type DesktopRendererBootstrap,
  type DesktopRendererLocalRuntimeStatus,
  type DesktopRendererModelSetupState,
  type DesktopRendererRuntimeCapabilityStatus,
  type DesktopZoomFactor
} from "./bootstrap.js";
import {
  installDesktopClientTokenInjector
} from "./client-token-injector.js";
import { DesktopFrontendServer } from "./frontend-server.js";
import { tryDesktopCleanup } from "./lifecycle-cleanup.js";
import { resolveDesktopMode, resolveDevelopmentFrontendOrigin } from "./mode.js";
import { resolveDesktopPaths } from "./paths.js";
import {
  installDesktopPermissionCapability
} from "./permission-policy.js";
import {
  DESKTOP_MIN_HEIGHT,
  DESKTOP_MIN_WIDTH,
  createSecureWebPreferences
} from "./window-config.js";

const OPTIONAL_LOCAL_RUNTIME_STARTUP_BUDGET_MS = 60_000;
const PACKAGED_SMOKE_PROOF_MAX_BYTES = 64 * 1024;
const PACKAGED_SMOKE_INPUT = "Packaged Windows desktop smoke input.";

let localRuntime: DesktopLocalRuntimeComposition | undefined;
const startupAbort = new AbortController();
const backend = new DesktopBackendController(async (config) =>
  createAndStartServer({
    ...config,
    ...(localRuntime?.voiceRuntime === undefined
      ? {}
      : { voiceRuntime: localRuntime.voiceRuntime }),
    ...(localRuntime?.visionBackend === undefined
      ? {}
      : { visionBackend: localRuntime.visionBackend })
  })
);
let frontendServer: DesktopFrontendServer | undefined;
let mainWindow: BrowserWindow | undefined;
let bootstrap: DesktopRendererBootstrap | undefined;
let frontendUrl: string | undefined;
let clientToken: string | undefined;
let removeTokenInjector: (() => void) | undefined;
let removePermissionCapability: (() => void) | undefined;
let shuttingDown = false;
let shutdownComplete = false;
let shutdownPromise: Promise<void> | undefined;
let modelSetupState: DesktopRendererModelSetupState = "IDLE";
let modelSetupRestartRequired = false;
let modelInstallPromise: Promise<DesktopRendererLocalRuntimeStatus> | undefined;
const packagedSingleInstanceSmokeHost = process.argv.includes(
  "--packaged-single-instance-smoke-host"
);

if (!app.requestSingleInstanceLock()) {
  if (
    process.argv.includes("--install-local-models")
    || process.argv.includes("--install-local-vision-models")
  ) {
    console.error(
      "Local model setup requires the running Interview App instance to be closed."
    );
    process.exitCode = 1;
  }
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow !== undefined) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
    if (packagedSingleInstanceSmokeHost && app.isPackaged) {
      void shutdownDesktop()
        .catch(() => {
          process.exitCode = 1;
        })
        .finally(() => {
          shutdownComplete = true;
          app.quit();
        });
    }
  });

  app.on("before-quit", (event) => {
    if (shutdownComplete) return;
    event.preventDefault();
    void shutdownDesktop()
      .catch(() => {
        process.exitCode = 1;
      })
      .finally(() => {
        shutdownComplete = true;
        app.quit();
      });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("activate", () => {
    if (!shuttingDown && mainWindow === undefined && bootstrap !== undefined && frontendUrl !== undefined) {
      void createMainWindow().catch(() => {
        void failStartup("The desktop window could not be recreated.");
      });
    }
  });

  void app.whenReady().then(startDesktop).catch(() => {
    void failStartup("The desktop application could not start securely.");
  });
}

async function startDesktop(): Promise<void> {
  app.setName("Interview App");
  await configurePackagedSmokeUserData();
  if (process.platform === "win32") {
    app.setAppUserModelId("com.anshuman.interviewapp");
  }
  const mode = resolveDesktopMode(app.isPackaged, process.argv);
  const paths = resolveDesktopPaths({
    cwd: process.cwd(),
    resourcesPath: process.resourcesPath,
    userDataPath: app.getPath("userData"),
    isPackaged: app.isPackaged
  });
  await mkdir(paths.appDataRoot, { recursive: true });
  if (app.isPackaged) {
    await assertPackagedPreloadIntegrity(paths.preloadPath);
  }

  const configuredPython = process.env["INTERVIEW_LOCAL_PYTHON"];
  const runtime = new DesktopLocalRuntimeComposition({
    appDataRoot: paths.appDataRoot,
    cwd: process.cwd(),
    resourcesPath: process.resourcesPath,
    isPackaged: app.isPackaged,
    ...(configuredPython === undefined ? {} : { pythonExecutable: configuredPython })
  });
  localRuntime = runtime;
  if (process.argv.includes("--install-local-models")) {
    try {
      await runtime.installVoiceAssets(startupAbort.signal);
    } catch (error) {
      if (startupAbort.signal.aborted) return;
      throw error;
    }
    await runtime.stopWorkers();
    shutdownComplete = true;
    app.quit();
    return;
  }
  if (process.argv.includes("--install-local-vision-models")) {
    try {
      await runtime.installVisionAssets(startupAbort.signal);
    } catch (error) {
      if (startupAbort.signal.aborted) return;
      throw error;
    }
    await runtime.stopWorkers();
    shutdownComplete = true;
    app.quit();
    return;
  }
  const optionalRuntimeSignal = AbortSignal.any([
    startupAbort.signal,
    AbortSignal.timeout(OPTIONAL_LOCAL_RUNTIME_STARTUP_BUDGET_MS)
  ]);
  await runtime.start({ signal: optionalRuntimeSignal });
  if (shuttingDown || startupAbort.signal.aborted) return;

  if (mode === "production") {
    frontendServer = new DesktopFrontendServer(paths.frontendRoot);
    frontendUrl = await frontendServer.start();
  } else {
    frontendUrl = resolveDevelopmentFrontendOrigin(
      process.env["INTERVIEW_DESKTOP_DEV_URL"]
    );
  }

  clientToken = randomBytes(32).toString("hex");
  const backendConfig = {
    host: "127.0.0.1",
    commandPort: 0,
    rendererStreamPort: 0,
    voicePort: 0,
    clientToken,
    allowedOrigins: [new URL(frontendUrl).origin],
    databasePath: paths.databasePath
  } as const;
  const server = await backend.start(backendConfig);

  if (frontendServer !== undefined) {
    frontendServer.configureBackendOrigins(
      server.bound.command.url,
      server.bound.rendererStream.streamUrl,
      server.bound.voice.url
    );
  }

  bootstrap = createDesktopRendererBootstrap({
    commandBaseUrl: server.bound.command.url,
    rendererStreamUrl: server.bound.rendererStream.streamUrl,
    voiceBaseUrl: server.bound.voice.url,
    appVersion: app.isPackaged ? app.getVersion() : "development",
    platform: process.platform
  });

  installBootstrapHandler();
  installZoomHandler();
  installLocalRuntimeHandlers();
  await createMainWindow(paths.preloadPath);

  if (process.argv.includes("--packaged-smoke-test")) {
    if (!app.isPackaged) throw new Error("Packaged smoke mode requires a packaged executable");
    await runPackagedSmoke(server, backendConfig);
    await shutdownDesktop();
    shutdownComplete = true;
    app.quit();
  }
}

function installLocalRuntimeHandlers(): void {
  ipcMain.removeHandler(DESKTOP_LOCAL_RUNTIME_STATUS_CHANNEL);
  ipcMain.removeHandler(DESKTOP_INSTALL_LOCAL_MODELS_CHANNEL);

  ipcMain.handle(
    DESKTOP_LOCAL_RUNTIME_STATUS_CHANNEL,
    (event: IpcMainInvokeEvent): DesktopRendererLocalRuntimeStatus => {
      if (!isAuthorizedDesktopInvoke(event)) {
        throw new Error("Desktop local runtime request was rejected");
      }
      return localRuntimeStatusForRenderer();
    }
  );

  ipcMain.handle(
    DESKTOP_INSTALL_LOCAL_MODELS_CHANNEL,
    async (event: IpcMainInvokeEvent): Promise<DesktopRendererLocalRuntimeStatus> => {
      if (!isAuthorizedDesktopInvoke(event)) {
        throw new Error("Desktop local model setup request was rejected");
      }
      if (modelInstallPromise !== undefined) return modelInstallPromise;
      if (modelSetupRestartRequired) return localRuntimeStatusForRenderer();
      const runtime = localRuntime;
      if (runtime === undefined || shuttingDown) {
        throw new Error("Desktop local runtime is unavailable");
      }
      modelSetupState = "INSTALLING";
      modelSetupRestartRequired = false;
      const operation = installLocalModels(runtime);
      modelInstallPromise = operation;
      void operation.finally(() => {
        if (modelInstallPromise === operation) modelInstallPromise = undefined;
      }).catch(() => undefined);
      return operation;
    }
  );
}

function isAuthorizedDesktopInvoke(event: IpcMainInvokeEvent): boolean {
  const currentWindow = mainWindow;
  const currentFrontendUrl = frontendUrl;
  return currentWindow !== undefined
    && currentFrontendUrl !== undefined
    && isAuthorizedDesktopBootstrapRequest({
      shuttingDown,
      senderWebContentsId: event.sender.id,
      trustedWebContentsId: currentWindow.webContents.id,
      senderFrame: event.senderFrame,
      trustedMainFrame: currentWindow.webContents.mainFrame,
      senderFrameUrl: event.senderFrame?.url,
      trustedFrontendUrl: currentFrontendUrl
    });
}

async function installLocalModels(
  runtime: DesktopLocalRuntimeComposition
): Promise<DesktopRendererLocalRuntimeStatus> {
  try {
    await runtime.installVoiceAssets(startupAbort.signal);
    modelSetupState = "INSTALLED";
    modelSetupRestartRequired = true;
    return localRuntimeStatusForRenderer();
  } catch {
    if (startupAbort.signal.aborted) {
      modelSetupState = "IDLE";
      modelSetupRestartRequired = false;
      throw new Error("Local model setup was cancelled");
    }
    modelSetupState = "FAILED";
    modelSetupRestartRequired = false;
    throw new Error(
      "Local model setup failed. Check network access, available disk space, and retry."
    );
  }
}

function localRuntimeStatusForRenderer(): DesktopRendererLocalRuntimeStatus {
  const snapshot = localRuntime?.getCapabilityStatus();
  return Object.freeze({
    protocolVersion: 1,
    speech: rendererCapability(snapshot?.speech),
    tts: rendererCapability(snapshot?.tts),
    vision: rendererCapability(snapshot?.vision),
    python: Object.freeze({
      strategy: "SYSTEM_CPYTHON",
      supportedVersions: Object.freeze(["3.12", "3.13"] as const)
    }),
    modelSetup: Object.freeze({
      state: modelSetupState,
      restartRequired: modelSetupRestartRequired
    })
  });
}

function rendererCapability(
  status: {
    readonly state: DesktopRendererRuntimeCapabilityStatus["state"];
    readonly reasonCode?: string;
  } | undefined
): DesktopRendererRuntimeCapabilityStatus {
  if (status === undefined) {
    return Object.freeze({ state: "UNAVAILABLE", reasonCode: "NOT_STARTED" });
  }
  return Object.freeze({
    state: status.state,
    ...(status.reasonCode === undefined ? {} : { reasonCode: status.reasonCode })
  });
}

async function assertPackagedPreloadIntegrity(preloadPath: string): Promise<void> {
  const metadata = await lstat(preloadPath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("Packaged preload is missing or is not a regular file");
  }
  const digest = createHash("sha256")
    .update(await readFile(preloadPath))
    .digest("hex");
  if (digest !== PACKAGED_DESKTOP_PRELOAD_SHA256) {
    throw new Error("Packaged preload failed integrity validation");
  }
}

async function configurePackagedSmokeUserData(): Promise<void> {
  const requested = process.env["INTERVIEW_PACKAGED_SMOKE_USER_DATA"];
  if (requested === undefined) return;
  if (
    !app.isPackaged
    || !(
      process.argv.includes("--packaged-smoke-test")
      || process.argv.includes("--packaged-single-instance-smoke-host")
      || process.argv.includes("--packaged-single-instance-smoke-probe")
    )
  ) {
    throw new Error("Packaged smoke user-data override is only valid in packaged smoke mode");
  }
  if (!path.isAbsolute(requested) || requested.includes("\0")) {
    throw new Error("Packaged smoke user-data path must be absolute");
  }
  await mkdir(requested, { recursive: true });
  app.setPath("userData", requested);
}

async function postPackagedSmokeCommand(
  commandUrl: string,
  token: string,
  origin: string,
  command: Readonly<Record<string, unknown>>
): Promise<unknown> {
  const response = await fetch(commandUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-interview-client-token": token,
      origin
    },
    body: JSON.stringify(command),
    cache: "no-store",
    credentials: "omit",
    redirect: "error"
  });
  const contentType = response.headers.get("content-type");
  if (contentType?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    throw new Error(`Packaged command smoke returned invalid content type: ${contentType ?? "<none>"}`);
  }
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Packaged command smoke failed with HTTP ${String(response.status)}: ${body.slice(0, 512)}`);
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new Error("Packaged command smoke returned malformed JSON");
  }
}

function packagedSmokeProofPath(name: string): string | undefined {
  const candidate = process.env[name];
  if (candidate === undefined) return undefined;
  if (
    candidate.length === 0
    || candidate.length > 4_096
    || candidate.includes("\0")
    || !path.isAbsolute(candidate)
  ) {
    throw new Error("Packaged smoke proof path must be a bounded absolute path");
  }
  return candidate;
}

async function verifyPriorPackagedSmokeSession(
  server: Awaited<ReturnType<DesktopBackendController["start"]>>
): Promise<void> {
  const proofPath = packagedSmokeProofPath("INTERVIEW_PACKAGED_SMOKE_EXPECT_REPORT");
  if (proofPath === undefined) return;

  const metadata = await lstat(proofPath);
  if (
    !metadata.isFile()
    || metadata.isSymbolicLink()
    || metadata.size <= 0
    || metadata.size > PACKAGED_SMOKE_PROOF_MAX_BYTES
  ) {
    throw new Error("Packaged upgrade smoke proof is not a bounded regular file");
  }
  const raw = await readFile(proofPath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Packaged upgrade smoke proof is malformed");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Packaged upgrade smoke proof is malformed");
  }
  const record = parsed as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",")
      !== "expectedStudentText,minimumSequence,protocolVersion,sessionId"
    || record["protocolVersion"] !== 1
    || record["expectedStudentText"] !== PACKAGED_SMOKE_INPUT
    || typeof record["minimumSequence"] !== "number"
    || !Number.isSafeInteger(record["minimumSequence"])
    || record["minimumSequence"] < 0
  ) {
    throw new Error("Packaged upgrade smoke proof is malformed");
  }
  const sessionIdResult = SessionIdSchema.safeParse(record["sessionId"]);
  if (
    !sessionIdResult.success
    || !sessionIdResult.data.startsWith("session_")
    || sessionIdResult.data.length > 128
  ) {
    throw new Error("Packaged upgrade smoke proof contains an invalid session ID");
  }
  const sessionId = sessionIdResult.data;
  try {
    await server.runtime.sessions.ensureRecovered(sessionId);
  } catch {
    throw new Error("Upgraded package could not recover the prior persisted session");
  }
  const state = server.registry.get(sessionId).getState();
  if (
    state.sessionId !== sessionId
    || !state.started
    || state.sequence < record["minimumSequence"]
    || !Object.values(state.turns).some(
      (turn) => turn.studentText === PACKAGED_SMOKE_INPUT
    )
  ) {
    throw new Error("Upgraded package did not preserve the prior authoritative session");
  }
}

async function writePackagedSmokeProof(
  sessionId: SessionId,
  minimumSequence: number
): Promise<void> {
  const proofPath = packagedSmokeProofPath("INTERVIEW_PACKAGED_SMOKE_REPORT");
  if (proofPath === undefined) return;
  const payload = JSON.stringify({
    protocolVersion: 1,
    sessionId,
    expectedStudentText: PACKAGED_SMOKE_INPUT,
    minimumSequence
  });
  if (Buffer.byteLength(payload, "utf8") > PACKAGED_SMOKE_PROOF_MAX_BYTES) {
    throw new Error("Packaged smoke proof exceeded its bounded size");
  }
  await writeFile(proofPath, payload, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600
  });
}

async function runPackagedSmoke(
  server: Awaited<ReturnType<DesktopBackendController["start"]>>,
  backendConfig: Parameters<DesktopBackendController["start"]>[0]
): Promise<void> {
  const window = mainWindow;
  if (window === undefined || window.isDestroyed()) {
    throw new Error("Packaged smoke did not create a desktop window");
  }
  const rendererReady: unknown = await window.webContents.executeJavaScript(
    `new Promise((resolve) => {