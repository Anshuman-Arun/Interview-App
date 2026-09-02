import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  BoardRevisionSchema,
  authoritativeBoardShapeCanonicalJson,
  newRequestId,
  newSessionId,
  type AuthoritativeStudentShape,
  type BoardRevision,
  type NormalizedBoardMutation,
  type SessionId
} from "../packages/domain/src/index.js";
import {
  SessionRuntimeRegistry,
  TurnCoordinator,
  createCommandEnvelope
} from "../packages/interview-engine/src/index.js";
import { SqliteEventStore } from "../packages/persistence/src/index.js";
import { sixPeopleProblem } from "../packages/problems/src/index.js";
import {
  AuthoritativeBoardSyncCoordinator
} from "../apps/web/src/whiteboard/authoritative-board-sync.js";
import type { NormalizedStudentShapeChange } from "../apps/web/src/whiteboard/normalized-board.js";

function shape(
  id: string,
  revision: number,
  x = 10
): AuthoritativeStudentShape {
  return {
    id,
    type: "rectangle",
    bounds: { x, y: 20, width: 100, height: 60 },
    revision,
    createdAt: 1,
    lastModifiedAt: revision
  };
}

function mutation(
  baseBoardRevision: BoardRevision,
  values: {
    readonly added?: readonly AuthoritativeStudentShape[];
    readonly updated?: readonly {
      readonly beforeRevision: number;
      readonly shape: AuthoritativeStudentShape;
    }[];
    readonly deleted?: readonly {
      readonly shapeId: string;
      readonly expectedRevision: number;
    }[];
  }
): NormalizedBoardMutation {
  return {
    baseBoardRevision,
    added: [...(values.added ?? [])],
    updated: [...(values.updated ?? [])],
    deleted: [...(values.deleted ?? [])]
  };
}

