import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { afterEach, describe, expect, it } from "vitest";
import {
  newSessionId,
  type SessionId
} from "../packages/domain/src/index.js";
import {
  TurnCoordinator,
  createCommandEnvelope
} from "../packages/interview-engine/src/index.js";
import { sixPeopleProblem } from "../packages/problems/src/index.js";
import { BrowserCommandClient } from "../apps/web/src/command-client.js";
import { BrowserSessionReadClient } from "../apps/web/src/session-read-client.js";
import { SessionReviewModal } from "../apps/web/src/components/SessionReviewModal.js";
import { createAndStartServer } from "../apps/server/src/server.js";

const TOKEN = "grounded_product_flow_e2e_token_000000000000001";
const ORIGIN = "http://127.0.0.1:5173";

const testWindow = new Window({ url: ORIGIN });
Object.defineProperties(globalThis, {
  window: { configurable: true, value: testWindow },
  self: { configurable: true, value: testWindow },
  document: { configurable: true, value: testWindow.document },
  navigator: { configurable: true, value: testWindow.navigator },
  Element: { configurable: true, value: testWindow.Element },
  HTMLElement: { configurable: true, value: testWindow.HTMLElement },
  HTMLButtonElement: { configurable: true, value: testWindow.HTMLButtonElement },
  Node: { configurable: true, value: testWindow.Node },
  Event: { configurable: true, value: testWindow.Event },
  MouseEvent: { configurable: true, value: testWindow.MouseEvent },
  MutationObserver: { configurable: true, value: testWindow.MutationObserver }
});
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

function authenticatedFetch(): typeof fetch {
  return async (input, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set("Origin", ORIGIN);
    return fetch(input, { ...init, headers });
  };
}

async function waitForSelector(selector: string): Promise<Element> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const found = document.querySelector(selector);
    if (found !== null) return found;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  throw new Error(`Timed out waiting for ${selector}`);
}

function findButton(label: string): HTMLButtonElement {
  const button = [...document.querySelectorAll("button")].find(
    (candidate) => candidate.textContent.trim() === label
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Expected button ${label}`);
  }
  return button;
}

describe("post-session product flow E2E", () => {
  let server: Awaited<ReturnType<typeof createAndStartServer>> | undefined;
  let root: Root | undefined;

  afterEach(async () => {
    if (root !== undefined) {
      await act(async () => root?.unmount());
      root = undefined;
    }
    document.body.innerHTML = "";
    if (server !== undefined) {
      await server.stop();
      server = undefined;
    }
  });

  it("completes, opens grounded evaluation, inspects unsupported dimensions, reopens replay, and never redelivers", async () => {
    server = await createAndStartServer({
      host: "127.0.0.1",
      commandPort: 0,
      rendererStreamPort: 0,
      clientToken: TOKEN,
      allowedOrigins: [ORIGIN],
      databasePath: ":memory:"
    });

    const fetchImpl = authenticatedFetch();
    const commands = new BrowserCommandClient({
      baseUrl: server.bound.command.url,
      clientToken: TOKEN,
      fetchImpl
    });
    const reads = new BrowserSessionReadClient({
      baseUrl: server.bound.command.url,
      clientToken: TOKEN,
      fetchImpl
    });

    const sessionId: SessionId = newSessionId();
    await commands.startSession(sessionId);

    const writer = server.registry.get(sessionId);
    const turns = new TurnCoordinator(writer);
    await turns.commitInput(
      "The claim is correct because the same-colour neighborhood forces the required triangle."
    );
    const supportEventId = writer.getState().eventIds.at(-1);
    if (supportEventId === undefined) throw new Error("Expected turn provenance");

    for (const [dimension, proposedValue] of [
      ["CORRECTNESS", "CORRECT"],
      ["JUSTIFICATION", "JUSTIFIED"]
    ] as const) {
      const admitted = await turns.processEvidenceProposal({
        envelope: createCommandEnvelope({
          sessionId,
          producer: "product-flow-e2e"
        }),
        proposal: {
          key: {
            problemId: sixPeopleProblem.id,
            subject: { kind: "CLAIM", claimId: "product-flow-claim" },
            dimension
          },
          proposedValue,
          inferenceConfidence: 0.95,
          evidenceEventIds: [supportEventId]
        }
      });
      expect(admitted.committed).toBe(true);
    }

    await commands.completeSession(sessionId);
    const authoritativeEventCount = server.store.eventCount(sessionId);
    let evaluationReadCount = 0;
    let replayReadCount = 0;
    const readEvaluation = (id: SessionId, signal?: AbortSignal) => {
      evaluationReadCount += 1;
      return reads.getEvaluation(id, signal);
    };
    const readReplay = (id: SessionId, signal?: AbortSignal) => {
      replayReadCount += 1;
      return reads.getReplay(id, signal);
    };

    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);

    await act(async () => {
      root?.render(
        React.createElement(SessionReviewModal, {
          sessionId,
          initialTab: "evaluation",
          readEvaluation,
          readReplay,
          onClose: () => undefined
        })
      );
    });

    await waitForSelector("[data-testid='grounded-evaluation-panel']");
    const correctness = await waitForSelector(
      "[data-testid='evaluation-dimension-technicalCorrectness']"
    );
    const communication = await waitForSelector(
      "[data-testid='evaluation-dimension-communication']"
    );

    expect(correctness.textContent).toContain("Technical Correctness");
    expect(correctness.textContent).toContain("100");
    expect(communication.textContent).toContain("Communication");
    expect(communication.textContent).toContain("Not scored");
    expect(communication.textContent).toContain(
      "Current application-owned evidence does not contain a validated communication-quality signal."
    );
    expect(evaluationReadCount).toBe(1);
    expect(replayReadCount).toBe(0);
    expect(server.store.eventCount(sessionId)).toBe(authoritativeEventCount);

    await act(async () => {
      findButton("Replay timeline").dispatchEvent(
        new MouseEvent("click", { bubbles: true })
      );
    });
    await waitForSelector("[data-testid='session-replay-panel']");
    expect(document.body.textContent).toContain("authoritative events");
    expect(document.body.textContent).toContain("Turn committed");
    expect(evaluationReadCount).toBe(1);
    expect(replayReadCount).toBe(1);
    expect(server.store.eventCount(sessionId)).toBe(authoritativeEventCount);

    await act(async () => root?.unmount());
    root = undefined;
    document.body.innerHTML = "";

    const reopenedHost = document.createElement("div");
    document.body.append(reopenedHost);
    root = createRoot(reopenedHost);
    await act(async () => {
      root?.render(
        React.createElement(SessionReviewModal, {
          sessionId,
          initialTab: "replay",
          readEvaluation,
          readReplay,
          onClose: () => undefined
        })
      );
    });

    await waitForSelector("[data-testid='session-replay-panel']");
    expect(document.body.textContent).toContain("Turn committed");
    expect(evaluationReadCount).toBe(1);
    expect(replayReadCount).toBe(2);
    expect(server.store.eventCount(sessionId)).toBe(authoritativeEventCount);

    const history = await reads.getHistory();
    const historical = history.sessions.find((item) => item.sessionId === sessionId);
    expect(historical?.status).toBe("COMPLETED");
    expect(historical?.readStatus).toBe("AVAILABLE");
    expect(server.store.eventCount(sessionId)).toBe(authoritativeEventCount);
  });
});
