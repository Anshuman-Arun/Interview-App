import path from "node:path";
import process from "node:process";
import { SqliteEventStore } from "../../../packages/persistence/src/index.js";
import { SessionRuntimeRegistry } from "../../../packages/interview-engine/src/index.js";
import type { LocalTransportSecurity } from "../../../packages/domain/src/index.js";
import { LocalInterviewTransportRuntime } from "./local-interview-transport-runtime.js";
import type { ProviderRuntimeResolver } from "./provider-runtime.js";
import type { VoiceRuntimeConfiguration } from "./voice-runtime.js";

const DEFAULT_COMMAND_PORT = 43123;
const DEFAULT_RENDERER_STREAM_PORT = 43124;
const DEFAULT_VOICE_PORT = 43125;
const DEFAULT_ALLOWED_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:3000", "http://127.0.0.1:3000"];

function generateSecureToken(): string {
  return globalThis.crypto.randomUUID().replace(/-/g, "") + globalThis.crypto.randomUUID().replace(/-/g, "");
}

export interface ServerConfig {
  readonly host?: "127.0.0.1" | "::1";
  readonly commandPort?: number;
  readonly rendererStreamPort?: number;
  readonly voicePort?: number;
  readonly voiceRuntime?: VoiceRuntimeConfiguration;
  readonly clientToken?: string;
  readonly allowedOrigins?: readonly string[];
  readonly databasePath?: string;
  readonly providerRuntimeResolver?: ProviderRuntimeResolver;
}

export async function createAndStartServer(config: ServerConfig = {}) {
  const host = config.host ?? "127.0.0.1";
  const commandPort = resolvePort(config.commandPort, process.env["COMMAND_PORT"], DEFAULT_COMMAND_PORT, "COMMAND_PORT");
  const rendererStreamPort = resolvePort(
    config.rendererStreamPort,
    process.env["RENDERER_STREAM_PORT"],
    DEFAULT_RENDERER_STREAM_PORT,
    "RENDERER_STREAM_PORT"
  );
  const voicePort = resolvePort(config.voicePort, process.env["VOICE_PORT"], DEFAULT_VOICE_PORT, "VOICE_PORT");
  const clientToken = config.clientToken ?? process.env["INTERVIEW_CLIENT_TOKEN"] ?? generateSecureToken();
  const rawOrigins = config.allowedOrigins ?? (process.env["CLIENT_ORIGIN"] ? [process.env["CLIENT_ORIGIN"], ...DEFAULT_ALLOWED_ORIGINS] : DEFAULT_ALLOWED_ORIGINS);
  const allowedOrigins = new Set(rawOrigins);
  const databasePath = config.databasePath ?? process.env["DATABASE_PATH"] ?? path.join(process.cwd(), "interview-session.sqlite");

  const security: LocalTransportSecurity = {
    host,
    clientToken,
    allowedOrigins
  };

  const store = new SqliteEventStore(databasePath);
  const registry = new SessionRuntimeRegistry(store);

  let runtime: LocalInterviewTransportRuntime | undefined;
  let bound: Awaited<ReturnType<LocalInterviewTransportRuntime["start"]>>;
  try {
    runtime = new LocalInterviewTransportRuntime({
      security,
      registry,
      store,
      commandPort,
      rendererStreamPort,
      voicePort,
      ...(config.voiceRuntime === undefined ? {} : { voiceRuntime: config.voiceRuntime }),
      ...(config.providerRuntimeResolver === undefined
        ? {}
        : { providerRuntimeResolver: config.providerRuntimeResolver })
    });
    bound = await runtime.start();
  } catch (error) {
    let cleanupFailure: unknown;
    if (runtime !== undefined) {
      try {
        await runtime.stop();
      } catch (cleanupError) {
        cleanupFailure = cleanupError;
      }
    }
    store.close();
    if (cleanupFailure !== undefined) {
      throw new AggregateError(
        [error, cleanupFailure],
        "Server startup failed and runtime cleanup also failed",
        { cause: error }
      );
    }
    throw error;
  }

  const startedRuntime = runtime;
  if (startedRuntime === undefined) {
    store.close();
    throw new Error("Server runtime was not constructed");
  }

  return {
    runtime: startedRuntime,
    store,
    registry,
    security,
    databasePath,
    bound,
    async stop() {
      await startedRuntime.stop();
      store.close();
    }
  };
}

async function main() {
  const instance = await createAndStartServer();
  console.log("--------------------------------------------------");
  console.log("  Technical Interview Runtime - Loopback Server");
  console.log("--------------------------------------------------");
  console.log(`  Host:                  ${instance.bound.command.host}`);
  console.log(`  Command Endpoint:      ${instance.bound.command.url}/v1/commands`);
  console.log(`  Renderer Stream:       ${instance.bound.rendererStream.streamUrl}`);
  console.log(`  Voice Transport:       ${instance.bound.voice.url}`);
  console.log(`  Voice Models:          ${configHasVoiceRuntime(instance.runtime) ? "injected runtime configured" : "not configured (transport fails closed)"}`);
  console.log(`  Allowed Origins:       ${String(instance.security.allowedOrigins.size)} configured`);
  console.log("  Database:              local SQLite");
  console.log("--------------------------------------------------");
  console.log("  Server is ready for authenticated client connections.");

  const handleShutdown = async (signal: string) => {
    console.log(`\nReceived ${signal}. Shutting down gracefully...`);
    try {
      await instance.stop();
      console.log("Server stopped successfully.");
      process.exit(0);
    } catch {
      console.error("Error during server shutdown.");
      process.exit(1);
    }
  };

  process.on("SIGINT", () => void handleShutdown("SIGINT"));
  process.on("SIGTERM", () => void handleShutdown("SIGTERM"));
}

if (process.argv[1] && (process.argv[1].endsWith("server.ts") || process.argv[1].endsWith("server.js"))) {
  void main().catch(() => {
    console.error("Fatal error starting interview server.");
    process.exit(1);
  });
}

function resolvePort(
  configured: number | undefined,
  environmentValue: string | undefined,
  fallback: number,
  label: string
): number {
  const value = configured ?? (
    environmentValue === undefined
      ? fallback
      : parseStrictPort(environmentValue, label)
  );
  if (!Number.isSafeInteger(value) || value < 0 || value > 65_535) {
    throw new Error(`${label} must be an integer between 0 and 65535`);
  }
  return value;
}

function parseStrictPort(value: string, label: string): number {
  if (!/^(?:0|[1-9][0-9]{0,4})$/u.test(value)) {
    throw new Error(`${label} must contain only a decimal port number`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new Error(`${label} must be an integer between 0 and 65535`);
  }
  return parsed;
}

function configHasVoiceRuntime(runtime: LocalInterviewTransportRuntime): boolean {
  return runtime.voiceInput !== undefined && runtime.voiceSynthesis !== undefined;
}
