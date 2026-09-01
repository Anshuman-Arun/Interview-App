import type {
  CommandEnvelope,
  CommandIdentity,
  CommandResult,
  SessionId,
  StoredSessionSummary
} from "../../domain/src/index.js";
import { newEventId } from "../../domain/src/index.js";
import {
  CURRENT_EVENT_SCHEMA_VERSION,
  SessionEventSchema,
  reduceSessionEvent,
  replaySession,
  type EventDraft,
  type SessionEvent,
  type SessionState
} from "../../events/src/index.js";
import { RequestIdConflictError, type SqliteEventStore } from "../../persistence/src/index.js";
import type { z } from "zod";
import { fingerprintCommand } from "./command-fingerprint.js";

export interface StateTransition<TResult> {
  readonly drafts: readonly EventDraft[];
  readonly result: TResult;
}

export type TransitionHandler<TResult> = (state: Readonly<SessionState>) => StateTransition<TResult>;

export class SessionWriter {
  private tail: Promise<void> = Promise.resolve();
  private state: SessionState;
  private readonly openedAt = Date.now();
  private readonly elapsedOffset: number;
  private acceptingCommands = true;
  private fullyClosed = false;

  private constructor(
    private readonly store: SqliteEventStore,
    public readonly sessionId: SessionId
  ) {
    const events = store.load(sessionId);
    this.state = replaySession(sessionId, events);
    this.elapsedOffset = (events.at(-1)?.elapsedMs ?? 0) + (events.length === 0 ? 0 : 1);
  }

  public static open(store: SqliteEventStore, sessionId: SessionId): SessionWriter {
    return new SessionWriter(store, sessionId);
  }

  public getState(): Readonly<SessionState> {
    return this.state;
  }

  public isClosed(): boolean {
    return !this.acceptingCommands;
  }

  public async waitForIdle(): Promise<void> {
    await this.tail;
  }

  public async close(): Promise<void> {
    if (!this.acceptingCommands) {
      await this.tail;
      return;
    }
    this.acceptingCommands = false;
    await this.tail;
    this.fullyClosed = true;
  }

  private validateDraftTransition(
    drafts: readonly EventDraft[],
    envelope: CommandEnvelope,
    elapsedMs: number
  ): void {
    let previewState = this.state;
    const wallTime = new Date().toISOString();
    for (let index = 0; index < drafts.length; index += 1) {
      const draft = drafts[index];
      if (draft === undefined) continue;
      if (
        draft.type === "SESSION_STARTED"
        && draft.payload.configuration === undefined
      ) {
        throw new Error("New SESSION_STARTED events require authoritative session configuration");
      }
      const event = SessionEventSchema.parse({
        eventId: newEventId(),
        sessionId: this.sessionId,
        sequence: previewState.sequence + 1,
        schemaVersion: CURRENT_EVENT_SCHEMA_VERSION,
        source: draft.source,
        wallTime,
        elapsedMs: elapsedMs + index,
        causationId: envelope.causationId,
        correlationId: envelope.correlationId,
        type: draft.type,
        payload: draft.payload
      });
      previewState = reduceSessionEvent(previewState, event);
    }
  }

  public execute<TResult>(
    envelope: CommandEnvelope,
    commandIdentity: CommandIdentity,
    resultSchema: z.ZodType<TResult>,
    handler: TransitionHandler<TResult>
  ): Promise<CommandResult<TResult>> {
    if (!this.acceptingCommands || this.fullyClosed) {
      return Promise.reject(new Error("SessionWriter is closed and cannot execute commands"));
    }
    if (envelope.sessionId !== this.sessionId) {
      return Promise.reject(new Error("Command session does not match writer session"));
    }
    let commandFingerprint: string;
    try {
      commandFingerprint = fingerprintCommand(envelope, commandIdentity);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error("Command identity validation failed"));
    }
    const run = (): CommandResult<TResult> => {
      const prior = this.store.getProcessedResultForWriter(
        this.sessionId,
        envelope.requestId,
        this.state.sequence
      );
      if (prior.found) {
        if (prior.commandFingerprint !== commandFingerprint) throw new RequestIdConflictError();
        return { duplicate: true, value: resultSchema.parse(prior.result), appendedEventCount: 0 };
      }
      const transition = handler(this.state);
      const validatedResult = resultSchema.parse(transition.result);
      const elapsedMs = this.elapsedOffset + Math.max(0, Date.now() - this.openedAt);
      this.validateDraftTransition(transition.drafts, envelope, elapsedMs);
      const persisted = this.store.appendIdempotent({
        sessionId: this.sessionId,
        requestId: envelope.requestId,
        causationId: envelope.causationId,
        correlationId: envelope.correlationId,
        elapsedMs,
        expectedPriorSequence: this.state.sequence,
        commandFingerprint,
        drafts: transition.drafts,
        result: validatedResult
      });
      if (!persisted.duplicate) {
        this.state = persisted.events.reduce(reduceSessionEvent, this.state);
      }
      return {
        duplicate: persisted.duplicate,
        value: resultSchema.parse(persisted.result),
        appendedEventCount: persisted.events.length
      };
    };
    const outcome = this.tail.then(run, run);
    this.tail = outcome.then(() => undefined, () => undefined);
    return outcome;
  }
}

