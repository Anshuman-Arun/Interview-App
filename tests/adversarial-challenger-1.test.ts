import { describe, expect, it } from "vitest";
import {
  BoardActionSchema,
  type BoardAction,
  type ReasoningProvider
} from "../packages/domain/src/index.js";
import {
  InMemoryTldrawEditor,
  StaleShapeRevisionError,
  StudentShapeImmutableError,
  TldrawWhiteboardAdapter
} from "../apps/web/src/tldraw-whiteboard-adapter.js";
import {
  GeminiApiAdapter,
  openProviderExecutionSession
} from "../packages/providers/src/index.js";
import { ProviderPolicyError } from "../packages/providers/src/policy.js";

const BASE_NOW = new Date("2026-08-30T04:00:00.000Z");

const STRICT_FREE_POLICY = {
  allowMeteredUsage: false,
  maximumDataUse: "REMOTE_MAY_BE_USED_FOR_IMPROVEMENT" as const,
  billingVerificationMaxAgeMs: 5_000
};

describe("Adversarial Test 1: Whiteboard Layer Isolation & Student Shape Immutability", () => {
  it("rejects erase_ai_annotation targeting STUDENT layer shape and ensures shape is 100% unmodified", async () => {
    const editor = new InMemoryTldrawEditor();
    const adapter = new TldrawWhiteboardAdapter(editor);

    const studentShape = adapter.createStudentShape({
      type: "geo",
      x: 120,
      y: 240,
      props: { geo: "rectangle", text: "Student Vertex v1", color: "blue", w: 100, h: 50 },
      shapeRevision: 1
    });

    const snapshotBefore = JSON.stringify(editor.getShape(studentShape.id));

    const maliciousAction: BoardAction = {
      operation: "erase_ai_annotation",
      layer: "AI_ANNOTATION",
      targetShapeId: studentShape.id,
      annotationPurpose: "adversarial probe: attempt to erase student shape"
    };

    await expect(adapter.applyAiOverlayAction(maliciousAction)).rejects.toThrow(
      StudentShapeImmutableError
    );

    const snapshotAfter = JSON.stringify(editor.getShape(studentShape.id));
    expect(snapshotAfter).toBe(snapshotBefore);
  });

  it("rejects erase_ai_annotation targeting SYSTEM_DECORATION layer shape", async () => {
    const editor = new InMemoryTldrawEditor();
    const adapter = new TldrawWhiteboardAdapter(editor);

    const systemShapeId = "shape:system_grid_background";
    editor.createShapes([
      {
        id: systemShapeId,
        type: "geo",
        x: 0,
        y: 0,
        meta: { layer: "SYSTEM_DECORATION", origin: "SYSTEM" }
      }
    ]);

    const snapshotBefore = JSON.stringify(editor.getShape(systemShapeId));

    const maliciousAction: BoardAction = {
      operation: "erase_ai_annotation",
      layer: "AI_ANNOTATION",
      targetShapeId: systemShapeId,
      annotationPurpose: "adversarial probe: attempt to erase system decoration"
    };

    await expect(adapter.applyAiOverlayAction(maliciousAction)).rejects.toThrow(
      StudentShapeImmutableError
    );

    const snapshotAfter = JSON.stringify(editor.getShape(systemShapeId));
    expect(snapshotAfter).toBe(snapshotBefore);
  });

  it("ensures un-targeted erase_ai_annotation never deletes student or system shapes when no AI shapes exist", async () => {
    const editor = new InMemoryTldrawEditor();
    const adapter = new TldrawWhiteboardAdapter(editor);

    const s1 = adapter.createStudentShape({ type: "geo", x: 10, y: 10, props: { text: "v1" } });
    const s2 = adapter.createStudentShape({ type: "geo", x: 60, y: 60, props: { text: "v2" } });

    editor.createShapes([
      {
        id: "shape:system_axis",
        type: "geo",
        x: 0,
        y: 0,
        meta: { layer: "SYSTEM_DECORATION" }
      }
    ]);

    expect(editor.getCurrentPageShapes()).toHaveLength(3);

    // Call erase_ai_annotation without targetShapeId
    await adapter.applyAiOverlayAction({
      operation: "erase_ai_annotation",
      layer: "AI_ANNOTATION",
      annotationPurpose: "erase latest when no AI shapes exist"
    });

    const shapesAfter = editor.getCurrentPageShapes();
    expect(shapesAfter).toHaveLength(3);
    expect(editor.getShape(s1.id)).toBeDefined();
    expect(editor.getShape(s2.id)).toBeDefined();
    expect(editor.getShape("shape:system_axis")).toBeDefined();
  });

  it("verifies all 6 constructive AI overlay operations leave targeted student shapes 100% immutable and strictly isolated", async () => {
    const editor = new InMemoryTldrawEditor();
    const adapter = new TldrawWhiteboardAdapter(editor);

    const studentShape = adapter.createStudentShape({
      type: "geo",
      x: 150,
      y: 150,
      props: { geo: "ellipse", text: "Original Student Node", w: 80, h: 80, color: "black" },
      shapeRevision: 1
    });

    const pristineStudentRecord = JSON.stringify(editor.getShape(studentShape.id));

    const operations: readonly BoardAction["operation"][] = [
      "circle",
      "highlight",
      "draw_arrow",
      "point_at",
      "write_text",
      "write_equation"
    ];

    for (const op of operations) {
      const action: BoardAction = {
        operation: op,
        layer: "AI_ANNOTATION",
        targetShapeId: studentShape.id,
        expectedShapeRevision: 1,
        content: `Hint for ${op}`,
        annotationPurpose: `adversarial immutability probe for ${op}`
      };

      await adapter.applyAiOverlayAction(action);

      // Verify the targeted student shape is bit-for-bit identical to its original state
      const currentStudentRecord = JSON.stringify(editor.getShape(studentShape.id));
      expect(currentStudentRecord).toBe(pristineStudentRecord);

      // Verify newly created shape has AI_ANNOTATION layer and AI origin
      const allShapes = editor.getCurrentPageShapes();
      const latestAiShape = allShapes[allShapes.length - 1];
      expect(latestAiShape).toBeDefined();
      expect(latestAiShape?.meta?.["layer"]).toBe("AI_ANNOTATION");
      expect(latestAiShape?.meta?.["origin"]).toBe("AI");
      expect(latestAiShape?.meta?.["targetShapeId"]).toBe(studentShape.id);
    }
  });

  it("rejects forged BoardActions attempting to claim non-AI layer at schema boundary", () => {
    const invalidActions = [
      {
        operation: "circle",
        layer: "STUDENT",
        annotationPurpose: "forged student layer claim"
      },
      {
        operation: "write_text",
        layer: "SYSTEM_DECORATION",
        annotationPurpose: "forged system layer claim"
      },
      {
        operation: "highlight",
        layer: "UNKNOWN_LAYER",
        annotationPurpose: "unknown layer claim"
      }
    ];

    for (const forged of invalidActions) {
      expect(() => BoardActionSchema.parse(forged)).toThrow();
    }
  });

  it("mass stress test: clearAiOverlay removes exactly 100% of AI shapes and leaves 100% of student/system shapes intact", async () => {
    const editor = new InMemoryTldrawEditor();
    const adapter = new TldrawWhiteboardAdapter(editor);

    // Create 30 student shapes
    const studentShapeIds: string[] = [];
    const studentSnapshots = new Map<string, string>();
    for (let i = 0; i < 30; i++) {
      const s = adapter.createStudentShape({
        type: "geo",
        x: i * 20,
        y: i * 15,
        props: { text: `Vertex ${String(i)}`, w: 50, h: 50 },
        shapeRevision: 1
      });
      studentShapeIds.push(s.id);
      studentSnapshots.set(s.id, JSON.stringify(editor.getShape(s.id)));
    }

    // Create 10 system shapes
    const systemShapeIds: string[] = [];
    const systemSnapshots = new Map<string, string>();
    for (let i = 0; i < 10; i++) {
      const sysId = `shape:system_element_${String(i)}`;
      editor.createShapes([
        {
          id: sysId,
          type: "geo",
          x: i * 100,
          y: 0,
          meta: { layer: "SYSTEM_DECORATION", origin: "SYSTEM" }
        }
      ]);
      systemShapeIds.push(sysId);
      systemSnapshots.set(sysId, JSON.stringify(editor.getShape(sysId)));
    }

    // Create 20 AI annotations
    for (let i = 0; i < 20; i++) {
      const targetId = studentShapeIds[i % studentShapeIds.length];
      await adapter.applyAiOverlayAction({
        operation: i % 2 === 0 ? "circle" : "highlight",
        layer: "AI_ANNOTATION",
        targetShapeId: targetId,
        expectedShapeRevision: 1,
        annotationPurpose: `ai hint ${String(i)}`
      });
    }

    expect(editor.getCurrentPageShapes()).toHaveLength(60);

    // Execute atomic clearAiOverlay
    await adapter.clearAiOverlay();

    const remainingShapes = editor.getCurrentPageShapes();
    expect(remainingShapes).toHaveLength(40); // 30 student + 10 system

    // Verify 0 AI shapes remain
    const remainingAiShapes = remainingShapes.filter((s) => s.meta?.["layer"] === "AI_ANNOTATION");
    expect(remainingAiShapes).toHaveLength(0);

    // Verify all student shapes are bit-for-bit identical
    for (const sId of studentShapeIds) {
      const current = JSON.stringify(editor.getShape(sId));
      expect(current).toBe(studentSnapshots.get(sId));
    }

    // Verify all system shapes are bit-for-bit identical
    for (const sysId of systemShapeIds) {
      const current = JSON.stringify(editor.getShape(sysId));
      expect(current).toBe(systemSnapshots.get(sysId));
    }

    // Idempotency: second clear does nothing
    await adapter.clearAiOverlay();
    expect(editor.getCurrentPageShapes()).toHaveLength(40);
  });
});

