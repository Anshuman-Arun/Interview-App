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

export interface TurnRecoveryDelegate {
  readonly recoverPendingTurns: (sessionId: SessionId) => Promise<void>;
}

export interface VisionEvidenceRecoveryDelegate {
  readonly recoverPendingVisionEvidence: (sessionId: SessionId) => Promise<void>;
}

/**
 * Process-lifetime recovery ownership shared by every transport adapter.
 * A session is recovered at most once successfully in one application runtime.
 */
export class SessionRecoveryCoordinator {
  private readonly recoveries = new Map<SessionId, Promise<readonly DeliveryId[]>>();
  private delegate: TurnRecoveryDelegate | undefined;
  private visionEvidenceDelegate: VisionEvidenceRecoveryDelegate | undefined;

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
    const queuedContent = new Map<DeliveryId, { readonly text: string }>();
    const history: SessionHistoryEntry[] = [];
    for (const event of events) {
      if (event.type === "DELIVERY_QUEUED") {
        const content = event.payload.atom.content;
        if (content.medium === "TEXT" || content.medium === "AUDIO") {
          queuedContent.set(event.payload.atom.deliveryId, { text: content.text });
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
    return history;
  }

  public setTurnRecoveryDelegate(delegate: TurnRecoveryDelegate): void {
    this.delegate = delegate;
  }

  public setVisionEvidenceRecoveryDelegate(
    delegate: VisionEvidenceRecoveryDelegate
  ): () => void {
    this.visionEvidenceDelegate = delegate;
    return () => {
      if (this.visionEvidenceDelegate === delegate) {
        this.visionEvidenceDelegate = undefined;
      }
    };
  }

  public getWriter(sessionId: SessionId): SessionWriter {
    return this.registry.get(sessionId);
  }

  public getWriterAsync(sessionId: SessionId): Promise<SessionWriter> {
    return this.registry.getAsync(sessionId);
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
      if (this.visionEvidenceDelegate !== undefined) {
        await this.visionEvidenceDelegate.recoverPendingVisionEvidence(sessionId);
      }
      if (this.delegate !== undefined) {
        await this.delegate.recoverPendingTurns(sessionId);
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
