import { randomBytes, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createAndStartServer } from "../../server/src/server.js";
import { newSessionId } from "../../../packages/domain/src/index.js";
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

let localRuntime: DesktopLocalRuntimeComposition | undefined;
const startupAbort = new AbortController();
const backend = new DesktopBackendController(async (config) =>
  createAndStartServer({
    ...config,
    ...(localRuntime?.voiceRuntime === undefined
      ? {}
      : { voiceRuntime: localRuntime.voiceRuntime })
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
  if (process.argv.includes("--install-local-models")) {
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
      const deadline = Date.now() + 5000;
      const check = () => {
        const root = document.getElementById("root");
        const mounted = root instanceof HTMLElement
          && root.childElementCount > 0
          && document.querySelector(".interview-app-container") instanceof HTMLElement
          && typeof globalThis.interviewDesktop?.getBootstrap === "function"
          && typeof globalThis.interviewDesktop?.getLocalRuntimeStatus === "function"
          && typeof globalThis.interviewDesktop?.installLocalModels === "function";
        if (mounted) {
          resolve(true);
          return;
        }
        if (Date.now() >= deadline) {
          resolve(false);
          return;
        }
        setTimeout(check, 50);
      };
      check();
    })`
  );
  if (rendererReady !== true) {
    throw new Error("Packaged renderer did not mount the product shell");
  }

  const token = backendConfig.clientToken;
  const origin = backendConfig.allowedOrigins?.[0];
  if (
    typeof token !== "string"
    || token.length < 32
    || typeof origin !== "string"
    || origin.length === 0
  ) {
    throw new Error("Packaged smoke backend authentication configuration is unavailable");
  }

  const commandUrl = `${server.bound.command.url}/v1/commands`;
  const sessionId = newSessionId();
  await postPackagedSmokeCommand(commandUrl, token, origin, {
    protocolVersion: 1,
    type: "START_SESSION",
    requestId: `request_${randomUUID()}`,
    sessionId
  });
  await postPackagedSmokeCommand(commandUrl, token, origin, {
    protocolVersion: 1,
    type: "COMMIT_TYPED_INPUT",
    requestId: `request_${randomUUID()}`,
    sessionId,
    text: "Packaged Windows desktop smoke input."
  });

  const beforeRestart = JSON.stringify(server.registry.get(sessionId).getState());
  await backend.stop();
  const restarted = await backend.start(backendConfig);
  const afterRestart = JSON.stringify(restarted.registry.get(sessionId).getState());
  if (afterRestart !== beforeRestart) {
    throw new Error("Packaged SQLite persistence smoke validation failed");
  }
}

function installBootstrapHandler(): void {
  ipcMain.removeAllListeners(DESKTOP_BOOTSTRAP_CHANNEL);
  ipcMain.on(DESKTOP_BOOTSTRAP_CHANNEL, (event: IpcMainEvent) => {
    const currentWindow = mainWindow;
    const currentBootstrap = bootstrap;
    const currentFrontendUrl = frontendUrl;
    if (
      currentWindow === undefined
      || currentBootstrap === undefined
      || currentFrontendUrl === undefined
      || !isAuthorizedDesktopBootstrapRequest({
        shuttingDown,
        senderWebContentsId: event.sender.id,
        trustedWebContentsId: currentWindow.webContents.id,
        senderFrame: event.senderFrame,
        trustedMainFrame: currentWindow.webContents.mainFrame,
        senderFrameUrl: event.senderFrame?.url,
        trustedFrontendUrl: currentFrontendUrl
      })
    ) {
      event.returnValue = null;
      return;
    }
    event.returnValue = currentBootstrap;
  });
}

function installZoomHandler(): void {
  ipcMain.removeAllListeners(DESKTOP_ZOOM_CHANNEL);
  ipcMain.on(DESKTOP_ZOOM_CHANNEL, (event: IpcMainEvent, requestedFactor: unknown) => {
    const currentWindow = mainWindow;
    const currentBootstrap = bootstrap;
    const currentFrontendUrl = frontendUrl;
    if (
      currentWindow === undefined
      || currentBootstrap === undefined
      || currentFrontendUrl === undefined
      || !isAuthorizedDesktopBootstrapRequest({
        shuttingDown,
        senderWebContentsId: event.sender.id,
        trustedWebContentsId: currentWindow.webContents.id,
        senderFrame: event.senderFrame,
        trustedMainFrame: currentWindow.webContents.mainFrame,
        senderFrameUrl: event.senderFrame?.url,
        trustedFrontendUrl: currentFrontendUrl
      })
      || !isDesktopZoomFactor(requestedFactor)
    ) {
      event.returnValue = false;
      return;
    }

    applyDesktopZoomFactor(currentWindow, requestedFactor, false);
    event.returnValue = true;
  });
}

function applyDesktopZoomFactor(
  window: BrowserWindow,
  factor: DesktopZoomFactor,
  notifyRenderer: boolean
): void {
  window.webContents.setZoomFactor(factor);
  if (notifyRenderer) {
    window.webContents.send(DESKTOP_ZOOM_CHANGED_CHANNEL, factor);
  }
}

function stepDesktopZoom(window: BrowserWindow, direction: -1 | 1): void {
  const current = window.webContents.getZoomFactor();
  const unclamped = current + direction * 0.1;
  const target = Math.min(
    DESKTOP_MAX_ZOOM_FACTOR,
    Math.max(DESKTOP_MIN_ZOOM_FACTOR, Math.round(unclamped * 100) / 100)
  );
  applyDesktopZoomFactor(window, target, true);
}

function installDesktopZoomShortcuts(window: BrowserWindow): void {
  window.webContents.on("before-input-event", (event, input) => {
    if (
      input.type !== "keyDown"
      || (!input.control && !input.meta)
      || input.alt
    ) {
      return;
    }

    if (input.key === "+" || input.key === "=") {
      event.preventDefault();
      stepDesktopZoom(window, 1);
      return;
    }
    if (input.key === "-") {
      event.preventDefault();
      stepDesktopZoom(window, -1);
      return;
    }
    if (input.key === "0") {
      event.preventDefault();
      applyDesktopZoomFactor(window, 1, true);
    }
  });
}

async function createMainWindow(preloadPath?: string): Promise<void> {
  const targetUrl = frontendUrl;
  const currentBootstrap = bootstrap;
  const token = clientToken;
  if (targetUrl === undefined || currentBootstrap === undefined || token === undefined) {
    throw new Error("Desktop runtime is not ready");
  }

  const resolvedPreload = preloadPath ?? resolveDesktopPaths({
    cwd: process.cwd(),
    resourcesPath: process.resourcesPath,
    userDataPath: app.getPath("userData"),
    isPackaged: app.isPackaged
  }).preloadPath;

  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: DESKTOP_MIN_WIDTH,
    minHeight: DESKTOP_MIN_HEIGHT,
    show: false,
    autoHideMenuBar: true,
    webPreferences: createSecureWebPreferences(resolvedPreload)
  });
  mainWindow = window;
  const electronSession = window.webContents.session;

  removeTokenInjector?.();
  const thisRemoveTokenInjector = installDesktopClientTokenInjector(
    electronSession.webRequest,
    {
      commandUrl: `${currentBootstrap.commandBaseUrl}/v1/commands`,
      rendererStreamUrl: currentBootstrap.rendererStreamUrl,
      voiceBaseUrl: currentBootstrap.voiceBaseUrl,
      clientToken: token,
      webContentsId: window.webContents.id,
      getTrustedMainFrame: () => {
        if (window.isDestroyed()) return null;
        return window.webContents.mainFrame;
      }
    }
  );
  removeTokenInjector = thisRemoveTokenInjector;

  removePermissionCapability?.();
  const thisRemovePermissionCapability = installDesktopPermissionCapability(
    electronSession,
    {
      trustedWebContentsId: window.webContents.id,
      trustedFrontendOrigin: new URL(targetUrl).origin
    }
  );
  removePermissionCapability = thisRemovePermissionCapability;

  installDesktopZoomShortcuts(window);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const guardNavigation = (details: { preventDefault(): void; url: string }): void => {
    if (!isTrustedDesktopNavigation(details.url, targetUrl)) details.preventDefault();
  };
  // Electron's current navigation API passes the destination on the details
  // object. Guard every frame, not only the main frame, so an iframe cannot
  // navigate away from the trusted loopback origin.
  window.webContents.on("will-frame-navigate", guardNavigation);
  window.webContents.on("will-redirect", guardNavigation);
  window.webContents.on("will-attach-webview", (event) => {
    event.preventDefault();
  });
  window.once("closed", () => {
    if (mainWindow === window) mainWindow = undefined;

    const permissionCleanup = tryDesktopCleanup(thisRemovePermissionCapability);
    if (
      permissionCleanup.ok
      && removePermissionCapability === thisRemovePermissionCapability
    ) {
      removePermissionCapability = undefined;
    }

    const tokenCleanup = tryDesktopCleanup(thisRemoveTokenInjector);
    if (tokenCleanup.ok && removeTokenInjector === thisRemoveTokenInjector) {
      removeTokenInjector = undefined;
    }
  });

  await window.loadURL(targetUrl);
  if (!window.isDestroyed()) {
    window.show();
    window.focus();
  }
}

async function failStartup(message: string): Promise<void> {
  process.exitCode = 1;
  if (process.argv.includes("--install-local-models")) {
    console.error("Local model setup failed.");
    app.quit();
    return;
  }
  if (!app.isReady()) {
    app.quit();
    return;
  }
  if (process.argv.includes("--packaged-smoke-test")) {
    console.error(message);
    app.quit();
    return;
  }
  try {
    await dialog.showMessageBox({
      type: "error",
      title: "Interview App startup failed",
      message
    });
  } catch {
    // Startup failure must still converge to process shutdown if the dialog itself fails.
  } finally {
    app.quit();
  }
}

function shutdownDesktop(): Promise<void> {
  if (shutdownPromise !== undefined) return shutdownPromise;
  shuttingDown = true;
  startupAbort.abort();
  bootstrap = undefined;
  ipcMain.removeAllListeners(DESKTOP_BOOTSTRAP_CHANNEL);
  ipcMain.removeAllListeners(DESKTOP_ZOOM_CHANNEL);
  ipcMain.removeHandler(DESKTOP_LOCAL_RUNTIME_STATUS_CHANNEL);
  ipcMain.removeHandler(DESKTOP_INSTALL_LOCAL_MODELS_CHANNEL);

  const failures: unknown[] = [];

  let capabilityRevocationFailed = false;
  const permissionCleanup = removePermissionCapability;
  if (permissionCleanup !== undefined) {
    const result = tryDesktopCleanup(permissionCleanup);
    if (result.ok) removePermissionCapability = undefined;
    else {
      failures.push(result.error);
      capabilityRevocationFailed = true;
    }
  }

  const tokenCleanup = removeTokenInjector;
  if (tokenCleanup !== undefined) {
    const result = tryDesktopCleanup(tokenCleanup);
    if (result.ok) removeTokenInjector = undefined;
    else {
      failures.push(result.error);
      capabilityRevocationFailed = true;
    }
  }

  if (capabilityRevocationFailed) {
    // A failed permission or authentication-hook revocation leaves capability
    // state ambiguous. Destroy the only WebContents that could exercise it
    // before backend/frontend teardown continues.
    const currentWindow = mainWindow;
    if (currentWindow !== undefined && !currentWindow.isDestroyed()) {
      try {
        currentWindow.destroy();
      } catch (error) {
        failures.push(error);
      }
    }
  }

  clientToken = undefined;

  shutdownPromise = (async () => {
    try {
      await backend.stop();
    } catch (error) {
      failures.push(error);
    }

    const activeModelInstall = modelInstallPromise;
    if (activeModelInstall !== undefined) {
      await activeModelInstall.catch(() => undefined);
    }

    const currentLocalRuntime = localRuntime;
    if (currentLocalRuntime !== undefined) {
      try {
        await currentLocalRuntime.stopWorkers();
        if (localRuntime === currentLocalRuntime) localRuntime = undefined;
      } catch (error) {
        failures.push(error);
      }
    }

    const currentFrontendServer = frontendServer;
    if (currentFrontendServer !== undefined) {
      try {
        await currentFrontendServer.stop();
        if (frontendServer === currentFrontendServer) frontendServer = undefined;
      } catch (error) {
        failures.push(error);
      }
    }

    frontendUrl = undefined;
    if (failures.length > 0) {
      throw new AggregateError(failures, "Desktop shutdown failed");
    }
  })();
  return shutdownPromise;
}
