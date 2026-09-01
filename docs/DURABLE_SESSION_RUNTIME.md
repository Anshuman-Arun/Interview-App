# Durable, Resumable Local Session Runtime

## 1. Overview & Architectural Invariants

The technical interview application runtime is grounded in an authoritative, event-sourced SQLite persistence model. Interview state is not maintained in ephemeral server memory or external provider sessions; instead, every state transition is an immutable, strictly sequenced semantic event persisted to SQLite in write-ahead logging (WAL) mode.

```
+-----------------------------------------------------------------------------------+
|                                 Authoritative SQLite                              |
|  +-----------------------------------+     +-----------------------------------+  |
|  |     session_events (STRICT)       |     |   processed_requests (STRICT)     |  |
|  | (session_id, sequence, event_json)|     | (session_id, request_id, result)  |  |
|  +-----------------------------------+     +-----------------------------------+  |
|                                                                                   |
|  +-----------------------------------------------------------------------------+  |
|  |                   session_index (STRICT, Rebuildable Projection)             |  |
|  | (session_id, problem_id, problem_version, status, sequence, timestamps)     |  |
|  +-----------------------------------------------------------------------------+  |
+-----------------------------------------------------------------------------------+
                                         ^
                                         | Atomic ACID Write
+-----------------------------------------------------------------------------------+
|                        SessionRuntimeRegistry & SessionWriter                     |
|  - Serialized Promise-chain queue per SessionId                                   |
|  - In-flight mutex ensuring single logical writer instance per active SessionId   |
|  - Graceful drain, close, and idle synchronization                                |
+-----------------------------------------------------------------------------------+
                                         ^
                                         | Loopback Boundary
+-----------------------------------------------------------------------------------+
|                    LoopbackCommandServer & Transport Runtime                      |
|  - /v1/commands: START_SESSION, RESUME_SESSION, COMPLETE_SESSION, ARCHIVE_SESSION |
|  - /v1/renderer-stream: Authenticated SSE Stream with Reconnect Support           |
+-----------------------------------------------------------------------------------+
                                         ^
                                         | Authenticated Client
+-----------------------------------------------------------------------------------+
|                                React / Vite Frontend                              |
|  - Session Switcher & Resumption Modal                                            |
|  - Real-time Status Badges & Lifecycle Actions                                    |
+-----------------------------------------------------------------------------------+
```

### Core Architecture Invariants
1. **Authoritative Event Log**: SQLite `session_events` is the single source of truth. Application state is reconstructed deterministically via the pure `reduceSessionEvent` / `replaySession` pipeline.
2. **Strict Sequence Continuity**: Sequences are 1-indexed strictly monotonic integers `1, 2, ..., N`. Any missing sequence, gap, duplicate sequence, or corrupt payload fails closed immediately with `CorruptEventStreamError`.
3. **Single Logical Writer**: `SessionRuntimeRegistry` enforces that at most one active `SessionWriter` instance exists per `SessionId` across the process.
4. **Rebuildable Projections**: The `session_index` table is a read-accelerating projection. It can be dropped or rebuilt at any time via `rebuildSessionIndex()` without data loss.
5. **Conservative Crash Recovery**: Unacknowledged in-flight deliveries on restart or disconnect are classified as `POSSIBLY_EXPOSED` to prevent accidental disclosure leaks. Incomplete generations are superseded as `CRASH_RECOVERY_STRANDED`.

---

## 2. Durable Session Repository & Projections

### SQLite Schema
```sql
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
```

### Repository Methods
- `hasSession(sessionId: SessionId): boolean`: Checks whether any events exist for the given session.
- `listSessionIds(): readonly SessionId[]`: Enumerates distinct session IDs ordered by earliest creation.
- `listSessions(): readonly StoredSessionSummary[]`: Returns projected session metadata (`sessionId`, `problemId`, `problemVersion`, `status`, `sequence`, `createdAt`, `updatedAt`, `eventCount`).
- `rebuildSessionIndex(): void`: Drops all rows in `session_index` and reconstructs the table purely by streaming `session_events`.
- `load(sessionId: SessionId): readonly SessionEvent[]`: Loads all events for a session, upcasting to current schema versions and verifying strict sequence continuity.

