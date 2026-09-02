import {
  MAX_AUTHORITATIVE_BOARD_SHAPES,
  MAX_BOARD_MUTATION_SHAPES,
  NormalizedBoardMutationSchema,
  RequestIdSchema,
  type AuthoritativeStudentShape,
  type BoardRevision,
  type NormalizedBoardMutation,
  type RequestId,
  type SessionId
} from "../../../../packages/domain/src/index.js";
import type { StudentShape } from "../../../../packages/whiteboard/src/index.js";
import type { BrowserCommandClient } from "../command-client.js";
import type { NormalizedStudentShapeChange } from "./normalized-board.js";

export type AuthoritativeBoardSyncStatus =
  | "UNINITIALIZED"
  | "SYNCED"
  | "PENDING"
  | "UNSYNCHRONIZED";

export interface AuthoritativeBoardSyncSnapshot {
  readonly status: AuthoritativeBoardSyncStatus;
  readonly authoritativeRevision?: BoardRevision;
  readonly pendingMutationCount: number;
  readonly reason?: string;
}

interface PendingMutation {
  readonly requestId: RequestId;
  readonly fingerprint: string;
  readonly change: Omit<NormalizedBoardMutation, "baseBoardRevision">;
  attempts: number;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

const MAX_PENDING_MUTATIONS = 64;
const MAX_RECENT_FINGERPRINTS = 128;
const MAX_TRANSPORT_ATTEMPTS = 2;

export class AuthoritativeBoardSyncCoordinator {
  private sessionId: SessionId | undefined;
  private authoritativeRevision: BoardRevision | undefined;
  private status: AuthoritativeBoardSyncStatus = "UNINITIALIZED";
  private reason: string | undefined;
  private readonly pending: PendingMutation[] = [];
  private readonly recentFingerprints: string[] = [];
  private draining = false;
  private lifecycleEpoch = 0;

  public constructor(
    private readonly client: Pick<BrowserCommandClient, "commitBoardMutation" | "getBoardState">
  ) {}

  public snapshot(): AuthoritativeBoardSyncSnapshot {
    return {
      status: this.status,
      ...(this.authoritativeRevision === undefined
        ? {}
        : { authoritativeRevision: this.authoritativeRevision }),
      pendingMutationCount: this.pending.length,
      ...(this.reason === undefined ? {} : { reason: this.reason })
    };
  }

  public canBindCurrentCanvasToAuthority(): boolean {
    return this.status === "SYNCED"
      && !this.draining
      && this.pending.length === 0
      && this.authoritativeRevision !== undefined;
  }

  public currentAuthoritativeRevision(): BoardRevision | undefined {
    return this.canBindCurrentCanvasToAuthority()
      ? this.authoritativeRevision
      : undefined;
  }

  public reset(): void {
    this.lifecycleEpoch += 1;
    this.rejectPending(new Error("Whiteboard authority synchronization was reset"));
    this.sessionId = undefined;
    this.authoritativeRevision = undefined;
    this.status = "UNINITIALIZED";
    this.reason = undefined;
    this.recentFingerprints.length = 0;
  }

  public async synchronize(
    sessionId: SessionId,
    localShapes: readonly StudentShape[]
  ): Promise<AuthoritativeBoardSyncSnapshot> {
    const epoch = this.lifecycleEpoch + 1;
    this.lifecycleEpoch = epoch;
    if (localShapes.length > MAX_AUTHORITATIVE_BOARD_SHAPES) {
      return this.failClosed("Local whiteboard exceeds the authoritative shape limit");
    }
    const state = await this.client.getBoardState(sessionId);
    if (epoch !== this.lifecycleEpoch) return this.snapshot();
    this.sessionId = sessionId;

    if (!state.shapeAuthorityKnown) {
      return this.failClosed("Recovered board shape authority is unavailable");
    }

    if (this.pending.length > 0 && shapesMatch(localShapes, state.shapeRevisions)) {
      this.authoritativeRevision = state.boardRevision;
      this.pending.splice(0).forEach((entry) => entry.resolve());
      this.status = "SYNCED";
      this.reason = undefined;
      return this.snapshot();
    }

    if (this.pending.length > 0) {
      return this.failClosed("Authoritative state changed while whiteboard mutations were pending");
    }

    if (shapesMatch(localShapes, state.shapeRevisions)) {
      this.authoritativeRevision = state.boardRevision;
      this.status = "SYNCED";
      this.reason = undefined;
      return this.snapshot();
    }

    if (state.boardRevision !== 0 || state.shapeRevisions.length !== 0) {
      return this.failClosed("Local whiteboard does not match recovered authoritative shape revisions");
    }

    this.authoritativeRevision = state.boardRevision;
    this.status = "SYNCED";
    this.reason = undefined;
    for (let offset = 0; offset < localShapes.length; offset += MAX_BOARD_MUTATION_SHAPES) {
      const chunk = localShapes.slice(offset, offset + MAX_BOARD_MUTATION_SHAPES);
      const change = {
        added: chunk.map(toAuthoritativeShape),
        updated: [],
        deleted: []
      };
      await this.enqueuePrepared(change, fingerprintPrepared(change));
    }
    return this.snapshot();
  }

