import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BoardRevisionSchema,
  type WhiteboardVisionSnapshotResponse
} from "../packages/domain/src/index.js";
import type { StudentShape } from "../packages/whiteboard/src/index.js";
import type { NormalizedStudentShapeChange } from "../apps/web/src/whiteboard/normalized-board.js";
import {
  WhiteboardVisionScheduler
} from "../apps/web/src/whiteboard/vision-scheduler.js";
import { newSessionId } from "../packages/domain/src/index.js";

function shape(
  id: string,
  revision: number,
  x = 0,
  width = 100,
  height = 100
): StudentShape {
  return {
    id,
    type: "rectangle",
    bounds: { x, y: 0, width, height },
    revision,
    createdAt: 1,
    lastModifiedAt: revision
  };
}

function addedChange(value: StudentShape): NormalizedStudentShapeChange {
  return {
    source: "EDITOR",
    added: [value],
    updated: [],
    deleted: []
  };
}

function updatedChange(
  before: StudentShape,
  after: StudentShape
): NormalizedStudentShapeChange {
  return {
    source: "EDITOR",
    added: [],
    updated: [{ before, after }],
    deleted: []
  };
}

function acceptedResponse(
  upload: Parameters<ConstructorParameters<typeof WhiteboardVisionScheduler>[0]["submit"]>[0]
): WhiteboardVisionSnapshotResponse {
  return {
    protocolVersion: 1,
    requestId: upload.requestId,
    sessionId: upload.sessionId,
    status: "ACCEPTED",
    observationCount: 1,
    evidenceCommittedCount: 0
  };
}

