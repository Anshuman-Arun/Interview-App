import { DESKTOP_AUTH_HEADER_VALUE } from "./bootstrap.js";

export interface BeforeSendHeadersDetails {
  readonly url: string;
  readonly method: string;
  readonly webContentsId?: number;
  readonly frame?: object | null;
  readonly resourceType?: string;
  readonly requestHeaders: Record<string, string | string[]>;
}

export type BeforeSendHeadersCallback = (result: {
  readonly requestHeaders: Record<string, string | string[]>;
}) => void;

export interface WebRequestHeaderBoundary {
  onBeforeSendHeaders(
    filter: { readonly urls: readonly string[] },
    listener: (details: BeforeSendHeadersDetails, callback: BeforeSendHeadersCallback) => void
  ): void;
  onBeforeSendHeaders(listener: null): void;
}

export function installDesktopClientTokenInjector(
  webRequest: WebRequestHeaderBoundary,
  input: {
    readonly commandUrl: string;
    readonly rendererStreamUrl: string;
    readonly clientToken: string;
    readonly webContentsId: number;
    readonly getTrustedMainFrame: () => object | null;
  }
): () => void {
  if (
    typeof input.clientToken !== "string"
    || input.clientToken.length < 32
    || /[\r\n]/u.test(input.clientToken)
  ) {
    throw new Error("Desktop client token is invalid");
  }
  if (!Number.isSafeInteger(input.webContentsId) || input.webContentsId <= 0) {
    throw new Error("Desktop WebContents id is invalid");
  }
  if (typeof input.getTrustedMainFrame !== "function") {
    throw new Error("Desktop trusted main-frame resolver is invalid");
  }

  const commandUrl = exactDesktopEndpoint(input.commandUrl, "/v1/commands");
  const rendererStreamUrl = exactDesktopEndpoint(
    input.rendererStreamUrl,
    "/v1/renderer-stream"
  );
  const endpoints = new Set([commandUrl, rendererStreamUrl]);
  const filterOrigins = [...new Set(
    [...endpoints].map((endpoint) => `${new URL(endpoint).origin}/*`)
  )];

  const listener = (
    details: BeforeSendHeadersDetails,
    callback: BeforeSendHeadersCallback
  ): void => {
    const trustedMainFrame = safelyResolveTrustedMainFrame(input.getTrustedMainFrame);
    if (
      details.webContentsId !== input.webContentsId
      || trustedMainFrame === null
      || details.frame !== trustedMainFrame
      || details.method !== "POST"
      || !endpoints.has(details.url)
      || !hasExactSingleHeaderValue(
        details.requestHeaders,
        "x-interview-client-token",
        DESKTOP_AUTH_HEADER_VALUE
      )
    ) {
      callback({ requestHeaders: details.requestHeaders });
      return;
    }

    const requestHeaders = Object.fromEntries(
      Object.entries(details.requestHeaders).filter(
        ([key]) => key.toLowerCase() !== "x-interview-client-token"
      )
    );
    requestHeaders["x-interview-client-token"] = input.clientToken;
    callback({ requestHeaders });
  };

  let installed = false;
  try {
    webRequest.onBeforeSendHeaders({ urls: filterOrigins }, listener);
    installed = true;
  } catch (error) {
    try {
      webRequest.onBeforeSendHeaders(null);
    } catch {
      // Best-effort rollback; preserve the original registration failure.
    }
    throw error;
  }

  return () => {
    if (!installed) return;
    webRequest.onBeforeSendHeaders(null);
    installed = false;
  };
}

function safelyResolveTrustedMainFrame(
  getTrustedMainFrame: () => object | null
): object | null {
  try {
    const frame = getTrustedMainFrame();
    return typeof frame === "object" && frame !== null ? frame : null;
  } catch {
    return null;
  }
}

function exactDesktopEndpoint(value: string, pathname: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Desktop token injection endpoint must be a valid URL");
  }

  if (
    parsed.protocol !== "http:"
    || (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "[::1]")
    || parsed.username.length > 0
    || parsed.password.length > 0
    || parsed.pathname !== pathname
    || parsed.search.length > 0
    || parsed.hash.length > 0
  ) {
    throw new Error("Desktop token injection endpoint must be an exact HTTP loopback endpoint");
  }
  return parsed.toString();
}

function hasExactSingleHeaderValue(
  headers: Record<string, string | string[]>,
  name: string,
  expectedValue: string
): boolean {
  const matches = Object.entries(headers).filter(
    ([key]) => key.toLowerCase() === name.toLowerCase()
  );
  return matches.length === 1 && matches[0]?.[1] === expectedValue;
}
