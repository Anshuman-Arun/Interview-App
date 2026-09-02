import {
  SessionHistoryEntrySchema,
  type DeliveryId,
  type SessionHistoryEntry,
  type SessionId,
  type StoredSessionSummary
} from "../../../packages/domain/src/index.js";
import { DeliveryCoordinator } from "../../../packages/delivery/src/index.js";
import {
  replaySession,
  type SessionEvent
} from "../../../packages/events/src/index.js";
import type { SqliteEventStore } from "../../../packages/persistence/src/index.js";
import { assertReplayPrefixValidForRecovery } from "../../../packages/replay/src/index.js";
import { resolveSessionStateComposition } from "./interview-session-composition.js";
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

export interface VisionEvidenceRecoveryDelegate {
  readonly recoverPendingVisionEvidence: (sessionId: SessionId) => Promise<void>;
}

export class LegacyUninitializedQuantSessionError extends Error {
  public readonly code = "LEGACY_UNINITIALIZED_QUANT_SESSION" as const;

  public constructor() {
    super(
      "This Quant session predates deterministic runtime initialization and cannot be resumed; start a new Quant session"
    );
    this.name = "LegacyUninitializedQuantSessionError";
  }
}

/**
 * Process-lifetime recovery ownership shared by every transport adapter.
 * A session is recovered at most once successfully in one application runtime.
 */
export class SessionRecoveryCoordinator {
  private readonly recoveries = new Map<SessionId, Promise<readonly DeliveryId[]>>();
  private readonly retryableTurnRecoveries = new Set<SessionId>();
  private delegate: TurnRecoveryDelegate | undefined;
  private visionEvidenceDelegate: VisionEvidenceRecoveryDelegate | undefined;

  public constructor(
    private readonly registry: SessionRuntimeRegistry,
    private readonly store?: SqliteEventStore
  ) {}

  public listSessions(): readonly StoredSessionSummary[] {
    const summaries = this.store?.listSessions() ?? this.registry.listSessions();
    return summaries.map((summary): StoredSessionSummary => {
      const events = this.store?.load(summary.sessionId) ?? this.registry.loadEvents(summary.sessionId);
      const state = replaySession(summary.sessionId, events);
      if (!isQuantSessionState(state)) return summary;

      // Older builds could persist configured Quant sessions before the
      // deterministic runtime existed. Keep those sessions discoverable but
      // never invent a seed or treat them as deterministically initialized.
      if (isLegacyUninitializedQuantSessionState(state)) {
        assertSessionInventoryMatchesState(summary, state, events);
      } else {
        // The SQLite session index is a rebuildable convenience projection. Do not
        // let schema-valid but semantically forged deterministic Quant history be
        // advertised as a trusted ACTIVE/COMPLETED inventory entry.
        try {
          assertReplayPrefixValidForRecovery(summary.sessionId, events);
          resolveSessionStateComposition(state);
          assertSessionInventoryMatchesState(summary, state, events);
        } catch {
          // Persisted-history validation failures are server-authority failures,
          // not candidate command conflicts, even when the deterministic engine
          // happens to report them with an action-shaped error type.
          throw new Error("Authoritative quant session inventory validation failed");
        }
      }

      // Quant Research persists a synthetic PROBLEM_PRESENTED only so generic
      // replay can retain chronology. LIST_SESSIONS has no mode discriminator,
      // so exposing that identity as problemId/problemVersion would make it
      // indistinguishable from an Oxford problem to legacy consumers.
      return {
        sessionId: summary.sessionId,
        status: summary.status,
        sequence: summary.sequence,
        createdAt: summary.createdAt,
        updatedAt: summary.updatedAt,
        eventCount: summary.eventCount
      };
    });
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
      // Resolve exact application-owned identity and specialized deterministic
      // state before recovery may append anything. Quant streams additionally
      // require generic event provenance/transition validation: unlike the older
      // Oxford recovery fixtures, their production event family has no legacy
      // recovery-only histories that intentionally bypass replay projection.
      const state = writer.getState();
      if (isLegacyUninitializedQuantSessionState(state)) {
        throw new LegacyUninitializedQuantSessionError();
      }

      let composition: ReturnType<typeof resolveSessionStateComposition>;
      try {
        composition = resolveSessionStateComposition(state);
        if (composition.mode !== "OXFORD_MATHEMATICS") {
          assertReplayPrefixValidForRecovery(sessionId, this.registry.loadEvents(sessionId));
        }
      } catch (error) {
        if (isQuantSessionState(state)) {
          // Never let corrupted persisted deterministic history masquerade as a
          // malformed/stale candidate action at the HTTP error boundary.
          throw new Error("Authoritative quant session recovery validation failed", { cause: error });
        }
        throw error;
      }
      const deliveryIds = await new DeliveryCoordinator(writer).recoverUncertainDeliveries();
      if (this.visionEvidenceDelegate !== undefined) {
        await this.visionEvidenceDelegate.recoverPendingVisionEvidence(sessionId);
      }
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

function assertSessionInventoryMatchesState(
  summary: Readonly<StoredSessionSummary>,
  state: Readonly<ReturnType<SessionWriter["getState"]>>,
  events: readonly SessionEvent[]
): void {
  if (
    summary.status !== state.status
    || summary.sequence !== state.sequence
    || summary.eventCount !== events.length
    || summary.problemId !== state.problem?.id
    || summary.problemVersion !== state.problem?.version
    || summary.createdAt !== events[0]?.wallTime
    || summary.updatedAt !== events.at(-1)?.wallTime
  ) {
    throw new Error("Quant session inventory does not match authoritative state");
  }
}

function isLegacyUninitializedQuantSessionState(
  state: Readonly<ReturnType<SessionWriter["getState"]>>
): boolean {
  if (!state.started) return false;
  if (state.problem !== undefined || state.quantTrading !== undefined || state.quantResearch !== undefined) {
    return false;
  }
  return state.configuration?.mode === "QUANT_TRADING"
    || state.configuration?.mode === "QUANT_RESEARCH";
}

function isQuantSessionState(state: Readonly<ReturnType<SessionWriter["getState"]>>): boolean {
  return state.configuration?.mode === "QUANT_TRADING"
    || state.configuration?.mode === "QUANT_RESEARCH"
    || state.quantTrading !== undefined
    || state.quantResearch !== undefined;
}

function semanticDeliveryKey(generationId: string, text: string): string {
  return `${generationId}\u0000${text}`;
}
