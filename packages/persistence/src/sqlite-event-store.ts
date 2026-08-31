import { DatabaseSync } from "node:sqlite";
import {
  CommandFingerprintSchema,
  newEventId,
  SessionIdSchema,
  StoredSessionSummarySchema,
  type CommandFingerprint,
  type RequestId,
  type SessionId,
  type StoredSessionSummary
} from "../../domain/src/index.js";
import {
  CURRENT_EVENT_SCHEMA_VERSION,
  EventUpcasterRegistry,
  SessionEventSchema,
  type EventDraft,
  type SessionEvent
} from "../../events/src/index.js";

export interface AppendIdempotentInput<TResult> {
  readonly sessionId: SessionId;
  readonly requestId: RequestId;
  readonly causationId: RequestId;
  readonly correlationId: RequestId;
  readonly elapsedMs: number;
  readonly expectedPriorSequence: number;
  readonly commandFingerprint: CommandFingerprint;
  readonly drafts: readonly EventDraft[];
  readonly result: TResult;
}

export interface AppendIdempotentResult<TResult> {
  readonly duplicate: boolean;
  readonly events: readonly SessionEvent[];
  readonly result: TResult;
}

export class RequestIdConflictError extends Error {
  public readonly code = "REQUEST_ID_CONFLICT" as const;

  public constructor() {
    super("RequestId reuse conflicts with a different logical command");
    this.name = "RequestIdConflictError";
  }
}

export class StaleSessionWriterError extends Error {
  public readonly code = "STALE_SESSION_WRITER" as const;

  public constructor(
    public readonly expectedPriorSequence: number,
    public readonly actualPriorSequence: number
  ) {
    super(
      `Session writer is stale: expected prior sequence ${String(expectedPriorSequence)}, actual ${String(actualPriorSequence)}`
    );
    this.name = "StaleSessionWriterError";
  }
}

export class CorruptEventStreamError extends Error {
  public readonly code = "CORRUPT_EVENT_STREAM" as const;

  public constructor(message: string) {
    super(message);
    this.name = "CorruptEventStreamError";
  }
}

export class SqliteEventStore {
  private readonly database: DatabaseSync;
  private readonly upcasters: EventUpcasterRegistry;
  private closed = false;

