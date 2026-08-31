import { exactLoopbackOrigin } from "./bootstrap.js";
export interface DesktopPermissionWebContents {
  readonly id: number;
}

export interface DesktopPermissionRequestDetails {
  readonly requestingUrl?: string;
  readonly isMainFrame?: boolean;
  readonly mediaTypes?: readonly string[];
}

export interface DesktopPermissionCheckDetails {
  readonly requestingUrl?: string;
  readonly isMainFrame?: boolean;
  readonly mediaType?: string;
  readonly embeddingOrigin?: string;
  readonly securityOrigin?: string;
}

export interface DesktopPermissionPolicyInput {
  readonly trustedWebContentsId: number;
  readonly trustedFrontendOrigin: string;
}

export type DesktopPermissionRequestHandler = (
  webContents: DesktopPermissionWebContents | null,
  permission: string,
  callback: (granted: boolean) => void,
  details: DesktopPermissionRequestDetails
) => void;

export type DesktopPermissionCheckHandler = (
  webContents: DesktopPermissionWebContents | null,
  permission: string,
  requestingOrigin: string,
  details: DesktopPermissionCheckDetails
) => boolean;

export interface DesktopPermissionSessionBoundary {
  setPermissionRequestHandler(handler: DesktopPermissionRequestHandler | null): void;
  setPermissionCheckHandler(handler: DesktopPermissionCheckHandler | null): void;
}

export function installDesktopPermissionCapability(
  session: DesktopPermissionSessionBoundary,
  input: DesktopPermissionPolicyInput
): () => void {
  const trustedInput = normalizePermissionPolicyInput(input);
  const requestHandler: DesktopPermissionRequestHandler = (
    webContents,
    permission,
    callback,
    details
  ) => {
    callback(allowDesktopPermissionRequest(webContents, permission, details, trustedInput));
  };
  const checkHandler: DesktopPermissionCheckHandler = (
    webContents,
    permission,
    requestingOrigin,
    details
  ) => allowDesktopPermissionCheck(
    webContents,
    permission,
    requestingOrigin,
    details,
    trustedInput
  );

  try {
    session.setPermissionRequestHandler(requestHandler);
    session.setPermissionCheckHandler(checkHandler);
  } catch (error) {
    try {
      session.setPermissionRequestHandler(null);
    } catch {
      // Best-effort rollback; preserve original installation failure.
    }
    try {
      session.setPermissionCheckHandler(null);
    } catch {
      // Best-effort rollback; preserve original installation failure.
    }
    throw error;
  }

  let active = true;
  return () => {
    if (!active) return;
    const failures: unknown[] = [];
    try {
      session.setPermissionRequestHandler(null);
    } catch (error) {
      failures.push(error);
    }
    try {
      session.setPermissionCheckHandler(null);
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "Desktop permission capability cleanup failed");
    }
    active = false;
  };
}

export function allowDesktopPermissionRequest(
  webContents: DesktopPermissionWebContents | null,
  permission: string,
  details: DesktopPermissionRequestDetails,
  input: DesktopPermissionPolicyInput
): boolean {
  const trusted = tryNormalizePermissionPolicyInput(input);
  if (trusted === undefined) return false;
  if (webContents?.id !== trusted.trustedWebContentsId) return false;
  if (permission !== "media") return false;
  if (details.isMainFrame !== true) return false;
  if (!sameOrigin(details.requestingUrl, trusted.trustedFrontendOrigin)) return false;
  const mediaTypes = details.mediaTypes;
  return mediaTypes !== undefined
    && mediaTypes.length === 1
    && mediaTypes[0] === "audio";
}

export function allowDesktopPermissionCheck(
  webContents: DesktopPermissionWebContents | null,
  permission: string,
  requestingOrigin: string,
  details: DesktopPermissionCheckDetails,
  input: DesktopPermissionPolicyInput
): boolean {
  const trusted = tryNormalizePermissionPolicyInput(input);
  if (trusted === undefined) return false;
  if (webContents?.id !== trusted.trustedWebContentsId) return false;
  if (permission !== "media") return false;
  if (details.isMainFrame !== true) return false;
  if (details.mediaType !== "audio") return false;
  if (!sameOrigin(requestingOrigin, trusted.trustedFrontendOrigin)) return false;
  if (details.requestingUrl !== undefined
    && !sameOrigin(details.requestingUrl, trusted.trustedFrontendOrigin)) return false;
  if (details.embeddingOrigin !== undefined
    && !sameOrigin(details.embeddingOrigin, trusted.trustedFrontendOrigin)) return false;
  if (details.securityOrigin !== undefined
    && !sameOrigin(details.securityOrigin, trusted.trustedFrontendOrigin)) return false;
  return true;
}

function normalizePermissionPolicyInput(
  input: DesktopPermissionPolicyInput
): DesktopPermissionPolicyInput {
  if (!Number.isSafeInteger(input.trustedWebContentsId) || input.trustedWebContentsId <= 0) {
    throw new Error("Trusted desktop WebContents id is invalid");
  }
  return {
    trustedWebContentsId: input.trustedWebContentsId,
    trustedFrontendOrigin: exactLoopbackOrigin(input.trustedFrontendOrigin)
  };
}

function tryNormalizePermissionPolicyInput(
  input: DesktopPermissionPolicyInput
): DesktopPermissionPolicyInput | undefined {
  try {
    return normalizePermissionPolicyInput(input);
  } catch {
    return undefined;
  }
}

function sameOrigin(candidate: string | undefined, trustedOrigin: string): boolean {
  if (candidate === undefined) return false;
  try {
    return new URL(candidate).origin === new URL(trustedOrigin).origin;
  } catch {
    return false;
  }
}
