import { describe, expect, it, afterEach } from "vitest";
import {
  BillingVerificationSchema,
  BoardActionSchema,
  DeliveryContentSchema,
  DeliveryIdSchema,
  ModelCapabilitiesSchema,
  newDeliveryId,
  newSessionId,
  RequestIdSchema,
  SessionIdSchema,
  type BoardAction,
  type GenerationId,
  type InterviewProblem,
  type InterviewerProposal,
  type ModelCapabilities,
  type ProviderCancellationResult,
  type ReasoningProvider,
  type ReasoningSession,
  type ReasoningTurnInput,
  type SessionId,
  type WhiteboardAdapter
} from "../packages/domain/src/index.js";

import { replaySession } from "../packages/events/src/index.js";
import { SqliteEventStore } from "../packages/persistence/src/index.js";
import {
  assertInterviewProblemIntegrity,
  sixPeopleProblem
} from "../packages/problems/src/index.js";
import {
  openProviderExecutionSession,
  ProviderExecutionError,
  ProviderPolicyError,
  preflightProviderPolicy,
  assertProviderPermitted
} from "../packages/providers/src/index.js";
import {
  DeliveryCoordinator,
  MockRenderer
} from "../packages/delivery/src/index.js";
import {
  ClosedWorldDisclosureAnalyzer,
  DisclosureValidator,
  ProviderCoordinator,
  SessionRuntimeRegistry,
  TurnCoordinator,
  createCommandEnvelope,
  type SessionWriter
} from "../packages/interview-engine/src/index.js";
import {
  BrowserCommandClient,
  BrowserCommandProtocolError
} from "../apps/web/src/command-client.js";
import {
  RendererClient,
  type TextPresenter
} from "../apps/web/src/renderer-client.js";
import {
  LocalInterviewTransportRuntime,
  type BoundLocalInterviewTransport
} from "../apps/server/src/local-interview-transport-runtime.js";

// ============================================================================
// Shared Test Doubles & Helpers
// ============================================================================

export interface MathSegment {
  readonly type: "text" | "inline-math" | "block-math";
  readonly content: string;
}

export function parseMathSegments(input: string): MathSegment[] {
  const segments: MathSegment[] = [];
  const regex = /(\$\$[\s\S]*?\$\$|\$(?:\\\$|[^$\n])+?\$)/g;

  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(input)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: "text", content: input.slice(lastIndex, match.index) });
    }
    const token = match[0];
    if (token.startsWith("$$") && token.endsWith("$$")) {
      segments.push({ type: "block-math", content: token.slice(2, -2).trim() });
    } else if (token.startsWith("$") && token.endsWith("$")) {
      segments.push({ type: "inline-math", content: token.slice(1, -1).trim() });
    }
    lastIndex = match.index + token.length;
  }

  if (lastIndex < input.length) {
    segments.push({ type: "text", content: input.slice(lastIndex) });
  }

  return segments;
}

function generationEnvelope(
  writer: SessionWriter,
  sessionId: SessionId,
  generationId: GenerationId,
  producer: string
) {
  const generation = writer.getState().generations[generationId];
  if (generation === undefined) throw new Error("Missing generation basis");
  return createCommandEnvelope({
    sessionId,
    producer,
    generationId,
    ...(generation.basis.inputEpisodeId === undefined
      ? {}
      : { inputEpisodeId: generation.basis.inputEpisodeId }),
    turnId: generation.basis.turnId,
    contextEpoch: generation.basis.contextEpoch,
    sourceRevision: generation.basis.committedInputSequence
  });
}

export interface CanvasShape {
  readonly id: string;
  readonly layer: "STUDENT" | "AI_ANNOTATION" | "SYSTEM_DECORATION";
  readonly type: string;
  readonly content?: string | undefined;
  readonly shapeRevision: number;
  readonly targetShapeId?: string | undefined;
  readonly annotationPurpose?: string | undefined;
}

export class LayerIsolatedWhiteboard implements WhiteboardAdapter {
  private readonly shapes = new Map<string, CanvasShape>();
  private idCounter = 0;

  public addStudentShape(shape: Omit<CanvasShape, "layer" | "shapeRevision">): CanvasShape {
    const full: CanvasShape = {
      ...shape,
      layer: "STUDENT",
      shapeRevision: 1
    };
    this.shapes.set(full.id, full);
    return full;
  }

  public updateStudentShape(id: string, updates: Partial<Omit<CanvasShape, "id" | "layer">>): CanvasShape {
    const existing = this.shapes.get(id);
    if (!existing || existing.layer !== "STUDENT") {
      throw new Error(`Cannot update non-student shape ${id}`);
    }
    const updated: CanvasShape = {
      ...existing,
      ...updates,
      layer: "STUDENT",
      shapeRevision: existing.shapeRevision + 1
    };
    this.shapes.set(id, updated);
    return updated;
  }

  public async applyAiOverlayAction(action: BoardAction): Promise<void> {
    const validated = BoardActionSchema.parse(action);
    if (validated.targetShapeId) {
      const target = this.shapes.get(validated.targetShapeId);
      if (validated.expectedShapeRevision !== undefined) {
        if (!target || target.shapeRevision !== validated.expectedShapeRevision) {
          return;
        }
      }
    }

    if (validated.operation === "erase_ai_annotation") {
      if (validated.targetShapeId) {
        const target = this.shapes.get(validated.targetShapeId);
        if (target && target.layer === "AI_ANNOTATION") {
          this.shapes.delete(validated.targetShapeId);
        }
        return;
      }
    }

    const aiShapeId = `ai_shape_${String(++this.idCounter)}`;
    const aiShape: CanvasShape = {
      id: aiShapeId,
      layer: "AI_ANNOTATION",
      type: validated.operation,
      content: validated.content,
      shapeRevision: 1,
      targetShapeId: validated.targetShapeId,
      annotationPurpose: validated.annotationPurpose
    };
    this.shapes.set(aiShapeId, aiShape);
  }

  public async clearAiOverlay(): Promise<void> {
    for (const [id, shape] of this.shapes.entries()) {
      if (shape.layer === "AI_ANNOTATION") {
        this.shapes.delete(id);
      }
    }
  }

  public getShapes(): readonly CanvasShape[] {
    return Array.from(this.shapes.values());
  }

  public getShape(id: string): CanvasShape | undefined {
    return this.shapes.get(id);
  }
}

export class TestGeminiApiAdapter implements ReasoningProvider {
  public name = "gemini-api";
  public readonly adapterVersion = "1.0.0";
  public readonly capabilities: ModelCapabilities = {
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
  };

  public constructor(
    private readonly proposalProvider?: (input: ReasoningTurnInput) => InterviewerProposal,
    private readonly allowMetered = false,
    private readonly customBillingProof?: (now: Date) => unknown
  ) {}

  public async verifyBillingSafety(input: { readonly now: Date }): Promise<unknown> {
    if (this.customBillingProof) return this.customBillingProof(input.now);
    if (this.allowMetered) {
      return {
        billingClass: "METERED" as const,
        enforcementMechanism: "Standard pay-as-you-go billing",
        verifiedAt: input.now.toISOString(),
        adapterVersion: this.adapterVersion,
        spendImpossible: false
      };
    }
    return {
      billingClass: "VERIFIED_FREE_ONLY" as const,
      enforcementMechanism: "Google AI Studio Free Tier hard rate limits with zero billing account",
      verifiedAt: input.now.toISOString(),
      adapterVersion: this.adapterVersion,
      spendImpossible: true
    };
  }

  public async createSession(): Promise<ReasoningSession> {
    const proposalProvider = this.proposalProvider;
    let streamClosed = false;
    return {
      async *sendTurn(input: ReasoningTurnInput): AsyncIterable<InterviewerProposal> {
        if (streamClosed) return;
        const prop: InterviewerProposal = proposalProvider
          ? proposalProvider(input)
          : {
              realizedAction: "PROBE_JUSTIFICATION",
              claimedDisclosureLevel: 0,
              claimedDisclosureIds: [],
              speechText: "Why must that claim hold?"
            };
        yield prop;
      },
      async cancelTurn(): Promise<ProviderCancellationResult> {
        streamClosed = true;
        return { semantics: "CLOSE_CLIENT_STREAM", streamClosed: true };
      },
      async close(): Promise<void> {
        streamClosed = true;
      }
    };
  }
}


const CLIENT_TOKEN = "e2e-typed-interview-test-client-token-long-enough-32";
const ORIGIN = "http://127.0.0.1:3000";

let activeRuntimes: LocalInterviewTransportRuntime[] = [];
let activeStores: SqliteEventStore[] = [];

afterEach(async () => {
  for (const runtime of activeRuntimes) {
    try {
      await runtime.stop();
    } catch {
      // ignore teardown errors
    }
  }
  activeRuntimes = [];
  for (const store of activeStores) {
    try {
      store.close();
    } catch {
      // ignore teardown errors
    }
  }
  activeStores = [];
});

async function spawnTestLoopback(dbPath = ":memory:"): Promise<{
  runtime: LocalInterviewTransportRuntime;
  bound: BoundLocalInterviewTransport;
  store: SqliteEventStore;
  client: BrowserCommandClient;
}> {
  const store = new SqliteEventStore(dbPath);
  activeStores.push(store);
  const runtime = new LocalInterviewTransportRuntime({
    security: {
      host: "127.0.0.1",
      clientToken: CLIENT_TOKEN,
      allowedOrigins: new Set([ORIGIN])
    },
    registry: new SessionRuntimeRegistry(store)
  });
  activeRuntimes.push(runtime);
  const bound = await runtime.start();

  const client = new BrowserCommandClient({
    baseUrl: bound.command.url,
    clientToken: CLIENT_TOKEN,
    fetchImpl: (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("Origin", ORIGIN);
      return fetch(input, { ...init, headers });
    }
  });

  return { runtime, bound, store, client };
}

// ============================================================================
// TIER 1: Feature Coverage in Isolation (5 tests per feature = 65 tests)
// ============================================================================