describe("Adversarial Test 2: Gemini Provider Gating & Admission Fail-Closed Defense", () => {
  it("rejects metered provider when policy forbids metered usage", async () => {
    const adapter = new GeminiApiAdapter({
      apiKey: "paid-key"
    });

    await expect(
      openProviderExecutionSession({
        provider: adapter,
        policy: STRICT_FREE_POLICY,
        now: BASE_NOW
      })
    ).rejects.toMatchObject({
      code: "SPEND_NOT_PROVEN_IMPOSSIBLE"
    });
  });

  it("fails closed when provider missing verifyBillingSafety method", async () => {
    const invalidProvider = {
      name: "tampered-gemini",
      adapterVersion: "1.0.0",
      capabilities: {
        inputModalities: new Set(["text" as const]),
        textStreaming: false,
        structuredOutput: "FINAL_ONLY" as const,
        persistentSession: false,
        resumableSession: false,
        cancellation: "CLOSE_CLIENT_STREAM" as const,
        sessionSurvivesClientAbort: false,
        sessionSurvivesProviderCancel: false,
        usageReporting: false,
        dataUse: "REMOTE_MAY_BE_USED_FOR_IMPROVEMENT" as const
      },
      // verifyBillingSafety is intentionally omitted
      createSession: () => Promise.reject(new Error("should not reach here"))
    } as unknown as ReasoningProvider;

    await expect(
      openProviderExecutionSession({
        provider: invalidProvider,
        policy: STRICT_FREE_POLICY,
        now: BASE_NOW
      })
    ).rejects.toMatchObject({
      code: "MISSING_BILLING_VERIFIER"
    });
  });

  it("fails closed when verifyBillingSafety throws an unexpected error", async () => {
    const faultyProvider: ReasoningProvider = {
      name: "faulty-gemini",
      adapterVersion: "1.0.0",
      capabilities: {
        inputModalities: new Set(["text"]),
        textStreaming: false,
        structuredOutput: "FINAL_ONLY",
        persistentSession: false,
        resumableSession: false,
        cancellation: "CLOSE_CLIENT_STREAM",
        sessionSurvivesClientAbort: false,
        sessionSurvivesProviderCancel: false,
        usageReporting: false,
        dataUse: "REMOTE_MAY_BE_USED_FOR_IMPROVEMENT"
      },
      verifyBillingSafety: () => Promise.reject(new Error("Billing database unreachable")),
      createSession: () => Promise.reject(new Error("should not reach here"))
    };

    await expect(
      openProviderExecutionSession({
        provider: faultyProvider,
        policy: STRICT_FREE_POLICY,
        now: BASE_NOW
      })
    ).rejects.toMatchObject({
      code: "BILLING_VERIFICATION_FAILED"
    });
  });

  describe("Forged / Tampered Billing Verification Proofs", () => {
    it("rejects forged proof claiming spendImpossible: false", async () => {
      const adapter = new GeminiApiAdapter({
        billingVerificationFactory: (now) => ({
          billingClass: "VERIFIED_FREE_ONLY",
          enforcementMechanism: "Forged proof",
          verifiedAt: now.toISOString(),
          adapterVersion: "1.0.0",
          spendImpossible: false
        })
      });

      await expect(
        openProviderExecutionSession({
          provider: adapter,
          policy: STRICT_FREE_POLICY,
          now: BASE_NOW
        })
      ).rejects.toThrow(ProviderPolicyError);
    });

    it("rejects forged proof with unauthorized billingClass (e.g. METERED or UNKNOWN)", async () => {
      const adapter = new GeminiApiAdapter({
        billingVerificationFactory: (now) => ({
          billingClass: "UNKNOWN",
          enforcementMechanism: "Unknown path",
          verifiedAt: now.toISOString(),
          adapterVersion: "1.0.0",
          spendImpossible: true
        })
      });

      await expect(
        openProviderExecutionSession({
          provider: adapter,
          policy: STRICT_FREE_POLICY,
          now: BASE_NOW
        })
      ).rejects.toThrow(ProviderPolicyError);
    });

    it("rejects proof with mismatched adapterVersion (replay attack across versions)", async () => {
      const adapter = new GeminiApiAdapter({
        adapterVersion: "1.0.0",
        billingVerificationFactory: (now) => ({
          billingClass: "VERIFIED_FREE_ONLY",
          enforcementMechanism: "Proof from obsolete version",
          verifiedAt: now.toISOString(),
          adapterVersion: "0.9.0", // Mismatched!
          spendImpossible: true
        })
      });

      await expect(
        openProviderExecutionSession({
          provider: adapter,
          policy: STRICT_FREE_POLICY,
          now: BASE_NOW
        })
      ).rejects.toMatchObject({
        code: "ADAPTER_VERSION_MISMATCH"
      });
    });

    it("rejects proof with empty or whitespace-only enforcementMechanism", async () => {
      const adapter = new GeminiApiAdapter({
        billingVerificationFactory: (now) => ({
          billingClass: "VERIFIED_FREE_ONLY",
          enforcementMechanism: "   ",
          verifiedAt: now.toISOString(),
          adapterVersion: "1.0.0",
          spendImpossible: true
        })
      });

      await expect(
        openProviderExecutionSession({
          provider: adapter,
          policy: STRICT_FREE_POLICY,
          now: BASE_NOW
        })
      ).rejects.toMatchObject({
        code: "INVALID_BILLING_VERIFICATION"
      });
    });
  });

  describe("Clock Skew & Timestamp Boundaries", () => {
    it("rejects proof timestamped in the future (future clock skew)", async () => {
      const futureNow = new Date(BASE_NOW.getTime() + 1_000); // 1 sec in future
      const adapter = new GeminiApiAdapter({
        billingVerificationFactory: () => ({
          billingClass: "VERIFIED_FREE_ONLY",
          enforcementMechanism: "Future proof",
          verifiedAt: futureNow.toISOString(),
          adapterVersion: "1.0.0",
          spendImpossible: true
        })
      });

      await expect(
        openProviderExecutionSession({
          provider: adapter,
          policy: STRICT_FREE_POLICY,
          now: BASE_NOW
        })
      ).rejects.toMatchObject({
        code: "VERIFICATION_FUTURE"
      });
    });

    it("rejects proof older than billingVerificationMaxAgeMs (stale clock skew)", async () => {
      const maxAgeMs = STRICT_FREE_POLICY.billingVerificationMaxAgeMs; // 5000ms
      const staleTime = new Date(BASE_NOW.getTime() - maxAgeMs - 1); // 5001ms ago

      const adapter = new GeminiApiAdapter({
        billingVerificationFactory: () => ({
          billingClass: "VERIFIED_FREE_ONLY",
          enforcementMechanism: "Stale proof",
          verifiedAt: staleTime.toISOString(),
          adapterVersion: "1.0.0",
          spendImpossible: true
        })
      });

      await expect(
        openProviderExecutionSession({
          provider: adapter,
          policy: STRICT_FREE_POLICY,
          now: BASE_NOW
        })
      ).rejects.toMatchObject({
        code: "VERIFICATION_STALE"
      });
    });

    it("accepts proof at exact boundary timestamps (verifiedAt === now and verifiedAt === now - maxAgeMs)", async () => {
      const maxAgeMs = STRICT_FREE_POLICY.billingVerificationMaxAgeMs;
      const exactBoundaryTime = new Date(BASE_NOW.getTime() - maxAgeMs);

      const fetchMock = () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              candidates: [{ content: { parts: [{ text: JSON.stringify({ realizedAction: "WAIT", claimedDisclosureLevel: 0, claimedDisclosureIds: [] }) }] } }]
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          )
        );

      const adapter = new GeminiApiAdapter({
        fetchImpl: fetchMock,
        billingVerificationFactory: () => ({
          billingClass: "VERIFIED_FREE_ONLY",
          enforcementMechanism: "Boundary proof",
          verifiedAt: exactBoundaryTime.toISOString(),
          adapterVersion: "1.0.0",
          spendImpossible: true
        })
      });

      const session = await openProviderExecutionSession({
        provider: adapter,
        policy: STRICT_FREE_POLICY,
        now: BASE_NOW
      });

      expect(session.providerName).toBe("gemini-api");
      await session.close();
    });

    it("rejects malformed unparseable ISO datetime in verifiedAt", async () => {
      const adapter = new GeminiApiAdapter({
        billingVerificationFactory: () => ({
          billingClass: "VERIFIED_FREE_ONLY",
          enforcementMechanism: "Corrupt time",
          verifiedAt: "2026-99-99T99:99:99.999Z",
          adapterVersion: "1.0.0",
          spendImpossible: true
        })
      });

      await expect(
        openProviderExecutionSession({
          provider: adapter,
          policy: STRICT_FREE_POLICY,
          now: BASE_NOW
        })
      ).rejects.toThrow();
    });

    it("rejects invalid NaN clock passed into openProviderExecutionSession", async () => {
      const adapter = new GeminiApiAdapter();
      await expect(
        openProviderExecutionSession({
          provider: adapter,
          policy: STRICT_FREE_POLICY,
          now: new Date("invalid date string")
        })
      ).rejects.toMatchObject({
        code: "INVALID_CLOCK"
      });
    });
  });

  describe("DataUse Policy Boundary Enforcement", () => {
    it("strictly forbids REMOTE_MAY_BE_USED_FOR_IMPROVEMENT under LOCAL_ONLY or REMOTE_NO_TRAINING policy", async () => {
      const adapter = new GeminiApiAdapter({
        dataUse: "REMOTE_MAY_BE_USED_FOR_IMPROVEMENT"
      });

      await expect(
        openProviderExecutionSession({
          provider: adapter,
          policy: {
            allowMeteredUsage: false,
            maximumDataUse: "LOCAL_ONLY",
            billingVerificationMaxAgeMs: 5_000
          },
          now: BASE_NOW
        })
      ).rejects.toMatchObject({
        code: "DATA_USE_EXCEEDS_POLICY"
      });

      await expect(
        openProviderExecutionSession({
          provider: adapter,
          policy: {
            allowMeteredUsage: false,
            maximumDataUse: "REMOTE_NO_TRAINING",
            billingVerificationMaxAgeMs: 5_000
          },
          now: BASE_NOW
        })
      ).rejects.toMatchObject({
        code: "DATA_USE_EXCEEDS_POLICY"
      });
    });
  });
});

