import { describe, expect, it } from "vitest";
import { SessionIdSchema } from "../packages/domain/src/index.js";
import {
  parseProductRoute,
  productRouteTitle,
  productRouteToHash,
  routeForActiveInterview
} from "../apps/web/src/navigation/product-route.js";

describe("expressive product routing", () => {
  const sessionId = SessionIdSchema.parse(
    "session_00000000-0000-4000-8000-000000000201"
  );

  it("round-trips dependency-free product routes", () => {
    const routes = [
      { page: "home" } as const,
      { page: "interview" } as const,
      { page: "sessions" } as const,
      { page: "settings" } as const,
      { page: "review", sessionId, view: "evaluation" } as const,
      { page: "review", sessionId, view: "replay" } as const
    ];

    for (const route of routes) {
      expect(parseProductRoute(productRouteToHash(route))).toEqual(route);
    }
  });

  it("fails closed for malformed review identities and unsupported routes", () => {
    for (const hash of [
      "#/wat",
      "#/settings/extra",
      "#/review",
      "#/review/%2F",
      "#/review/%E0%A4%A",
      `#/review/${sessionId}/other`
    ]) {
      expect(parseProductRoute(hash)).toEqual({ page: "home" });
    }
  });

  it("route-locks an active interview to the live workspace", () => {
    expect(routeForActiveInterview({ page: "home" }, true))
      .toEqual({ page: "interview" });
    expect(routeForActiveInterview({ page: "sessions" }, true))
      .toEqual({ page: "interview" });
    expect(routeForActiveInterview({ page: "interview" }, true))
      .toEqual({ page: "interview" });
    expect(routeForActiveInterview({ page: "home" }, false))
      .toEqual({ page: "home" });
  });

  it("uses restrained document titles", () => {
    expect(productRouteTitle({ page: "home" })).toBe("Interview");
    expect(productRouteTitle({ page: "sessions" })).toBe("Sessions · Interview");
    expect(productRouteTitle({ page: "settings" })).toBe("Settings · Interview");
    expect(productRouteTitle({ page: "review", sessionId, view: "replay" }))
      .toBe("Review · Interview");
  });
});
