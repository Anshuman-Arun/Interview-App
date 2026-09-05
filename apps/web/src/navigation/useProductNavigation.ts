import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_PRODUCT_ROUTE,
  parseProductRoute,
  productRouteTitle,
  productRouteToHash,
  type ProductRoute
} from "./product-route.js";

export interface ProductNavigation {
  readonly route: ProductRoute;
  readonly navigate: (
    route: ProductRoute,
    options?: { readonly replace?: boolean }
  ) => void;
}

function isDesktopRenderer(): boolean {
  return typeof window !== "undefined"
    && (globalThis as typeof globalThis & {
      readonly interviewDesktop?: object;
    }).interviewDesktop !== undefined;
}

function readRoute(): ProductRoute {
  if (typeof window === "undefined") return DEFAULT_PRODUCT_ROUTE;
  if (isDesktopRenderer()) return DEFAULT_PRODUCT_ROUTE;
  return parseProductRoute(window.location.hash);
}

function readHashRoute(): ProductRoute {
  if (typeof window === "undefined") return DEFAULT_PRODUCT_ROUTE;
  return parseProductRoute(window.location.hash);
}

export function useProductNavigation(): ProductNavigation {
  const [route, setRoute] = useState<ProductRoute>(readRoute);

  useEffect(() => {
    if (isDesktopRenderer()) {
      const homeHash = productRouteToHash(DEFAULT_PRODUCT_ROUTE);
      if (window.location.hash !== homeHash) {
        const nextUrl = new URL(window.location.href);
        nextUrl.hash = homeHash;
        window.history.replaceState(null, "", nextUrl);
      }
      setRoute(DEFAULT_PRODUCT_ROUTE);
    }

    const onHashChange = (): void => setRoute(readHashRoute());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    document.title = productRouteTitle(route);
  }, [route]);

  const navigate = useCallback(
    (
      nextRoute: ProductRoute,
      options?: { readonly replace?: boolean }
    ): void => {
      setRoute(nextRoute);
      if (typeof window === "undefined") return;

      const hash = productRouteToHash(nextRoute);
      if (window.location.hash === hash) return;

      if (options?.replace === true) {
        const nextUrl = new URL(window.location.href);
        nextUrl.hash = hash;
        window.history.replaceState(null, "", nextUrl);
        return;
      }

      window.location.hash = hash;
    },
    []
  );

  return { route, navigate };
}