  public constructor(path: string, upcasters = new EventUpcasterRegistry()) {
    this.database = new DatabaseSync(path);
    this.upcasters = upcasters;
    this.database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS session_events (
        session_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        event_id TEXT NOT NULL UNIQUE,
        schema_version INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        event_json TEXT NOT NULL,
        PRIMARY KEY (session_id, sequence)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS processed_requests (
        session_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        command_fingerprint TEXT NOT NULL,
        result_json TEXT NOT NULL,
        PRIMARY KEY (session_id, request_id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS session_index (
        session_id TEXT PRIMARY KEY,
        problem_id TEXT,
        problem_version TEXT,
        status TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        event_count INTEGER NOT NULL
      ) STRICT;
    `);

    const processedRequestColumns = this.database.prepare("PRAGMA table_info(processed_requests)").all() as unknown as readonly { name: string }[];
    if (!processedRequestColumns.some((column) => column.name === "command_fingerprint")) {
      this.database.exec("ALTER TABLE processed_requests ADD COLUMN command_fingerprint TEXT;");
    }
  }

  public hasSession(sessionId: SessionId): boolean {
    const row = this.database.prepare(
      "SELECT 1 FROM session_events WHERE session_id = ? LIMIT 1"
    ).get(sessionId);
    return row !== undefined;
  }

  public listSessionIds(): readonly SessionId[] {
    const rows = this.database.prepare(
      "SELECT DISTINCT session_id FROM session_events ORDER BY session_id ASC"
    ).all() as unknown as readonly { session_id: string }[];
    return rows.map((r) => SessionIdSchema.parse(r.session_id));
  }

  public listSessions(): readonly StoredSessionSummary[] {
    // The index is only a rebuildable projection. Rebuilding before reads makes
    // authoritative events win over missing, stale, or injected projection rows.
    this.rebuildSessionIndex();
    const rows = this.database.prepare(`
      SELECT session_id, problem_id, problem_version, status, sequence, created_at, updated_at, event_count
      FROM session_index
      ORDER BY updated_at DESC
    `).all() as unknown as readonly {
      session_id: string;
      problem_id: string | null;
      problem_version: string | null;
      status: string;
      sequence: number;
      created_at: string;
      updated_at: string;
      event_count: number;
    }[];

    return rows.map((r) =>
      StoredSessionSummarySchema.parse({
        sessionId: r.session_id,
        problemId: r.problem_id ?? undefined,
        problemVersion: r.problem_version ?? undefined,
        status: r.status,
        sequence: r.sequence,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        eventCount: r.event_count
      })
    );
  }

  public rebuildSessionIndex(): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.exec("DELETE FROM session_index;");
      const sessionRows = this.database.prepare(
        "SELECT DISTINCT session_id FROM session_events"
      ).all() as unknown as readonly { session_id: string }[];

      const insertIndex = this.database.prepare(`
        INSERT INTO session_index (session_id, problem_id, problem_version, status, sequence, created_at, updated_at, event_count)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const { session_id } of sessionRows) {
        const events = this.load(SessionIdSchema.parse(session_id));
        if (events.length === 0) continue;

        let problemId: string | null = null;
        let problemVersion: string | null = null;
        let status: "CREATED" | "ACTIVE" | "COMPLETED" | "ARCHIVED" = "CREATED";

        for (const event of events) {
          if (event.type === "PROBLEM_PRESENTED") {
            problemId = event.payload.problemId;
            problemVersion = event.payload.problemVersion;
          }
          if (event.type === "SESSION_STARTED") {
            status = "ACTIVE";
          }
          if (event.type === "SESSION_COMPLETED") {
            status = "COMPLETED";
          }
          if (event.type === "SESSION_ARCHIVED") {
            status = "ARCHIVED";
          }
        }

        const firstEvent = events[0];
        const lastEvent = events.at(-1);
        if (firstEvent === undefined || lastEvent === undefined) continue;

        const createdAt = firstEvent.wallTime;
        const updatedAt = lastEvent.wallTime;
        const sequence = lastEvent.sequence;
        const eventCount = events.length;

        insertIndex.run(session_id, problemId, problemVersion, status, sequence, createdAt, updatedAt, eventCount);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  public load(sessionId: SessionId): readonly SessionEvent[] {
    const rows = this.database.prepare(
      "SELECT event_json FROM session_events WHERE session_id = ? ORDER BY sequence ASC"
    ).all(sessionId) as unknown as readonly { event_json: string }[];

    let events: SessionEvent[];
    try {
      events = rows.map((row) => this.upcasters.toCurrent(JSON.parse(row.event_json) as unknown));
    } catch (error) {
      throw new CorruptEventStreamError(
        `Corrupt event JSON or schema violation in session ${sessionId}: ${error instanceof Error ? error.message : "unknown error"}`
      );
    }

    let expectedSequence = 1;
    for (const event of events) {
      if (event.sessionId !== sessionId) {
        throw new CorruptEventStreamError(
          `Event sessionId mismatch: expected ${sessionId}, found ${event.sessionId}`
        );
      }
      if (event.sequence !== expectedSequence) {
        throw new CorruptEventStreamError(
          `Non-contiguous event sequence for session ${sessionId}: expected ${String(expectedSequence)}, received ${String(event.sequence)}`
        );
      }
      expectedSequence += 1;
    }

    return events;
  }

  public getProcessedResult(sessionId: SessionId, requestId: RequestId):
    | { readonly found: false }
    | { readonly found: true; readonly commandFingerprint: string | null; readonly result: unknown } {
    const prior = this.database.prepare(
      "SELECT command_fingerprint, result_json FROM processed_requests WHERE session_id = ? AND request_id = ?"
    ).get(sessionId, requestId) as { command_fingerprint: string | null; result_json: string } | undefined;
    return prior === undefined
      ? { found: false }
      : {
          found: true,
          commandFingerprint: prior.command_fingerprint,
          result: JSON.parse(prior.result_json) as unknown
        };
  }

  public appendIdempotent<TResult>(input: AppendIdempotentInput<TResult>): AppendIdempotentResult<TResult> {
    const commandFingerprint = CommandFingerprintSchema.parse(input.commandFingerprint);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (
        !Number.isSafeInteger(input.expectedPriorSequence)
        || input.expectedPriorSequence < 0
      ) {
        throw new RangeError("Expected prior event sequence must be a non-negative safe integer");
      }
      const latest = this.database.prepare(
        "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM session_events WHERE session_id = ?"
      ).get(input.sessionId) as { sequence: number };
      if (!Number.isSafeInteger(latest.sequence) || latest.sequence < 0) {
        throw new CorruptEventStreamError(
          `Invalid latest event sequence for session ${input.sessionId}: ${String(latest.sequence)}`
        );
      }
      if (latest.sequence !== input.expectedPriorSequence) {
        throw new StaleSessionWriterError(input.expectedPriorSequence, latest.sequence);
      }

      const prior = this.database.prepare(
        "SELECT command_fingerprint, result_json FROM processed_requests WHERE session_id = ? AND request_id = ?"
      ).get(input.sessionId, input.requestId) as { command_fingerprint: string | null; result_json: string } | undefined;
      if (prior !== undefined) {
        if (prior.command_fingerprint !== commandFingerprint) throw new RequestIdConflictError();
        this.database.exec("COMMIT");
        return { duplicate: true, events: [], result: JSON.parse(prior.result_json) as TResult };
      }

      let sequence = latest.sequence;
      const events = input.drafts.map((draft, index) => {
        sequence += 1;
        return SessionEventSchema.parse({
          eventId: newEventId(),
          sessionId: input.sessionId,
          sequence,
          schemaVersion: CURRENT_EVENT_SCHEMA_VERSION,
          source: draft.source,
          wallTime: new Date().toISOString(),
          elapsedMs: input.elapsedMs + index,
          causationId: input.causationId,
          correlationId: input.correlationId,
          type: draft.type,
          payload: draft.payload
        });
      });

      const insertEvent = this.database.prepare(`
        INSERT INTO session_events (session_id, sequence, event_id, schema_version, event_type, event_json)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const event of events) {
        insertEvent.run(
          event.sessionId,
          event.sequence,
          event.eventId,
          event.schemaVersion,
          event.type,
          JSON.stringify(event)
        );
      }
      this.database.prepare(
        "INSERT INTO processed_requests (session_id, request_id, command_fingerprint, result_json) VALUES (?, ?, ?, ?)"
      ).run(input.sessionId, input.requestId, commandFingerprint, JSON.stringify(input.result));

      this.database.exec("COMMIT");
      return { duplicate: false, events, result: input.result };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  public eventCount(sessionId: SessionId): number {
    const row = this.database.prepare(
      "SELECT COUNT(*) AS count FROM session_events WHERE session_id = ?"
    ).get(sessionId) as { count: number };
    return row.count;
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }
}
