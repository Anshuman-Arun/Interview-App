export const DESKTOP_BOOTSTRAP_CHANNEL = "interview-desktop:get-bootstrap";
export const DESKTOP_ZOOM_CHANNEL = "interview-desktop:set-zoom";
export const DESKTOP_AUTH_HEADER_VALUE = "desktop-managed-v1";

export const DESKTOP_ZOOM_FACTORS = [0.875, 1, 1.125, 1.25] as const;
export type DesktopZoomFactor = typeof DESKTOP_ZOOM_FACTORS[number];

export function isDesktopZoomFactor(value: unknown): value is DesktopZoomFactor {
  return typeof value === "number"
    && DESKTOP_ZOOM_FACTORS.some((factor) => factor === value);
}

export interface DesktopRendererBootstrap {
  readonly protocolVersion: 1;
  readonly commandBaseUrl: string;
  readonly rendererStreamUrl: string;
  readonly voiceBaseUrl: string;
  readonly authentication: {
    readonly mode: "DESKTOP_MANAGED";
    readonly headerValue: typeof DESKTOP_AUTH_HEADER_VALUE;
  };
  readonly appVersion: string;
  readonly platform: string;
}

export function createDesktopRendererBootstrap(input: {
  readonly commandBaseUrl: string;
  readonly rendererStreamUrl: string;
  readonly voiceBaseUrl: string;
  readonly appVersion: string;
  readonly platform: string;
}): DesktopRendererBootstrap {
  const commandBaseUrl = exactLoopbackOrigin(input.commandBaseUrl);
  const rendererStreamUrl = exactRendererStreamUrl(input.rendererStreamUrl);
  const voiceBaseUrl = exactLoopbackOrigin(input.voiceBaseUrl);
  if (input.appVersion.trim().length === 0) throw new Error("Desktop app version is unavailable");
  if (input.platform.trim().length === 0) throw new Error("Desktop platform is unavailable");
  return {
    protocolVersion: 1,
    commandBaseUrl,
    rendererStreamUrl,
    voiceBaseUrl,
    authentication: {
      mode: "DESKTOP_MANAGED",
      headerValue: DESKTOP_AUTH_HEADER_VALUE
    },
    appVersion: input.appVersion,
    platform: input.platform
  };
}

export function isAuthorizedDesktopBootstrapRequest(input: {
  readonly shuttingDown: boolean;
  readonly senderWebContentsId: number;
  readonly trustedWebContentsId: number;
  readonly senderFrame: object | null;
  readonly trustedMainFrame: object;
  readonly senderFrameUrl: string | undefined;
  readonly trustedFrontendUrl: string;
}): boolean {
  return !input.shuttingDown
    && input.senderWebContentsId === input.trustedWebContentsId
    && input.senderFrame !== null
    && input.senderFrame === input.trustedMainFrame
    && input.senderFrameUrl !== undefined
    && sameOrigin(input.senderFrameUrl, input.trustedFrontendUrl);
}

export function isTrustedDesktopNavigation(
  candidate: string,
  trustedFrontendUrl: string
): boolean {
  try {
    const trustedOrigin = exactLoopbackOrigin(new URL(trustedFrontendUrl).origin);
    return new URL(candidate).origin === trustedOrigin;
  } catch {
    return false;
  }
}

export function validateDesktopRendererBootstrap(value: unknown): DesktopRendererBootstrap {
  if (typeof value !== "object" || value === null) throw new Error("Desktop bootstrap is malformed");
  const record = value as Record<string, unknown>;
  const authentication = record["authentication"];
  if (typeof authentication !== "object" || authentication === null) {
    throw new Error("Desktop bootstrap is malformed");
  }
  const auth = authentication as Record<string, unknown>;
  if (
    !hasExactKeys(record, [
      "protocolVersion",
      "commandBaseUrl",
      "rendererStreamUrl",
      "voiceBaseUrl",
      "authentication",
      "appVersion",
      "platform"
    ])
    || !hasExactKeys(auth, ["mode", "headerValue"])
    || record["protocolVersion"] !== 1
    || typeof record["commandBaseUrl"] !== "string"
    || typeof record["rendererStreamUrl"] !== "string"
    || typeof record["voiceBaseUrl"] !== "string"
    || auth["mode"] !== "DESKTOP_MANAGED"
    || auth["headerValue"] !== DESKTOP_AUTH_HEADER_VALUE
    || typeof record["appVersion"] !== "string"
    || typeof record["platform"] !== "string"
  ) {
    throw new Error("Desktop bootstrap is malformed");
  }
  return createDesktopRendererBootstrap({
    commandBaseUrl: record["commandBaseUrl"],
    rendererStreamUrl: record["rendererStreamUrl"],
    voiceBaseUrl: record["voiceBaseUrl"],
    appVersion: record["appVersion"],
    platform: record["platform"]
  });
}

function sameOrigin(candidate: string, trusted: string): boolean {
  try {
    return new URL(candidate).origin === new URL(trusted).origin;
  } catch {
    return false;
  }
}

function hasExactKeys(
  record: Record<string, unknown>,
  expectedKeys: readonly string[]
): boolean {
  const actual = Object.keys(record).sort();
  const expected = [...expectedKeys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

export function exactLoopbackOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Desktop URL must be a valid loopback URL");
  }
  if (
    parsed.protocol !== "http:"
    || (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "[::1]")
    || parsed.username.length > 0
    || parsed.password.length > 0
    || parsed.pathname !== "/"
    || parsed.search.length > 0
    || parsed.hash.length > 0
  ) {
    throw new Error("Desktop URL must be an exact HTTP loopback origin");
  }
  return parsed.origin;
}

function exactRendererStreamUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Renderer stream URL must be valid");
  }
  if (
    parsed.protocol !== "http:"
    || (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "[::1]")
    || parsed.username.length > 0
    || parsed.password.length > 0
    || parsed.pathname !== "/v1/renderer-stream"
    || parsed.search.length > 0
    || parsed.hash.length > 0
  ) {
    throw new Error("Renderer stream URL must target the exact loopback stream endpoint");
  }
  return parsed.toString();
}
