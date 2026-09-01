import path from "node:path";

export interface DesktopPathInput {
  readonly cwd: string;
  readonly resourcesPath: string;
  readonly userDataPath: string;
  readonly isPackaged: boolean;
}

export interface DesktopPaths {
  readonly frontendRoot: string;
  readonly preloadPath: string;
  readonly appDataRoot: string;
  readonly databasePath: string;
}

export function resolveDesktopPaths(input: DesktopPathInput): DesktopPaths {
  if (input.userDataPath.trim().length === 0 || !path.isAbsolute(input.userDataPath)) {
    throw new Error("Desktop user-data path must be an absolute filesystem path");
  }

  const frontendRoot = input.isPackaged
    ? path.join(input.resourcesPath, "web")
    : path.resolve(input.cwd, "dist/apps/web");
  const preloadPath = input.isPackaged
    ? path.join(input.resourcesPath, "preload.cjs")
    : path.resolve(input.cwd, "apps/desktop/preload.cjs");
  const appDataRoot = path.join(input.userDataPath, "data");
  return {
    frontendRoot,
    preloadPath,
    appDataRoot,
    databasePath: path.join(appDataRoot, "interview-session.sqlite")
  };
}
