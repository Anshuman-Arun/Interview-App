import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_APP_ROUTE,
  appRouteDocumentTitle,
  appRouteToHash,
  parseAppRouteHash,
  type AppRoute
} from "./app-route.js";

export interface UseAppRouteResult {
  readonly route: AppRoute;
  readonly navigate: (route: AppRoute, options?: { readonly replace?: boolean }) => void;
}

function readRoute(): AppRoute {
  if (typeof window === "undefined") return DEFAULT_APP_ROUTE;
  return parseAppRouteHash(window.location.hash);
}

export function useAppRoute(): UseAppRouteResult {
  const [route, setRoute] = useState<AppRoute>(readRoute);

  useEffect(() => {
    const handleHashChange = (): void => {
      setRoute(readRoute());
    };
    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);

  useEffect(() => {
    document.title = appRouteDocumentTitle(route);
  }, [route]);

  const navigate = useCallback(
    (nextRoute: AppRoute, options?: { readonly replace?: boolean }): void => {
      const nextHash = appRouteToHash(nextRoute);
      setRoute(nextRoute);

      if (typeof window === "undefined") return;
      if (window.location.hash === nextHash) return;

      if (options?.replace === true) {
        const nextUrl = new URL(window.location.href);
        nextUrl.hash = nextHash;
        window.history.replaceState(null, "", nextUrl);
        return;
      }

      window.location.hash = nextHash;
    },
    []
  );

  return { route, navigate };
}