type SessionRuntimeEntry =
  | {
      readonly phase: "OPENING";
      readonly token: symbol;
      readonly opening: Promise<SessionWriter>;
    }
  | { readonly phase: "ACTIVE"; readonly writer: SessionWriter }
  | { readonly phase: "CLOSING"; readonly closing: Promise<void> };

export class SessionRuntimeRegistry {
  private readonly entries = new Map<SessionId, SessionRuntimeEntry>();
  private closingAll = false;
  private closeAllPromise: Promise<void> | undefined;

  public constructor(private readonly store: SqliteEventStore) {}

  public get(sessionId: SessionId): SessionWriter {
    if (this.closingAll) {
      throw new Error("Session runtime registry is closing all writers");
    }

    const entry = this.entries.get(sessionId);
    if (entry?.phase === "OPENING") {
      throw new Error("Session runtime is opening; use getAsync to await the canonical writer");
    }
    if (entry?.phase === "CLOSING") {
      throw new Error("Session runtime is closing; use getAsync to wait for reopening");
    }
    if (entry?.phase === "ACTIVE" && !entry.writer.isClosed()) {
      return entry.writer;
    }
    if (entry?.phase === "ACTIVE") {
      this.entries.delete(sessionId);
    }

    const writer = SessionWriter.open(this.store, sessionId);
    this.entries.set(sessionId, { phase: "ACTIVE", writer });
    return writer;
  }

  public async getAsync(sessionId: SessionId): Promise<SessionWriter> {
    for (;;) {
      if (this.closingAll) {
        throw new Error("Session runtime registry is closing all writers");
      }

      const entry = this.entries.get(sessionId);
      if (entry === undefined) {
        const token = Symbol("session-runtime-opening");
        const opening = Promise.resolve()
          .then(() => {
            const writer = SessionWriter.open(this.store, sessionId);
            const current = this.entries.get(sessionId);
            if (current?.phase === "OPENING" && current.token === token) {
              this.entries.set(sessionId, { phase: "ACTIVE", writer });
            }
            return writer;
          })
          .catch((error: unknown) => {
            const current = this.entries.get(sessionId);
            if (current?.phase === "OPENING" && current.token === token) {
              this.entries.delete(sessionId);
            }
            throw error;
          });
        this.entries.set(sessionId, { phase: "OPENING", token, opening });
        await opening;
        continue;
      }

      if (entry.phase === "OPENING") {
        await entry.opening;
        continue;
      }

      if (entry.phase === "CLOSING") {
        await entry.closing;
        continue;
      }

      if (!entry.writer.isClosed()) {
        return entry.writer;
      }
      if (this.entries.get(sessionId) === entry) {
        this.entries.delete(sessionId);
      }
    }
  }

  public async close(sessionId: SessionId): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (entry === undefined) return;
    if (entry.phase === "CLOSING") {
      await entry.closing;
      return;
    }

    let closing!: Promise<void>;
    if (entry.phase === "OPENING") {
      closing = entry.opening
        .then(async (writer) => writer.close())
        .finally(() => {
          const current = this.entries.get(sessionId);
          if (current?.phase === "CLOSING" && current.closing === closing) {
            this.entries.delete(sessionId);
          }
        });
    } else {
      closing = entry.writer.close().finally(() => {
        const current = this.entries.get(sessionId);
        if (current?.phase === "CLOSING" && current.closing === closing) {
          this.entries.delete(sessionId);
        }
      });
    }

    this.entries.set(sessionId, { phase: "CLOSING", closing });
    await closing;
  }

  public closeAll(): Promise<void> {
    if (this.closeAllPromise !== undefined) return this.closeAllPromise;

    this.closingAll = true;
    const closingAll = (async () => {
      try {
        while (this.entries.size > 0) {
          const sessionIds = [...this.entries.keys()];
          const results = await Promise.allSettled(
            sessionIds.map(async (sessionId) => this.close(sessionId))
          );
          const failures = results
            .filter((result): result is PromiseRejectedResult => result.status === "rejected")
            .map((result): unknown => result.reason as unknown);
          if (failures.length > 0) {
            throw new AggregateError(failures, "One or more session writers failed to close");
          }
        }
      } finally {
        this.closingAll = false;
        this.closeAllPromise = undefined;
      }
    })();
    this.closeAllPromise = closingAll;
    return closingAll;
  }

  public hasSession(sessionId: SessionId): boolean {
    return this.store.hasSession(sessionId);
  }

  public listSessions(): readonly StoredSessionSummary[] {
    return this.store.listSessions();
  }

  public loadEvents(sessionId: SessionId): readonly SessionEvent[] {
    return this.store.load(sessionId);
  }

  public getActiveSessionIds(): readonly SessionId[] {
    return [...this.entries.entries()]
      .filter(([, entry]) => entry.phase === "ACTIVE" && !entry.writer.isClosed())
      .map(([sessionId]) => sessionId);
  }
}
