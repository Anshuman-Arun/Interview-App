import path from "node:path";
export const DESKTOP_MIN_WIDTH = 960;
export const DESKTOP_MIN_HEIGHT = 640;
export const DESKTOP_SESSION_PARTITION = "interview-desktop";

export interface SecureDesktopWebPreferences {
  readonly preload: string;
  readonly contextIsolation: true;
  readonly nodeIntegration: false;
  readonly nodeIntegrationInWorker: false;
  readonly nodeIntegrationInSubFrames: false;
  readonly sandbox: true;
  readonly webSecurity: true;
  readonly allowRunningInsecureContent: false;
  readonly webviewTag: false;
  readonly partition: typeof DESKTOP_SESSION_PARTITION;
}

export function createSecureWebPreferences(preloadPath: string): SecureDesktopWebPreferences {
  if (
    typeof preloadPath !== "string"
    || preloadPath.trim().length === 0
    || !path.isAbsolute(preloadPath)
  ) {
    throw new Error("Desktop preload path must be an absolute filesystem path");
  }
  return {
    preload: preloadPath,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    partition: DESKTOP_SESSION_PARTITION
  };
}