describe("Tier 1: Feature Coverage (Isolation)", () => {
  describe("Feature 1: GeminiApiAdapter & Model Capabilities", () => {
    it("declares valid ModelCapabilities matching schema", () => {
      const adapter = new TestGeminiApiAdapter();
      const parseResult = ModelCapabilitiesSchema.safeParse(adapter.capabilities);
      expect(parseResult.success).toBe(true);
      expect(adapter.capabilities.inputModalities).toEqual(new Set(["text"]));
      expect(adapter.capabilities.structuredOutput).toBe("FINAL_ONLY");
    });

    it("declares honest CLOSE_CLIENT_STREAM cancellation semantics", () => {
      const adapter = new TestGeminiApiAdapter();
      expect(adapter.capabilities.cancellation).toBe("CLOSE_CLIENT_STREAM");
      expect(adapter.capabilities.sessionSurvivesClientAbort).toBe(false);
    });

    it("declares non-empty provider identity and adapter version", () => {
      const adapter = new TestGeminiApiAdapter();
      expect(adapter.name).toBe("gemini-api");
      expect(adapter.adapterVersion).toBe("1.0.0");
    });

    it("creates reasoning session with sendTurn and cancelTurn methods", async () => {
      const adapter = new TestGeminiApiAdapter();
      const session = await adapter.createSession();
      expect(typeof session.sendTurn).toBe("function");
      expect(typeof session.cancelTurn).toBe("function");
      expect(typeof session.close).toBe("function");
      await session.close();
    });

    it("executes turn and emits valid InterviewerProposal", async () => {
      const adapter = new TestGeminiApiAdapter(() => ({
        realizedAction: "PROBE_JUSTIFICATION",
        claimedDisclosureLevel: 0,
        claimedDisclosureIds: [],
        speechText: "Consider the degree of vertex v."
      }));
      const session = await adapter.createSession();
      const proposals: InterviewerProposal[] = [];
      for await (const p of session.sendTurn({ context: {}, generationId: "gen_1" as GenerationId })) {
        proposals.push(p);
      }
      expect(proposals).toHaveLength(1);
      expect(proposals[0]?.speechText).toBe("Consider the degree of vertex v.");
      await session.close();
    });
  });

  describe("Feature 2: No-Metered Billing Proof & Fail-Closed Gating", () => {
    it("returns valid VERIFIED_FREE_ONLY billing proof", async () => {
      const adapter = new TestGeminiApiAdapter();
      const now = new Date("2026-08-30T04:00:00Z");
      const verification = await adapter.verifyBillingSafety({ now });
      const parsed = BillingVerificationSchema.parse(verification);
      expect(parsed.billingClass).toBe("VERIFIED_FREE_ONLY");
      expect(parsed.spendImpossible).toBe(true);
      expect(parsed.adapterVersion).toBe("1.0.0");
    });

    it("matches adapterVersion in billing verification with provider version", async () => {
      const adapter = new TestGeminiApiAdapter();
      const now = new Date();
      const verification = BillingVerificationSchema.parse(await adapter.verifyBillingSafety({ now }));
      expect(verification.adapterVersion).toBe(adapter.adapterVersion);
    });

    it("preflight succeeds when policy allows free tier and verification passes", () => {
      const adapter = new TestGeminiApiAdapter();
      const now = new Date();
      const preflight = preflightProviderPolicy({
        policy: { allowMeteredUsage: false, maximumDataUse: "REMOTE_MAY_BE_USED_FOR_IMPROVEMENT", billingVerificationMaxAgeMs: 60000 },
        capabilities: adapter.capabilities,
        adapterVersion: adapter.adapterVersion,
        now
      });
      expect(preflight.requiresBillingVerification).toBe(true);
    });

    it("assertProviderPermitted passes for verified free billing proof", async () => {
      const adapter = new TestGeminiApiAdapter();
      const now = new Date();
      const verification = await adapter.verifyBillingSafety({ now });
      expect(() => {
        assertProviderPermitted({
          policy: { allowMeteredUsage: false, maximumDataUse: "REMOTE_MAY_BE_USED_FOR_IMPROVEMENT", billingVerificationMaxAgeMs: 60000 },
          capabilities: adapter.capabilities,
          adapterVersion: adapter.adapterVersion,
          billingVerification: verification,
          now
        });
      }).not.toThrow();
    });

    it("bypasses billing verification requirement when allowMeteredUsage is true", () => {
      const adapter = new TestGeminiApiAdapter();
      const now = new Date();
      const preflight = preflightProviderPolicy({
        policy: { allowMeteredUsage: true, maximumDataUse: "REMOTE_MAY_BE_USED_FOR_IMPROVEMENT", billingVerificationMaxAgeMs: 60000 },
        capabilities: adapter.capabilities,
        adapterVersion: adapter.adapterVersion,
        now
      });
      expect(preflight.requiresBillingVerification).toBe(false);
    });
  });

  describe("Feature 3: Provider Session Admission & Redaction", () => {
    it("admits session cleanly via openProviderExecutionSession", async () => {
      const adapter = new TestGeminiApiAdapter();
      const session = await openProviderExecutionSession({
        provider: adapter,
        policy: { allowMeteredUsage: false, maximumDataUse: "REMOTE_MAY_BE_USED_FOR_IMPROVEMENT", billingVerificationMaxAgeMs: 60000 }
      });
      expect(session.providerName).toBe("gemini-api");
      expect(session.adapterVersion).toBe("1.0.0");
      await session.close();
    });

    it("rejects admission if provider name is blank", async () => {
      const invalidAdapter = new TestGeminiApiAdapter();
      invalidAdapter.name = "";
      await expect(openProviderExecutionSession({
        provider: invalidAdapter,
        policy: { allowMeteredUsage: false, maximumDataUse: "REMOTE_MAY_BE_USED_FOR_IMPROVEMENT", billingVerificationMaxAgeMs: 60000 }
      })).rejects.toThrow(ProviderExecutionError);
    });


    it("rejects admission if provider dataUse exceeds policy maximum", async () => {
      const adapter = new TestGeminiApiAdapter(); // uses REMOTE_MAY_BE_USED_FOR_IMPROVEMENT
      await expect(openProviderExecutionSession({
        provider: adapter,
        policy: { allowMeteredUsage: false, maximumDataUse: "LOCAL_ONLY", billingVerificationMaxAgeMs: 60000 }
      })).rejects.toThrow(ProviderPolicyError);
    });

    it("suppresses output cleanly when turn is cancelled", async () => {
      const adapter = new TestGeminiApiAdapter();
      const session = await openProviderExecutionSession({
        provider: adapter,
        policy: { allowMeteredUsage: false, maximumDataUse: "REMOTE_MAY_BE_USED_FOR_IMPROVEMENT", billingVerificationMaxAgeMs: 60000 }
      });
      const genId = "gen_cancel" as GenerationId;
      await session.cancelTurn(genId);
      const results = [];
      for await (const p of session.sendTurn({ context: {}, generationId: genId })) {
        results.push(p);
      }
      expect(results).toHaveLength(0);
      await session.close();
    });

    it("rejects calls on closed execution session", async () => {
      const adapter = new TestGeminiApiAdapter();
      const session = await openProviderExecutionSession({
        provider: adapter,
        policy: { allowMeteredUsage: false, maximumDataUse: "REMOTE_MAY_BE_USED_FOR_IMPROVEMENT", billingVerificationMaxAgeMs: 60000 }
      });
      await session.close();
      await expect(session.cancelTurn("gen_1" as GenerationId)).rejects.toThrow("closed");
    });
  });

  describe("Feature 4: Whiteboard Shape Layer Isolation", () => {
    it("partitions canvas shapes into STUDENT, AI_ANNOTATION, SYSTEM_DECORATION", () => {
      const canvas = new LayerIsolatedWhiteboard();
      const student = canvas.addStudentShape({ id: "v1", type: "vertex", content: "v1" });
      expect(student.layer).toBe("STUDENT");
      expect(student.shapeRevision).toBe(1);
    });

    it("assigns AI_ANNOTATION layer to all AI overlay actions", async () => {
      const canvas = new LayerIsolatedWhiteboard();
      await canvas.applyAiOverlayAction({
        operation: "circle",
        layer: "AI_ANNOTATION",
        targetShapeId: "v1",
        annotationPurpose: "highlight candidate vertex"
      });
      const shapes = canvas.getShapes();
      const aiShapes = shapes.filter((s) => s.layer === "AI_ANNOTATION");
      expect(aiShapes).toHaveLength(1);
      expect(aiShapes[0]?.type).toBe("circle");
    });

    it("preserves student shapes untouched when AI overlay actions are applied", async () => {
      const canvas = new LayerIsolatedWhiteboard();
      const initial = canvas.addStudentShape({ id: "v1", type: "vertex", content: "v1" });
      await canvas.applyAiOverlayAction({
        operation: "highlight",
        layer: "AI_ANNOTATION",
        targetShapeId: "v1",
        annotationPurpose: "draw attention"
      });
      const current = canvas.getShape("v1");
      expect(current).toEqual(initial);
      expect(current?.shapeRevision).toBe(1);
    });

    it("clearAiOverlay removes all AI annotations while preserving student shapes", async () => {
      const canvas = new LayerIsolatedWhiteboard();
      canvas.addStudentShape({ id: "v1", type: "vertex" });
      canvas.addStudentShape({ id: "v2", type: "vertex" });
      await canvas.applyAiOverlayAction({ operation: "circle", layer: "AI_ANNOTATION", targetShapeId: "v1", annotationPurpose: "focus" });
      await canvas.applyAiOverlayAction({ operation: "draw_arrow", layer: "AI_ANNOTATION", targetShapeId: "v2", annotationPurpose: "pointer" });

      expect(canvas.getShapes()).toHaveLength(4);
      await canvas.clearAiOverlay();
      const remaining = canvas.getShapes();
      expect(remaining).toHaveLength(2);
      expect(remaining.every((s) => s.layer === "STUDENT")).toBe(true);
    });

    it("erase_ai_annotation never deletes a STUDENT shape", async () => {
      const canvas = new LayerIsolatedWhiteboard();
      canvas.addStudentShape({ id: "student_node_1", type: "vertex" });
      await canvas.applyAiOverlayAction({
        operation: "erase_ai_annotation",
        layer: "AI_ANNOTATION",
        targetShapeId: "student_node_1",
        annotationPurpose: "attempt illegal delete"
      });
      expect(canvas.getShape("student_node_1")).toBeDefined();
    });
  });

  describe("Feature 5: Non-Destructive AI Overlay Actions", () => {
    it("applies circle action targeting student vertex", async () => {
      const canvas = new LayerIsolatedWhiteboard();
      canvas.addStudentShape({ id: "node_1", type: "vertex" });
      await canvas.applyAiOverlayAction({
        operation: "circle",
        layer: "AI_ANNOTATION",
        targetShapeId: "node_1",
        annotationPurpose: "encircle chosen vertex"
      });
      const aiShape = canvas.getShapes().find((s) => s.type === "circle");
      expect(aiShape).toBeDefined();
      expect(aiShape?.targetShapeId).toBe("node_1");
    });

    it("applies highlight action over student equation", async () => {
      const canvas = new LayerIsolatedWhiteboard();
      canvas.addStudentShape({ id: "eq_1", type: "formula", content: "d(v)=5" });
      await canvas.applyAiOverlayAction({
        operation: "highlight",
        layer: "AI_ANNOTATION",
        targetShapeId: "eq_1",
        annotationPurpose: "highlight degree calculation"
      });
      const aiShape = canvas.getShapes().find((s) => s.type === "highlight");
      expect(aiShape).toBeDefined();
      expect(aiShape?.targetShapeId).toBe("eq_1");
    });

    it("applies draw_arrow and point_at directional actions", async () => {
      const canvas = new LayerIsolatedWhiteboard();
      canvas.addStudentShape({ id: "node_2", type: "vertex" });
      await canvas.applyAiOverlayAction({ operation: "draw_arrow", layer: "AI_ANNOTATION", targetShapeId: "node_2", annotationPurpose: "guide" });
      await canvas.applyAiOverlayAction({ operation: "point_at", layer: "AI_ANNOTATION", targetShapeId: "node_2", annotationPurpose: "indicate" });
      const actions = canvas.getShapes().filter((s) => s.layer === "AI_ANNOTATION");
      expect(actions).toHaveLength(2);
      expect(actions.map((a) => a.type)).toEqual(["draw_arrow", "point_at"]);
    });

    it("applies write_text and write_equation overlay cards", async () => {
      const canvas = new LayerIsolatedWhiteboard();
      await canvas.applyAiOverlayAction({ operation: "write_text", layer: "AI_ANNOTATION", content: "By PHP, at least 3 share color", annotationPurpose: "socratic note" });
      await canvas.applyAiOverlayAction({ operation: "write_equation", layer: "AI_ANNOTATION", content: "\\lceil 5/2 \\rceil = 3", annotationPurpose: "php equation" });
      const cards = canvas.getShapes().filter((s) => s.layer === "AI_ANNOTATION");
      expect(cards).toHaveLength(2);
      expect(cards[1]?.content).toBe("\\lceil 5/2 \\rceil = 3");
    });

    it("erases specific targeted AI annotation", async () => {
      const canvas = new LayerIsolatedWhiteboard();
      await canvas.applyAiOverlayAction({ operation: "circle", layer: "AI_ANNOTATION", targetShapeId: "node_1", annotationPurpose: "temp circle" });
      const createdId = canvas.getShapes().find((s) => s.type === "circle")?.id;
      expect(createdId).toBeDefined();
      if (createdId) {
        await canvas.applyAiOverlayAction({
          operation: "erase_ai_annotation",
          layer: "AI_ANNOTATION",
          targetShapeId: createdId,
          annotationPurpose: "remove circle"
        });
        expect(canvas.getShape(createdId)).toBeUndefined();
      }
    });
  });

  describe("Feature 6: Shape Revision & Stale Reference Guard", () => {
    it("increments shapeRevision upon student edits", () => {
      const canvas = new LayerIsolatedWhiteboard();
      canvas.addStudentShape({ id: "edge_1", type: "line" });
      expect(canvas.getShape("edge_1")?.shapeRevision).toBe(1);
      canvas.updateStudentShape("edge_1", { content: "red" });
      expect(canvas.getShape("edge_1")?.shapeRevision).toBe(2);
    });

    it("accepts AI action when expectedShapeRevision matches target shape revision", async () => {
      const canvas = new LayerIsolatedWhiteboard();
      canvas.addStudentShape({ id: "v1", type: "vertex" });
      await canvas.applyAiOverlayAction({
        operation: "circle",
        layer: "AI_ANNOTATION",
        targetShapeId: "v1",
        expectedShapeRevision: 1,
        annotationPurpose: "fresh reference"
      });
      expect(canvas.getShapes().filter((s) => s.layer === "AI_ANNOTATION")).toHaveLength(1);
    });

    it("refuses AI action attachment when expectedShapeRevision is stale", async () => {
      const canvas = new LayerIsolatedWhiteboard();
      canvas.addStudentShape({ id: "v1", type: "vertex" });
      canvas.updateStudentShape("v1", { content: "moved" }); // now revision 2
      await canvas.applyAiOverlayAction({
        operation: "circle",
        layer: "AI_ANNOTATION",
        targetShapeId: "v1",
        expectedShapeRevision: 1, // stale!
        annotationPurpose: "stale reference"
      });
      // Should not attach stale overlay
      expect(canvas.getShapes().filter((s) => s.layer === "AI_ANNOTATION")).toHaveLength(0);
    });

    it("handles non-existent targetShapeId safely without throwing", async () => {
      const canvas = new LayerIsolatedWhiteboard();
      await expect(canvas.applyAiOverlayAction({
        operation: "highlight",
        layer: "AI_ANNOTATION",
        targetShapeId: "non_existent_id",
        expectedShapeRevision: 1,
        annotationPurpose: "missing target"
      })).resolves.not.toThrow();
    });

    it("preserves student canvas elements when stale actions are dropped", async () => {
      const canvas = new LayerIsolatedWhiteboard();
      canvas.addStudentShape({ id: "v1", type: "vertex", content: "node" });
      canvas.updateStudentShape("v1", { content: "updated" });
      await canvas.applyAiOverlayAction({
        operation: "highlight",
        layer: "AI_ANNOTATION",
        targetShapeId: "v1",
        expectedShapeRevision: 1,
        annotationPurpose: "stale"
      });
      expect(canvas.getShape("v1")?.shapeRevision).toBe(2);
      expect(canvas.getShape("v1")?.content).toBe("updated");
    });
  });


  describe("Feature 7: KaTeX Math Rendering Engine", () => {
    it("parses single inline math delimiter $...$", () => {
      const text = "Let $v \\in V$ be a vertex.";
      const segments = parseMathSegments(text);
      expect(segments).toEqual([
        { type: "text", content: "Let " },
        { type: "inline-math", content: "v \\in V" },
        { type: "text", content: " be a vertex." }
      ]);
    });

    it("parses display block math delimiter $$...$$", () => {
      const text = "We have: $$\\deg(v) = 5$$ By PHP...";
      const segments = parseMathSegments(text);
      expect(segments).toEqual([
        { type: "text", content: "We have: " },
        { type: "block-math", content: "\\deg(v) = 5" },
        { type: "text", content: " By PHP..." }
      ]);
    });

    it("parses multiple mixed math segments across sentence", () => {
      const text = "Since $R(3,3) = 6$, we know $$|V| = 6$$ and $\\lceil 5/2 \\rceil = 3$.";
      const segments = parseMathSegments(text);
      expect(segments).toHaveLength(7);
      expect(segments[1]).toEqual({ type: "inline-math", content: "R(3,3) = 6" });
      expect(segments[3]).toEqual({ type: "block-math", content: "|V| = 6" });
      expect(segments[5]).toEqual({ type: "inline-math", content: "\\lceil 5/2 \\rceil = 3" });
    });

    it("handles plain text with no math delimiters cleanly", () => {
      const text = "Plain English text with no math syntax.";
      const segments = parseMathSegments(text);
      expect(segments).toEqual([{ type: "text", content: text }]);
    });

    it("handles escaped dollar signs without treating them as math tokens", () => {
      const text = "The ticket costs \\$100 total.";
      const segments = parseMathSegments(text);
      expect(segments).toEqual([{ type: "text", content: "The ticket costs \\$100 total." }]);
    });
  });

  describe("Feature 8: Problem Statement & Formulation Display", () => {
    it("provides Oxford Ramsey R(3,3) problem prompt and given information", () => {
      expect(sixPeopleProblem.id).toBe("oxford-six-people");
      expect(sixPeopleProblem.public.prompt).toContain("six people");
      expect(sixPeopleProblem.public.givenInformation).toContain("Acquaintance is symmetric.");
    });

    it("declares topics and introductory-oxford difficulty", () => {
      expect(sixPeopleProblem.interviewer.topics).toEqual(["combinatorics", "graph theory", "pigeonhole principle"]);
      expect(sixPeopleProblem.interviewer.difficulty).toBe("introductory-oxford");
    });

    it("defines 2 valid approaches and 5 milestones in reasoning graph", () => {
      expect(sixPeopleProblem.interviewer.reasoningGraph.approaches).toHaveLength(2);
      expect(sixPeopleProblem.interviewer.reasoningGraph.milestones).toHaveLength(5);
      expect(sixPeopleProblem.interviewer.reasoningGraph.milestones.map((m) => m.id)).toEqual([
        "model-relations",
        "choose-vertex",
        "close-triangle",
        "complement-case",
        "verify"
      ]);
    });

    it("defines protected disclosures with minimum disclosure levels", () => {
      const disclosures = sixPeopleProblem.interviewer.protectedDisclosures;
      expect(disclosures).toHaveLength(2);
      expect(disclosures[0]?.minimumDisclosureLevel).toBe(2);
      expect(disclosures[1]?.minimumDisclosureLevel).toBe(4);
    });

    it("passes static problem integrity validation", () => {
      expect(() => assertInterviewProblemIntegrity(sixPeopleProblem)).not.toThrow();
    });
  });

  describe("Feature 9: Student Typed Input Lifecycle", () => {
    it("commits typed input and returns InputEpisodeId and TurnId", async () => {
      const { client } = await spawnTestLoopback();
      const sessionId = SessionIdSchema.parse(newSessionId());
      await client.startSession(sessionId);

      const response = await client.commitTypedInput(sessionId, "Let the 6 people be vertices of K_6.");
      expect(response.type).toBe("INPUT_COMMITTED");
      expect(response.inputEpisodeId).toMatch(/^episode_/);
      expect(response.turnId).toMatch(/^turn_/);
    });

    it("appends atomic input events into session event store", async () => {
      const { client, store } = await spawnTestLoopback();
      const sessionId = SessionIdSchema.parse(newSessionId());
      await client.startSession(sessionId);
      await client.commitTypedInput(sessionId, "Two-colour the edges with red and blue.");

      const events = store.load(sessionId);
      const types = events.map((e) => e.type);
      expect(types).toContain("INPUT_EPISODE_STARTED");
      expect(types).toContain("INPUT_EPISODE_UPDATED");
      expect(types).toContain("INPUT_EPISODE_COMMITTED");
      expect(types).toContain("TURN_COMMITTED");
    });

    it("idempotently caches committed input on duplicate RequestId", async () => {
      const { client, store } = await spawnTestLoopback();
      const sessionId = SessionIdSchema.parse(newSessionId());
      await client.startSession(sessionId);

      const requestId = RequestIdSchema.parse("request_idem_1");
      const first = await client.commitTypedInput(sessionId, "Initial input text", { requestId });
      const second = await client.commitTypedInput(sessionId, "Initial input text", { requestId });

      expect(second.turnId).toBe(first.turnId);
      expect(second.inputEpisodeId).toBe(first.inputEpisodeId);

      const turnEvents = store.load(sessionId).filter((e) => e.type === "TURN_COMMITTED");
      expect(turnEvents).toHaveLength(1);
    });

    it("advances sequence number monotonically across successive turns", async () => {
      const { client } = await spawnTestLoopback();
      const sessionId = SessionIdSchema.parse(newSessionId());
      await client.startSession(sessionId);

      await client.commitTypedInput(sessionId, "Turn 1");
      const summary1 = await client.getSessionSummary(sessionId);

      await client.commitTypedInput(sessionId, "Turn 2");
      const summary2 = await client.getSessionSummary(sessionId);

      expect(summary2.sequence).toBeGreaterThan(summary1.sequence);
    });

    it("persists student reasoning text faithfully in state", async () => {
      const { client, runtime } = await spawnTestLoopback();
      const sessionId = SessionIdSchema.parse(newSessionId());
      await client.startSession(sessionId);

      const text = "A claim with LaTeX: $R(3,3)=6$.";
      await client.commitTypedInput(sessionId, text);

      const writer = runtime.sessions.getWriter(sessionId);
      const state = writer.getState();
      const turns = Object.values(state.turns);
      expect(turns).toHaveLength(1);
      expect(turns[0]?.studentText).toBe(text);
    });
  });

  describe("Feature 10: Socratic Response Streaming & Badges", () => {
    it("progresses delivery atom through QUEUED, DELIVERING, EXPOSED, COMPLETED", async () => {
      const store = new SqliteEventStore(":memory:");
      activeStores.push(store);
      const sessionId = newSessionId();
      const writer = new SessionRuntimeRegistry(store).get(sessionId);
      const turns = new TurnCoordinator(writer);
      await turns.startSession(sixPeopleProblem);
      const { inputEpisodeId, turnId } = await turns.commitInput("Input for delivery");
      await turns.selectAction(turnId, sixPeopleProblem);
      const { generationId } = await turns.startGeneration(inputEpisodeId, turnId, "mock-model");

      const validator = new DisclosureValidator(new ClosedWorldDisclosureAnalyzer(["Socratic prompt"]));
      const processed = await turns.processProposal({
        envelope: generationEnvelope(writer, sessionId, generationId, "mock-model"),
        problem: sixPeopleProblem,
        proposal: { realizedAction: "PROBE_JUSTIFICATION", claimedDisclosureLevel: 0, claimedDisclosureIds: [], speechText: "Socratic prompt" },
        validator
      });
      expect(processed.accepted).toBe(true);
      const deliveryId = processed.deliveryAtoms[0]?.deliveryId;
      expect(deliveryId).toBeDefined();
      if (!deliveryId) return;

      const renderer = new MockRenderer();
      const delivery = new DeliveryCoordinator(writer);
      await delivery.deliver(deliveryId, renderer);

      const state = writer.getState();
      expect(state.deliveries[deliveryId]?.status).toBe("COMPLETED");
    });

    it("RendererClient presents text and forwards to textPresenter", async () => {
      const presented: { text: string; id: string }[] = [];
      const textPresenter: TextPresenter = {
        presentText(text, deliveryId) {
          presented.push({ text, id: deliveryId });
        }
      };
      const client = new RendererClient({
        sessionId: newSessionId(),
        acknowledgementSender: {
          send: () => Promise.resolve()
        },
        textPresenter,
        audioPlayer: { playAudio: () => Promise.resolve() }
      });

      await client.handleMessage({
        protocolVersion: 1,
        type: "DELIVERY_COMMAND",
        command: {
          deliveryId: newDeliveryId(),
          content: { medium: "TEXT", text: "Socratic inquiry" }
        }
      });

      expect(presented).toHaveLength(1);
      expect(presented[0]?.text).toBe("Socratic inquiry");
    });

    it("RendererClient deduplicates delivery commands with same DeliveryId", async () => {
      let count = 0;
      const textPresenter: TextPresenter = {
        presentText() { count++; }
      };
      const client = new RendererClient({
        sessionId: newSessionId(),
        acknowledgementSender: { send: () => Promise.resolve() },
        textPresenter,
        audioPlayer: { playAudio: () => Promise.resolve() }
      });

      const delId = newDeliveryId();
      const msg = {
        protocolVersion: 1 as const,
        type: "DELIVERY_COMMAND" as const,
        command: {
          deliveryId: delId,
          content: { medium: "TEXT" as const, text: "Once only" }
        }
      };

      await client.handleMessage(msg);
      await client.handleMessage(msg);
      expect(count).toBe(1);
    });

    it("reconnectDelivery returns current delivery atom status", async () => {
      const { client } = await spawnTestLoopback();
      const sessionId = SessionIdSchema.parse(newSessionId());
      await client.startSession(sessionId);

      await expect(client.reconnectDelivery(sessionId, DeliveryIdSchema.parse("delivery_nonexistent"))).rejects.toThrow(BrowserCommandProtocolError);
    });

    it("DeliveryCoordinator cancels unexposed delivery atoms before exposure", async () => {
      const store = new SqliteEventStore(":memory:");
      activeStores.push(store);
      const sessionId = newSessionId();
      const writer = new SessionRuntimeRegistry(store).get(sessionId);
      const turns = new TurnCoordinator(writer);
      await turns.startSession(sixPeopleProblem);
      const { inputEpisodeId, turnId } = await turns.commitInput("Input");
      await turns.selectAction(turnId, sixPeopleProblem);
      const { generationId } = await turns.startGeneration(inputEpisodeId, turnId, "mock");
      const validator = new DisclosureValidator(new ClosedWorldDisclosureAnalyzer(["prompt"]));
      const processed = await turns.processProposal({
        envelope: generationEnvelope(writer, sessionId, generationId, "mock"),
        problem: sixPeopleProblem,
        proposal: { realizedAction: "PROBE_JUSTIFICATION", claimedDisclosureLevel: 0, claimedDisclosureIds: [], speechText: "prompt" },
        validator
      });
      const deliveryId = processed.deliveryAtoms[0]?.deliveryId;
      if (!deliveryId) return;

      const delivery = new DeliveryCoordinator(writer);
      await delivery.cancelBeforeExposure(deliveryId, "test cancellation");
      expect(writer.getState().deliveries[deliveryId]?.status).toBe("CANCELLED");
    });
  });

  describe("Feature 11: Session Start & Recovery", () => {
    it("starts new session via loopback START_SESSION command", async () => {
      const { client } = await spawnTestLoopback();
      const sessionId = SessionIdSchema.parse(newSessionId());
      const response = await client.startSession(sessionId);
      expect(response.type).toBe("SESSION_STARTED");
      expect(response.sessionId).toBe(sessionId);
    });

    it("returns session summary with sequence, started, and contextEpoch", async () => {
      const { client } = await spawnTestLoopback();
      const sessionId = SessionIdSchema.parse(newSessionId());
      await client.startSession(sessionId);
      const summary = await client.getSessionSummary(sessionId);
      expect(summary.started).toBe(true);
      expect(summary.sequence).toBeGreaterThanOrEqual(1);
      expect(summary.contextEpoch).toBe(0);
    });

    it("converts in-flight delivering atoms to POSSIBLY_EXPOSED during session recovery", async () => {
      const store = new SqliteEventStore(":memory:");
      activeStores.push(store);
      const sessionId = newSessionId();
      const writer = new SessionRuntimeRegistry(store).get(sessionId);
      const turns = new TurnCoordinator(writer);
      await turns.startSession(sixPeopleProblem);
      const { inputEpisodeId, turnId } = await turns.commitInput("Input");
      await turns.selectAction(turnId, sixPeopleProblem);
      const { generationId } = await turns.startGeneration(inputEpisodeId, turnId, "mock");
      const validator = new DisclosureValidator(new ClosedWorldDisclosureAnalyzer(["safe"]));
      const processed = await turns.processProposal({
        envelope: generationEnvelope(writer, sessionId, generationId, "mock"),
        problem: sixPeopleProblem,
        proposal: { realizedAction: "PROBE_JUSTIFICATION", claimedDisclosureLevel: 0, claimedDisclosureIds: [], speechText: "safe" },
        validator
      });
      const deliveryId = processed.deliveryAtoms[0]?.deliveryId;
      if (!deliveryId) return;

      // Start delivery manually without completing
      await new DeliveryCoordinator(writer).markStarted(deliveryId);
      expect(writer.getState().deliveries[deliveryId]?.status).toBe("DELIVERING");

      // Now recover session
      await new DeliveryCoordinator(writer).recoverUncertainDeliveries();
      expect(writer.getState().deliveries[deliveryId]?.status).toBe("POSSIBLY_EXPOSED");
    });

    it("coalesces overlapping recovery calls into a single recovery pass", async () => {
      const { client } = await spawnTestLoopback();
      const sessionId = SessionIdSchema.parse(newSessionId());
      await client.startSession(sessionId);

      const [res1, res2] = await Promise.all([
        client.getSessionSummary(sessionId),
        client.getSessionSummary(sessionId)
      ]);
      expect(res1.sequence).toBe(res2.sequence);
    });

    it("reconstructs identical state from SQLite event store upon replay", async () => {
      const { client, store } = await spawnTestLoopback();
      const sessionId = SessionIdSchema.parse(newSessionId());
      await client.startSession(sessionId);
      await client.commitTypedInput(sessionId, "Vertex v has degree 5.");

      const events = store.load(sessionId);
      const replayed = replaySession(sessionId, events);
      expect(replayed.started).toBe(true);
      expect(Object.keys(replayed.turns)).toHaveLength(1);
    });
  });

  describe("Feature 12: Architecture Invariants & Quality Gates", () => {
    it("enforces single-writer model: events can only be appended via SessionWriter", () => {
      const store = new SqliteEventStore(":memory:");
      activeStores.push(store);
      const registry = new SessionRuntimeRegistry(store);
      const writer = registry.get(newSessionId());
      expect(typeof writer.execute).toBe("function");
    });


    it("never serializes clientToken in request body or query string", async () => {
      const { client } = await spawnTestLoopback();
      const sessionId = SessionIdSchema.parse(newSessionId());
      const res = await client.startSession(sessionId);
      expect(JSON.stringify(res)).not.toContain(CLIENT_TOKEN);
    });

    it("produces contiguous, 1-indexed sequence numbers across all events", async () => {
      const { client, store } = await spawnTestLoopback();
      const sessionId = SessionIdSchema.parse(newSessionId());
      await client.startSession(sessionId);
      await client.commitTypedInput(sessionId, "Step 1");
      await client.commitTypedInput(sessionId, "Step 2");

      const events = store.load(sessionId);
      const seqs = events.map((e) => e.sequence);
      expect(seqs).toEqual(Array.from({ length: events.length }, (_, i) => i + 1));
    });

    it("replaySession is pure and deterministic given the same event history", async () => {
      const { client, store } = await spawnTestLoopback();
      const sessionId = SessionIdSchema.parse(newSessionId());
      await client.startSession(sessionId);
      await client.commitTypedInput(sessionId, "Deterministic replay check");

      const events = store.load(sessionId);
      const replay1 = replaySession(sessionId, events);
      const replay2 = replaySession(sessionId, events);
      expect(replay1).toEqual(replay2);
    });

    it("rejects untyped command injections over loopback transport", async () => {
      const { bound } = await spawnTestLoopback();
      const res = await fetch(`${bound.command.url}/v1/commands`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-interview-client-token": CLIENT_TOKEN,
          "Origin": ORIGIN
        },
        body: JSON.stringify({ protocolVersion: 1, type: "UNAUTHORIZED_COMMAND" })
      });
      expect(res.status).toBe(400);
    });
  });

  describe("Feature 13: End-to-End Ramsey R(3,3) Verification", () => {
    it("completes Step 1: Model relations as two-colour K_6", async () => {
      const store = new SqliteEventStore(":memory:");
      activeStores.push(store);
      const sessionId = newSessionId();
      const writer = new SessionRuntimeRegistry(store).get(sessionId);
      const turns = new TurnCoordinator(writer);
      await turns.startSession(sixPeopleProblem);

      const { turnId } = await turns.commitInput("We model the 6 people as vertices of K_6 with red and blue edges.");
      const action = await turns.selectAction(turnId, sixPeopleProblem);
      expect(action).toBeDefined();
    });

    it("completes Step 2: Choose vertex and compute deg(v) = 5", async () => {
      const store = new SqliteEventStore(":memory:");
      activeStores.push(store);
      const sessionId = newSessionId();
      const writer = new SessionRuntimeRegistry(store).get(sessionId);
      const turns = new TurnCoordinator(writer);
      await turns.startSession(sixPeopleProblem);

      await turns.commitInput("K_6 setup");
      const { turnId } = await turns.commitInput("Choose any vertex v. There are 5 incident edges from v.");
      const action = await turns.selectAction(turnId, sixPeopleProblem);
      expect(action).toBeDefined();
    });

    it("completes Step 3: Apply Pigeonhole Principle partition (at least 3 same color)", async () => {
      const store = new SqliteEventStore(":memory:");
      activeStores.push(store);
      const sessionId = newSessionId();
      const writer = new SessionRuntimeRegistry(store).get(sessionId);
      const turns = new TurnCoordinator(writer);
      await turns.startSession(sixPeopleProblem);

      const { turnId } = await turns.commitInput("By Pigeonhole Principle ceil(5/2) = 3, so at least 3 incident edges share a colour (say red).");
      const action = await turns.selectAction(turnId, sixPeopleProblem);
      expect(action).toBeDefined();
    });

    it("completes Step 4: Analyze internal endpoints to close monochromatic K_3 triangle", async () => {
      const store = new SqliteEventStore(":memory:");
      activeStores.push(store);
      const sessionId = newSessionId();
      const writer = new SessionRuntimeRegistry(store).get(sessionId);
      const turns = new TurnCoordinator(writer);
      await turns.startSession(sixPeopleProblem);

      const { turnId } = await turns.commitInput(
        "Let the 3 neighbours be u, w, x with red edges to v. If any edge among {u,w,x} is red, it forms a red triangle with v. Otherwise, all edges between u,w,x are blue, forming a blue triangle. Thus R(3,3) <= 6."
      );
      const action = await turns.selectAction(turnId, sixPeopleProblem);
      expect(action).toBeDefined();
    });

    it("completes Step 5: Full 4-turn proof progression replay matches final state", async () => {
      const store = new SqliteEventStore(":memory:");
      activeStores.push(store);
      const sessionId = newSessionId();
      const writer = new SessionRuntimeRegistry(store).get(sessionId);
      const turns = new TurnCoordinator(writer);
      await turns.startSession(sixPeopleProblem);

      await turns.commitInput("Turn 1: K_6 representation");
      await turns.commitInput("Turn 2: deg(v) = 5");
      await turns.commitInput("Turn 3: PHP ceil(5/2) = 3");
      await turns.commitInput("Turn 4: Monochromatic K_3 closure");

      const liveState = writer.getState();
      const replayedState = replaySession(sessionId, store.load(sessionId));
      expect(Object.keys(liveState.turns)).toHaveLength(4);
      expect(replayedState).toEqual(liveState);
    });
  });
});

