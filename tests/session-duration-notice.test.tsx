// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionDurationNotice } from "../apps/web/src/components/SessionDurationNotice.js";

describe("planned session duration product notice", () => {
  let root: Root | undefined;

  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    document.body.innerHTML = "";
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-04T02:00:00.000Z"));
  });

  afterEach(async () => {
    if (root !== undefined) {
      await act(async () => root?.unmount());
      root = undefined;
    }
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  function renderNotice(props: {
    readonly durationMinutes?: number;
    readonly createdAt?: string | null;
    readonly visible: boolean;
  }): void {
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => {
      root?.render(<SessionDurationNotice {...props} />);
    });
  }

  it("shows a non-blocking reminder when the configured duration is reached", async () => {
    renderNotice({
      durationMinutes: 30,
      createdAt: "2026-09-04T01:30:00.000Z",
      visible: true
    });

    const notice = document.querySelector('[data-testid="session-duration-notice"]');
    expect(notice?.textContent).toContain("Planned session time reached");
    expect(notice?.textContent).toContain("You can keep working");
  });

  it("waits until the planned time instead of ending work early", async () => {
    renderNotice({
      durationMinutes: 30,
      createdAt: "2026-09-04T01:45:00.000Z",
      visible: true
    });
    expect(document.querySelector('[data-testid="session-duration-notice"]')).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(14 * 60_000);
    });
    expect(document.querySelector('[data-testid="session-duration-notice"]')).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(document.querySelector('[data-testid="session-duration-notice"]')).not.toBeNull();
  });

  it("does not leak the live-session reminder over a backgrounded Home view", async () => {
    renderNotice({
      durationMinutes: 30,
      createdAt: "2026-09-04T01:00:00.000Z",
      visible: false
    });
    expect(document.querySelector('[data-testid="session-duration-notice"]')).toBeNull();
  });
});
