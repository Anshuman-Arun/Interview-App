import { createServer, type Server, type ServerResponse } from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { exactLoopbackOrigin } from "./bootstrap.js";

const HOST = "127.0.0.1";

export class DesktopFrontendServer {
  private server: Server | undefined;
  private starting: Promise<string> | undefined;
  private stopping: Promise<void> | undefined;
  private originValue: string | undefined;
  private connectOrigins: readonly string[] | undefined;
  private canonicalRoot: string | undefined;

  public constructor(private readonly rootDirectory: string) {}

  public start(): Promise<string> {
    if (this.stopping !== undefined) {
      return Promise.reject(new Error("Desktop frontend server is shutting down"));
    }
    if (this.originValue !== undefined) return Promise.resolve(this.originValue);
    if (this.starting !== undefined) return this.starting;
    const starting = this.startInternal();
    this.starting = starting;
    void starting.finally(() => {
      if (this.starting === starting) this.starting = undefined;
    }).catch(() => undefined);
    return starting;
  }

  public configureBackendOrigins(commandBaseUrl: string, rendererStreamUrl: string): void {
    const commandOrigin = exactLoopbackOrigin(commandBaseUrl);
    const streamOrigin = new URL(rendererStreamUrl).origin;
    exactLoopbackOrigin(streamOrigin);
    this.connectOrigins = [...new Set([commandOrigin, streamOrigin])];
  }

  public stop(): Promise<void> {
    if (this.stopping !== undefined) return this.stopping;
    const stopping = this.stopCurrent();
    this.stopping = stopping;
    void stopping.finally(() => {
      if (this.stopping === stopping) this.stopping = undefined;
    }).catch(() => undefined);
    return stopping;
  }

  private async stopCurrent(): Promise<void> {
    if (this.starting !== undefined) {
      try {
        await this.starting;
      } catch {
        return;
      }
    }
    const server = this.server;
    if (server === undefined) return;
    if (!server.listening) {
      if (this.server === server) {
        this.server = undefined;
        this.originValue = undefined;
        this.canonicalRoot = undefined;
      }
      return;
    }

    await new Promise<void>((resolve, reject) => {
      server.close((error) => error === undefined ? resolve() : reject(error));
    });
    if (this.server === server) {
      this.server = undefined;
      this.originValue = undefined;
      this.canonicalRoot = undefined;
    }
  }

  private async startInternal(): Promise<string> {
    const root = await realpath(this.rootDirectory);
    const indexPath = await realpath(path.join(root, "index.html"));
    if (!isPathWithin(root, indexPath)) {
      throw new Error("Built frontend index.html escapes the frontend root");
    }
    const indexStats = await stat(indexPath);
    if (!indexStats.isFile()) throw new Error("Built frontend index.html is unavailable");
    this.canonicalRoot = root;

    const server = createServer((request, response) => {
      void this.handleRequest(request.method ?? "GET", request.url ?? "/", response);
    });
    this.server = server;

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => reject(error);
        server.once("error", onError);
        server.listen({ host: HOST, port: 0, exclusive: true }, () => {
          server.off("error", onError);
          resolve();
        });
      });
    } catch (error) {
      if (server.listening) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      if (this.server === server) this.server = undefined;
      this.originValue = undefined;
      this.canonicalRoot = undefined;
      throw error;
    }

    const address = server.address();
    if (address === null || typeof address === "string") {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      this.server = undefined;
      this.originValue = undefined;
      this.canonicalRoot = undefined;
      throw new Error("Desktop frontend server has no TCP address");
    }
    this.originValue = toOrigin(address);
    return this.originValue;
  }

  private async handleRequest(
    method: string,
    requestUrl: string,
    response: ServerResponse
  ): Promise<void> {
    if (method !== "GET" && method !== "HEAD") {
      response.writeHead(405, this.securityHeaders());
      response.end();
      return;
    }
    if (this.connectOrigins === undefined) {
      response.writeHead(503, this.securityHeaders());
      response.end();
      return;
    }

    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(requestUrl, "http://desktop.invalid").pathname);
    } catch {
      response.writeHead(400, this.securityHeaders());
      response.end();
      return;
    }

    const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const root = this.canonicalRoot;
    if (root === undefined) {
      response.writeHead(503, this.securityHeaders());
      response.end();
      return;
    }

    let target = path.resolve(root, relative);
    if (!isPathWithin(root, target)) {
      response.writeHead(404, this.securityHeaders());
      response.end();
      return;
    }

    try {
      const targetStats = await stat(target);
      if (!targetStats.isFile()) throw new Error("not-file");
      target = await realpath(target);
      if (!isPathWithin(root, target)) {
        response.writeHead(404, this.securityHeaders());
        response.end();
        return;
      }
    } catch {
      if (path.extname(relative).length === 0) {
        try {
          target = await realpath(path.join(root, "index.html"));
        } catch {
          response.writeHead(404, this.securityHeaders());
          response.end();
          return;
        }
        if (!isPathWithin(root, target)) {
          response.writeHead(404, this.securityHeaders());
          response.end();
          return;
        }
      } else {
        response.writeHead(404, this.securityHeaders());
        response.end();
        return;
      }
    }

    try {
      const body = await readFile(target);
      response.writeHead(200, {
        ...this.securityHeaders(),
        "content-type": contentTypeFor(target),
        "content-length": String(body.byteLength),
        "cache-control": path.basename(target) === "index.html"
          ? "no-store"
          : "public, max-age=31536000, immutable"
      });
      if (method === "HEAD") response.end();
      else response.end(body);
    } catch {
      response.writeHead(404, this.securityHeaders());
      response.end();
    }
  }

  private securityHeaders(): Record<string, string> {
    const connectSrc = this.connectOrigins === undefined
      ? "'self'"
      : ["'self'", ...this.connectOrigins].join(" ");
    return {
      "content-security-policy":
        "default-src 'self'; "
        + "script-src 'self'; "
        + "style-src 'self' 'unsafe-inline'; "
        + "img-src 'self' data: blob:; "
        + "font-src 'self' data:; "
        + `connect-src ${connectSrc}; `
        + "media-src 'self' blob:; "
        + "object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "cross-origin-opener-policy": "same-origin"
    };
  }
}

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === ""
    || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function toOrigin(address: AddressInfo): string {
  return `http://${HOST}:${String(address.port)}`;
}

function contentTypeFor(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".html": return "text/html; charset=utf-8";
    case ".js": return "text/javascript; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".json": return "application/json; charset=utf-8";
    case ".svg": return "image/svg+xml";
    case ".png": return "image/png";
    case ".woff": return "font/woff";
    case ".woff2": return "font/woff2";
    default: return "application/octet-stream";
  }
}