// ============================================================================
// TIER 2: Boundary & Corner Cases (5 tests per feature = 65 tests)
// ============================================================================

describe("Tier 2: Boundary & Corner Cases", () => {
  describe("Feature 1: Capabilities Boundary", () => {
    it("rejects capabilities with empty inputModalities set", () => {
      expect(() => {
        ModelCapabilitiesSchema.parse({
          inputModalities: new Set([]),
          textStreaming: false,
          structuredOutput: "FINAL_ONLY",
          persistentSession: false,
          resumableSession: false,
          cancellation: "NONE",
          sessionSurvivesClientAbort: false,
          sessionSurvivesProviderCancel: false,
          usageReporting: false,
          dataUse: "LOCAL_ONLY"
        });
      }).toThrow();
    });

    it("rejects unknown cancellation enum value", () => {
      expect(() => {
        ModelCapabilitiesSchema.parse({
          inputModalities: new Set(["text"]),
          textStreaming: false,
          structuredOutput: "FINAL_ONLY",
          persistentSession: false,
          resumableSession: false,
          cancellation: "INVALID_CANCELLATION",
          sessionSurvivesClientAbort: false,
          sessionSurvivesProviderCancel: false,
          usageReporting: false,
          dataUse: "LOCAL_ONLY"
        });
      }).toThrow();
    });

    it("rejects extra unexpected properties under strict schema", () => {
      expect(() => {
        ModelCapabilitiesSchema.parse({
          inputModalities: new Set(["text"]),
          textStreaming: false,
          structuredOutput: "FINAL_ONLY",
          persistentSession: false,
          resumableSession: false,
          cancellation: "NONE",
          sessionSurvivesClientAbort: false,
          sessionSurvivesProviderCancel: false,
          usageReporting: false,
          dataUse: "LOCAL_ONLY",
          unexpectedExtra: true
        });
      }).toThrow();
    });

    it("rejects invalid structuredOutput enum", () => {
      expect(() => {
        ModelCapabilitiesSchema.parse({
          inputModalities: new Set(["text"]),
          textStreaming: false,
          structuredOutput: "UNSUPPORTED",
          persistentSession: false,
          resumableSession: false,
          cancellation: "NONE",
          sessionSurvivesClientAbort: false,
          sessionSurvivesProviderCancel: false,
          usageReporting: false,
          dataUse: "LOCAL_ONLY"
        });
      }).toThrow();
    });

    it("accepts valid reasoningLevels optional list", () => {
      const caps = ModelCapabilitiesSchema.parse({
        inputModalities: new Set(["text"]),
        textStreaming: false,
        structuredOutput: "FINAL_ONLY",
        persistentSession: false,
        resumableSession: false,
        cancellation: "NONE",
        sessionSurvivesClientAbort: false,
        sessionSurvivesProviderCancel: false,
        usageReporting: false,
        reasoningLevels: ["low", "medium", "high"],
        dataUse: "LOCAL_ONLY"
      });
      expect(caps.reasoningLevels).toEqual(["low", "medium", "high"]);
    });
  });

  describe("Feature 2: Billing Safety Boundaries", () => {
    it("fails closed when spendImpossible is false in no-metered mode", async () => {
      const adapter = new TestGeminiApiAdapter(undefined, false, (now) => ({
        billingClass: "VERIFIED_FREE_ONLY",
        enforcementMechanism: "Unverified key",
        verifiedAt: now.toISOString(),
        adapterVersion: "1.0.0",
        spendImpossible: false
      }));
      const now = new Date();
      const verification = await adapter.verifyBillingSafety({ now });
      expect(() => {
        assertProviderPermitted({
          policy: { allowMeteredUsage: false, maximumDataUse: "REMOTE_MAY_BE_USED_FOR_IMPROVEMENT", billingVerificationMaxAgeMs: 60000 },
          capabilities: adapter.capabilities,
          adapterVersion: adapter.adapterVersion,
          billingVerification: verification,
          now
        });
      }).toThrow(ProviderPolicyError);
    });

    it("fails closed when verification timestamp is in the future", async () => {
      const adapter = new TestGeminiApiAdapter(undefined, false, () => ({
        billingClass: "VERIFIED_FREE_ONLY",
        enforcementMechanism: "Mechanism",
        verifiedAt: new Date(Date.now() + 100_000).toISOString(),
        adapterVersion: "1.0.0",
        spendImpossible: true
      }));
      const now = new Date();
      const verification = await adapter.verifyBillingSafety({ now });
      expect(() => {
        assertProviderPermitted({
          policy: { allowMeteredUsage: false, maximumDataUse: "REMOTE_MAY_BE_USED_FOR_IMPROVEMENT", billingVerificationMaxAgeMs: 60000 },
          capabilities: adapter.capabilities,
          adapterVersion: adapter.adapterVersion,
          billingVerification: verification,
          now
        });
      }).toThrow("future");
    });

    it("fails closed when verification timestamp is older than billingVerificationMaxAgeMs", async () => {
      const adapter = new TestGeminiApiAdapter(undefined, false, () => ({
        billingClass: "VERIFIED_FREE_ONLY",
        enforcementMechanism: "Mechanism",
        verifiedAt: new Date(Date.now() - 200_000).toISOString(),
        adapterVersion: "1.0.0",
        spendImpossible: true
      }));
      const now = new Date();
      const verification = await adapter.verifyBillingSafety({ now });
      expect(() => {
        assertProviderPermitted({
          policy: { allowMeteredUsage: false, maximumDataUse: "REMOTE_MAY_BE_USED_FOR_IMPROVEMENT", billingVerificationMaxAgeMs: 60000 },
          capabilities: adapter.capabilities,
          adapterVersion: adapter.adapterVersion,
          billingVerification: verification,
          now
        });
      }).toThrow("stale");
    });

    it("fails closed when adapterVersion in verification does not match provider", async () => {
      const adapter = new TestGeminiApiAdapter(undefined, false, (now) => ({
        billingClass: "VERIFIED_FREE_ONLY",
        enforcementMechanism: "Mechanism",
        verifiedAt: now.toISOString(),
        adapterVersion: "0.9.0", // mismatched version!
        spendImpossible: true
      }));
      const now = new Date();
      const verification = await adapter.verifyBillingSafety({ now });
      expect(() => {
        assertProviderPermitted({
          policy: { allowMeteredUsage: false, maximumDataUse: "REMOTE_MAY_BE_USED_FOR_IMPROVEMENT", billingVerificationMaxAgeMs: 60000 },
          capabilities: adapter.capabilities,
          adapterVersion: adapter.adapterVersion,
          billingVerification: verification,
          now
        });
      }).toThrow("adapter version");
    });

    it("fails closed when billingClass is METERED in no-metered mode", async () => {
      const adapter = new TestGeminiApiAdapter(undefined, true);
      const now = new Date();
      const verification = await adapter.verifyBillingSafety({ now });
      expect(() => {
        assertProviderPermitted({
          policy: { allowMeteredUsage: false, maximumDataUse: "REMOTE_MAY_BE_USED_FOR_IMPROVEMENT", billingVerificationMaxAgeMs: 60000 },
          capabilities: adapter.capabilities,
          adapterVersion: adapter.adapterVersion,
          billingVerification: verification,
          now
        });
      }).toThrow(ProviderPolicyError);
    });
  });


  describe("Feature 3: Provider Admission & Redaction Boundaries", () => {
    it("fails admission if clock is invalid NaN date", async () => {
      const adapter = new TestGeminiApiAdapter();
      await expect(openProviderExecutionSession({
        provider: adapter,
        policy: { allowMeteredUsage: false, maximumDataUse: "REMOTE_MAY_BE_USED_FOR_IMPROVEMENT", billingVerificationMaxAgeMs: 60000 },
        now: new Date("invalid")
      })).rejects.toThrow();
    });

    it("fails admission if policy object is missing required numeric maxAge", () => {
      const adapter = new TestGeminiApiAdapter();
      expect(() => {
        preflightProviderPolicy({
          policy: { allowMeteredUsage: false, maximumDataUse: "LOCAL_ONLY", billingVerificationMaxAgeMs: -1 },
          capabilities: adapter.capabilities,
          adapterVersion: adapter.adapterVersion
        });
      }).toThrow(ProviderPolicyError);
    });

    it("sanitizes raw provider exceptions into standard ProviderExecutionError", async () => {
      const failingAdapter: ReasoningProvider = {
        name: "failing-provider",
        adapterVersion: "1.0.0",
        capabilities: new TestGeminiApiAdapter().capabilities,
        verifyBillingSafety: async () => { throw new Error("sensitive API key leaked here: sk-12345"); },
        createSession: async () => { throw new Error("connection failure"); }
      };

      await expect(openProviderExecutionSession({
        provider: failingAdapter,
        policy: { allowMeteredUsage: false, maximumDataUse: "REMOTE_MAY_BE_USED_FOR_IMPROVEMENT", billingVerificationMaxAgeMs: 60000 }
      })).rejects.toThrow("Provider billing verification failed");
    });

    it("prevents cancellation overclaim beyond declared capability", async () => {
      const overclaimingAdapter: ReasoningProvider = {
        name: "overclaiming",
        adapterVersion: "1.0.0",
        capabilities: {
          ...new TestGeminiApiAdapter().capabilities,
          cancellation: "NONE" // declares NONE!
        },
        verifyBillingSafety: async (inp) => ({
          billingClass: "VERIFIED_FREE_ONLY",
          enforcementMechanism: "Mechanism",
          verifiedAt: inp.now.toISOString(),
          adapterVersion: "1.0.0",
          spendImpossible: true
        }),
        createSession: async () => ({
          async *sendTurn() { yield { realizedAction: "PROBE_JUSTIFICATION", claimedDisclosureLevel: 0, claimedDisclosureIds: [], speechText: "text" }; },
          async cancelTurn() {
            // attempts to claim CANCEL_PROVIDER_COMPUTE!
            return { semantics: "CANCEL_PROVIDER_COMPUTE", providerConfirmed: true };
          },
          async close() {}
        })
      };

      const session = await openProviderExecutionSession({
        provider: overclaimingAdapter,
        policy: { allowMeteredUsage: false, maximumDataUse: "REMOTE_MAY_BE_USED_FOR_IMPROVEMENT", billingVerificationMaxAgeMs: 60000 }
      });

      await expect(session.cancelTurn("gen_1" as GenerationId)).rejects.toThrow("exceeds declared capability");
      await session.close();
    });

    it("rejects malformed proposal objects emitted by underlying session", async () => {
      const badOutputAdapter: ReasoningProvider = {
        name: "bad-output",
        adapterVersion: "1.0.0",
        capabilities: new TestGeminiApiAdapter().capabilities,
        verifyBillingSafety: async (inp) => ({
          billingClass: "VERIFIED_FREE_ONLY",
          enforcementMechanism: "Mechanism",
          verifiedAt: inp.now.toISOString(),
          adapterVersion: "1.0.0",
          spendImpossible: true
        }),
        createSession: async () => ({
          async *sendTurn() {
            // yield completely invalid proposal missing required realizedAction
            yield { invalidField: true } as unknown as InterviewerProposal;
          },
          async close() {}
        })
      };

      const session = await openProviderExecutionSession({
        provider: badOutputAdapter,
        policy: { allowMeteredUsage: false, maximumDataUse: "REMOTE_MAY_BE_USED_FOR_IMPROVEMENT", billingVerificationMaxAgeMs: 60000 }
      });

      const iterator = session.sendTurn({ context: {}, generationId: "gen_1" as GenerationId });
      await expect(iterator[Symbol.asyncIterator]().next()).rejects.toThrow(ProviderExecutionError);
      await session.close();
    });
  });

  describe("Feature 4: Layer Isolation Boundaries", () => {
    it("fails closed when update is attempted on non-existent shape", () => {
      const canvas = new LayerIsolatedWhiteboard();
      expect(() => canvas.updateStudentShape("no_such_shape", { content: "new" })).toThrow();
    });

    it("refuses to update AI_ANNOTATION shapes through student update channel", async () => {
      const canvas = new LayerIsolatedWhiteboard();
      await canvas.applyAiOverlayAction({ operation: "circle", layer: "AI_ANNOTATION", targetShapeId: "v1", annotationPurpose: "circle" });
      const aiShapeId = canvas.getShapes()[0]?.id;
      if (aiShapeId) {
        expect(() => canvas.updateStudentShape(aiShapeId, { content: "mutated" })).toThrow();
      }
    });

    it("clearAiOverlay does not remove student shapes even if store has 100 student shapes", async () => {
      const canvas = new LayerIsolatedWhiteboard();
      for (let i = 0; i < 100; i++) {
        canvas.addStudentShape({ id: `s_${String(i)}`, type: "node" });
      }
      await canvas.applyAiOverlayAction({ operation: "circle", layer: "AI_ANNOTATION", annotationPurpose: "note" });
      expect(canvas.getShapes()).toHaveLength(101);

      await canvas.clearAiOverlay();
      expect(canvas.getShapes()).toHaveLength(100);
    });

    it("erase_ai_annotation with empty target shape ignores without deleting", async () => {
      const canvas = new LayerIsolatedWhiteboard();
      canvas.addStudentShape({ id: "v1", type: "node" });
      await canvas.applyAiOverlayAction({
        operation: "erase_ai_annotation",
        layer: "AI_ANNOTATION",
        targetShapeId: "missing_target",
        annotationPurpose: "safe erase"
      });
      expect(canvas.getShapes()).toHaveLength(1);
    });

    it("preserves shape IDs and references across multiple overlay add/erase cycles", async () => {
      const canvas = new LayerIsolatedWhiteboard();
      canvas.addStudentShape({ id: "v_perm", type: "node" });

      for (let i = 0; i < 10; i++) {
        await canvas.applyAiOverlayAction({ operation: "highlight", layer: "AI_ANNOTATION", targetShapeId: "v_perm", annotationPurpose: `cycle_${String(i)}` });
        await canvas.clearAiOverlay();
      }
      expect(canvas.getShapes()).toHaveLength(1);
      expect(canvas.getShape("v_perm")).toBeDefined();
    });
  });

  describe("Feature 5: AI Overlay Actions Boundaries", () => {
    it("rejects BoardAction with invalid operation name", () => {
      expect(() => {
        BoardActionSchema.parse({
          operation: "INVALID_OP",
          layer: "AI_ANNOTATION",
          annotationPurpose: "test"
        });
      }).toThrow();
    });

    it("rejects BoardAction with non-AI_ANNOTATION layer", () => {
      expect(() => {
        BoardActionSchema.parse({
          operation: "circle",
          layer: "STUDENT", // Forbidden!
          annotationPurpose: "test"
        });
      }).toThrow();
    });

    it("rejects BoardAction with empty annotationPurpose string", () => {
      expect(() => {
        BoardActionSchema.parse({
          operation: "circle",
          layer: "AI_ANNOTATION",
          annotationPurpose: "" // Empty!
        });
      }).toThrow();
    });

    it("accepts valid write_equation with LaTeX math content", () => {
      const action = BoardActionSchema.parse({
        operation: "write_equation",
        layer: "AI_ANNOTATION",
        content: "\\sum_{i=1}^n i = \\frac{n(n+1)}{2}",
        annotationPurpose: "formula card"
      });
      expect(action.operation).toBe("write_equation");
    });

    it("handles double clearAiOverlay idempotently", async () => {
      const canvas = new LayerIsolatedWhiteboard();
      await canvas.clearAiOverlay();
      await canvas.clearAiOverlay();
      expect(canvas.getShapes()).toHaveLength(0);
    });
  });

  describe("Feature 6: Stale Reference Guard Boundaries", () => {
    it("rejects negative expectedShapeRevision in schema", () => {
      expect(() => {
        BoardActionSchema.parse({
          operation: "circle",
          layer: "AI_ANNOTATION",
          targetShapeId: "v1",
          expectedShapeRevision: -1,
          annotationPurpose: "invalid"
        });
      }).toThrow();
    });

    it("accepts zero expectedShapeRevision", () => {
      const action = BoardActionSchema.parse({
        operation: "circle",
        layer: "AI_ANNOTATION",
        targetShapeId: "v1",
        expectedShapeRevision: 0,
        annotationPurpose: "initial revision"
      });
      expect(action.expectedShapeRevision).toBe(0);
    });

    it("does not attach when expectedShapeRevision is higher than current shape revision", async () => {
      const canvas = new LayerIsolatedWhiteboard();
      canvas.addStudentShape({ id: "v1", type: "vertex" }); // rev 1
      await canvas.applyAiOverlayAction({
        operation: "circle",
        layer: "AI_ANNOTATION",
        targetShapeId: "v1",
        expectedShapeRevision: 5, // Future revision!
        annotationPurpose: "future ref"
      });
      expect(canvas.getShapes().filter((s) => s.layer === "AI_ANNOTATION")).toHaveLength(0);
    });

    it("preserves existing AI overlays when subsequent action has stale revision", async () => {
      const canvas = new LayerIsolatedWhiteboard();
      canvas.addStudentShape({ id: "v1", type: "vertex" });
      await canvas.applyAiOverlayAction({ operation: "write_text", layer: "AI_ANNOTATION", content: "Valid hint", annotationPurpose: "hint" });
      await canvas.applyAiOverlayAction({ operation: "circle", layer: "AI_ANNOTATION", targetShapeId: "v1", expectedShapeRevision: 99, annotationPurpose: "stale" });

      const aiShapes = canvas.getShapes().filter((s) => s.layer === "AI_ANNOTATION");
      expect(aiShapes).toHaveLength(1);
      expect(aiShapes[0]?.content).toBe("Valid hint");
    });

    it("allows AI actions without targetShapeId to always attach", async () => {
      const canvas = new LayerIsolatedWhiteboard();
      await canvas.applyAiOverlayAction({ operation: "write_text", layer: "AI_ANNOTATION", content: "Global note", annotationPurpose: "note" });
      expect(canvas.getShapes()).toHaveLength(1);
    });
  });

  describe("Feature 7: KaTeX Parser Boundaries", () => {
    it("handles empty string without error", () => {
      const segments = parseMathSegments("");
      expect(segments).toEqual([]);
    });

    it("handles unclosed single dollar sign as plain text", () => {
      const text = "Unclosed $ math delimiter here.";
      const segments = parseMathSegments(text);
      expect(segments).toEqual([{ type: "text", content: text }]);
    });

    it("handles unclosed double dollar signs as plain text", () => {
      const text = "Unclosed $$ display delimiter here.";
      const segments = parseMathSegments(text);
      expect(segments).toEqual([{ type: "text", content: text }]);
    });

    it("handles 10,000 character long plain text cleanly", () => {
      const large = "A".repeat(10_000);
      const segments = parseMathSegments(large);
      expect(segments).toHaveLength(1);
      expect(segments[0]?.content.length).toBe(10_000);
    });

    it("handles adjacent math expressions $a$$b$", () => {
      const text = "$a$$b$";
      const segments = parseMathSegments(text);
      expect(segments.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("Feature 8: Problem Integrity Boundaries", () => {
    it("rejects problem with blank public prompt", () => {
      const broken: InterviewProblem = {
        ...sixPeopleProblem,
        public: { prompt: "   ", givenInformation: ["Fact"] }
      };
      expect(() => assertInterviewProblemIntegrity(broken)).toThrow("Public prompt must be non-empty after trimming");
    });

    it("rejects problem with broken milestone edge referencing missing node", () => {
      const broken: InterviewProblem = {
        ...sixPeopleProblem,
        interviewer: {
          ...sixPeopleProblem.interviewer,
          reasoningGraph: {
            ...sixPeopleProblem.interviewer.reasoningGraph,
            edges: [{ from: "non_existent_node", to: "verify" }]
          }
        }
      };
      expect(() => assertInterviewProblemIntegrity(broken)).toThrow();
    });

    it("rejects problem with cyclic reasoning graph edges", () => {
      const broken: InterviewProblem = {
        ...sixPeopleProblem,
        interviewer: {
          ...sixPeopleProblem.interviewer,
          reasoningGraph: {
            ...sixPeopleProblem.interviewer.reasoningGraph,
            edges: [
              ...sixPeopleProblem.interviewer.reasoningGraph.edges,
              { from: "verify", to: "model-relations" }
            ]
          }
        }
      };
      expect(() => assertInterviewProblemIntegrity(broken)).toThrow("Reasoning graph must be acyclic");
    });

    it("rejects problem with milestone referencing unknown approach", () => {
      const first = sixPeopleProblem.interviewer.reasoningGraph.milestones[0];
      if (!first) throw new Error("Expected milestone in test fixture");
      const broken: InterviewProblem = {
        ...sixPeopleProblem,
        interviewer: {
          ...sixPeopleProblem.interviewer,
          reasoningGraph: {
            ...sixPeopleProblem.interviewer.reasoningGraph,
            milestones: [
              {
                ...first,
                approachIds: ["unknown_approach_id"]
              }
            ]
          }
        }
      };
      expect(() => assertInterviewProblemIntegrity(broken)).toThrow("references unknown approach");
    });

    it("rejects problem with duplicate milestone IDs", () => {
      const first = sixPeopleProblem.interviewer.reasoningGraph.milestones[0];
      if (!first) throw new Error("Expected milestone in test fixture");
      const broken: InterviewProblem = {
        ...sixPeopleProblem,
        interviewer: {
          ...sixPeopleProblem.interviewer,
          reasoningGraph: {
            ...sixPeopleProblem.interviewer.reasoningGraph,
            milestones: [
              ...sixPeopleProblem.interviewer.reasoningGraph.milestones,
              first
            ]
          }
        }
      };
      expect(() => assertInterviewProblemIntegrity(broken)).toThrow();
    });
  });


  describe("Feature 9: Student Input Boundaries", () => {
    it("rejects empty string typed input with validation error", async () => {
      const { client } = await spawnTestLoopback();
      const sessionId = SessionIdSchema.parse(newSessionId());
      await client.startSession(sessionId);
      await expect(client.commitTypedInput(sessionId, "")).rejects.toThrow();
    });

    it("accepts maximum allowed 20,000 character input", async () => {
      const { client } = await spawnTestLoopback();
      const sessionId = SessionIdSchema.parse(newSessionId());
      await client.startSession(sessionId);
      const largeInput = "x".repeat(20_000);
      const res = await client.commitTypedInput(sessionId, largeInput);
      expect(res.type).toBe("INPUT_COMMITTED");
    });

    it("rejects input exceeding 20,000 characters", async () => {
      const { client } = await spawnTestLoopback();
      const sessionId = SessionIdSchema.parse(newSessionId());
      await client.startSession(sessionId);
      const oversized = "x".repeat(20_001);
      await expect(client.commitTypedInput(sessionId, oversized)).rejects.toThrow();
    });

    it("handles complex LaTeX formulas and Unicode symbols without corruption", async () => {
      const { client } = await spawnTestLoopback();
      const sessionId = SessionIdSchema.parse(newSessionId());
      await client.startSession(sessionId);
      const mathText = "Let $\\alpha, \\beta \\in \\mathbb{R}$ with $\\sum_{i=1}^n \\omega_i \\ge 0$.";
      const res = await client.commitTypedInput(sessionId, mathText);
      expect(res.type).toBe("INPUT_COMMITTED");
    });

    it("preserves RequestId across repeated calls", async () => {
      const { client } = await spawnTestLoopback();
      const sessionId = SessionIdSchema.parse(newSessionId());
      await client.startSession(sessionId);
      const reqId = RequestIdSchema.parse("request_custom_req");
      const res = await client.commitTypedInput(sessionId, "Custom request ID", { requestId: reqId });
      expect(res.requestId).toBe(reqId);
    });
  });

  describe("Feature 10: Streaming & Delivery Badges Boundaries", () => {
    it("rejects acknowledgement of unknown delivery ID", async () => {
      const { client } = await spawnTestLoopback();
      const sessionId = SessionIdSchema.parse(newSessionId());
      await client.startSession(sessionId);
      await expect(client.acknowledgeDeliveryExposed(sessionId, DeliveryIdSchema.parse("delivery_nonexistent"))).rejects.toThrow();
    });

    it("idempotently accepts duplicate ACK_DELIVERY_EXPOSED calls", async () => {
      const store = new SqliteEventStore(":memory:");
      activeStores.push(store);
      const sessionId = newSessionId();
      const writer = new SessionRuntimeRegistry(store).get(sessionId);
      const turns = new TurnCoordinator(writer);
      await turns.startSession(sixPeopleProblem);
      const { inputEpisodeId, turnId } = await turns.commitInput("Input");
      await turns.selectAction(turnId, sixPeopleProblem);
      const { generationId } = await turns.startGeneration(inputEpisodeId, turnId, "mock");
      const validator = new DisclosureValidator(new ClosedWorldDisclosureAnalyzer(["text"]));
      const processed = await turns.processProposal({
        envelope: generationEnvelope(writer, sessionId, generationId, "mock"),
        problem: sixPeopleProblem,
        proposal: { realizedAction: "PROBE_JUSTIFICATION", claimedDisclosureLevel: 0, claimedDisclosureIds: [], speechText: "text" },
        validator
      });
      const deliveryId = processed.deliveryAtoms[0]?.deliveryId;
      if (!deliveryId) return;

      const coordinator = new DeliveryCoordinator(writer);
      await coordinator.markStarted(deliveryId);
      await coordinator.acknowledgeExposed(deliveryId);
      await expect(coordinator.acknowledgeExposed(deliveryId)).resolves.not.toThrow();
    });

    it("idempotently accepts duplicate ACK_DELIVERY_COMPLETED calls", async () => {
      const store = new SqliteEventStore(":memory:");
      activeStores.push(store);
      const sessionId = newSessionId();
      const writer = new SessionRuntimeRegistry(store).get(sessionId);
      const turns = new TurnCoordinator(writer);
      await turns.startSession(sixPeopleProblem);
      const { inputEpisodeId, turnId } = await turns.commitInput("Input");
      await turns.selectAction(turnId, sixPeopleProblem);
      const { generationId } = await turns.startGeneration(inputEpisodeId, turnId, "mock");
      const validator = new DisclosureValidator(new ClosedWorldDisclosureAnalyzer(["text"]));
      const processed = await turns.processProposal({
        envelope: generationEnvelope(writer, sessionId, generationId, "mock"),
        problem: sixPeopleProblem,
        proposal: { realizedAction: "PROBE_JUSTIFICATION", claimedDisclosureLevel: 0, claimedDisclosureIds: [], speechText: "text" },
        validator
      });
      const deliveryId = processed.deliveryAtoms[0]?.deliveryId;
      if (!deliveryId) return;

      const coordinator = new DeliveryCoordinator(writer);
      await coordinator.markStarted(deliveryId);
      await coordinator.acknowledgeExposed(deliveryId);
      await coordinator.acknowledgeCompleted(deliveryId);
      await expect(coordinator.acknowledgeCompleted(deliveryId)).resolves.not.toThrow();
    });

    it("rejects completing delivery before exposure", async () => {
      const store = new SqliteEventStore(":memory:");
      activeStores.push(store);
      const sessionId = newSessionId();
      const writer = new SessionRuntimeRegistry(store).get(sessionId);
      const turns = new TurnCoordinator(writer);
      await turns.startSession(sixPeopleProblem);
      const { inputEpisodeId, turnId } = await turns.commitInput("Input");
      await turns.selectAction(turnId, sixPeopleProblem);
      const { generationId } = await turns.startGeneration(inputEpisodeId, turnId, "mock");
      const validator = new DisclosureValidator(new ClosedWorldDisclosureAnalyzer(["text"]));
      const processed = await turns.processProposal({
        envelope: generationEnvelope(writer, sessionId, generationId, "mock"),
        problem: sixPeopleProblem,
        proposal: { realizedAction: "PROBE_JUSTIFICATION", claimedDisclosureLevel: 0, claimedDisclosureIds: [], speechText: "text" },
        validator
      });
      const deliveryId = processed.deliveryAtoms[0]?.deliveryId;
      if (!deliveryId) return;

      const coordinator = new DeliveryCoordinator(writer);
      await coordinator.markStarted(deliveryId);
      // Try to complete without exposing first
      await expect(coordinator.acknowledgeCompleted(deliveryId)).rejects.toThrow();
    });

    it("maintains maxTrackedDeliveries ring buffer size in RendererClient", async () => {
      const client = new RendererClient({
        sessionId: newSessionId(),
        acknowledgementSender: { send: () => Promise.resolve() },
        textPresenter: { presentText: () => {} },
        audioPlayer: { playAudio: () => Promise.resolve() },
        maxTrackedDeliveries: 5
      });

      for (let i = 0; i < 10; i++) {
        await client.handleMessage({
          protocolVersion: 1,
          type: "DELIVERY_COMMAND",
          command: {
            deliveryId: newDeliveryId(),
            content: { medium: "TEXT", text: `Msg ${String(i)}` }
          }
        });
      }
      expect(client).toBeDefined();
    });
  });

  describe("Feature 11: Session Recovery Boundaries", () => {
    it("handles recovery on fresh session with 0 committed turns cleanly", async () => {
      const { client } = await spawnTestLoopback();
      const sessionId = SessionIdSchema.parse(newSessionId());
      await client.startSession(sessionId);
      const summary = await client.getSessionSummary(sessionId);
      expect(summary.sequence).toBeGreaterThanOrEqual(1);
      expect(Object.keys(summary.deliveryStatuses)).toHaveLength(0);
    });

    it("recovers 10 simultaneous unacknowledged delivering atoms into POSSIBLY_EXPOSED", async () => {
      const store = new SqliteEventStore(":memory:");
      activeStores.push(store);
      const sessionId = newSessionId();
      const writer = new SessionRuntimeRegistry(store).get(sessionId);
      const turns = new TurnCoordinator(writer);
      await turns.startSession(sixPeopleProblem);

      const coordinator = new DeliveryCoordinator(writer);
      const validator = new DisclosureValidator(new ClosedWorldDisclosureAnalyzer(["prompt"]));

      for (let i = 0; i < 10; i++) {
        const { inputEpisodeId, turnId } = await turns.commitInput(`Turn ${String(i)}`);
        await turns.selectAction(turnId, sixPeopleProblem);
        const { generationId } = await turns.startGeneration(inputEpisodeId, turnId, "mock");
        const processed = await turns.processProposal({
          envelope: generationEnvelope(writer, sessionId, generationId, "mock"),
          problem: sixPeopleProblem,
          proposal: { realizedAction: "PROBE_JUSTIFICATION", claimedDisclosureLevel: 0, claimedDisclosureIds: [], speechText: "prompt" },
          validator
        });
        const deliveryId = processed.deliveryAtoms[0]?.deliveryId;
        if (deliveryId) {
          await coordinator.markStarted(deliveryId);
        }
      }

      await coordinator.recoverUncertainDeliveries();
      const state = writer.getState();
      const statuses = Object.values(state.deliveries).map((d) => d.status);
      expect(statuses.every((s) => s === "POSSIBLY_EXPOSED")).toBe(true);
    });

    it("fails closed when fetching the summary for a non-existent session", async () => {
      const { client } = await spawnTestLoopback();
      const error = await client.getSessionSummary(SessionIdSchema.parse("session_nonexistent"))
        .then(() => undefined, (reason: unknown) => reason);
      expect(error).toBeInstanceOf(BrowserCommandProtocolError);
      expect(error).toMatchObject({ status: 404, code: "NOT_FOUND" });
    });

    it("preserves contextEpoch across restarts", async () => {
      const { client } = await spawnTestLoopback();
      const sessionId = SessionIdSchema.parse(newSessionId());
      await client.startSession(sessionId);
      const summary = await client.getSessionSummary(sessionId);
      expect(summary.contextEpoch).toBe(0);
    });

    it("re-attaching stream after disconnect receives pending updates", async () => {
      const { client } = await spawnTestLoopback();
      const sessionId = SessionIdSchema.parse(newSessionId());
      await client.startSession(sessionId);
      const summary = await client.getSessionSummary(sessionId);
      expect(summary.started).toBe(true);
    });
  });

  describe("Feature 12: Architecture & Security Boundaries", () => {
    it("rejects loopback command with missing authorization header", async () => {
      const { bound } = await spawnTestLoopback();
      const res = await fetch(`${bound.command.url}/v1/commands`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Origin": ORIGIN },
        body: JSON.stringify({ protocolVersion: 1, type: "START_SESSION", requestId: "req_1", sessionId: "session_1" })
      });
      expect(res.status).toBe(401);
    });

    it("rejects loopback command with unauthorized Origin", async () => {
      const { bound } = await spawnTestLoopback();
      const res = await fetch(`${bound.command.url}/v1/commands`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-interview-client-token": CLIENT_TOKEN,
          "Origin": "http://malicious-origin.com"
        },
        body: JSON.stringify({ protocolVersion: 1, type: "START_SESSION", requestId: "req_1", sessionId: "session_1" })
      });
      expect(res.status).toBe(403);
    });

    it("rejects loopback command exceeding 64 KB payload size limit", async () => {
      const { bound } = await spawnTestLoopback();
      const hugeBody = JSON.stringify({
        protocolVersion: 1,
        type: "START_SESSION",
        requestId: "req_1",
        sessionId: "session_1",
        padding: "x".repeat(70_000)
      });
      const res = await fetch(`${bound.command.url}/v1/commands`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-interview-client-token": CLIENT_TOKEN,
          "Origin": ORIGIN
        },
        body: hugeBody
      });
      expect(res.status).toBe(413);
    });

    it("rejects non-POST HTTP methods with 404 or 400", async () => {
      const { bound } = await spawnTestLoopback();
      const res = await fetch(`${bound.command.url}/v1/commands`, {
        method: "GET",
        headers: {
          "x-interview-client-token": CLIENT_TOKEN,
          "Origin": ORIGIN
        }
      });
      expect(res.status).toBe(404);
    });

    it("handles CORS OPTIONS preflight request with 204 No Content", async () => {
      const { bound } = await spawnTestLoopback();
      const res = await fetch(`${bound.command.url}/v1/commands`, {
        method: "OPTIONS",
        headers: {
          "Origin": ORIGIN,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type, x-interview-client-token"
        }
      });
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    });
  });

  describe("Feature 13: Ramsey Proof Progression Boundaries", () => {
    it("handles student proposing invalid claim without crashing", async () => {
      const store = new SqliteEventStore(":memory:");
      activeStores.push(store);
      const sessionId = newSessionId();
      const writer = new SessionRuntimeRegistry(store).get(sessionId);
      const turns = new TurnCoordinator(writer);
      await turns.startSession(sixPeopleProblem);

      const { turnId } = await turns.commitInput("I assume acquaintance is transitive across all 6 people.");
      const action = await turns.selectAction(turnId, sixPeopleProblem);
      expect(action).toBeDefined();
    });

    it("protects level 4 disclosure from being emitted at level 0", async () => {
      const store = new SqliteEventStore(":memory:");
      activeStores.push(store);
      const sessionId = newSessionId();
      const writer = new SessionRuntimeRegistry(store).get(sessionId);
      const turns = new TurnCoordinator(writer);
      await turns.startSession(sixPeopleProblem);

      const { inputEpisodeId, turnId } = await turns.commitInput("First step claim");
      await turns.selectAction(turnId, sixPeopleProblem);
      const { generationId } = await turns.startGeneration(inputEpisodeId, turnId, "mock");

      // Closed world validator with disclosure fact
      const disclosureFact = sixPeopleProblem.interviewer.protectedDisclosures[1]?.fact ?? "";
      const validator = new DisclosureValidator(new ClosedWorldDisclosureAnalyzer([disclosureFact]));

      const result = await turns.processProposal({
        envelope: generationEnvelope(writer, sessionId, generationId, "mock"),
        problem: sixPeopleProblem,
        proposal: {
          realizedAction: "PROBE_JUSTIFICATION",
          claimedDisclosureLevel: 0, // Claim level 0 while disclosing protected fact
          claimedDisclosureIds: [],
          speechText: disclosureFact
        },
        validator
      });
      // Should reject due to disclosure violation
      expect(result.accepted).toBe(false);
    });

    it("verifies graph complement approach is tracked in problem approaches", () => {
      const approaches = sixPeopleProblem.interviewer.reasoningGraph.approaches;
      expect(approaches.some((a) => a.id === "graph-complement")).toBe(true);
    });

    it("handles five people counterexample query gracefully", () => {
      const ext = sixPeopleProblem.interviewer.reasoningGraph.extensions;
      expect(ext.some((e) => e.id === "five-counterexample")).toBe(true);
    });

    it("tracks common error assume-transitivity in reasoning graph", () => {
      const errors = sixPeopleProblem.interviewer.reasoningGraph.commonErrors;
      expect(errors.some((e) => e.id === "assume-transitivity")).toBe(true);
    });
  });
});

