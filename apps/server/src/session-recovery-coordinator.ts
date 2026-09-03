import {
  SessionHistoryEntrySchema,
  StoredSessionSummarySchema,
  type DeliveryId,
  type SessionConfigurationSource,
  type SessionHistoryEntry,
  type SessionId,
  type StoredSessionSummary
} from "../../../packages/domain/src/index.js";
import { DeliveryCoordinator } from "../../../packages/delivery/src/index.js";
import {
  replaySession,
  type SessionEvent
} from "../../../packages/events/src/index.js";
import {
  CorruptEventStreamError,
  type SqliteEventStore
} from "../../../packages/persistence/src/index.js";
import { assertReplayPrefixValidForRecovery } from "../../../packages/replay/src/index.js";
import { resolveSessionStateComposition } from "./interview-session-composition.js";
import { createLegacyDefaultSessionConfiguration } from "./legacy-session-compatibility.js";
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
    const summaries = this.store === undefined
      ? this.registry.listSessions()
      : listStoreSessionsBestEffort(this.store);
    const trusted: StoredSessionSummary[] = [];
    for (const summary of summaries) {
      const events = this.store?.load(summary.sessionId) ?? this.registry.loadEvents(summary.sessionId);
      const eventFamilyIsQuant = eventsIdentifyQuantSession(events);
      if (eventsAreLegacyUninitializedQuantSession(events)) {
        // Historical pre-runtime Quant sessions may contain lifecycle events that
        // modern deterministic reducers intentionally reject. Keep them
        // discoverable for migration, but expose no synthetic problem identity
        // and never open a modern writer for them.
        trusted.push(sanitizedQuantInventorySummary(summary));
        continue;
      }

      let state: ReturnType<typeof replaySession>;
      try {
        state = replaySession(summary.sessionId, events);
      } catch (error) {
        if (eventFamilyIsQuant) continue;
        throw error;
      }
      if (!isQuantSessionState(state)) {
        trusted.push(summary);
        continue;
      }

      if (isLegacyUninitializedQuantSessionState(state)) {
        assertSessionInventoryMatchesState(summary, state, events);
      } else {
        // Fail closed per deterministic session, not for the entire local
        // inventory. A single corrupt historical Quant stream must never be
        // advertised as trusted, but it also must not prevent healthy sessions
        // from being listed or a new interview from being started.
        try {
          assertReplayPrefixValidForRecovery(summary.sessionId, events);
          resolveSessionStateComposition(state);
          assertSessionInventoryMatchesState(summary, state, events);
        } catch {
          continue;
        }
      }

      // Quant Research persists a synthetic PROBLEM_PRESENTED only so generic
      // replay can retain chronology. LIST_SESSIONS has no mode discriminator,
      // so exposing that identity as problemId/problemVersion would make it
      // indistinguishable from an Oxford problem to legacy consumers.
      trusted.push(sanitizedQuantInventorySummary(summary));
    }
    return trusted;
  }

  public hasSession(sessionId: SessionId): boolean {
    return this.store?.hasSession(sessionId) ?? this.registry.hasSession(sessionId);
  }

  public getConfigurationSource(sessionId: SessionId): SessionConfigurationSource {
    if (!this.hasSession(sessionId)) {
      throw new Error("Session not found in authoritative event stream");
    }
    const events = this.store?.load(sessionId) ?? this.registry.loadEvents(sessionId);
    for (const event of events) {
      if (event.type === "SESSION_STARTED") {
        if (event.payload.configurationSource !== undefined) {
          return event.payload.configurationSource;
        }
        return inferUnmarkedConfigurationSource(event.payload.configuration);
      }
    }
    throw new Error("Authoritative session history has no SESSION_STARTED event");
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
      const persistedEvents = this.registry.loadEvents(sessionId);
      if (eventsAreLegacyUninitializedQuantSession(persistedEvents)) {
        throw new LegacyUninitializedQuantSessionError();
      }

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
          assertReplayPrefixValidForRecovery(sessionId, persistedEvents);
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

function listStoreSessionsBestEffort(
  store: SqliteEventStore
): readonly StoredSessionSummary[] {
  try {
    return store.listSessions();
  } catch (error) {
    if (!(error instanceof CorruptEventStreamError)) throw error;
  }

  const summaries: StoredSessionSummary[] = [];
  for (const sessionId of store.listSessionIds()) {
    let events: readonly SessionEvent[];
    try {
      events = store.load(sessionId);
    } catch (error) {
      if (error instanceof CorruptEventStreamError) continue;
      throw error;
    }
    if (events.length === 0) continue;

    let problemId: string | undefined;
    let problemVersion: string | undefined;
    let status: StoredSessionSummary["status"] = "CREATED";
    for (const event of events) {
      if (event.type === "PROBLEM_PRESENTED") {
        problemId = event.payload.problemId;
        problemVersion = event.payload.problemVersion;
      } else if (event.type === "SESSION_STARTED") {
        status = "ACTIVE";
      } else if (event.type === "SESSION_COMPLETED") {
        status = "COMPLETED";
      } else if (event.type === "SESSION_ARCHIVED") {
        status = "ARCHIVED";
      }
    }

    const first = events[0];
    const last = events.at(-1);
    if (first === undefined || last === undefined) continue;
    summaries.push(StoredSessionSummarySchema.parse({
      sessionId,
      ...(problemId === undefined ? {} : { problemId }),
      ...(problemVersion === undefined ? {} : { problemVersion }),
      status,
      sequence: last.sequence,
      createdAt: first.wallTime,
      updatedAt: last.wallTime,
      eventCount: events.length
    }));
  }

  return summaries.sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt)
    || left.sessionId.localeCompare(right.sessionId)
  );
}

