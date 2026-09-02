import {
  SessionHistoryEntrySchema,
  type DeliveryId,
  type SessionHistoryEntry,
  type SessionId,
  type StoredSessionSummary
} from "../../../packages/domain/src/index.js";
import { DeliveryCoordinator } from "../../../packages/delivery/src/index.js";
import { replaySession } from "../../../packages/events/src/index.js";
import type { SqliteEventStore } from "../../../packages/persistence/src/index.js";
import {
  type SessionRuntimeRegistry,
  type SessionWriter
} from "../../../packages/interview-engine/src/index.js";

export type TurnRecoveryDisposition = "COMPLETE" | "RETRYABLE" | "DEFERRED";

export interface TurnRecoveryDelegate {
  readonly recoverPendingTurns: (
    sessionId: SessionId
  ) => Promise<TurnRecoveryDisposition>;
}

/**
 * Process-lifetime recovery ownership shared by every transport adapter.
 * A session is recovered at most once successfully in one application runtime.
 */
export class SessionRecoveryCoordinator {
  private readonly recoveries = new Map<SessionId, Promise<readonly DeliveryId[]>>();
  private readonly retryableTurnRecoveries = new Set<SessionId>();
  private delegate: TurnRecoveryDelegate | undefined;

  public constructor(
    private readonly registry: SessionRuntimeRegistry,
    private readonly store?: SqliteEventStore
  ) {}

  public listSessions(): readonly StoredSessionSummary[] {
    return this.store?.listSessions() ?? this.registry.listSessions();
  }

  public hasSession(sessionId: SessionId): boolean {
    return this.store?.hasSession(sessionId) ?? this.registry.hasSession(sessionId);
  }

  public getHistory(sessionId: SessionId): readonly SessionHistoryEntry[] {
    if (!this.hasSession(sessionId)) return [];

    const events = this.store?.load(sessionId) ?? this.registry.loadEvents(sessionId);
    const state = replaySession(sessionId, events);
    const queuedContent = new Map<DeliveryId, {
      readonly text: string;
      readonly generationId: string;
      readonly medium: "TEXT" | "AUDIO";
    }>();
    const exposedSemanticKeys = new Set<string>();
    const history: SessionHistoryEntry[] = [];
    for (const event of events) {
      if (event.type === "DELIVERY_QUEUED") {
        const content = event.payload.atom.content;
        if (content.medium === "TEXT" || content.medium === "AUDIO") {
          queuedContent.set(event.payload.atom.deliveryId, {
            text: content.text,
            generationId: event.payload.atom.generationId,
            medium: content.medium
          });
        }
        continue;
      }

      if (event.type === "TURN_COMMITTED") {
        history.push(SessionHistoryEntrySchema.parse({
          role: "STUDENT",
          sequence: event.sequence,
          occurredAt: event.wallTime,
          turnId: event.payload.turnId,
          inputEpisodeId: event.payload.inputEpisodeId,
          text: event.payload.studentText
        }));
        continue;
      }

      if (event.type !== "DELIVERY_EXPOSED") continue;

      const content = queuedContent.get(event.payload.deliveryId);
      const current = state.deliveries[event.payload.deliveryId];
      // Durable history is a presentation history, not a generation/queue log.
      // Anchor interviewer entries to persisted physical exposure, never to
      // generation/queue time. POSSIBLY_EXPOSED has no DELIVERY_EXPOSED event
      // and therefore cannot be reconstructed as visible transcript.
      if (
        content !== undefined
        && (current?.status === "EXPOSED" || current?.status === "COMPLETED")
      ) {
        const semanticKey = semanticDeliveryKey(content.generationId, content.text);
        if (!exposedSemanticKeys.has(semanticKey)) {
          exposedSemanticKeys.add(semanticKey);
          history.push(SessionHistoryEntrySchema.parse({
            role: "INTERVIEWER",
            sequence: event.sequence,
            occurredAt: event.wallTime,
            deliveryId: event.payload.deliveryId,
            text: content.text,
            status: current.status
          }));
        }
      }
    }
    return history;
  }

  public setTurnRecoveryDelegate(delegate: TurnRecoveryDelegate): void {
    this.delegate = delegate;
  }

  public getWriter(sessionId: SessionId): SessionWriter {
    return this.registry.get(sessionId);
  }

  public getWriterAsync(sessionId: SessionId): Promise<SessionWriter> {
    return this.registry.getAsync(sessionId);
  }

  public retryPendingTurnRecovery(
    sessionId: SessionId
  ): Promise<readonly DeliveryId[]> {
    if (!this.retryableTurnRecoveries.has(sessionId)) {
      return this.ensureRecovered(sessionId);
    }
    this.retryableTurnRecoveries.delete(sessionId);
    this.recoveries.delete(sessionId);
    return this.ensureRecovered(sessionId);
  }

  public ensureRecovered(sessionId: SessionId): Promise<readonly DeliveryId[]> {
    if (!this.hasSession(sessionId)) {
      return Promise.reject(new Error("Session not found in authoritative event stream"));
    }

    const existing = this.recoveries.get(sessionId);
    if (existing !== undefined) return existing;

    const recovery = (async () => {
      const writer = await this.getWriterAsync(sessionId);
      const deliveryIds = await new DeliveryCoordinator(writer).recoverUncertainDeliveries();
      if (this.delegate !== undefined) {
        const disposition = await this.delegate.recoverPendingTurns(sessionId);
        if (disposition === "DEFERRED") {
          this.retryableTurnRecoveries.delete(sessionId);
          throw new Error("Turn recovery was deferred during provider shutdown");
        }
        if (disposition === "RETRYABLE") {
          this.retryableTurnRecoveries.add(sessionId);
        } else {
          this.retryableTurnRecoveries.delete(sessionId);
        }
      }
      return deliveryIds;
    })();

    this.recoveries.set(sessionId, recovery);
    void recovery.catch(() => {
      if (this.recoveries.get(sessionId) === recovery) {
        this.recoveries.delete(sessionId);
      }
    });
    return recovery;
  }
}

function semanticDeliveryKey(generationId: string, text: string): string {
  return `${generationId}\u0000${text}`;
}
