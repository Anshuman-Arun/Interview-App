import type { CommandEnvelope, CommandResult, SessionId } from "../../domain/src/index.js";
import { reduceSessionEvent, replaySession, type EventDraft, type SessionState } from "../../events/src/index.js";
import type { SqliteEventStore } from "../../persistence/src/index.js";
import type { z } from "zod";

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

  public execute<TResult>(
    envelope: CommandEnvelope,
    resultSchema: z.ZodType<TResult>,
    handler: TransitionHandler<TResult>
  ): Promise<CommandResult<TResult>> {
    if (envelope.sessionId !== this.sessionId) return Promise.reject(new Error("Command session does not match writer session"));
    const run = (): CommandResult<TResult> => {
      const prior = this.store.getProcessedResult(this.sessionId, envelope.requestId);
      if (prior.found) {
        return { duplicate: true, value: resultSchema.parse(prior.result), appendedEventCount: 0 };
      }
      const transition = handler(this.state);
      const validatedResult = resultSchema.parse(transition.result);
      const persisted = this.store.appendIdempotent({
        sessionId: this.sessionId,
        requestId: envelope.requestId,
        causationId: envelope.causationId,
        correlationId: envelope.correlationId,
        elapsedMs: this.elapsedOffset + Math.max(0, Date.now() - this.openedAt),
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

export class SessionRuntimeRegistry {
  private readonly writers = new Map<SessionId, SessionWriter>();

  public constructor(private readonly store: SqliteEventStore) {}

  public get(sessionId: SessionId): SessionWriter {
    const existing = this.writers.get(sessionId);
    if (existing !== undefined) return existing;
    const writer = SessionWriter.open(this.store, sessionId);
    this.writers.set(sessionId, writer);
    return writer;
  }
}
