import {
  SessionIdSchema,
  type SessionId
} from "../../../../packages/domain/src/index.js";

export type AppRoute =
  | { readonly page: "home" }
  | { readonly page: "interview" }
  | { readonly page: "sessions" }
  | { readonly page: "settings" }
  | {
      readonly page: "review";
      readonly sessionId: SessionId;
      readonly tab?: "evaluation" | "replay";
    };

export const DEFAULT_APP_ROUTE: AppRoute = { page: "home" };

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export function parseAppRouteHash(hash: string): AppRoute {
  const normalized = hash.startsWith("#") ? hash.slice(1) : hash;
  const path = normalized.startsWith("/") ? normalized.slice(1) : normalized;
  if (path.length === 0) return DEFAULT_APP_ROUTE;

  const segments = path.split("/").filter((segment) => segment.length > 0);
  const [head] = segments;

  if (head === "interview" && segments.length === 1) {
    return { page: "interview" };
  }
  if (head === "sessions" && segments.length === 1) {
    return { page: "sessions" };
  }
  if (head === "settings" && segments.length === 1) {
    return { page: "settings" };
  }
  if (head === "review" && (segments.length === 2 || segments.length === 3)) {
    const encodedSessionId = segments[1];
    if (encodedSessionId === undefined) return DEFAULT_APP_ROUTE;
    const decodedSessionId = safeDecode(encodedSessionId);
    if (decodedSessionId === null) return DEFAULT_APP_ROUTE;
    const parsedSessionId = SessionIdSchema.safeParse(decodedSessionId);
    if (!parsedSessionId.success) return DEFAULT_APP_ROUTE;

    const requestedTab = segments[2];
    if (
      requestedTab !== undefined
      && requestedTab !== "evaluation"
      && requestedTab !== "replay"
    ) {
      return DEFAULT_APP_ROUTE;
    }

    return {
      page: "review",
      sessionId: parsedSessionId.data,
      ...(requestedTab === undefined ? {} : { tab: requestedTab })
    };
  }

  return DEFAULT_APP_ROUTE;
}

export function appRouteDocumentTitle(route: AppRoute): string {
  switch (route.page) {
    case "home":
    case "interview":
      return "Interview";
    case "sessions":
      return "Sessions · Interview";
    case "settings":
      return "Settings · Interview";
    case "review":
      return "Session review · Interview";
  }
}

export function appRouteToHash(route: AppRoute): string {
  switch (route.page) {
    case "home":
      return "#/";
    case "interview":
      return "#/interview";
    case "sessions":
      return "#/sessions";
    case "settings":
      return "#/settings";
    case "review": {
      const tabSuffix = route.tab === undefined ? "" : `/${route.tab}`;
      return `#/review/${encodeURIComponent(route.sessionId)}${tabSuffix}`;
    }
  }
}