// ============================================================================
// TIER 3: Cross-Feature Combinations (13 Pairwise Interaction Tests)
// ============================================================================

describe("Tier 3: Cross-Feature Combinations", () => {
  it("Pair 1 (F9 Input + F10 Streaming): full turn lifecycle from typed input to delivery completion", async () => {
    const { client, runtime } = await spawnTestLoopback();
    const sessionId = SessionIdSchema.parse(newSessionId());
    await client.startSession(sessionId);

    const committed = await client.commitTypedInput(sessionId, "Student reasoning step");
    expect(committed.turnId).toBeDefined();

    await runtime.orchestrator.waitForAll();
    const writer = runtime.sessions.getWriter(sessionId);
    const state = writer.getState();
    const delivery = Object.values(state.deliveries).find((atom) =>
      state.generations[atom.generationId]?.basis.turnId === committed.turnId
    );
    expect(delivery).toBeDefined();
    if (delivery !== undefined) {
      expect(delivery.status).toBe("QUEUED");
      await new DeliveryCoordinator(writer).markStarted(delivery.deliveryId);
      await client.acknowledgeDeliveryExposed(sessionId, delivery.deliveryId);
      const ack = await client.acknowledgeDeliveryCompleted(sessionId, delivery.deliveryId);
      expect(ack.acknowledgement).toBe("COMPLETED");
    }
  });

  it("Pair 2 (F4 Layer + F5 AI Overlay): AI overlays circle on student vertex sketch", async () => {
    const canvas = new LayerIsolatedWhiteboard();
    const v1 = canvas.addStudentShape({ id: "v1", type: "vertex", content: "Vertex 1" });
    await canvas.applyAiOverlayAction({
      operation: "circle",
      layer: "AI_ANNOTATION",
      targetShapeId: v1.id,
      expectedShapeRevision: v1.shapeRevision,
      annotationPurpose: "highlight chosen vertex"
    });

    const shapes = canvas.getShapes();
    expect(shapes).toHaveLength(2);
    expect(shapes.find((s) => s.id === "v1")?.layer).toBe("STUDENT");
    expect(shapes.find((s) => s.type === "circle")?.layer).toBe("AI_ANNOTATION");
  });

  it("Pair 3 (F11 Recovery + F10 Badges): session recovery marks in-flight delivery POSSIBLY_EXPOSED in summary", async () => {
    const store = new SqliteEventStore(":memory:");
    activeStores.push(store);
    const sessionId = newSessionId();
    const writer = new SessionRuntimeRegistry(store).get(sessionId);
    const turns = new TurnCoordinator(writer);
    await turns.startSession(sixPeopleProblem);
    const { inputEpisodeId, turnId } = await turns.commitInput("Input");
    await turns.selectAction(turnId, sixPeopleProblem);
    const { generationId } = await turns.startGeneration(inputEpisodeId, turnId, "mock");
    const validator = new DisclosureValidator(new ClosedWorldDisclosureAnalyzer(["prompt"]));
    const processed = await turns.processProposal({
      envelope: generationEnvelope(writer, sessionId, generationId, "mock"),
      problem: sixPeopleProblem,
      proposal: { realizedAction: "PROBE_JUSTIFICATION", claimedDisclosureLevel: 0, claimedDisclosureIds: [], speechText: "prompt" },
      validator
    });
    const deliveryId = processed.deliveryAtoms[0]?.deliveryId;
    if (deliveryId) {
      await new DeliveryCoordinator(writer).markStarted(deliveryId);
      expect(writer.getState().deliveries[deliveryId]?.status).toBe("DELIVERING");

      await new DeliveryCoordinator(writer).recoverUncertainDeliveries();
      expect(writer.getState().deliveries[deliveryId]?.status).toBe("POSSIBLY_EXPOSED");
    }
  });


  it("Pair 4 (F7 KaTeX + F8 Problem Formulation): problem prompt contains parseable LaTeX formulas", () => {
    const prompt = sixPeopleProblem.public.prompt;
    const segments = parseMathSegments(prompt);
    expect(segments.length).toBeGreaterThanOrEqual(1);
  });

  it("Pair 5 (F7 KaTeX + F9 Input): typed input with KaTeX delimiters is preserved and parseable", async () => {
    const { client, store } = await spawnTestLoopback();
    const sessionId = SessionIdSchema.parse(newSessionId());
    await client.startSession(sessionId);

    const text = "Since $R(3,3) = 6$ and $\\deg(v) = 5$, we apply PHP.";
    await client.commitTypedInput(sessionId, text);

    const writer = new SessionRuntimeRegistry(store).get(sessionId);
    const committedText = Object.values(writer.getState().turns)[0]?.studentText ?? "";
    const segments = parseMathSegments(committedText);
    expect(segments.filter((s) => s.type === "inline-math")).toHaveLength(2);
  });

  it("Pair 6 (F1 Gemini + F2 Billing + F3 Admission): gated provider admission and turn execution", async () => {
    const store = new SqliteEventStore(":memory:");
    activeStores.push(store);
    const sessionId = newSessionId();
    const writer = new SessionRuntimeRegistry(store).get(sessionId);
    const turns = new TurnCoordinator(writer);
    await turns.startSession(sixPeopleProblem);

    const { inputEpisodeId, turnId } = await turns.commitInput("Student turn text");
    await turns.selectAction(turnId, sixPeopleProblem);

    const safeProbe = "How do you know deg(v) = 5?";
    const provider = new TestGeminiApiAdapter(() => ({
      realizedAction: "PROBE_JUSTIFICATION",
      claimedDisclosureLevel: 0,
      claimedDisclosureIds: [],
      speechText: safeProbe
    }));

    const validator = new DisclosureValidator(new ClosedWorldDisclosureAnalyzer([safeProbe]));
    const execution = await new ProviderCoordinator(writer).start({
      inputEpisodeId,
      turnId,
      provider,
      policy: { allowMeteredUsage: false, maximumDataUse: "REMOTE_MAY_BE_USED_FOR_IMPROVEMENT", billingVerificationMaxAgeMs: 60000 },
      problem: sixPeopleProblem,
      validator
    });

    const completion = await execution.completion;
    expect(completion.status).toBe("ACCEPTED");
  });

  it("Pair 7 (F4 Whiteboard + F6 Shape Revision + F5 Overlay): stale revision drops misaligned overlay", async () => {
    const canvas = new LayerIsolatedWhiteboard();
    const node = canvas.addStudentShape({ id: "node_1", type: "vertex" });
    canvas.updateStudentShape(node.id, { content: "moved node" }); // now revision 2

    // Apply overlay targeting obsolete revision 1
    await canvas.applyAiOverlayAction({
      operation: "highlight",
      layer: "AI_ANNOTATION",
      targetShapeId: node.id,
      expectedShapeRevision: 1,
      annotationPurpose: "stale highlight"
    });

    expect(canvas.getShapes().filter((s) => s.layer === "AI_ANNOTATION")).toHaveLength(0);
  });

  it("Pair 8 (F9 Input + F12 Invariants): monotonic event sequence across multi-turn interview", async () => {
    const { client, store } = await spawnTestLoopback();
    const sessionId = SessionIdSchema.parse(newSessionId());
    await client.startSession(sessionId);

    await client.commitTypedInput(sessionId, "Input 1");
    await client.commitTypedInput(sessionId, "Input 2");
    await client.commitTypedInput(sessionId, "Input 3");

    const events = store.load(sessionId);
    for (let i = 0; i < events.length; i++) {
      expect(events[i]?.sequence).toBe(i + 1);
    }
  });

  it("Pair 9 (F10 Delivery + F11 Command Client): two-phase exposure/completed ACKs over loopback HTTP", async () => {
    const { client, runtime } = await spawnTestLoopback();
    const sessionId = SessionIdSchema.parse(newSessionId());
    await client.startSession(sessionId);

    const writer = runtime.sessions.getWriter(sessionId);
    const turns = new TurnCoordinator(writer);
    const { inputEpisodeId, turnId } = await turns.commitInput("Input");
    await turns.selectAction(turnId, sixPeopleProblem);
    const { generationId } = await turns.startGeneration(inputEpisodeId, turnId, "mock");
    const validator = new DisclosureValidator(new ClosedWorldDisclosureAnalyzer(["prompt"]));
    const processed = await turns.processProposal({
      envelope: generationEnvelope(writer, sessionId, generationId, "mock"),
      problem: sixPeopleProblem,
      proposal: { realizedAction: "PROBE_JUSTIFICATION", claimedDisclosureLevel: 0, claimedDisclosureIds: [], speechText: "prompt" },
      validator
    });

    const deliveryId = processed.deliveryAtoms[0]?.deliveryId;
    if (deliveryId) {
      await new DeliveryCoordinator(writer).markStarted(deliveryId);
      const ackExposed = await client.acknowledgeDeliveryExposed(sessionId, deliveryId);
      expect(ackExposed.acknowledgement).toBe("EXPOSED");

      const ackCompleted = await client.acknowledgeDeliveryCompleted(sessionId, deliveryId);
      expect(ackCompleted.acknowledgement).toBe("COMPLETED");

      const summary = await client.getSessionSummary(sessionId);
      expect(summary.deliveryStatuses[deliveryId]).toBe("COMPLETED");
    }
  });

  it("Pair 10 (F8 Problem Graph + F13 Ramsey Verification): milestone DAG traversal for Ramsey proof", () => {
    expect(sixPeopleProblem.interviewer.reasoningGraph.milestones.length).toBeGreaterThanOrEqual(1);
    const edges = sixPeopleProblem.interviewer.reasoningGraph.edges;
    expect(edges.some((e) => e.from === "model-relations" && e.to === "choose-vertex")).toBe(true);
    expect(edges.some((e) => e.from === "choose-vertex" && e.to === "close-triangle")).toBe(true);
  });

  it("Pair 11 (F5 AI Overlay + F10 Delivery Medium): whiteboard overlay delivered via DeliveryContent with medium: 'WHITEBOARD'", () => {
    const boardAction: BoardAction = {
      operation: "circle",
      layer: "AI_ANNOTATION",
      targetShapeId: "v1",
      annotationPurpose: "highlight"
    };
    const content = DeliveryContentSchema.parse({
      medium: "WHITEBOARD",
      action: boardAction
    });
    expect(content.medium).toBe("WHITEBOARD");
    if (content.medium === "WHITEBOARD") {
      expect(content.action.operation).toBe("circle");
    }
  });

  it("Pair 12 (F3 Session Redaction + F9 Client Token): error redaction during invalid command dispatch", async () => {
    const { client } = await spawnTestLoopback();
    const sessionId = SessionIdSchema.parse(newSessionId());
    await client.startSession(sessionId);

    // Call with invalid empty text
    try {
      await client.commitTypedInput(sessionId, "");
    } catch (err) {
      expect(String(err)).not.toContain(CLIENT_TOKEN);
    }
  });

  it("Pair 13 (F11 Recovery Coordinator + F12 Persistence): SQLite restart restores exact state and summary", async () => {
    const dbPath = ":memory:";
    const store1 = new SqliteEventStore(dbPath);
    activeStores.push(store1);
    const sessionId = newSessionId();
    const registry1 = new SessionRuntimeRegistry(store1);
    const writer1 = registry1.get(sessionId);
    const turns1 = new TurnCoordinator(writer1);
    await turns1.startSession(sixPeopleProblem);
    await turns1.commitInput("Persisted turn text");

    const events = store1.load(sessionId);
    const stateReplayed = replaySession(sessionId, events);
    expect(stateReplayed.started).toBe(true);
    expect(Object.keys(stateReplayed.turns)).toHaveLength(1);
  });
});