---

## 3. Session Lifecycle Transitions

The runtime models interview sessions as a state machine:

```
           +-----------+
           |  CREATED  |
           +-----------+
                 |
                 | START_SESSION / PROBLEM_PRESENTED
                 v
           +-----------+
+--------> |  ACTIVE   | <--------+
|          +-----------+          |
|            |       |            |
| RESUME_    |       | COMPLETE_  | RESUME_SESSION
| SESSION    |       | SESSION    |
|            v       v            |
|      +-------------------+      |
|      |    COMPLETED      | -----+
|      +-------------------+
|                |
|                | ARCHIVE_SESSION
|                v
|      +-------------------+
+----- |    ARCHIVED       |
       +-------------------+
```

### Lifecycle Events
- `SESSION_STARTED`: Transitions status from `CREATED` to `ACTIVE`.
- `SESSION_RESUMED`: Appended upon session resumption after a restart or disconnect, tracking resumption timestamp.
- `SESSION_COMPLETED`: Marks the session as finished, recording an optional completion summary.
- `SESSION_ARCHIVED`: Archives the session for long-term historical audit, disabling default interactions while preserving full replayability.

---

## 4. SessionRuntimeRegistry & Concurrency Control

`SessionRuntimeRegistry` manages the lifecycle of `SessionWriter` instances:
- **Single-Flight Initialization**: `get(sessionId)` and `getAsync(sessionId)` use a per-session initialization mutex to prevent concurrent instantiations.
- **Ordered Operations**: Each `SessionWriter` serializes command execution through a local `tail: Promise<void>` queue.
- **Clean Teardown**: `close(sessionId)` and `closeAll()` drain pending writes, detach registry references, and transition writers to closed state where subsequent operations fail closed.

---

## 5. Local Transport Protocol & Endpoints

All commands are validated under the authenticated loopback boundary (`x-interview-client-token`, exact `Origin`, loopback IP bind).

| Command Type | Endpoint | Payload | Response |
| --- | --- | --- | --- |
| `LIST_SESSIONS` | `POST /v1/commands` | `{ type: "LIST_SESSIONS" }` | `{ ok: true, sessions: StoredSessionSummary[] }` |
| `START_SESSION` | `POST /v1/commands` | `{ type: "START_SESSION", sessionId, problemId }` | `{ ok: true, sessionId, status, started, sequence }` |
| `RESUME_SESSION` | `POST /v1/commands` | `{ type: "RESUME_SESSION", sessionId }` | `{ ok: true, sessionId, status, started, sequence }` |
| `COMPLETE_SESSION` | `POST /v1/commands` | `{ type: "COMPLETE_SESSION", sessionId, summary }` | `{ ok: true, sessionId, status: "COMPLETED", sequence }` |
| `ARCHIVE_SESSION` | `POST /v1/commands` | `{ type: "ARCHIVE_SESSION", sessionId, reason }` | `{ ok: true, sessionId, status: "ARCHIVED", sequence }` |

---

## 6. Frontend Integration

`apps/web` provides interactive session management:
- **Session Switcher**: A modal listing all available persisted sessions with status badges (`ACTIVE`, `COMPLETED`, `ARCHIVED`), sequence counts, and timestamps.
- **Resumption Flow**: Selecting a session resumes state via `useInterviewSession` hook, reattaching the command client and renderer SSE stream.
- **Session Actions**: Complete and Archive buttons in the header allow candidates or reviewers to transition session lifecycle states directly from the browser UI.

---

## 7. Verification & Property Testing

The durable session runtime is verified through comprehensive test suites:
- `tests/durable-session-repository.test.ts`: Validates repository operations, sequence gap detection, and `rebuildSessionIndex()` parity.
- `tests/session-runtime-registry.test.ts`: Validates concurrency serialization and graceful writer closure.
- `tests/durable-session-lifecycle.test.ts`: Validates end-to-end multi-epoch server restart recovery, session listing, resumption, and stream reconnection.
- `tests/adversarial/durable-session-schedules.property.test.ts`: Executes randomized interleavings across multiple sessions, verifying monotonic sequence continuity, projection equality, and duplicate idempotency.