describe("authoritative whiteboard mutation admission", () => {
  it("advances BoardRevision exactly once and durably deduplicates a retried request", async () => {
    const store = new SqliteEventStore(":memory:");
    try {
      const sessionId = newSessionId();
      const writer = new SessionRuntimeRegistry(store).get(sessionId);
      const turns = new TurnCoordinator(writer);
      await turns.startSession(sixPeopleProblem);

      const requestId = newRequestId();
      const envelope = createCommandEnvelope({
        sessionId,
        producer: "whiteboard-test",
        requestId
      });
      const firstMutation = mutation(BoardRevisionSchema.parse(0), {
        added: [shape("shape:student-a", 1)]
      });

      const first = await turns.commitBoardMutation(firstMutation, envelope);
      const eventCount = store.eventCount(sessionId);
      const duplicate = await turns.commitBoardMutation(firstMutation, envelope);

      expect(first).toEqual({
        committed: true,
        boardRevision: BoardRevisionSchema.parse(1)
      });
      expect(duplicate).toEqual(first);
      expect(store.eventCount(sessionId)).toBe(eventCount);
      expect(writer.getState().boardShapes["shape:student-a"]?.revision).toBe(1);

      const stale = await turns.commitBoardMutation(
        firstMutation,
        createCommandEnvelope({
          sessionId,
          producer: "whiteboard-test",
          requestId: newRequestId()
        })
      );
      expect(stale).toEqual({
        committed: false,
        boardRevision: BoardRevisionSchema.parse(1),
        reason: "STALE_CLIENT"
      });
      expect(store.eventCount(sessionId)).toBe(eventCount);

      const updated = await turns.commitBoardMutation(
        mutation(BoardRevisionSchema.parse(1), {
          updated: [{
            beforeRevision: 1,
            shape: shape("shape:student-a", 2, 30)
          }]
        })
      );
      expect(updated).toEqual({
        committed: true,
        boardRevision: BoardRevisionSchema.parse(2)
      });
      expect(writer.getState().boardShapes["shape:student-a"]?.bounds.x).toBe(30);

      const removed = await turns.commitBoardMutation(
        mutation(BoardRevisionSchema.parse(2), {
          deleted: [{ shapeId: "shape:student-a", expectedRevision: 2 }]
        })
      );
      expect(removed).toEqual({
        committed: true,
        boardRevision: BoardRevisionSchema.parse(3)
      });
      expect(writer.getState().boardShapes["shape:student-a"]).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("rejects updates that rewrite creation time or move modification time backwards", async () => {
    const store = new SqliteEventStore(":memory:");
    try {
      const sessionId = newSessionId();
      const writer = new SessionRuntimeRegistry(store).get(sessionId);
      const turns = new TurnCoordinator(writer);
      await turns.startSession(sixPeopleProblem);

      const original = {
        ...shape("shape:clock", 1, 10),
        lastModifiedAt: 10
      };
      expect((await turns.commitBoardMutation(
        mutation(BoardRevisionSchema.parse(0), { added: [original] })
      )).committed).toBe(true);

      const rewriteCreatedAt = await turns.commitBoardMutation(
        mutation(BoardRevisionSchema.parse(1), {
          updated: [{
            beforeRevision: 1,
            shape: {
              ...shape("shape:clock", 2, 20),
              createdAt: 2,
              lastModifiedAt: 20
            }
          }]
        })
      );
      expect(rewriteCreatedAt).toEqual({
        committed: false,
        boardRevision: BoardRevisionSchema.parse(1),
        reason: "MUTATION_CONFLICT"
      });

      const backwardsModified = await turns.commitBoardMutation(
        mutation(BoardRevisionSchema.parse(1), {
          updated: [{
            beforeRevision: 1,
            shape: {
              ...shape("shape:clock", 2, 20),
              createdAt: 1,
              lastModifiedAt: 5
            }
          }]
        })
      );
      expect(backwardsModified).toEqual({
        committed: false,
        boardRevision: BoardRevisionSchema.parse(1),
        reason: "MUTATION_CONFLICT"
      });
      expect(writer.getState().boardShapes["shape:clock"]).toEqual(original);
    } finally {
      store.close();
    }
  });

  it("fails closed after a legacy summary-only patch makes shape authority unknown", async () => {
    const store = new SqliteEventStore(":memory:");
    try {
      const sessionId = newSessionId();
      const writer = new SessionRuntimeRegistry(store).get(sessionId);
      const turns = new TurnCoordinator(writer);
      await turns.startSession(sixPeopleProblem);
      await turns.commitBoardPatch("legacy board mutation");

      expect(writer.getState().boardShapeAuthorityKnown).toBe(false);
      await expect(turns.commitBoardMutation(
        mutation(BoardRevisionSchema.parse(1), {
          added: [shape("shape:cannot-guess", 1)]
        })
      )).resolves.toEqual({
        committed: false,
        boardRevision: BoardRevisionSchema.parse(1),
        reason: "BOARD_AUTHORITY_UNKNOWN"
      });
    } finally {
      store.close();
    }
  });

  it("joins already-authoritative board activity into an active InputEpisode without double-incrementing BoardRevision", async () => {
    const store = new SqliteEventStore(":memory:");
    try {
      const sessionId = newSessionId();
      const writer = new SessionRuntimeRegistry(store).get(sessionId);
      const turns = new TurnCoordinator(writer);
      await turns.startSession(sixPeopleProblem);

      const utteranceId = await turns.beginUtterance();
      const { inputEpisodeId } = await turns.finalizeUtterance({
        utteranceId,
        text: "I am drawing the graph representation."
      });
      const committed = await turns.commitBoardMutation(
        mutation(BoardRevisionSchema.parse(0), {
          added: [shape("shape:episode-board", 1)]
        })
      );
      expect(committed.committed).toBe(true);

      await turns.appendBoardInput(
        inputEpisodeId,
        "Student drew the graph representation.",
        { alreadyCommittedBoardRevision: committed.boardRevision }
      );

      const state = writer.getState();
      expect(state.boardRevision).toBe(BoardRevisionSchema.parse(1));
      expect(state.inputEpisodes[inputEpisodeId]?.inputs).toEqual([
        {
          modality: "SPEECH",
          semanticContent: "I am drawing the graph representation."
        },
        {
          modality: "WHITEBOARD",
          semanticContent: "Student drew the graph representation."
        }
      ]);
    } finally {
      store.close();
    }
  });
});

type SyncClient = ConstructorParameters<typeof AuthoritativeBoardSyncCoordinator>[0];

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: Error) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function studentChange(
  kind: "ADD" | "UPDATE",
  x: number
): NormalizedStudentShapeChange {
  if (kind === "ADD") {
    return {
      source: "EDITOR",
      added: [shape("shape:queued", 1, x)],
      updated: [],
      deleted: []
    };
  }
  return {
    source: "EDITOR",
    added: [],
    updated: [{
      before: shape("shape:queued", 1, 10),
      after: shape("shape:queued", 2, x)
    }],
    deleted: []
  };
}

function boardStateResponse(
  sessionId: SessionId,
  boardRevision: BoardRevision,
  shapeRevisions: readonly {
    readonly shapeId: string;
    readonly revision: number;
    readonly contentSha256?: string;
  }[]
): Awaited<ReturnType<SyncClient["getBoardState"]>> {
  return {
    protocolVersion: 1,
    ok: true,
    type: "BOARD_STATE",
    requestId: newRequestId(),
    sessionId,
    boardRevision,
    shapeAuthorityKnown: true,
    shapeRevisions: shapeRevisions.map((entry) => ({
      shapeId: entry.shapeId,
      revision: entry.revision,
      contentSha256: entry.contentSha256 ?? "0".repeat(64)
    }))
  };
}

describe("browser authoritative board synchronization", () => {
  it("serializes two edits before the first acknowledgement and deduplicates a repeated callback", async () => {
    const sessionId = newSessionId();
    type CommitResponse = Awaited<ReturnType<SyncClient["commitBoardMutation"]>>;
    const first = deferred<CommitResponse>();
    const second = deferred<CommitResponse>();
    const calls: Parameters<SyncClient["commitBoardMutation"]>[] = [];

    const client: SyncClient = {
      getBoardState: async () =>
        boardStateResponse(sessionId, BoardRevisionSchema.parse(0), []),
      commitBoardMutation: (...args) => {
        calls.push(args);
        return calls.length === 1 ? first.promise : second.promise;
      }
    };
    const sync = new AuthoritativeBoardSyncCoordinator(client);
    await sync.synchronize(sessionId, []);

    const firstChange = studentChange("ADD", 10);
    const firstPending = sync.submit(firstChange);
    await sync.submit(firstChange);
    const secondPending = sync.submit(studentChange("UPDATE", 40));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1].baseBoardRevision).toBe(BoardRevisionSchema.parse(0));
    expect(sync.snapshot().pendingMutationCount).toBe(2);

    const firstRequestId = calls[0]?.[2]?.requestId;
    if (firstRequestId === undefined) throw new Error("Expected first whiteboard request ID");
    first.resolve({
      protocolVersion: 1,
      ok: true,
      type: "BOARD_MUTATION_COMMITTED",
      requestId: firstRequestId,
      sessionId,
      committed: true,
      boardRevision: BoardRevisionSchema.parse(1)
    });
    await firstPending;
    await Promise.resolve();

    expect(calls).toHaveLength(2);
    expect(calls[1]?.[1].baseBoardRevision).toBe(BoardRevisionSchema.parse(1));
    const secondRequestId = calls[1]?.[2]?.requestId;
    if (secondRequestId === undefined) throw new Error("Expected second whiteboard request ID");
    second.resolve({
      protocolVersion: 1,
      ok: true,
      type: "BOARD_MUTATION_COMMITTED",
      requestId: secondRequestId,
      sessionId,
      committed: true,
      boardRevision: BoardRevisionSchema.parse(2)
    });
    await secondPending;

    expect(sync.snapshot()).toMatchObject({
      status: "SYNCED",
      authoritativeRevision: BoardRevisionSchema.parse(2),
      pendingMutationCount: 0
    });
  });

  it("fails closed without transport on oversized or structurally invalid editor transactions", async () => {
    const sessionId = newSessionId();
    let commitCalls = 0;
    const client: SyncClient = {
      getBoardState: async () =>
        boardStateResponse(sessionId, BoardRevisionSchema.parse(0), []),
      commitBoardMutation: async () => {
        commitCalls += 1;
        throw new Error("Invalid local mutations must never reach transport");
      }
    };

    const oversizedSync = new AuthoritativeBoardSyncCoordinator(client);
    await oversizedSync.synchronize(sessionId, []);
    const oversized: NormalizedStudentShapeChange = {
      source: "EDITOR",
      added: Array.from(
        { length: 65 },
        (_, index) => shape(`shape:oversized-${String(index)}`, 1, index)
      ),
      updated: [],
      deleted: []
    };
    await expect(oversizedSync.submit(oversized)).rejects.toThrow(/bounded mutation size/u);
    expect(oversizedSync.snapshot()).toMatchObject({
      status: "UNSYNCHRONIZED",
      pendingMutationCount: 0
    });
    expect(commitCalls).toBe(0);

    const invalidSync = new AuthoritativeBoardSyncCoordinator(client);
    await invalidSync.synchronize(sessionId, []);
    const duplicate = shape("shape:duplicate", 1, 10);
    const invalid: NormalizedStudentShapeChange = {
      source: "EDITOR",
      added: [duplicate, duplicate],
      updated: [],
      deleted: []
    };
    await expect(invalidSync.submit(invalid)).rejects.toThrow();
    expect(invalidSync.snapshot()).toMatchObject({
      status: "UNSYNCHRONIZED",
      pendingMutationCount: 0,
      reason: "Whiteboard mutation failed local bounded validation"
    });
    expect(commitCalls).toBe(0);
  });

  it("retries a dropped command response with the exact same request ID and mutation basis", async () => {
    const sessionId = newSessionId();
    const calls: Parameters<SyncClient["commitBoardMutation"]>[] = [];
    const client: SyncClient = {
      getBoardState: async () =>
        boardStateResponse(sessionId, BoardRevisionSchema.parse(0), []),
      commitBoardMutation: async (...args) => {
        calls.push(args);
        if (calls.length === 1) throw new Error("simulated dropped acknowledgement");
        const requestId = args[2]?.requestId;
        if (requestId === undefined) throw new Error("Expected retry request ID");
        return {
          protocolVersion: 1,
          ok: true,
          type: "BOARD_MUTATION_COMMITTED",
          requestId,
          sessionId,
          committed: true,
          boardRevision: BoardRevisionSchema.parse(1)
        };
      }
    };
    const sync = new AuthoritativeBoardSyncCoordinator(client);
    await sync.synchronize(sessionId, []);
    await sync.submit(studentChange("ADD", 10));

    expect(calls).toHaveLength(2);
    expect(calls[0]?.[2]?.requestId).toBe(calls[1]?.[2]?.requestId);
    expect(calls[0]?.[1]).toEqual(calls[1]?.[1]);
    expect(sync.currentAuthoritativeRevision()).toBe(BoardRevisionSchema.parse(1));
  });

  it("deduplicates a delayed callback after reconnect proves a pending mutation already committed", async () => {
    const sessionId = newSessionId();
    type CommitResponse = Awaited<ReturnType<SyncClient["commitBoardMutation"]>>;
    const acknowledgement = deferred<CommitResponse>();
    const calls: Parameters<SyncClient["commitBoardMutation"]>[] = [];
    let boardReads = 0;
    const committedShape = shape("shape:queued", 1, 10);

    const client: SyncClient = {
      getBoardState: async () => {
        boardReads += 1;
        return boardReads === 1
          ? boardStateResponse(sessionId, BoardRevisionSchema.parse(0), [])
          : boardStateResponse(
              sessionId,
              BoardRevisionSchema.parse(1),
              [{
                shapeId: committedShape.id,
                revision: committedShape.revision,
                contentSha256: testShapeDigest(committedShape)
              }]
            );
      },
      commitBoardMutation: (...args) => {
        calls.push(args);
        return acknowledgement.promise;
      }
    };

    const sync = new AuthoritativeBoardSyncCoordinator(client);
    await sync.synchronize(sessionId, []);
    const change = studentChange("ADD", 10);
    const pending = sync.submit(change);
    await Promise.resolve();
    expect(calls).toHaveLength(1);

    const recovered = await sync.synchronize(sessionId, [committedShape]);
    expect(recovered).toMatchObject({
      status: "SYNCED",
      authoritativeRevision: BoardRevisionSchema.parse(1),
      pendingMutationCount: 0
    });
    await pending;

    await sync.submit(change);
    expect(calls).toHaveLength(1);

    const requestId = calls[0]?.[2]?.requestId;
    if (requestId === undefined) throw new Error("Expected pending whiteboard request ID");
    acknowledgement.resolve({
      protocolVersion: 1,
      ok: true,
      type: "BOARD_MUTATION_COMMITTED",
      requestId,
      sessionId,
      committed: true,
      boardRevision: BoardRevisionSchema.parse(1)
    });
    await Promise.resolve();
    expect(sync.currentAuthoritativeRevision()).toBe(BoardRevisionSchema.parse(1));
  });

  it("does not let a late old-session acknowledgement resurrect synchronization after reset", async () => {
    const firstSessionId = newSessionId();
    const secondSessionId = newSessionId();
    type CommitResponse = Awaited<ReturnType<SyncClient["commitBoardMutation"]>>;
    const oldAck = deferred<CommitResponse>();
    let oldRequestId: ReturnType<typeof newRequestId> | undefined;

    const client: SyncClient = {
      getBoardState: async (targetSessionId) =>
        boardStateResponse(
          targetSessionId,
          BoardRevisionSchema.parse(0),
          []
        ),
      commitBoardMutation: async (targetSessionId, _mutation, options) => {
        const requestId = options?.requestId ?? newRequestId();
        if (targetSessionId === firstSessionId) {
          oldRequestId = requestId;
          return oldAck.promise;
        }
        return {
          protocolVersion: 1,
          ok: true,
          type: "BOARD_MUTATION_COMMITTED",
          requestId,
          sessionId: secondSessionId,
          committed: true,
          boardRevision: BoardRevisionSchema.parse(1)
        };
      }
    };
    const sync = new AuthoritativeBoardSyncCoordinator(client);
    await sync.synchronize(firstSessionId, []);

    const pending = sync.submit(studentChange("ADD", 10));
    const resetRejection = expect(pending).rejects.toThrow(/reset/u);
    sync.reset();
    await resetRejection;

    if (oldRequestId === undefined) throw new Error("Expected in-flight old-session request");
    oldAck.resolve({
      protocolVersion: 1,
      ok: true,
      type: "BOARD_MUTATION_COMMITTED",
      requestId: oldRequestId,
      sessionId: firstSessionId,
      committed: true,
      boardRevision: BoardRevisionSchema.parse(1)
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(sync.snapshot()).toMatchObject({
      status: "UNINITIALIZED",
      pendingMutationCount: 0
    });
    expect(sync.currentAuthoritativeRevision()).toBeUndefined();

    await sync.synchronize(secondSessionId, []);
    await sync.submit({
      source: "EDITOR",
      added: [shape("shape:second-session", 1, 50)],
      updated: [],
      deleted: []
    });
    expect(sync.currentAuthoritativeRevision()).toBe(BoardRevisionSchema.parse(1));
  });

  it("never bootstraps a mounted canvas into an empty session without explicit session-scoped authorization", async () => {
    const sessionId = newSessionId();
    let commits = 0;
    const client: SyncClient = {
      getBoardState: async () =>
        boardStateResponse(sessionId, BoardRevisionSchema.parse(0), []),
      commitBoardMutation: async (_targetSessionId, _mutation, options) => {
        commits += 1;
        return {
          protocolVersion: 1,
          ok: true,
          type: "BOARD_MUTATION_COMMITTED",
          requestId: options?.requestId ?? newRequestId(),
          sessionId,
          committed: true,
          boardRevision: BoardRevisionSchema.parse(1)
        };
      }
    };
    const local = [shape("shape:foreign-session", 1, 10)];
    const sync = new AuthoritativeBoardSyncCoordinator(client);

    const refused = await sync.synchronize(sessionId, local);
    expect(refused.status).toBe("UNSYNCHRONIZED");
    expect(commits).toBe(0);

    sync.reset();
    const authorized = await sync.synchronize(
      sessionId,
      local,
      { allowBootstrapIntoEmptyAuthority: true }
    );
    expect(authorized).toMatchObject({
      status: "SYNCED",
      authoritativeRevision: BoardRevisionSchema.parse(1)
    });
    expect(commits).toBe(1);
  });

  it("recovers only the missing suffix of an explicitly authorized partial bootstrap", async () => {
    const sessionId = newSessionId();
    const committedMutations: Parameters<SyncClient["commitBoardMutation"]>[1][] = [];
    const client: SyncClient = {
      getBoardState: async () =>
        boardStateResponse(
          sessionId,
          BoardRevisionSchema.parse(1),
          [{
            shapeId: "shape:first-bootstrap",
            revision: 1,
            contentSha256: testShapeDigest(shape("shape:first-bootstrap", 1, 10))
          }]
        ),
      commitBoardMutation: async (_targetSessionId, mutation, options) => {
        committedMutations.push(mutation);
        return {
          protocolVersion: 1,
          ok: true,
          type: "BOARD_MUTATION_COMMITTED",
          requestId: options?.requestId ?? newRequestId(),
          sessionId,
          committed: true,
          boardRevision: BoardRevisionSchema.parse(2)
        };
      }
    };
    const sync = new AuthoritativeBoardSyncCoordinator(client);
    const snapshot = await sync.synchronize(
      sessionId,
      [
        shape("shape:first-bootstrap", 1, 10),
        shape("shape:missing-bootstrap", 1, 200)
      ],
      { allowBootstrapIntoEmptyAuthority: true }
    );

    expect(snapshot).toMatchObject({
      status: "SYNCED",
      authoritativeRevision: BoardRevisionSchema.parse(2),
      pendingMutationCount: 0
    });
    expect(committedMutations).toHaveLength(1);
    expect(committedMutations[0]).toMatchObject({
      baseBoardRevision: BoardRevisionSchema.parse(1),
      added: [{ id: "shape:missing-bootstrap", revision: 1 }]
    });
  });

  it("fails closed on reconnect when local shape revisions do not match authority", async () => {
    const sessionId = newSessionId();
    const client: SyncClient = {
      getBoardState: async () =>
        boardStateResponse(
          sessionId,
          BoardRevisionSchema.parse(3),
          [{ shapeId: "shape:queued", revision: 2 }]
        ),
      commitBoardMutation: async () => {
        throw new Error("Unexpected mutation during mismatch reconciliation");
      }
    };
    const sync = new AuthoritativeBoardSyncCoordinator(client);
    const snapshot = await sync.synchronize(
      sessionId,
      [shape("shape:queued", 1, 10)]
    );

    expect(snapshot.status).toBe("UNSYNCHRONIZED");
    expect(sync.currentAuthoritativeRevision()).toBeUndefined();
  });
});

function testShapeDigest(value: AuthoritativeStudentShape): string {
  return createHash("sha256")
    .update(authoritativeBoardShapeCanonicalJson(value), "utf8")
    .digest("hex");
}
