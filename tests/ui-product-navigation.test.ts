import { describe, expect, it } from "vitest";
import {
  appRouteDocumentTitle,
  appRouteToHash,
  parseAppRouteHash
} from "../apps/web/src/navigation/app-route.js";
import { SessionIdSchema } from "../packages/domain/src/index.js";

describe("product navigation routes", () => {
  it("round-trips stable product routes without a routing dependency", () => {
    const sessionId = SessionIdSchema.parse("session_00000000-0000-4000-8000-000000000001");

    const routes = [
      { page: "home" } as const,
      { page: "interview" } as const,
      { page: "sessions" } as const,
      { page: "settings" } as const,
      { page: "review", sessionId } as const,
      { page: "review", sessionId, tab: "evaluation" } as const,
      { page: "review", sessionId, tab: "replay" } as const
    ];

    for (const route of routes) {
      expect(parseAppRouteHash(appRouteToHash(route))).toEqual(route);
    }
  });

  it("maps routes to restrained document titles", () => {
    const sessionId = SessionIdSchema.parse(
      "session_00000000-0000-4000-8000-000000000002"
    );

    expect(appRouteDocumentTitle({ page: "home" })).toBe("Interview");
    expect(appRouteDocumentTitle({ page: "interview" })).toBe("Interview");
    expect(appRouteDocumentTitle({ page: "sessions" })).toBe("Sessions · Interview");
    expect(appRouteDocumentTitle({ page: "settings" })).toBe("Settings · Interview");
    expect(
      appRouteDocumentTitle({ page: "review", sessionId })
    ).toBe("Session review · Interview");
  });

  it("fails closed to home for malformed or unsupported hashes", () => {
    for (const hash of [
      "#/unknown",
      "#/review",
      "#/review/not-a-session",
      "#/review/%E0%A4%A",
      "#/review/session_00000000-0000-4000-8000-000000000001/other",
      "#/settings/extra"
    ]) {
      expect(parseAppRouteHash(hash)).toEqual({ page: "home" });
    }
  });

  it("accepts hashes with or without the leading hash marker", () => {
    expect(parseAppRouteHash("#/sessions")).toEqual({ page: "sessions" });
    expect(parseAppRouteHash("/sessions")).toEqual({ page: "sessions" });
    expect(parseAppRouteHash("sessions")).toEqual({ page: "sessions" });
  });
});

import fs from "node:fs";
import path from "node:path";

describe("top-level product route integration", () => {
  it("route-locks an ACTIVE interview to the focused live workspace", () => {
    const appSource = fs.readFileSync(
      path.resolve(process.cwd(), "apps/web/src/App.tsx"),
      "utf8"
    );

    expect(appSource).toContain("const { route, navigate } = useAppRoute()");
    expect(appSource).toContain('route.page === "interview"');
    expect(appSource).toContain('navigate({ page: "interview" }, { replace: true })');
    const routerSource = fs.readFileSync(
      path.resolve(process.cwd(), "apps/web/src/pages/ProductPageRouter.tsx"),
      "utf8"
    );

    expect(appSource).toContain("<ProductPageRouter");
    expect(routerSource).toContain("<HomePage");
    expect(routerSource).toContain("<SessionsPage");
    expect(routerSource).toContain("<SettingsPage");
    expect(routerSource).toContain("<SessionReviewPage");
  });
});
