import type { LocalTransportSecurity } from "../../../packages/domain/src/index.js";
import type { SessionRuntimeRegistry } from "../../../packages/interview-engine/src/index.js";
import type { SqliteEventStore } from "../../../packages/persistence/src/index.js";
import {
  LoopbackCommandServer,
  type BoundLoopbackAddress
} from "./loopback-command-server.js";
import {
  RendererStreamServer,
  type BoundRendererStreamAddress
} from "./renderer-stream-server.js";
import { SessionRecoveryCoordinator } from "./session-recovery-coordinator.js";
import { SessionReadService } from "./session-read-service.js";
import type { ProviderRuntimeResolver } from "./provider-runtime.js";
import { ServerTurnOrchestrator } from "./turn-orchestrator.js";

export interface LocalInterviewTransportRuntimeOptions {
  readonly security: LocalTransportSecurity;
  readonly registry: SessionRuntimeRegistry;
  readonly store?: SqliteEventStore;
  readonly commandPort?: number;
  readonly rendererStreamPort?: number;
  readonly maxRendererConnections?: number;
  readonly maxRendererConnectionsPerSession?: number;
  readonly maxRendererMessageBytes?: number;
  readonly orchestrator?: ServerTurnOrchestrator;
  readonly providerRuntimeResolver?: ProviderRuntimeResolver;
  readonly readService?: SessionReadService;
}

export interface BoundLocalInterviewTransport {
  readonly command: BoundLoopbackAddress;
  readonly rendererStream: BoundRendererStreamAddress;
}

/** Composition root for the two authenticated browser transports. */
export class LocalInterviewTransportRuntime {
  public readonly sessions: SessionRecoveryCoordinator;
  public readonly orchestrator: ServerTurnOrchestrator;
  public readonly readService: SessionReadService;
  public readonly commandServer: LoopbackCommandServer;
  public readonly rendererStreamServer: RendererStreamServer;
  private bound: BoundLocalInterviewTransport | undefined;
  private starting: Promise<BoundLocalInterviewTransport> | undefined;
  private stopping: Promise<void> | undefined;
  private stopFailure: unknown;
  private readonly registry: SessionRuntimeRegistry;

  public constructor(options: LocalInterviewTransportRuntimeOptions) {
    this.registry = options.registry;
    this.sessions = new SessionRecoveryCoordinator(options.registry, options.store);
    this.orchestrator =
      options.orchestrator ??
      new ServerTurnOrchestrator(
        this.sessions,
        () => this.rendererStreamServer,
        undefined,
        options.providerRuntimeResolver
      );
    this.sessions.setTurnRecoveryDelegate(this.orchestrator);
    this.readService = options.readService ?? new SessionReadService({
      source: {
        hasSession: (sessionId) =>
          options.store?.hasSession(sessionId) ?? options.registry.hasSession(sessionId),
        sessionCount: () =>
          options.store?.sessionCount() ?? options.registry.sessionCount(),
        listRecentSessionIds: (limit) =>
          options.store?.listRecentSessionIds(limit)
          ?? options.registry.listRecentSessionIds(limit),
        eventCount: (sessionId) =>
          options.store?.eventCount(sessionId)
          ?? options.registry.eventCount(sessionId),
        loadEvents: (sessionId) =>
          options.store?.load(sessionId) ?? options.registry.loadEvents(sessionId)
      }
    });
    this.commandServer = new LoopbackCommandServer({
      security: options.security,
      sessions: this.sessions,
      reads: this.readService,
      orchestrator: this.orchestrator,
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
    if (this.stopping !== undefined) {
      return this.stopping.then(async () => this.start());
    }
    if (this.stopFailure !== undefined) {
      return Promise.reject(new Error(
        "Local interview transport cannot restart after a failed shutdown until stop succeeds",
        { cause: this.stopFailure }
      ));
    }
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

  public stop(): Promise<void> {
    if (this.stopping !== undefined) return this.stopping;

    const stopping = this.stopFully();
    this.stopping = stopping;
    const clearStopping = (): void => {
      if (this.stopping === stopping) this.stopping = undefined;
    };
    void stopping.then(clearStopping, clearStopping);
    return stopping;
  }

  private async stopFully(): Promise<void> {
    const failures: unknown[] = [];
    const starting = this.starting;
    if (starting !== undefined) {
      try {
        await starting;
      } catch {
        // startBoth already rolls back a partially started command server.
      }
    }
    // Stop command admission first. Accepted commands may have detached
    // orchestration work that must finish while renderer transport and writers
    // are still available.
    try {
      await this.commandServer.stop();
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.orchestrator.waitForAll();
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.rendererStreamServer.stop();
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.registry.closeAll();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) {
      const failure = new AggregateError(failures, "Local interview transport shutdown failed");
      this.stopFailure = failure;
      throw failure;
    }
    this.bound = undefined;
    this.stopFailure = undefined;
  }

  private async startBoth(): Promise<BoundLocalInterviewTransport> {
    const command = await this.commandServer.start();
    try {
      const rendererStream = await this.rendererStreamServer.start();
      this.bound = { command, rendererStream };
      return this.bound;
    } catch (error) {
      try {
        await this.commandServer.stop();
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "Local interview transport startup failed and command-server rollback also failed",
          { cause: rollbackError }
        );
      }
      throw error;
    }
  }
}