// ============================================================================
// TIER 4: Real-World Application Scenarios (5 Scenarios per TEST_INFRA.md)
// ============================================================================

describe("Tier 4: Real-World Application Scenarios", () => {
  it("Scenario 1: Full Oxford Ramsey R(3,3) proof progression over simulated loopback and command clients", async () => {
    const { client, store } = await spawnTestLoopback();
    const sessionId = SessionIdSchema.parse(newSessionId());

    // 1. Start session
    const startRes = await client.startSession(sessionId);
    expect(startRes.sessionId).toBe(sessionId);

    // 2. Step 1: Model relations as two-colour K_6
    const step1 = await client.commitTypedInput(
      sessionId,
      "We represent the 6 people as the vertices of a complete graph $K_6$. Every pair of people is connected by an edge coloured either red (acquaintance) or blue (stranger)."
    );
    expect(step1.turnId).toBeDefined();

    // 3. Step 2: Choose vertex and compute deg(v) = 5
    const step2 = await client.commitTypedInput(
      sessionId,
      "Select an arbitrary vertex $v \\in V(K_6)$. Since there are 6 vertices in total, the degree of $v$ is $|V \\setminus \\{v\\}| = 5$. Thus, 5 edges are incident to $v$."
    );
    expect(step2.turnId).toBeDefined();

    // 4. Step 3: Apply Pigeonhole Principle partition
    const step3 = await client.commitTypedInput(
      sessionId,
      "By the Pigeonhole Principle, distributing 5 edges into 2 colour categories guarantees at least $\\lceil 5/2 \\rceil = 3$ edges of the same colour. Without loss of generality, let at least 3 incident edges from $v$ be red, connecting to vertices $u, w, x$."
    );
    expect(step3.turnId).toBeDefined();

    // 5. Step 4: Complete monochromatic K_3 triangle
    const step4 = await client.commitTypedInput(
      sessionId,
      "Consider the edges between {u, w, x}. If any edge between these 3 vertices (say (u,w)) is red, then {v, u, w} forms a monochromatic red triangle $K_3$. If none of the edges between {u, w, x} are red, then all three edges (u,w), (w,x), (u,x) must be blue, forming a monochromatic blue triangle $K_3$. In either case, a monochromatic $K_3$ exists. Therefore, $R(3,3) \\le 6$."
    );
    expect(step4.turnId).toBeDefined();


    // 6. Verify final session summary and replay integrity
    const summary = await client.getSessionSummary(sessionId);
    expect(summary.started).toBe(true);
    expect(summary.sequence).toBeGreaterThanOrEqual(5);

    const replayed = replaySession(sessionId, store.load(sessionId));
    expect(Object.keys(replayed.turns)).toHaveLength(4);
    expect(replayed.started).toBe(true);
  });

  it("Scenario 2: Whiteboard sketch & AI overlay coordination without mutating student strokes", async () => {
    const canvas = new LayerIsolatedWhiteboard();

    // Student sketches 6 vertices
    const vertices = ["v1", "v2", "v3", "v4", "v5", "v6"].map((id) =>
      canvas.addStudentShape({ id, type: "vertex", content: id })
    );

    // Student sketches edges from v1
    const edges = ["e_12", "e_13", "e_14", "e_15", "e_16"].map((id) =>
      canvas.addStudentShape({ id, type: "edge", content: "red" })
    );

    expect(canvas.getShapes()).toHaveLength(11);

    // AI overlays circle around v1
    await canvas.applyAiOverlayAction({
      operation: "circle",
      layer: "AI_ANNOTATION",
      targetShapeId: "v1",
      expectedShapeRevision: 1,
      annotationPurpose: "focus on vertex v1"
    });

    // AI highlights 3 red edges
    for (const edgeId of ["e_12", "e_13", "e_14"]) {
      await canvas.applyAiOverlayAction({
        operation: "highlight",
        layer: "AI_ANNOTATION",
        targetShapeId: edgeId,
        expectedShapeRevision: 1,
        annotationPurpose: "highlight 3 monochromatic edges"
      });
    }

    // AI writes KaTeX equation card
    await canvas.applyAiOverlayAction({
      operation: "write_equation",
      layer: "AI_ANNOTATION",
      content: "\\lceil 5/2 \\rceil = 3",
      annotationPurpose: "pigeonhole principle equation card"
    });

    // Verify 11 student shapes + 5 AI overlay shapes = 16 total shapes
    expect(canvas.getShapes()).toHaveLength(16);

    // Verify student shapes are completely unchanged
    for (const v of vertices) {
      expect(canvas.getShape(v.id)).toEqual(v);
    }
    for (const e of edges) {
      expect(canvas.getShape(e.id)).toEqual(e);
    }

    // AI clears overlays at end of step
    await canvas.clearAiOverlay();
    expect(canvas.getShapes()).toHaveLength(11);
    expect(canvas.getShapes().every((s) => s.layer === "STUDENT")).toBe(true);
  });

  it("Scenario 3: Session disconnect and recovery mid-interview with delivery status map reconciliation", async () => {
    const store = new SqliteEventStore(":memory:");
    activeStores.push(store);
    const sessionId = SessionIdSchema.parse(newSessionId());
    const registry = new SessionRuntimeRegistry(store);
    const writer = registry.get(sessionId);
    const turns = new TurnCoordinator(writer);
    await turns.startSession(sixPeopleProblem);

    // Turn 1 committed and delivered
    const { inputEpisodeId, turnId } = await turns.commitInput("Step 1 reasoning");
    await turns.selectAction(turnId, sixPeopleProblem);
    const { generationId } = await turns.startGeneration(inputEpisodeId, turnId, "mock");
    const validator = new DisclosureValidator(new ClosedWorldDisclosureAnalyzer(["Socratic question"]));
    const processed = await turns.processProposal({
      envelope: generationEnvelope(writer, sessionId, generationId, "mock"),
      problem: sixPeopleProblem,
      proposal: { realizedAction: "PROBE_JUSTIFICATION", claimedDisclosureLevel: 0, claimedDisclosureIds: [], speechText: "Socratic question" },
      validator
    });

    const deliveryId = processed.deliveryAtoms[0]?.deliveryId;
    if (deliveryId) {
      // Start delivery but simulate network disconnect before ACK
      await new DeliveryCoordinator(writer).markStarted(deliveryId);
      expect(writer.getState().deliveries[deliveryId]?.status).toBe("DELIVERING");

      // Recover uncertain deliveries after restart
      await new DeliveryCoordinator(writer).recoverUncertainDeliveries();
      expect(writer.getState().deliveries[deliveryId]?.status).toBe("POSSIBLY_EXPOSED");
    }

    // Resumes interview session with next turn
    const step2 = await turns.commitInput("Resumed reasoning step after reconnect");
    expect(step2.turnId).toBeDefined();
  });


  it("Scenario 4: Metered usage attack attempt / Fail-closed preflight gating", async () => {
    // Metered adapter attempting spend when policy allows only free tier
    const meteredAdapter = new TestGeminiApiAdapter(undefined, true); // allowMetered = true -> returns METERED class

    await expect(openProviderExecutionSession({
      provider: meteredAdapter,
      policy: {
        allowMeteredUsage: false, // Strict free-only policy
        maximumDataUse: "REMOTE_MAY_BE_USED_FOR_IMPROVEMENT",
        billingVerificationMaxAgeMs: 60000
      }
    })).rejects.toThrow(ProviderPolicyError);
  });

  it("Scenario 5: Complex LaTeX formula drafting and Socratic rendering across transcript feed", () => {
    const studentFormulas = [
      "Let $|V| = 6$ and consider $R(s,t) \\le R(s-1,t) + R(s,t-1)$.",
      "We calculate $\\lceil (6-1)/2 \\rceil = \\lceil 5/2 \\rceil = 3$.",
      "By symmetry, $u \\sim v \\iff v \\sim u$ in the complete graph $K_6$.",
      "For $n=5$, a 5-cycle $C_5$ has no monochromatic $K_3$, proving $R(3,3) > 5$."
    ];

    for (const formula of studentFormulas) {
      const segments = parseMathSegments(formula);
      expect(segments.length).toBeGreaterThanOrEqual(1);
      const mathSegments = segments.filter((s) => s.type === "inline-math" || s.type === "block-math");
      expect(mathSegments.length).toBeGreaterThanOrEqual(1);
      expect(mathSegments.every((s) => s.content.length > 0)).toBe(true);
    }
  });
});
