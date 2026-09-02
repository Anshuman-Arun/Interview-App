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
import { ServerTurnOrchestrator } from "./turn-orchestrator.js";
import {
  EphemeralAudioAssetStore,
  VoiceInputCoordinator,
  VoiceSynthesisCoordinator,
  type VoiceRuntimeConfiguration
} from "./voice-runtime.js";
import {
  VoiceTransportServer,
  type BoundVoiceTransportAddress
} from "./voice-transport-server.js";

export interface LocalInterviewTransportRuntimeOptions {
  readonly security: LocalTransportSecurity;
  readonly registry: SessionRuntimeRegistry;
  readonly store?: SqliteEventStore;
  readonly commandPort?: number;
  readonly rendererStreamPort?: number;
  readonly voicePort?: number;
  readonly voiceRuntime?: VoiceRuntimeConfiguration;
  readonly maxRendererConnections?: number;
  readonly maxRendererConnectionsPerSession?: number;
  readonly maxRendererMessageBytes?: number;
  readonly orchestrator?: ServerTurnOrchestrator;
  readonly readService?: SessionReadService;
}

export interface BoundLocalInterviewTransport {
  readonly command: BoundLoopbackAddress;
  readonly rendererStream: BoundRendererStreamAddress;
  readonly voice: BoundVoiceTransportAddress;
}

/** Composition root for the two authenticated browser transports. */
export class LocalInterviewTransportRuntime {
  public readonly sessions: SessionRecoveryCoordinator;
  public readonly orchestrator: ServerTurnOrchestrator;
  public readonly readService: SessionReadService;
  public readonly commandServer: LoopbackCommandServer;
  public readonly rendererStreamServer: RendererStreamServer;
  public readonly voiceTransportServer: VoiceTransportServer;
  public readonly audioAssets: EphemeralAudioAssetStore;
  public readonly voiceSynthesis: VoiceSynthesisCoordinator | undefined;
  public readonly voiceInput: VoiceInputCoordinator | undefined;
  private bound: BoundLocalInterviewTransport | undefined;
  private starting: Promise<BoundLocalInterviewTransport> | undefined;
  private stopping: Promise<void> | undefined;
  private stopFailure: unknown;
  private readonly registry: SessionRuntimeRegistry;
  private readonly voiceDeliveryOperations = new Set<Promise<void>>();
  private voiceDeliveryShutdown = false;

  public constructor(options: LocalInterviewTransportRuntimeOptions) {
    this.registry = options.registry;
    this.sessions = new SessionRecoveryCoordinator(options.registry, options.store);
    this.audioAssets = new EphemeralAudioAssetStore();
    this.voiceSynthesis = options.voiceRuntime === undefined
      ? undefined
      : new VoiceSynthesisCoordinator(
        this.sessions,
        this.audioAssets,
        options.voiceRuntime.tts
      );
    this.orchestrator =
      options.orchestrator ??
      new ServerTurnOrchestrator(this.sessions, () => this.rendererStreamServer);
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
        : { maxMessageBytes: options.maxRendererMessageBytes }),
      audioAssetAvailable: (sessionId, audioRef) =>
        this.audioAssets.has(sessionId, audioRef),
      onDeliverySent: (sessionId, deliveryId) =>
        this.scheduleVoiceDelivery(sessionId, deliveryId)
    });
    this.voiceInput = options.voiceRuntime === undefined || this.voiceSynthesis === undefined
      ? undefined
      : new VoiceInputCoordinator(
        this.sessions,
        this.orchestrator,
        options.voiceRuntime.speechWorker,
        this.audioAssets,
        this.voiceSynthesis
      );
    this.voiceTransportServer = new VoiceTransportServer({
      security: options.security,
      assets: this.audioAssets,
      ...(this.voiceInput === undefined ? {} : { coordinator: this.voiceInput }),
      ...(options.voicePort === undefined ? {} : { port: options.voicePort })
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
    // Stop command + microphone admission first. Accepted work may still need
    // the renderer and authoritative writers while it converges.
    try {
      await this.commandServer.stop();
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.voiceTransportServer.stop();
    } catch (error) {
      failures.push(error);
    }
    this.voiceDeliveryShutdown = true;
    try {
      await this.voiceInput?.shutdown();
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.orchestrator.waitForAll();
    } catch (error) {
      failures.push(error);
    }
    try {
      await Promise.all([...this.voiceDeliveryOperations]);
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.voiceSynthesis?.shutdown();
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.rendererStreamServer.stop();
    } catch (error) {
      failures.push(error);
    }
    this.audioAssets.clear();
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
    this.voiceDeliveryShutdown = false;
    const command = await this.commandServer.start();
    let rendererStream: BoundRendererStreamAddress | undefined;
    try {
      rendererStream = await this.rendererStreamServer.start();
      const voice = await this.voiceTransportServer.start();
      this.bound = { command, rendererStream, voice };
      return this.bound;
    } catch (error) {
      const rollbackFailures: unknown[] = [error];
      try {
        await this.voiceTransportServer.stop();
      } catch (rollbackError) {
        rollbackFailures.push(rollbackError);
      }
      if (rendererStream !== undefined) {
        try {
          await this.rendererStreamServer.stop();
        } catch (rollbackError) {
          rollbackFailures.push(rollbackError);
        }
      }
      try {
        await this.commandServer.stop();
      } catch (rollbackError) {
        rollbackFailures.push(rollbackError);
      }
      if (rollbackFailures.length > 1) {
        throw new AggregateError(
          rollbackFailures,
          "Local interview transport startup failed and rollback also failed"
        );
      }
      throw error;
    }
  }

  private scheduleVoiceDelivery(
    sessionId: Parameters<VoiceSynthesisCoordinator["synthesizeSentTextDelivery"]>[0],
    deliveryId: Parameters<VoiceSynthesisCoordinator["synthesizeSentTextDelivery"]>[1]
  ): Promise<void> {
    if (this.voiceDeliveryShutdown || this.voiceSynthesis === undefined) {
      return Promise.resolve();
    }
    const operation = this.handleVoiceDelivery(sessionId, deliveryId);
    this.voiceDeliveryOperations.add(operation);
    void operation.finally(() => {
      this.voiceDeliveryOperations.delete(operation);
    }).catch(() => undefined);
    return operation;
  }

  private async handleVoiceDelivery(
    sessionId: Parameters<VoiceSynthesisCoordinator["synthesizeSentTextDelivery"]>[0],
    deliveryId: Parameters<VoiceSynthesisCoordinator["synthesizeSentTextDelivery"]>[1]
  ): Promise<void> {
    if (this.voiceDeliveryShutdown || this.voiceSynthesis === undefined) return;
    const writer = this.sessions.getWriter(sessionId);
    const source = writer.getState().deliveries[deliveryId];
    if (source?.content.medium !== "TEXT") return;

    const audio = await this.voiceSynthesis.synthesizeSentTextDelivery(sessionId, deliveryId);
    if (audio === undefined || this.voiceDeliveryShutdown) return;
    await this.rendererStreamServer.publishDelivery(sessionId, audio.deliveryId);
  }
}
