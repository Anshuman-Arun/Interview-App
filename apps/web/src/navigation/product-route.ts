import {
  SessionIdSchema,
  type SessionId
} from "../../../../packages/domain/src/index.js";
import { isSessionIdAddressableForRead } from "../session-read-client.js";

export type ProductRoute =
  | { readonly page: "home" }
  | { readonly page: "new" }
  | { readonly page: "interview" }
  | { readonly page: "sessions" }
  | { readonly page: "settings" }
  | {
      readonly page: "review";
      readonly sessionId: SessionId;
      readonly view: "evaluation" | "replay";
    };

export const DEFAULT_PRODUCT_ROUTE: ProductRoute = { page: "home" };

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export function parseProductRoute(hash: string): ProductRoute {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (raw.length === 0 || raw === "/") return DEFAULT_PRODUCT_ROUTE;

  // Product hashes are deliberately canonical. Do not normalize repeated,
  // missing, or trailing separators into a different valid route.
  if (!raw.startsWith("/")) return DEFAULT_PRODUCT_ROUTE;
  const normalized = raw.slice(1);
  if (
    normalized.length === 0
    || normalized.startsWith("/")
    || normalized.endsWith("/")
    || normalized.includes("//")
  ) {
    return DEFAULT_PRODUCT_ROUTE;
  }

  const parts = normalized.split("/");
  const head = parts[0];

  if (head === "interview" && parts.length === 1) {
    return { page: "interview" };
  }
  if (head === "sessions" && parts.length === 1) {
    return { page: "sessions" };
  }
  if (head === "settings" && parts.length === 1) {
    return { page: "settings" };
  }
  if (head === "review" && parts.length >= 2 && parts.length <= 3) {
    const encoded = parts[1];
    if (encoded === undefined) return DEFAULT_PRODUCT_ROUTE;
    const decoded = safeDecode(encoded);
    if (decoded === null) return DEFAULT_PRODUCT_ROUTE;
    const parsed = SessionIdSchema.safeParse(decoded);
    if (
      !parsed.success
      || !isSessionIdAddressableForRead(parsed.data)
    ) {
      return DEFAULT_PRODUCT_ROUTE;
    }
    const requestedView = parts[2];
    if (
      requestedView !== undefined
      && requestedView !== "evaluation"
      && requestedView !== "replay"
    ) {
      return DEFAULT_PRODUCT_ROUTE;
    }

    return {
      page: "review",
      sessionId: parsed.data,
      view: requestedView ?? "evaluation"
    };
  }

  return DEFAULT_PRODUCT_ROUTE;
}

export function productRouteToHash(route: ProductRoute): string {
  switch (route.page) {
    case "home":
      return "#/";
    case "new":
      return "#/new";
    case "interview":
      return "#/interview";
    case "sessions":
      return "#/sessions";
    case "settings":
      return "#/settings";
    case "review":
      return `#/review/${encodeURIComponent(route.sessionId)}/${route.view}`;
  }
}

export function productRouteTitle(route: ProductRoute): string {
  switch (route.page) {
    case "home":
    case "interview":
      return "Interview";
    case "sessions":
      return "Sessions · Interview";
    case "settings":
      return "Settings · Interview";
    case "review":
      return "Review · Interview";
  }
}

export function routeForActiveInterview(
  route: ProductRoute,
  hasActiveInterview: boolean,
  isPaused = false
): ProductRoute {
  if (!hasActiveInterview) return route;
  if (isPaused) {
    return route.page === "home" || route.page === "new"
      ? route
      : { page: "home" };
  }
  return route.page === "interview" ? route : { page: "interview" };
}
