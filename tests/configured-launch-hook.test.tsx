// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  InterviewSessionConfigurationSchema,
  newSessionId,
  type SessionId
} from "../packages/domain/src/index.js";
import {
  useInterviewSession,
  type UseInterviewSessionResult
} from "../apps/web/src/hooks/useInterviewSession.js";

const BASE_URL = "http://127.0.0.1:43123";
const RENDERER_URL = "http://127.0.0.1:43124/v1/renderer-stream";
const VOICE_URL = "http://127.0.0.1:43125";
const CLIENT_TOKEN = "configured-launch-hook-token-000000000000000000";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function renderHook(fetchImpl: typeof fetch): {
  readonly root: Root;
  readonly container: HTMLDivElement;
  current(): UseInterviewSessionResult;
} {
  let current: UseInterviewSessionResult | undefined;
  function Probe() {
    current = useInterviewSession({
      baseUrl: BASE_URL,
      rendererStreamUrl: RENDERER_URL,
      voiceBaseUrl: VOICE_URL,
      clientToken: CLIENT_TOKEN,
      fetchImpl
    });
    return <div>{current.sessionId ?? "none"}</div>;
  }

  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(<Probe />));
  return {
    root,
    container,
    current: () => {
      if (current === undefined) throw new Error("Hook did not render");
      return current;
    }
  };
}

describe("configured interview hook launch", () => {
  const originalAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");

  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  });

  afterEach(() => {
    if (originalAct === undefined) {
      Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    } else {
      Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", originalAct);
    }
    document.body.innerHTML = "";
  });

  it("binds Quant mode authoritatively without attaching Oxford mutation or renderer authority", async () => {
    const sessionId: SessionId = newSessionId();
    const configuration = InterviewSessionConfigurationSchema.parse({
      configurationVersion: 1,
      mode: "QUANT_TRADING",
      scenario: {
        id: "BASIC_MARKET_MAKING",
        version: "1.0.0"
      },
      interventionPolicy: "STRICT",
      providerSelection: {
        providerId: "mock-model",
        modelId: "mock-default"
      }
    });
    const commandTypes: string[] = [];
    let rendererRequests = 0;

    const fetchImpl: typeof fetch = async (input, init = {}) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      if (url === RENDERER_URL) {
        rendererRequests += 1;
        throw new Error("Quant launch must not attach the Oxford renderer stream");
      }
      if (url !== `${BASE_URL}/v1/commands`) {
        throw new Error(`Unexpected transport URL: ${url}`);
      }
      if (typeof init.body !== "string") {
        throw new Error("Command body must be JSON text");
      }
      const command = JSON.parse(init.body) as {
        readonly type?: string;
        readonly requestId?: string;
        readonly sessionId?: SessionId;
      };
      if (typeof command.type !== "string" || typeof command.requestId !== "string") {
        throw new Error("Malformed command");
      }
      commandTypes.push(command.type);

      if (command.type === "START_CONFIGURED_SESSION") {
        return jsonResponse({
          protocolVersion: 1,
          requestId: command.requestId,
          ok: true,
          type: "CONFIGURED_SESSION_STARTED",
          sessionId,
          configuration
        });
      }
      if (command.type === "GET_INTERVIEW_SESSION_CONTEXT") {
        return jsonResponse({
          protocolVersion: 1,
          requestId: command.requestId,
          ok: true,
          type: "INTERVIEW_SESSION_CONTEXT",
          sessionId,
          configuration,
          configurationSource: "CONFIGURED"
        });
      }
      throw new Error(`Unexpected command type: ${command.type}`);
    };

    const rendered = renderHook(fetchImpl);
    await act(async () => {
      await rendered.current().startConfiguredSession(configuration, sessionId);
    });

    expect(rendered.current().sessionId).toBe(sessionId);
    expect(rendered.current().sessionStatus).toBe("ACTIVE");
    expect(rendered.current().configuration).toEqual(configuration);
    expect(rendered.current().configurationSource).toBe("CONFIGURED");
    expect(rendered.current().problem).toBeNull();
    expect(rendered.current().whiteboardSync.status).toBe("UNINITIALIZED");
    expect(rendered.current().isConnected).toBe(false);
    expect(rendererRequests).toBe(0);
    expect(commandTypes).toEqual([
      "START_CONFIGURED_SESSION",
      "GET_INTERVIEW_SESSION_CONTEXT"
    ]);
    await expect(rendered.current().submitTypedInput("must not enter Oxford turn flow"))
      .rejects.toThrow("Cannot submit input without an active session");

    act(() => rendered.current().pauseSession());
    expect(rendered.current().isPaused).toBe(true);
    await act(async () => {
      await rendered.current().resumePausedSession();
    });
    expect(rendered.current().isPaused).toBe(false);
    expect(rendererRequests).toBe(0);

    act(() => rendered.current().disconnect());
    await act(async () => rendered.root.unmount());
    rendered.container.remove();
  });

  it("keeps configured identity after a successful start when the context reread fails", async () => {
    const sessionId: SessionId = newSessionId();
    const configuration = InterviewSessionConfigurationSchema.parse({
      configurationVersion: 1,
      mode: "QUANT_RESEARCH",
      scenario: {
        id: "MODEL_COMPARISON",
        version: "1.0.0"
      },
      interventionPolicy: "BALANCED",
      providerSelection: {
        providerId: "mock-model",
        modelId: "mock-default"
      }
    });

    const fetchImpl: typeof fetch = async (input, init = {}) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      if (url === RENDERER_URL) {
        throw new Error("Quant launch must not attach the renderer");
      }
      if (url !== `${BASE_URL}/v1/commands` || typeof init.body !== "string") {
        throw new Error("Unexpected transport request");
      }
      const command = JSON.parse(init.body) as {
        readonly type?: string;
        readonly requestId?: string;
      };
      if (typeof command.requestId !== "string") throw new Error("Missing request ID");
      if (command.type === "START_CONFIGURED_SESSION") {
        return jsonResponse({
          protocolVersion: 1,
          requestId: command.requestId,
          ok: true,
          type: "CONFIGURED_SESSION_STARTED",
          sessionId,
          configuration
        });
      }
      if (command.type === "GET_INTERVIEW_SESSION_CONTEXT") {
        return jsonResponse({
          protocolVersion: 1,
          ok: false,
          error: {
            code: "INTERNAL_ERROR",
            message: "Context temporarily unavailable"
          }
        }, 500);
      }
      throw new Error(`Unexpected command type: ${String(command.type)}`);
    };

    const rendered = renderHook(fetchImpl);
    await act(async () => {
      await rendered.current().startConfiguredSession(configuration, sessionId);
    });

    expect(rendered.current().sessionId).toBe(sessionId);
    expect(rendered.current().configuration).toEqual(configuration);
    expect(rendered.current().configurationSource).toBe("CONFIGURED");
    expect(rendered.current().error).toContain(
      "authoritative session context could not be reloaded"
    );

    act(() => rendered.current().disconnect());
    await act(async () => rendered.root.unmount());
    rendered.container.remove();
  });
});
