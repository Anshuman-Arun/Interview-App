// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  newSessionId,
  type SessionId
} from "../packages/domain/src/index.js";
import {
  useInterviewSession,
  type UseInterviewSessionResult
} from "../apps/web/src/hooks/useInterviewSession.js";
import {
  InMemoryTldrawEditor,
  TldrawWhiteboardAdapter
} from "../apps/web/src/tldraw-whiteboard-adapter.js";

const BASE_URL = "http://127.0.0.1:43123";
const RENDERER_URL = "http://127.0.0.1:43124/v1/renderer-stream";
const VOICE_URL = "http://127.0.0.1:43125";
const CLIENT_TOKEN = "session-transition-test-token-0123456789abcdef";

interface DeferredStart {
  readonly seen: Promise<void>;
  release(): void;
}

function createDeferredStart(
  sessionId: SessionId,
  state: {
    readonly resolvers: Map<SessionId, () => void>;
    readonly seenResolvers: Map<SessionId, () => void>;
  }
): DeferredStart {
  let resolveSeen: (() => void) | undefined;
  const seen = new Promise<void>((resolve) => {
    resolveSeen = resolve;
  });
  state.seenResolvers.set(sessionId, resolveSeen as () => void);
  return {
    seen,
    release: () => {
      const resolve = state.resolvers.get(sessionId);
      if (resolve === undefined) throw new Error("Deferred START_SESSION request was not observed");
      resolve();
    }
  };
}

function makeFetchHarness(deferredSessions: readonly SessionId[]) {
  const deferred = new Set<SessionId>(deferredSessions);
  const resolvers = new Map<SessionId, () => void>();
  const seenResolvers = new Map<SessionId, () => void>();

  const fetchImpl: typeof fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === RENDERER_URL) {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init.signal;
        const abort = (): void => {
          const error = new Error("renderer stream aborted");
          error.name = "AbortError";
          reject(error);
        };
        if (signal?.aborted === true) {
          abort();
          return;
        }
        signal?.addEventListener("abort", abort, { once: true });
      });
    }

    if (url !== `${BASE_URL}/v1/commands`) {
      throw new Error(`Unexpected transport URL: ${url}`);
    }
    if (typeof init.body !== "string") throw new Error("Command body must be JSON text");
    const command = JSON.parse(init.body) as {
      readonly type?: string;
      readonly requestId?: string;
      readonly sessionId?: SessionId;
    };
    if (typeof command.requestId !== "string") throw new Error("Command requestId is missing");

    if (command.type === "START_SESSION") {
      if (command.sessionId === undefined) throw new Error("START_SESSION is missing sessionId");
      if (deferred.has(command.sessionId)) {
        seenResolvers.get(command.sessionId)?.();
        return new Promise<Response>((resolve) => {
          resolvers.set(command.sessionId as SessionId, () => {
            resolve(jsonResponse({
              protocolVersion: 1,
              requestId: command.requestId,
              ok: true,
              type: "SESSION_STARTED",
              sessionId: command.sessionId
            }));
          });
        });
      }
      return jsonResponse({
        protocolVersion: 1,
        requestId: command.requestId,
        ok: true,
        type: "SESSION_STARTED",
        sessionId: command.sessionId
      });
    }

    if (command.type === "GET_INTERVIEW_SESSION_CONTEXT") {
      return jsonResponse({
        protocolVersion: 1,
        ok: false,
        error: {
          code: "INTERNAL_ERROR",
          message: "Context intentionally unavailable in transition test"
        }
      }, 500);
    }

    throw new Error(`Unexpected command type: ${String(command.type)}`);
  };

  return {
    fetchImpl,
    deferredState: { resolvers, seenResolvers }
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function renderHook(
  fetchImpl: typeof fetch,
  whiteboardAdapter?: TldrawWhiteboardAdapter
): {
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
      fetchImpl,
      ...(whiteboardAdapter === undefined ? {} : { whiteboardAdapter })
    });
    return <div>{current.sessionId ?? "none"}</div>;
  }

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<Probe />);
  });
  return {
    root,
    container,
    current: () => {
      if (current === undefined) throw new Error("Hook did not render");
      return current;
    }
  };
}

const ACT_ENVIRONMENT_KEY = "IS_REACT_ACT_ENVIRONMENT";
const hadActEnvironment = Object.prototype.hasOwnProperty.call(globalThis, ACT_ENVIRONMENT_KEY);
const previousActEnvironment: unknown = Reflect.get(globalThis, ACT_ENVIRONMENT_KEY);

