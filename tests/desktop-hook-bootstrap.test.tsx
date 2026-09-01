// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { useInterviewSession } from "../apps/web/src/hooks/useInterviewSession.js";

function Probe({ tick }: { readonly tick: number }) {
  const session = useInterviewSession();
  return <div>{String(session.isTransportManaged)}:{tick}</div>;
}

const actEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
const hadActEnvironment = Object.prototype.hasOwnProperty.call(
  globalThis,
  "IS_REACT_ACT_ENVIRONMENT"
);
const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;

describe("desktop hook bootstrap lifecycle", () => {
  beforeEach(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    if (hadActEnvironment) {
      actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    } else {
      delete actEnvironment.IS_REACT_ACT_ENVIRONMENT;
    }
    vi.unstubAllGlobals();
    delete (globalThis as typeof globalThis & { interviewDesktop?: unknown }).interviewDesktop;
  });

  it("reads desktop bootstrap exactly once across rerenders", async () => {
    const getBootstrap = vi.fn(() => ({
      protocolVersion: 1,
      commandBaseUrl: "http://127.0.0.1:41000",
      rendererStreamUrl: "http://127.0.0.1:41001/v1/renderer-stream",
      authentication: {
        mode: "DESKTOP_MANAGED",
        headerValue: "desktop-managed-v1"
      },
      appVersion: "test",
      platform: "test"
    }));
    Object.defineProperty(globalThis, "interviewDesktop", {
      value: { getBootstrap },
      configurable: true
    });
    vi.stubGlobal("fetch", async () => {
      throw new Error("network should not be used during hook initialization");
    });

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<Probe tick={0} />);
    });
    expect(getBootstrap).toHaveBeenCalledTimes(1);
    expect(container.textContent).toBe("true:0");

    await act(async () => {
      root.render(<Probe tick={1} />);
    });
    expect(getBootstrap).toHaveBeenCalledTimes(1);
    expect(container.textContent).toBe("true:1");

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});
