import { exactLoopbackOrigin } from "./bootstrap.js";

export type DesktopMode = "development" | "production";

export function resolveDesktopMode(isPackaged: boolean, argv: readonly string[]): DesktopMode {
  return isPackaged || argv.includes("--desktop-production")
    ? "production"
    : "development";
}

export function resolveDevelopmentFrontendOrigin(value: string | undefined): string {
  return exactLoopbackOrigin(value ?? "http://127.0.0.1:5173");
}
