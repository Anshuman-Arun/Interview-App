import process from "node:process";
import { SqliteEventStore } from "../../../packages/persistence/src/index.js";
import { SessionRuntimeRegistry } from "../../../packages/interview-engine/src/index.js";
import type { LocalTransportSecurity } from "../../../packages/domain/src/index.js";
import { LocalInterviewTransportRuntime } from "./local-interview-transport-runtime.js";

const DEFAULT_COMMAND_PORT = 43123;
const DEFAULT_RENDERER_STREAM_PORT = 43124;
const DEFAULT_ALLOWED_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:3000", "http://127.0.0.1:3000"];

function generateSecureToken(): string {
  return globalThis.crypto.randomUUID().replace(/-/g, "") + globalThis.crypto.randomUUID().replace(/-/g, "");
}

export interface ServerConfig {
  readonly host?: "127.0.0.1" | "::1";
  readonly commandPort?: number;
  readonly rendererStreamPort?: number;
  readonly clientToken?: string;
  readonly allowedOrigins?: readonly string[];
  readonly databasePath?: string;
}

export async function createAndStartServer(config: ServerConfig = {}) {
  const host = config.host ?? "127.0.0.1";
  const commandPort = config.commandPort ?? (process.env["COMMAND_PORT"] ? parseInt(process.env["COMMAND_PORT"], 10) : DEFAULT_COMMAND_PORT);
  const rendererStreamPort = config.rendererStreamPort ?? (process.env["RENDERER_STREAM_PORT"] ? parseInt(process.env["RENDERER_STREAM_PORT"], 10) : DEFAULT_RENDERER_STREAM_PORT);
  const clientToken = config.clientToken ?? process.env["INTERVIEW_CLIENT_TOKEN"] ?? generateSecureToken();
  const rawOrigins = config.allowedOrigins ?? (process.env["CLIENT_ORIGIN"] ? [process.env["CLIENT_ORIGIN"], ...DEFAULT_ALLOWED_ORIGINS] : DEFAULT_ALLOWED_ORIGINS);
  const allowedOrigins = new Set(rawOrigins);
  const databasePath = config.databasePath ?? process.env["DATABASE_PATH"] ?? ":memory:";

  const security: LocalTransportSecurity = {
    host,
    clientToken,
    allowedOrigins
  };

  const store = new SqliteEventStore(databasePath);
  const registry = new SessionRuntimeRegistry(store);

  const runtime = new LocalInterviewTransportRuntime({
    security,
    registry,
    commandPort,
    rendererStreamPort
  });

  const bound = await runtime.start();

  return {
    runtime,
    store,
    registry,
    security,
    bound,
    async stop() {
      await runtime.stop();
      store.close();
    }
  };
}

async function main() {
  const instance = await createAndStartServer();
  console.log("--------------------------------------------------");
  console.log("  Oxford Technical Interview App - Loopback Server");
  console.log("--------------------------------------------------");
  console.log(`  Host:                  ${instance.bound.command.host}`);
  console.log(`  Command Endpoint:      ${instance.bound.command.url}/v1/commands`);
  console.log(`  Renderer Stream:       ${instance.bound.rendererStream.streamUrl}`);
  console.log(`  Allowed Origins:       ${[...instance.security.allowedOrigins].join(", ")}`);
  console.log(`  Web Launch URL:        http://localhost:5173/?token=${instance.security.clientToken}`);
  console.log("--------------------------------------------------");
  console.log("  Server is ready for authenticated browser connections.");

  const handleShutdown = async (signal: string) => {
    console.log(`\nReceived ${signal}. Shutting down gracefully...`);
    try {
      await instance.stop();
      console.log("Server stopped successfully.");
      process.exit(0);
    } catch (err) {
      console.error("Error during server shutdown:", err);
      process.exit(1);
    }
  };

  process.on("SIGINT", () => void handleShutdown("SIGINT"));
  process.on("SIGTERM", () => void handleShutdown("SIGTERM"));
}

if (process.argv[1] && (process.argv[1].endsWith("server.ts") || process.argv[1].endsWith("server.js"))) {
  void main().catch((err: unknown) => {
    console.error("Fatal error starting interview server:", err);
    process.exit(1);
  });
}