  public submit(change: NormalizedStudentShapeChange): Promise<void> {
    if (this.sessionId === undefined || this.authoritativeRevision === undefined) {
      return Promise.reject(new Error("Whiteboard authority has not been synchronized"));
    }
    if (this.status === "UNSYNCHRONIZED") {
      return Promise.reject(new Error(this.reason ?? "Whiteboard authority is unsynchronized"));
    }

    const prepared = prepareMutation(change);
    const fingerprint = fingerprintPrepared(prepared);
    if (this.recentFingerprints.includes(fingerprint)
        || this.pending.some((entry) => entry.fingerprint === fingerprint)) {
      return Promise.resolve();
    }
    return this.enqueuePrepared(prepared, fingerprint);
  }

  private enqueuePrepared(
    change: Omit<NormalizedBoardMutation, "baseBoardRevision">,
    fingerprint: string
  ): Promise<void> {
    if (this.pending.length >= MAX_PENDING_MUTATIONS) {
      this.failClosed("Whiteboard mutation backlog exceeded its bound");
      return Promise.reject(new Error("Whiteboard mutation backlog exceeded its bound"));
    }

    const requestId = RequestIdSchema.parse(`request_${globalThis.crypto.randomUUID()}`);
    const promise = new Promise<void>((resolve, reject) => {
      this.pending.push({
        requestId,
        fingerprint,
        change,
        attempts: 0,
        resolve,
        reject
      });
    });
    this.status = "PENDING";
    void this.drain();
    return promise;
  }

  private async drain(): Promise<void> {
    if (this.draining || this.status === "UNSYNCHRONIZED") return;
    const epoch = this.lifecycleEpoch;
    this.draining = true;
    try {
      while (this.pending.length > 0) {
        const entry = this.pending[0];
        if (
          entry === undefined
          || this.sessionId === undefined
          || this.authoritativeRevision === undefined
        ) {
          this.failClosed("Whiteboard synchronization lost its session or revision basis");
          return;
        }

        const mutation = NormalizedBoardMutationSchema.parse({
          baseBoardRevision: this.authoritativeRevision,
          ...entry.change
        });
        let response;
        for (;;) {
          entry.attempts += 1;
          try {
            response = await this.client.commitBoardMutation(
              this.sessionId,
              mutation,
              { requestId: entry.requestId }
            );
            break;
          } catch (error) {
            if (epoch !== this.lifecycleEpoch) return;
            if (entry.attempts >= MAX_TRANSPORT_ATTEMPTS) {
              this.failClosed(
                "Whiteboard mutation acknowledgement is unknown after transport failure",
                error instanceof Error ? error : new Error("Whiteboard mutation transport failed")
              );
              return;
            }
          }
        }
        if (epoch !== this.lifecycleEpoch) return;

        if (!response.committed) {
          this.authoritativeRevision = response.boardRevision;
          this.failClosed(`Whiteboard mutation was rejected: ${response.reason ?? "UNKNOWN"}`);
          return;
        }

        this.authoritativeRevision = response.boardRevision;
        this.pending.shift();
        rememberFingerprint(this.recentFingerprints, entry.fingerprint);
        entry.resolve();
      }
      if (epoch !== this.lifecycleEpoch) return;
      this.status = "SYNCED";
      this.reason = undefined;
    } finally {
      this.draining = false;
    }
  }

  private failClosed(reason: string, cause?: Error): AuthoritativeBoardSyncSnapshot {
    this.lifecycleEpoch += 1;
    this.status = "UNSYNCHRONIZED";
    this.reason = reason;
    this.rejectPending(cause ?? new Error(reason));
    return this.snapshot();
  }

  private rejectPending(error: Error): void {
    for (const entry of this.pending.splice(0)) entry.reject(error);
  }
}

function prepareMutation(
  change: NormalizedStudentShapeChange
): Omit<NormalizedBoardMutation, "baseBoardRevision"> {
  return {
    added: change.added.map(toAuthoritativeShape),
    updated: change.updated.map((entry) => ({
      beforeRevision: entry.before.revision,
      shape: toAuthoritativeShape(entry.after)
    })),
    deleted: change.deleted.map((shape) => ({
      shapeId: shape.id,
      expectedRevision: shape.revision
    }))
  };
}

function toAuthoritativeShape(shape: StudentShape): AuthoritativeStudentShape {
  return {
    id: shape.id,
    type: shape.type,
    bounds: { ...shape.bounds },
    ...(shape.points === undefined
      ? {}
      : { points: shape.points.map((point) => ({ ...point })) }),
    ...(shape.text === undefined ? {} : { text: shape.text }),
    revision: shape.revision,
    createdAt: shape.createdAt,
    lastModifiedAt: shape.lastModifiedAt
  };
}

function shapesMatch(
  localShapes: readonly StudentShape[],
  remote: readonly { readonly shapeId: string; readonly revision: number }[]
): boolean {
  if (localShapes.length !== remote.length) return false;
  const local = localShapes
    .map((shape) => ({ shapeId: shape.id, revision: shape.revision }))
    .sort((left, right) => left.shapeId.localeCompare(right.shapeId));
  for (let index = 0; index < local.length; index += 1) {
    if (
      local[index]?.shapeId !== remote[index]?.shapeId
      || local[index]?.revision !== remote[index]?.revision
    ) return false;
  }
  return true;
}

function fingerprintPrepared(
  prepared: Omit<NormalizedBoardMutation, "baseBoardRevision">
): string {
  return JSON.stringify(prepared);
}

function rememberFingerprint(recent: string[], fingerprint: string): void {
  recent.push(fingerprint);
  while (recent.length > MAX_RECENT_FINGERPRINTS) recent.shift();
}
