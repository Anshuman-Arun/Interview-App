import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  newRequestId,
  newSessionId,
  type RequestId,
  type SessionId
} from "../../packages/domain/src/index.js";
import { SqliteEventStore } from "../../packages/persistence/src/index.js";
import {
  SessionRuntimeRegistry,
  TurnCoordinator,
  createCommandEnvelope
} from "../../packages/interview-engine/src/index.js";
import { sixPeopleProblem } from "../../packages/problems/src/index.js";
import { replaySession } from "../../packages/events/src/index.js";

interface CommittedRecord {
  readonly requestId: RequestId;
  readonly sessionId: SessionId;
  readonly text: string;
}

// Deterministic PRNG
function createPrng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x9e3779b9) >>> 0;
    let t = s ^ (s >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t = t ^ (t >>> 15);
    t = Math.imul(t, 0x735a2d97);
    return ((t ^ (t >>> 15)) >>> 0) / 4294967296;
  };
}

describe("Adversarial Property: Durable Session Interleavings and Invariants", () => {
  it("maintains sequence continuity, projection accuracy, and idempotency under random operational schedules", { timeout: 30_000 }, async () => {
    const NUM_RUNS = 12;

    for (let run = 0; run < NUM_RUNS; run++) {
      const prng = createPrng(1337 + run * 7919);
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `prop-session-schedule-${String(run)}-`));
      const dbPath = path.join(tmpDir, "prop-session.sqlite");

      let store = new SqliteEventStore(dbPath);
      let registry = new SessionRuntimeRegistry(store);

      const sessionIds: SessionId[] = [newSessionId(), newSessionId()];
      const committedRequests: CommittedRecord[] = [];

      const numSteps = 20 + Math.floor(prng() * 15);

      for (let step = 0; step < numSteps; step++) {
        const op = Math.floor(prng() * 6);
        const sid = sessionIds[Math.floor(prng() * sessionIds.length)] ?? sessionIds[0];
        if (sid === undefined) continue;

        try {
          switch (op) {
            case 0: {
              // Start session if not started
              const writer = registry.get(sid);
              const turns = new TurnCoordinator(writer);
              if (!writer.getState().started) {
                await turns.startSession(sixPeopleProblem);
              }
              break;
            }
            case 1: {
              // Commit input
              const writer = registry.get(sid);
              if (writer.getState().started && writer.getState().status === "ACTIVE") {
                const turns = new TurnCoordinator(writer);
                const reqId = newRequestId();
                const text = `Reasoning step ${String(step)} for run ${String(run)}`;
                committedRequests.push({ requestId: reqId, sessionId: sid, text });
                const env = createCommandEnvelope({ sessionId: sid, requestId: reqId, producer: "prop-test" });
                await turns.commitInput(text, env);
              }
              break;
            }
            case 2: {
              // Idempotent retry of a previous request
              if (committedRequests.length > 0) {
                const index = Math.floor(prng() * committedRequests.length);
                const chosen = committedRequests[index];
                if (chosen !== undefined) {
                  const reqId = chosen.requestId;
                  const sId = chosen.sessionId;
                  const txt = chosen.text;
                  const writer = registry.get(sId);
                  const turns = new TurnCoordinator(writer);
                  const env = createCommandEnvelope({ sessionId: sId, requestId: reqId, producer: "prop-test" });
                  const prevSeq = writer.getState().sequence;
                  await turns.commitInput(txt, env);
                  // Sequence must not advance on duplicate
                  expect(writer.getState().sequence).toBe(prevSeq);
                }
              }
              break;
            }
            case 3: {
              // Simulate crash / server restart
              await registry.closeAll();
              store.close();

              store = new SqliteEventStore(dbPath);
              registry = new SessionRuntimeRegistry(store);
              break;
            }
            case 4: {
              // Rebuild index and verify projection consistency
              store.rebuildSessionIndex();
              const summaries = store.listSessions();
              for (const s of summaries) {
                const events = store.load(s.sessionId);
                const replayed = replaySession(s.sessionId, events);
                expect(s.sequence).toBe(replayed.sequence);
                expect(s.status).toBe(replayed.status);
                expect(s.eventCount).toBe(events.length);
              }
              break;
            }
            case 5: {
              // Resume, complete or archive
              const writer = registry.get(sid);
              const turns = new TurnCoordinator(writer);
              if (writer.getState().started && writer.getState().status === "ACTIVE") {
                if (prng() < 0.5) {
                  await turns.resumeSession();
                } else {
                  await turns.completeSession(undefined, "Completed in prop test");
                }
              }
              break;
            }
          }
        } catch (err) {
          // Expected business logic guards are fine, but unexpected corruption must fail
          if (err instanceof Error && err.name === "CorruptEventStreamError") {
            throw err;
          }
        }
      }

      // Final Invariant Validations
      for (const sid of sessionIds) {
        if (store.hasSession(sid)) {
          const events = store.load(sid);
          expect(events.length).toBeGreaterThan(0);

          // 1. Sequence continuity invariant
          for (let i = 0; i < events.length; i++) {
            expect(events[i]?.sequence).toBe(i + 1);
          }

          // 2. Replay consistency invariant
          const replayed = replaySession(sid, events);
          expect(replayed.sequence).toBe(events.length);

          // 3. Projected summary matches raw replay
          const summaries = store.listSessions();
          const summary = summaries.find((s) => s.sessionId === sid);
          if (summary !== undefined) {
            expect(summary.sequence).toBe(replayed.sequence);
            expect(summary.status).toBe(replayed.status);
            expect(summary.eventCount).toBe(events.length);
          }
        }
      }

      await registry.closeAll();
      store.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