describe("whiteboard vision dirty scheduler", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("cancels and requeues a capture when the student edits during snapshot export", async () => {
    vi.useFakeTimers();
    let revision = BoardRevisionSchema.parse(1);
    let shapes: readonly StudentShape[] = [shape("shape:a", 1)];
    let captureCount = 0;
    let firstCaptureResolve!: (value: {
      readonly bytes: Uint8Array;
      readonly width: number;
      readonly height: number;
    }) => void;
    let firstCaptureStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      firstCaptureStarted = resolve;
    });
    const uploads: Parameters<ConstructorParameters<typeof WhiteboardVisionScheduler>[0]["submit"]>[0][] = [];

    const scheduler = new WhiteboardVisionScheduler({
      sessionId: newSessionId(),
      debounceMs: 0,
      getAuthoritativeRevision: () => revision,
      getStudentShapes: () => shapes,
      captureRegion: async () => {
        captureCount += 1;
        if (captureCount === 1) {
          firstCaptureStarted();
          return new Promise((resolve) => {
            firstCaptureResolve = resolve;
          });
        }
        return {
          bytes: new Uint8Array([1, 2, 3]),
          width: 16,
          height: 16
        };
      },
      submit: async (upload) => {
        uploads.push(upload);
        return acceptedResponse(upload);
      }
    });

    try {
      const firstShape = shape("shape:a", 1);
      scheduler.record(addedChange(firstShape));
      await vi.advanceTimersByTimeAsync(0);
      await firstStarted;

      const secondShape = shape("shape:a", 2, 30);
      shapes = [secondShape];
      revision = BoardRevisionSchema.parse(2);
      scheduler.record(updatedChange(firstShape, secondShape));

      firstCaptureResolve({
        bytes: new Uint8Array([1, 2, 3]),
        width: 16,
        height: 16
      });
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();

      expect(captureCount).toBe(2);
      expect(uploads).toHaveLength(1);
      expect(uploads[0]?.sourceBoardRevision).toBe(BoardRevisionSchema.parse(2));
      expect(uploads[0]?.relevantShapeRevisions).toEqual([{
        shapeId: "shape:a",
        expectedRevision: 2
      }]);
    } finally {
      scheduler.dispose();
    }
  });

  it("retries one transient flush failure without dropping the dirty region", async () => {
    vi.useFakeTimers();
    const currentShape = shape("shape:a", 1);
    let attempts = 0;
    const scheduler = new WhiteboardVisionScheduler({
      sessionId: newSessionId(),
      debounceMs: 1,
      getAuthoritativeRevision: () => BoardRevisionSchema.parse(1),
      getStudentShapes: () => [currentShape],
      captureRegion: async () => ({
        bytes: new Uint8Array([1, 2, 3]),
        width: 16,
        height: 16
      }),
      submit: async (upload) => {
        attempts += 1;
        if (attempts === 1) throw new Error("transient loopback failure");
        return acceptedResponse(upload);
      }
    });

    try {
      scheduler.record(addedChange(currentShape));
      await vi.advanceTimersByTimeAsync(1);
      expect(attempts).toBe(1);
      expect(scheduler.pendingDirtyBoxCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(attempts).toBe(2);
      expect(scheduler.pendingDirtyBoxCount()).toBe(0);
      expect(scheduler.getLastResponse()?.status).toBe("ACCEPTED");
    } finally {
      scheduler.dispose();
    }
  });

  it("bounds scheduler-level retries during a persistent flush failure", async () => {
    vi.useFakeTimers();
    const currentShape = shape("shape:a", 1);
    let attempts = 0;
    const scheduler = new WhiteboardVisionScheduler({
      sessionId: newSessionId(),
      debounceMs: 1,
      getAuthoritativeRevision: () => BoardRevisionSchema.parse(1),
      getStudentShapes: () => [currentShape],
      captureRegion: async () => ({
        bytes: new Uint8Array([1, 2, 3]),
        width: 16,
        height: 16
      }),
      submit: async () => {
        attempts += 1;
        throw new Error("persistent loopback failure");
      }
    });

    try {
      scheduler.record(addedChange(currentShape));
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(attempts).toBe(2);
      expect(scheduler.pendingDirtyBoxCount()).toBe(0);
    } finally {
      scheduler.dispose();
    }
  });

  it("collapses a long dirty sequence into a bounded backlog", () => {
    const scheduler = new WhiteboardVisionScheduler({
      sessionId: newSessionId(),
      debounceMs: 10_000,
      getAuthoritativeRevision: () => undefined,
      getStudentShapes: () => [],
      captureRegion: async () => ({
        bytes: new Uint8Array([1]),
        width: 1,
        height: 1
      }),
      submit: async (upload) => acceptedResponse(upload)
    });

    try {
      for (let index = 0; index < 500; index += 1) {
        scheduler.record(addedChange(
          shape(`shape:${String(index)}`, 1, index * 2, 1, 1)
        ));
      }
      expect(scheduler.pendingDirtyBoxCount()).toBeLessThanOrEqual(128);
    } finally {
      scheduler.dispose();
    }
  });

  it("drops enormous dirty regions before capture", async () => {
    vi.useFakeTimers();
    const huge = shape("shape:huge", 1, 0, 5_000, 5_000);
    let captures = 0;
    const scheduler = new WhiteboardVisionScheduler({
      sessionId: newSessionId(),
      debounceMs: 0,
      getAuthoritativeRevision: () => BoardRevisionSchema.parse(1),
      getStudentShapes: () => [huge],
      captureRegion: async () => {
        captures += 1;
        return {
          bytes: new Uint8Array([1]),
          width: 1,
          height: 1
        };
      },
      submit: async (upload) => acceptedResponse(upload)
    });

    try {
      scheduler.record(addedChange(huge));
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
      expect(captures).toBe(0);
    } finally {
      scheduler.dispose();
    }
  });

  it("rejects dirty regions containing more than the bounded relevant-shape set before capture", async () => {
    vi.useFakeTimers();
    const shapes = Array.from(
      { length: 65 },
      (_, index) => shape(`shape:${String(index)}`, 1, index)
    );
    let captures = 0;
    const scheduler = new WhiteboardVisionScheduler({
      sessionId: newSessionId(),
      debounceMs: 0,
      getAuthoritativeRevision: () => BoardRevisionSchema.parse(1),
      getStudentShapes: () => shapes,
      captureRegion: async () => {
        captures += 1;
        return {
          bytes: new Uint8Array([1]),
          width: 1,
          height: 1
        };
      },
      submit: async (upload) => acceptedResponse(upload)
    });

    try {
      scheduler.record(addedChange(shapes[0] ?? shape("shape:fallback", 1)));
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
      expect(captures).toBe(0);
    } finally {
      scheduler.dispose();
    }
  });
});
