import { DatabaseSync } from "node:sqlite";
import {
  CommandFingerprintSchema,
  newEventId,
  type CommandFingerprint,
  type RequestId,
  type SessionId
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

export class SqliteEventStore {
  private readonly database: DatabaseSync;
  private readonly upcasters: EventUpcasterRegistry;

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
    `);
    const processedRequestColumns = this.database.prepare("PRAGMA table_info(processed_requests)").all() as unknown as readonly { name: string }[];
    if (!processedRequestColumns.some((column) => column.name === "command_fingerprint")) {
      this.database.exec("ALTER TABLE processed_requests ADD COLUMN command_fingerprint TEXT;");
    }
  }

  public load(sessionId: SessionId): readonly SessionEvent[] {
    const rows = this.database.prepare(
      "SELECT event_json FROM session_events WHERE session_id = ? ORDER BY sequence ASC"
    ).all(sessionId) as unknown as readonly { event_json: string }[];
    return rows.map((row) => this.upcasters.toCurrent(JSON.parse(row.event_json) as unknown));
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
      const prior = this.database.prepare(
        "SELECT command_fingerprint, result_json FROM processed_requests WHERE session_id = ? AND request_id = ?"
      ).get(input.sessionId, input.requestId) as { command_fingerprint: string | null; result_json: string } | undefined;
      if (prior !== undefined) {
        if (prior.command_fingerprint !== commandFingerprint) throw new RequestIdConflictError();
        this.database.exec("COMMIT");
        return { duplicate: true, events: [], result: JSON.parse(prior.result_json) as TResult };
      }

      const latest = this.database.prepare(
        "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM session_events WHERE session_id = ?"
      ).get(input.sessionId) as { sequence: number };
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
    this.database.close();
  }
}
