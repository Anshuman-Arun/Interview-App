import type { LocalTransportSecurity } from "../../../packages/domain/src/index.js";
import type { SessionRuntimeRegistry } from "../../../packages/interview-engine/src/index.js";
import {
  LoopbackCommandServer,
  type BoundLoopbackAddress
} from "./loopback-command-server.js";
import {
  RendererStreamServer,
  type BoundRendererStreamAddress
} from "./renderer-stream-server.js";
import { SessionRecoveryCoordinator } from "./session-recovery-coordinator.js";

export interface LocalInterviewTransportRuntimeOptions {
  readonly security: LocalTransportSecurity;
  readonly registry: SessionRuntimeRegistry;
  readonly commandPort?: number;
  readonly rendererStreamPort?: number;
  readonly maxRendererConnections?: number;
  readonly maxRendererConnectionsPerSession?: number;
  readonly maxRendererMessageBytes?: number;
}

export interface BoundLocalInterviewTransport {
  readonly command: BoundLoopbackAddress;
  readonly rendererStream: BoundRendererStreamAddress;
}

/** Composition root for the two authenticated browser transports. */
export class LocalInterviewTransportRuntime {
  public readonly sessions: SessionRecoveryCoordinator;
  public readonly commandServer: LoopbackCommandServer;
  public readonly rendererStreamServer: RendererStreamServer;
  private bound: BoundLocalInterviewTransport | undefined;
  private starting: Promise<BoundLocalInterviewTransport> | undefined;

  public constructor(options: LocalInterviewTransportRuntimeOptions) {
    this.sessions = new SessionRecoveryCoordinator(options.registry);
    this.commandServer = new LoopbackCommandServer({
      security: options.security,
      sessions: this.sessions,
      ...(options.commandPort === undefined ? {} : { port: options.commandPort })
    });
    this.rendererStreamServer = new RendererStreamServer({
      security: options.security,
      sessions: this.sessions,
      ...(options.rendererStreamPort === undefined ? {} : { port: options.rendererStreamPort }),
      ...(options.maxRendererConnections === undefined
        ? {}
        : { maxConnections: options.maxRendererConnections }),
      ...(options.maxRendererConnectionsPerSession === undefined
        ? {}
        : { maxConnectionsPerSession: options.maxRendererConnectionsPerSession }),
      ...(options.maxRendererMessageBytes === undefined
        ? {}
        : { maxMessageBytes: options.maxRendererMessageBytes })
    });
  }

  public start(): Promise<BoundLocalInterviewTransport> {
    if (this.bound !== undefined) return Promise.resolve(this.bound);
    if (this.starting !== undefined) return this.starting;
    const starting = this.startBoth();
    this.starting = starting;
    const clearStarting = (): void => {
      if (this.starting === starting) this.starting = undefined;
    };
    void starting.then(clearStarting, clearStarting);
    return starting;
  }

  public async stop(): Promise<void> {
    const failures: unknown[] = [];
    try {
      await this.rendererStreamServer.stop();
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.commandServer.stop();
    } catch (error) {
      failures.push(error);
    }
    this.bound = undefined;
    if (failures.length > 0) {
      throw new AggregateError(failures, "Local interview transport shutdown failed");
    }
  }

  private async startBoth(): Promise<BoundLocalInterviewTransport> {
    const command = await this.commandServer.start();
    try {
      const rendererStream = await this.rendererStreamServer.start();
      this.bound = { command, rendererStream };
      return this.bound;
    } catch (error) {
      await this.commandServer.stop();
      throw error;
    }
  }
}