function eventsAreLegacyUninitializedQuantSession(
  events: readonly SessionEvent[]
): boolean {
  const start = events.find((event) => event.type === "SESSION_STARTED");
  const mode = start?.type === "SESSION_STARTED"
    ? start.payload.configuration?.mode
    : undefined;
  if (mode !== "QUANT_TRADING" && mode !== "QUANT_RESEARCH") return false;
  return !events.some((event) =>
    event.type.startsWith("QUANT_TRADING_")
    || event.type.startsWith("QUANT_RESEARCH_")
  );
}

function eventsIdentifyQuantSession(events: readonly SessionEvent[]): boolean {
  return events.some((event) =>
    (
      event.type === "SESSION_STARTED"
      && (
        event.payload.configuration?.mode === "QUANT_TRADING"
        || event.payload.configuration?.mode === "QUANT_RESEARCH"
      )
    )
    || event.type.startsWith("QUANT_TRADING_")
    || event.type.startsWith("QUANT_RESEARCH_")
  );
}

function sanitizedQuantInventorySummary(
  summary: Readonly<StoredSessionSummary>
): StoredSessionSummary {
  return {
    sessionId: summary.sessionId,
    status: summary.status,
    sequence: summary.sequence,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    eventCount: summary.eventCount
  };
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
  if (state.quantTrading !== undefined || state.quantResearch !== undefined) return false;
  return state.configuration?.mode === "QUANT_TRADING"
    || state.configuration?.mode === "QUANT_RESEARCH";
}

function isQuantSessionState(state: Readonly<ReturnType<SessionWriter["getState"]>>): boolean {
  return state.configuration?.mode === "QUANT_TRADING"
    || state.configuration?.mode === "QUANT_RESEARCH"
    || state.quantTrading !== undefined
    || state.quantResearch !== undefined;
}


function inferUnmarkedConfigurationSource(
  configuration: unknown
): SessionConfigurationSource {
  if (configuration === undefined || configuration === null || typeof configuration !== "object") {
    return "LEGACY_COMPATIBILITY";
  }

  const candidate = configuration as {
    readonly mode?: string;
    readonly problem?: { readonly id?: string; readonly version?: string };
    readonly difficulty?: string;
    readonly interventionPolicy?: string;
    readonly durationMinutes?: number;
    readonly providerSelection?: unknown;
  };

  if (candidate.mode !== "OXFORD_MATHEMATICS") {
    return "CONFIGURED";
  }

  const legacy = createLegacyDefaultSessionConfiguration();
  if (legacy.mode !== "OXFORD_MATHEMATICS") {
    throw new Error("Legacy compatibility configuration must remain Oxford Mathematics");
  }

  const exactLegacyShape =
    candidate.problem?.id === legacy.problem.id
    && candidate.problem?.version === legacy.problem.version
    && candidate.difficulty === legacy.difficulty
    && candidate.interventionPolicy === legacy.interventionPolicy
    && candidate.durationMinutes === undefined
    && candidate.providerSelection === undefined;

  // Before provenance was persisted, configured sessions already stored their
  // exact configuration. Any shape that could not have been emitted by legacy
  // START_SESSION is therefore known to be configured. The one historically
  // ambiguous Ramsey/default shape remains conservatively legacy.
  return exactLegacyShape ? "LEGACY_COMPATIBILITY" : "CONFIGURED";
}

function semanticDeliveryKey(generationId: string, text: string): string {
  return `${generationId}\u0000${text}`;
}