describe("Adversarial Test 3: Shape Revision Mismatch & Stale Reference Refusal", () => {
  it("refuses AI overlay hint when target shape has been edited by student (actual revision > expected revision)", async () => {
    const editor = new InMemoryTldrawEditor();
    const adapter = new TldrawWhiteboardAdapter(editor);

    const vertex = adapter.createStudentShape({
      type: "geo",
      x: 100,
      y: 100,
      props: { text: "v1" },
      shapeRevision: 1
    });

    // Student moves or edits vertex, bumping revision to 2
    adapter.updateStudentShape(vertex.id, { x: 150 });
    expect(editor.getShape(vertex.id)?.meta?.["shapeRevision"]).toBe(2);

    // AI attempts to deliver hint generated against revision 1
    const staleAction: BoardAction = {
      operation: "circle",
      layer: "AI_ANNOTATION",
      targetShapeId: vertex.id,
      expectedShapeRevision: 1, // Stale!
      annotationPurpose: "circle v1 based on old position"
    };

    await expect(adapter.applyAiOverlayAction(staleAction)).rejects.toThrow(
      StaleShapeRevisionError
    );

    // Verify NO AI overlay shapes were created
    const shapes = editor.getCurrentPageShapes();
    expect(shapes).toHaveLength(1);
    expect(shapes[0]?.id).toBe(vertex.id);
  });

  it("refuses AI overlay hint when expectedShapeRevision is speculatively in the future (expected > actual)", async () => {
    const editor = new InMemoryTldrawEditor();
    const adapter = new TldrawWhiteboardAdapter(editor);

    const vertex = adapter.createStudentShape({
      type: "geo",
      x: 100,
      y: 100,
      shapeRevision: 2
    });

    const phantomAction: BoardAction = {
      operation: "highlight",
      layer: "AI_ANNOTATION",
      targetShapeId: vertex.id,
      expectedShapeRevision: 5, // Phantom forward revision!
      annotationPurpose: "highlight speculative revision"
    };

    await expect(adapter.applyAiOverlayAction(phantomAction)).rejects.toThrow(
      StaleShapeRevisionError
    );

    expect(editor.getCurrentPageShapes()).toHaveLength(1);
  });

  it("refuses hint targeting a shape that does not exist on canvas", async () => {
    const editor = new InMemoryTldrawEditor();
    const adapter = new TldrawWhiteboardAdapter(editor);

    const missingAction: BoardAction = {
      operation: "point_at",
      layer: "AI_ANNOTATION",
      targetShapeId: "shape:non_existent_ghost_shape",
      expectedShapeRevision: 1,
      annotationPurpose: "point at hallucinated node"
    };

    await expect(adapter.applyAiOverlayAction(missingAction)).rejects.toThrow(
      StaleShapeRevisionError
    );

    expect(editor.getCurrentPageShapes()).toHaveLength(0);
  });

  it("refuses action where expectedShapeRevision is provided without targetShapeId", async () => {
    const editor = new InMemoryTldrawEditor();
    const adapter = new TldrawWhiteboardAdapter(editor);

    const orphanAction: BoardAction = {
      operation: "write_equation",
      layer: "AI_ANNOTATION",
      expectedShapeRevision: 1,
      content: "d(v) >= 3",
      annotationPurpose: "equation with invalid revision constraint"
    };

    await expect(adapter.applyAiOverlayAction(orphanAction)).rejects.toThrow(
      StaleShapeRevisionError
    );

    expect(editor.getCurrentPageShapes()).toHaveLength(0);
  });

  it("simulates concurrent multi-turn race: stale hints are rejected while fresh hints are accepted", async () => {
    const editor = new InMemoryTldrawEditor();
    const adapter = new TldrawWhiteboardAdapter(editor);

    // Student creates 3 vertices
    const v1 = adapter.createStudentShape({ type: "geo", x: 100, y: 100, props: { text: "v1" }, shapeRevision: 1 });
    const v2 = adapter.createStudentShape({ type: "geo", x: 200, y: 100, props: { text: "v2" }, shapeRevision: 1 });
    const v3 = adapter.createStudentShape({ type: "geo", x: 300, y: 100, props: { text: "v3" }, shapeRevision: 1 });

    // Concurrently: Student edits v2, bumping v2's revision to 2
    adapter.updateStudentShape(v2.id, { x: 220, props: { text: "v2 (moved)" } });

    // AI delivers 3 hints computed during turn:
    // Hint 1: targets v1 at rev 1 (Fresh)
    const hint1: BoardAction = {
      operation: "circle",
      layer: "AI_ANNOTATION",
      targetShapeId: v1.id,
      expectedShapeRevision: 1,
      annotationPurpose: "hint on v1"
    };
    await expect(adapter.applyAiOverlayAction(hint1)).resolves.not.toThrow();

    // Hint 2: targets v2 at rev 1 (Stale because student moved v2)
    const hint2: BoardAction = {
      operation: "draw_arrow",
      layer: "AI_ANNOTATION",
      targetShapeId: v2.id,
      expectedShapeRevision: 1,
      annotationPurpose: "stale arrow on v2"
    };
    await expect(adapter.applyAiOverlayAction(hint2)).rejects.toThrow(StaleShapeRevisionError);

    // Hint 3: targets v3 at rev 1 (Fresh)
    const hint3: BoardAction = {
      operation: "point_at",
      layer: "AI_ANNOTATION",
      targetShapeId: v3.id,
      expectedShapeRevision: 1,
      annotationPurpose: "hint on v3"
    };
    await expect(adapter.applyAiOverlayAction(hint3)).resolves.not.toThrow();

    // Verify that Hint 1 and Hint 3 were rendered, while Hint 2 was cleanly discarded
    const shapes = editor.getCurrentPageShapes();
    expect(shapes).toHaveLength(5); // 3 student + 2 AI hints

    const aiShapes = shapes.filter((s) => s.meta?.["layer"] === "AI_ANNOTATION");
    expect(aiShapes).toHaveLength(2);
    expect(aiShapes.some((s) => s.meta?.["targetShapeId"] === v1.id)).toBe(true);
    expect(aiShapes.some((s) => s.meta?.["targetShapeId"] === v3.id)).toBe(true);
    expect(aiShapes.some((s) => s.meta?.["targetShapeId"] === v2.id)).toBe(false);
  });
});
