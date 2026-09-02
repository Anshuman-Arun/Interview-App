import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import process from "node:process";
import { createAndStartServer } from "../../server/src/server.js";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  type IpcMainEvent
} from "electron";
import { DesktopBackendController } from "./backend-controller.js";
import { DesktopLocalRuntimeComposition } from "./runtime/index.js";
import {
  DESKTOP_BOOTSTRAP_CHANNEL,
  DESKTOP_ZOOM_CHANGED_CHANNEL,
  DESKTOP_ZOOM_CHANNEL,
  DESKTOP_ZOOM_FACTORS,
  createDesktopRendererBootstrap,
  isAuthorizedDesktopBootstrapRequest,
  isDesktopZoomFactor,
  isTrustedDesktopNavigation,
  type DesktopRendererBootstrap,
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
    if (mainWindow === undefined) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
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
  const mode = resolveDesktopMode(app.isPackaged, process.argv);
  const paths = resolveDesktopPaths({
    cwd: process.cwd(),
    resourcesPath: process.resourcesPath,
    userDataPath: app.getPath("userData"),
    isPackaged: app.isPackaged
  });
  await mkdir(paths.appDataRoot, { recursive: true });

  const runtime = new DesktopLocalRuntimeComposition({
    appDataRoot: paths.appDataRoot,
    cwd: process.cwd(),
    resourcesPath: process.resourcesPath,
    isPackaged: app.isPackaged
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
  const server = await backend.start({
    host: "127.0.0.1",
    commandPort: 0,
    rendererStreamPort: 0,
    voicePort: 0,
    clientToken,
    allowedOrigins: [new URL(frontendUrl).origin],
    databasePath: paths.databasePath
  });

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
  await createMainWindow(paths.preloadPath);
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
  const factors = DESKTOP_ZOOM_FACTORS;
  let target: DesktopZoomFactor;

  if (direction > 0) {
    target = factors.find((factor) => factor > current + 0.001)
      ?? 1.25;
  } else {
    target = [...factors].reverse().find((factor) => factor < current - 0.001)
      ?? 0.875;
  }

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
