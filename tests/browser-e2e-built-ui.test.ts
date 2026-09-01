import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  newSessionId,
  type DeliveryId,
  type SessionId
} from "../packages/domain/src/index.js";
import { BrowserCommandClient } from "../apps/web/src/command-client.js";
import {
  RendererClient,
  type TextPresenter
} from "../apps/web/src/renderer-client.js";
import {
  consumeAuthenticatedRendererStream,
  createLoopbackAcknowledgementSender
} from "../apps/web/src/renderer-stream.js";
import { createAndStartServer } from "../apps/server/src/server.js";

const TEST_CLIENT_TOKEN = "e2e_browser_test_token_min_32_chars_long_001";

describe("Real Built UI & Loopback Server E2E Verification", () => {
  let serverInstance: Awaited<ReturnType<typeof createAndStartServer>> | undefined;
  let webServer: http.Server | undefined;
  let webPort = 0;
  let tempDir = "";

  afterEach(async () => {
    if (serverInstance !== undefined) {
      await serverInstance.stop();
      serverInstance = undefined;
    }
    if (webServer !== undefined) {
      const server = webServer;
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      webServer = undefined;
    }
    if (tempDir !== "" && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = "";
    }
  });

  it("serves built production UI, enforces zero CDN links, and completes authenticated turn over loopback transport", async () => {
    const distDir = path.resolve(process.cwd(), "dist/apps/web");
    expect(fs.existsSync(distDir)).toBe(true);

    const indexHtmlPath = path.join(distDir, "index.html");
    expect(fs.existsSync(indexHtmlPath)).toBe(true);
    const indexHtml = fs.readFileSync(indexHtmlPath, "utf8");

    // 1. Prove no external CDN links exist in the built HTML
    expect(indexHtml).not.toContain("jsdelivr.net");
    expect(indexHtml).not.toContain("cdnjs.cloudflare.com");
    expect(indexHtml).not.toContain("unpkg.com");
    expect(indexHtml).not.toContain("googleapis.com");
    expect(indexHtml).not.toContain("DEFAULT_CLIENT_TOKEN");
    expect(indexHtml).not.toContain(TEST_CLIENT_TOKEN);

    // 2. Start a static web server serving the production build
    webServer = http.createServer((req, res) => {
      const reqUrl = req.url === "/" ? "/index.html" : (req.url ?? "/index.html");
      const urlPart = reqUrl.split("?")[0] ?? "/index.html";
      const filePath = path.join(distDir, urlPart);
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = path.extname(filePath);
        const contentType =
          ext === ".html"
            ? "text/html"
            : ext === ".js"
              ? "application/javascript"
              : ext === ".css"
                ? "text/css"
                : "application/octet-stream";
        res.writeHead(200, { "Content-Type": contentType });
        res.end(fs.readFileSync(filePath));
      } else {
        res.writeHead(404);
        res.end("Not found");
      }
    });

    const staticServer = webServer;
    await new Promise<void>((resolve) => {
      staticServer.listen(0, "127.0.0.1", () => {
        const addr = staticServer.address();
        if (typeof addr === "object" && addr !== null) {
          webPort = addr.port;
        }
        resolve();
      });
    });

    const webOrigin = `http://127.0.0.1:${String(webPort)}`;

    // Verify index.html is served successfully
    const htmlResponse = await fetch(`${webOrigin}/index.html`);
    expect(htmlResponse.status).toBe(200);
    const servedHtml = await htmlResponse.text();
    expect(servedHtml).toContain("Technical Interview Runtime");

    // 3. Start file-backed loopback server
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "interview-e2e-sqlite-"));
    const dbFile = path.join(tempDir, "interview.sqlite");

    serverInstance = await createAndStartServer({
      host: "127.0.0.1",
      commandPort: 0,
      rendererStreamPort: 0,
      clientToken: TEST_CLIENT_TOKEN,
      allowedOrigins: [webOrigin],
      databasePath: dbFile
    });

    const commandUrl = serverInstance.bound.command.url;
    const streamUrl = serverInstance.bound.rendererStream.streamUrl;

    // Track network requests to prove zero external provider calls
    const externalCalls: string[] = [];
    const monitoredFetch: typeof fetch = async (input, init = {}) => {
      const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (!urlStr.startsWith("http://127.0.0.1:") && !urlStr.startsWith("http://localhost:")) {
        externalCalls.push(urlStr);
      }
      const headers = new Headers(init.headers);
      headers.set("Origin", webOrigin);
      headers.set("x-interview-client-token", TEST_CLIENT_TOKEN);
      return fetch(input, { ...init, headers });
    };

    const commandClient = new BrowserCommandClient({
      baseUrl: commandUrl,
      clientToken: TEST_CLIENT_TOKEN,
      fetchImpl: monitoredFetch
    });

    const sessionId: SessionId = newSessionId();

    // 4. Start Session
    const startResult = await commandClient.startSession(sessionId);
    expect(startResult.ok).toBe(true);
    expect(startResult.sessionId).toBe(sessionId);

    // 5. Connect SSE stream
    const presentedTexts: Array<{ text: string; deliveryId: DeliveryId }> = [];
    const textPresenter: TextPresenter = {
      presentText: (text, deliveryId) => {
        presentedTexts.push({ text, deliveryId });
      }
    };

    const ackSender = createLoopbackAcknowledgementSender({
      commandUrl: `${commandUrl}/v1/commands`,
      authenticatedFetch: monitoredFetch
    });

    const rendererClient = new RendererClient({
      sessionId,
      acknowledgementSender: ackSender,
      textPresenter,
      audioPlayer: {
        playAudio: async ({ callbacks }) => {
          await callbacks.onStarted();
          await callbacks.onCompleted();
        }
      }
    });

    const streamAbortController = new AbortController();
    const streamPromise = consumeAuthenticatedRendererStream(
      {
        streamUrl,
        sessionId,
        authenticatedFetch: monitoredFetch,
        signal: streamAbortController.signal
      },
      rendererClient
    );

    await new Promise((resolve) => setTimeout(resolve, 50));

    // 6. Commit typed reasoning
    const studentInput = "Let the six people be vertices of K_6. Pick vertex A with 5 incident edges. By the Pigeonhole Principle, at least three must have the same color, say red.";
    const inputResult = await commandClient.commitTypedInput(sessionId, studentInput);
    expect(inputResult.ok).toBe(true);

    // 7. Wait for Socratic response over SSE
    const startTime = Date.now();
    while (presentedTexts.length === 0 && Date.now() - startTime < 3000) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    expect(presentedTexts.length).toBeGreaterThanOrEqual(1);
    const delivered = presentedTexts[0];
    expect(delivered).toBeDefined();
    if (delivered === undefined) throw new Error("Expected delivered text");
    expect(delivered.text).toContain("vertex A");

    // Allow ACKs to complete
    await new Promise((resolve) => setTimeout(resolve, 100));

    const summary = await commandClient.getSessionSummary(sessionId);
    expect(summary.deliveryStatuses[delivered.deliveryId]).toBe("COMPLETED");

    streamAbortController.abort();
    await streamPromise.catch(() => undefined);

    // 8. Prove zero calls were made to external provider endpoints
    expect(externalCalls).toEqual([]);

    // 9. Server process restart & recovery
    await serverInstance.stop();
    serverInstance = undefined;

    const restartedServer = await createAndStartServer({
      host: "127.0.0.1",
      commandPort: 0,
      rendererStreamPort: 0,
      clientToken: TEST_CLIENT_TOKEN,
      allowedOrigins: [webOrigin],
      databasePath: dbFile
    });

    const restartedClient = new BrowserCommandClient({
      baseUrl: restartedServer.bound.command.url,
      clientToken: TEST_CLIENT_TOKEN,
      fetchImpl: monitoredFetch
    });

    const recoveredSummary = await restartedClient.getSessionSummary(sessionId);
    expect(recoveredSummary.started).toBe(true);
    expect(recoveredSummary.sequence).toBe(summary.sequence);
    expect(recoveredSummary.deliveryStatuses[delivered.deliveryId]).toBe("COMPLETED");

    await restartedServer.stop();
  });
});