describe("interview session transition authority", () => {
  beforeEach(() => {
    Reflect.set(globalThis, ACT_ENVIRONMENT_KEY, true);
  });

  afterEach(() => {
    if (hadActEnvironment) Reflect.set(globalThis, ACT_ENVIRONMENT_KEY, previousActEnvironment);
    else Reflect.deleteProperty(globalThis, ACT_ENVIRONMENT_KEY);
    vi.restoreAllMocks();
  });

  it("does not let a slower earlier session start replace the newer session", async () => {
    const firstSession = newSessionId();
    const secondSession = newSessionId();
    const harness = makeFetchHarness([firstSession]);
    const first = createDeferredStart(firstSession, harness.deferredState);
    const rendered = renderHook(harness.fetchImpl);

    let firstStart: Promise<void> | undefined;
    await act(async () => {
      firstStart = rendered.current().startSession(firstSession);
      await first.seen;
    });

    await act(async () => {
      await rendered.current().startSession(secondSession);
    });
    expect(rendered.current().sessionId).toBe(secondSession);

    first.release();
    await act(async () => {
      await firstStart;
    });
    expect(rendered.current().sessionId).toBe(secondSession);

    act(() => rendered.current().disconnect());
    await act(async () => {
      rendered.root.unmount();
    });
    rendered.container.remove();
  });

  it("ignores a stale whiteboard synchronization that finishes after session replacement", async () => {
    const firstSession = newSessionId();
    const secondSession = newSessionId();
    let releaseFirstBoardState: (() => void) | undefined;
    let markFirstBoardStateSeen: (() => void) | undefined;
    const firstBoardStateSeen = new Promise<void>((resolve) => {
      markFirstBoardStateSeen = resolve;
    });

    const fetchImpl: typeof fetch = async (input, init = {}) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      if (url === RENDERER_URL) {
        return new Promise<Response>((_resolve, reject) => {
          const signal = init.signal;
          const abort = (): void => {
            const error = new Error("renderer stream aborted");
            error.name = "AbortError";
            reject(error);
          };
          if (signal?.aborted === true) {
            abort();
            return;
          }
          signal?.addEventListener("abort", abort, { once: true });
        });
      }
      if (url !== `${BASE_URL}/v1/commands`) {
        throw new Error(`Unexpected transport URL: ${url}`);
      }
      if (typeof init.body !== "string") throw new Error("Command body must be JSON text");
      const command = JSON.parse(init.body) as {
        readonly type?: string;
        readonly requestId?: string;
        readonly sessionId?: SessionId;
      };
      if (typeof command.requestId !== "string") throw new Error("Command requestId is missing");

      if (command.type === "START_SESSION") {
        return jsonResponse({
          protocolVersion: 1,
          requestId: command.requestId,
          ok: true,
          type: "SESSION_STARTED",
          sessionId: command.sessionId
        });
      }
      if (command.type === "GET_INTERVIEW_SESSION_CONTEXT") {
        return jsonResponse({
          protocolVersion: 1,
          ok: false,
          error: {
            code: "INTERNAL_ERROR",
            message: "Context intentionally unavailable in transition test"
          }
        }, 500);
      }
      if (command.type === "GET_BOARD_STATE") {
        if (command.sessionId === firstSession) {
          markFirstBoardStateSeen?.();
          return new Promise<Response>((resolve) => {
            releaseFirstBoardState = () => resolve(jsonResponse({
              protocolVersion: 1,
              requestId: command.requestId,
              ok: true,
              type: "BOARD_STATE",
              sessionId: firstSession,
              boardRevision: 1,
              shapeAuthorityKnown: true,
              shapeRevisions: []
            }));
          });
        }
        if (command.sessionId === secondSession) {
          return jsonResponse({
            protocolVersion: 1,
            requestId: command.requestId,
            ok: true,
            type: "BOARD_STATE",
            sessionId: secondSession,
            boardRevision: 2,
            shapeAuthorityKnown: true,
            shapeRevisions: []
          });
        }
      }
      throw new Error(`Unexpected command type: ${String(command.type)}`);
    };

    const adapter = new TldrawWhiteboardAdapter(new InMemoryTldrawEditor());
    const rendered = renderHook(fetchImpl, adapter);
    let firstStart: Promise<void> | undefined;

    await act(async () => {
      firstStart = rendered.current().startSession(firstSession);
      await firstBoardStateSeen;
    });

    await act(async () => {
      await rendered.current().startSession(secondSession);
    });
    expect(rendered.current().sessionId).toBe(secondSession);
    expect(rendered.current().whiteboardSync).toMatchObject({
      status: "SYNCED",
      authoritativeRevision: 2
    });

    if (releaseFirstBoardState === undefined) {
      throw new Error("First board-state request was not deferred");
    }
    releaseFirstBoardState();
    await act(async () => {
      await firstStart;
    });

    expect(rendered.current().sessionId).toBe(secondSession);
    expect(rendered.current().whiteboardSync).toMatchObject({
      status: "SYNCED",
      authoritativeRevision: 2
    });

    act(() => rendered.current().disconnect());
    await act(async () => {
      rendered.root.unmount();
    });
    rendered.container.remove();
  });

  it("disconnect invalidates an in-flight start before it can reattach transport", async () => {
    const sessionId = newSessionId();
    const harness = makeFetchHarness([sessionId]);
    const pending = createDeferredStart(sessionId, harness.deferredState);
    const rendered = renderHook(harness.fetchImpl);

    let start: Promise<void> | undefined;
    await act(async () => {
      start = rendered.current().startSession(sessionId);
      await pending.seen;
    });

    act(() => rendered.current().disconnect());
    pending.release();
    await act(async () => {
      await start;
    });

    expect(rendered.current().sessionId).toBeNull();
    expect(rendered.current().isStreaming).toBe(false);
    expect(rendered.current().isConnected).toBe(false);

    await act(async () => {
      rendered.root.unmount();
    });
    rendered.container.remove();
  });
});
