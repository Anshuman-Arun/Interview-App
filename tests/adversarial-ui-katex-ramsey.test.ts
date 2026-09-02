import { describe, expect, it, vi, afterEach } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  newDeliveryId,
  newSessionId,
  RequestIdSchema,
  SessionIdSchema
} from "../packages/domain/src/index.js";
import type { RendererAcknowledgementCommand } from "../packages/delivery/src/index.js";
import {
  MathText,
  parseMathSegments,
  renderKaTeXToString
} from "../apps/web/src/components/MathText.js";
import { StudentInputArea } from "../apps/web/src/components/StudentInputArea.js";
import { TranscriptFeed, type TranscriptItem } from "../apps/web/src/components/TranscriptFeed.js";
import { BrowserCommandClient } from "../apps/web/src/command-client.js";
import {
  RendererClient,
  type RendererAcknowledgementSender,
  type TextPresenter
} from "../apps/web/src/renderer-client.js";
import {
  InMemoryTldrawEditor,
  TldrawWhiteboardAdapter
} from "../apps/web/src/tldraw-whiteboard-adapter.js";
import { SqliteEventStore } from "../packages/persistence/src/index.js";
import { SessionRuntimeRegistry } from "../packages/interview-engine/src/index.js";
import {
  LocalInterviewTransportRuntime,
  type BoundLocalInterviewTransport
} from "../apps/server/src/local-interview-transport-runtime.js";
import { replaySession } from "../packages/events/src/index.js";

const CLIENT_TOKEN = "e2e-typed-interview-test-client-token-long-enough-32";
const ORIGIN = "http://127.0.0.1:3000";
let activeRuntimes: LocalInterviewTransportRuntime[] = [];
let activeStores: SqliteEventStore[] = [];

afterEach(async () => {
  for (const runtime of activeRuntimes) {
    try {
      await runtime.stop();
    } catch {
      // ignore
    }
  }
  activeRuntimes = [];
  for (const store of activeStores) {
    try {
      store.close();
    } catch {
      // ignore
    }
  }
  activeStores = [];
});

async function spawnTestLoopback(dbPath = ":memory:"): Promise<{
  runtime: LocalInterviewTransportRuntime;
  bound: BoundLocalInterviewTransport;
  store: SqliteEventStore;
  client: BrowserCommandClient;
  registry: SessionRuntimeRegistry;
}> {
  const store = new SqliteEventStore(dbPath);
  activeStores.push(store);
  const registry = new SessionRuntimeRegistry(store);
  const runtime = new LocalInterviewTransportRuntime({
    security: {
      host: "127.0.0.1",
      clientToken: CLIENT_TOKEN,
      allowedOrigins: new Set([ORIGIN])
    },
    registry
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

  return { client, store, runtime, bound, registry };
}

describe("Adversarial Test Suite 1: KaTeX Math Rendering Stress & Pathological Inputs", () => {
  const malformedDelimiters = [
    // Unclosed inline single dollar
    "Let $v be a vertex",
    "Formula $x+y and another formula $z+w",
    "Single dollar sign $ at the end",
    "$ at the beginning",
    "Multiple unclosed $a $b $c $d",
    // Unclosed double dollar
    "$$\\sum_{i=1}^n x_i without closing block",
    "Block math $$",
    "Formula with $$ inside text but not closed",
    // Unclosed brackets and parentheses
    "Inline \\( math without close",
    "Block \\[ math without close",
    "Mismatched \\[ x \\)",
    "Mismatched \\( y \\]",
    // Mismatched dollar delimiters
    "Mixed $\\frac{a}{b}$$ syntax",
    "Mixed $$\\int_0^1 f(x)dx$ syntax",
    // Consecutive and overlapping dollars
    "$$$$",
    "$$$",
    "$$$$$$",
    "$$$$$$$$",
    "$x$$y$",
    "$$x$$$y$$",
    "$$a$$b$$c$$",
    // Empty math delimiters
    "Empty single $$",
    "Empty double $$$$",
    "Empty paren \\(\\)",
    "Empty bracket \\[\\]",
    "Whitespace single $   $",
    "Whitespace double $$   $$",
    // Trailing escapes and unclosed macros
    "Math $\\",
    "Math $\\frac{",
    "Math $\\sqrt{",
    "Math $\\alpha\\",
    "Math $\\text{"
  ];

  it.each(malformedDelimiters)(
    "never throws or crashes on malformed delimiter: %j",
    (input) => {
      expect(() => {
        const segments = parseMathSegments(input);
        expect(Array.isArray(segments)).toBe(true);

        for (const seg of segments) {
          expect(seg).toHaveProperty("type");
          expect(seg).toHaveProperty("content");
          expect(["text", "inline-math", "block-math"]).toContain(seg.type);
          expect(typeof seg.content).toBe("string");
        }

        const html = renderKaTeXToString(input, false);
        expect(typeof html).toBe("string");

        const element = React.createElement(MathText, { text: input });
        const markup = renderToStaticMarkup(element);
        expect(typeof markup).toBe("string");
      }).not.toThrow();
    }
  );

  const deeplyNestedAndPathological = [
    // Deeply nested fractions (depth 50)
    "Fraction depth 50: $" +
      "\\frac{1}{".repeat(50) +
      "x" +
      "}".repeat(50) +
      "$",
    // Deeply nested square roots (depth 50)
    "Sqrt depth 50: $" +
      "\\sqrt{".repeat(50) +
      "1+x" +
      "}".repeat(50) +
      "$",
    // Deeply nested parentheses/brackets
    "Brackets depth 50: $" +
      "\\left(".repeat(50) +
      "x" +
      "\\right)".repeat(50) +
      "$",
    // Pathological subscript/superscript chain
    "Superscript chain: $x^{y^{z^{w^{a^{b^{c^{d^{e^{f}}}}}}}}}}$",
    "Subscript chain: $x_{1_{2_{3_{4_{5_{6_{7_{8_{9}}}}}}}}}$",
    // Huge 10,000 character formula
    "Huge formula: $" + "x + ".repeat(1500) + "y$",
    // TeX definition attacks and unknown macros
    "Unknown macro: $\\unknownMacro{123}$",
    "TeX def attack: $\\def\\foo{bar}\\foo$",
    "TeX let attack: $\\let\\foo\\bar$",
    "TeX csname attack: $\\csname foo\\endcsname$",
    "TeX catcode attack: $\\catcode`\\$=11$",
    // Script and HTML tags inside math (XSS attempts)
    "XSS script: $<script>alert('xss')</script>$",
    "XSS img: $\\text{<img src=x onerror=alert(1)>}$",
    "XSS href: $\\href{javascript:alert(1)}{click}$",
    // Control characters and null bytes
    "Control chars: $\\alpha\\x00\\x01\\x02\\x03\\x04\\x05\\x06\\x07\\x08\\x0b\\x0c\\x0e\\x0f$",
    // Unicode math symbols inside LaTeX
    "Unicode in math: $\\sum_{i=1}^n \\sqrt[3]{\\alpha_i} \\otimes \\mathcal{H} \\bigoplus \\mathbb{R} \\smile \\heartsuit 🦄 🚀 📐$",
    // Combinations of inline and block math
    "Mixed: Text before $$e^{i\\pi} + 1 = 0$$ middle $R(3,3)=6$ end \\[\\deg(v)=5\\] done."
  ];

  it.each(deeplyNestedAndPathological)(
    "safely parses and renders pathological math input: %j",
    (input) => {
      expect(() => {
        const segments = parseMathSegments(input);
        expect(segments.length).toBeGreaterThan(0);

        const element = React.createElement(MathText, { text: input });
        const markup = renderToStaticMarkup(element);
        expect(markup.length).toBeGreaterThan(0);
      }).not.toThrow();
    }
  );

  it("handles empty and whitespace-only math tokens gracefully", () => {
    const emptyCases = ["$$", "$$$$", "\\(\\)", "\\[\\]", "$ $", "$   $", "$$\\n\\n$$"];
    for (const ec of emptyCases) {
      const segments = parseMathSegments(ec);
      expect(segments).toBeDefined();
      const markup = renderToStaticMarkup(React.createElement(MathText, { text: ec }));
      expect(typeof markup).toBe("string");
    }
  });

  it("gracefully falls back when KaTeX render fails on invalid LaTeX command", () => {
    const brokenLaTeX = "$\\badMacroWithArgs{broken{incomplete$";
    const segments = parseMathSegments(brokenLaTeX);
    expect(segments.length).toBeGreaterThan(0);

    const element = React.createElement(MathText, { text: brokenLaTeX });
    const markup = renderToStaticMarkup(element);
    expect(markup).toContain("katex");
  });
});

describe("Adversarial Test Suite 2: Input Boundary & Rapid Concurrency Stress", () => {
  it("validates 0-character and whitespace-only boundary conditions", () => {
    const emptyInputs = ["", " ", "   ", "\t", "\n", "\r\n", "  \t \n  "];
    for (const empty of emptyInputs) {
      const mockSubmit = vi.fn();
      const element = React.createElement(StudentInputArea, {
        placeholder: empty,
        onSubmit: mockSubmit
      });
      const markup = renderToStaticMarkup(element);
      expect(markup).toContain('maxLength="20000"');
      expect(markup).toContain('data-testid="char-counter"');
      expect(markup).toContain('data-testid="submit-reasoning-btn"');
      expect(markup).toContain("disabled");
      expect(mockSubmit).not.toHaveBeenCalled();
    }
  });

  it("validates exact 20,000 character maximum boundary", () => {
    const exactly20k = "a".repeat(20000);
    const over20k = "a".repeat(20001);
    const huge50k = "a".repeat(50000);

    // 20k chars
    const element20k = React.createElement(StudentInputArea, {
      onSubmit: vi.fn()
    });
    const markup20k = renderToStaticMarkup(element20k);
    expect(markup20k).toContain('maxLength="20000"');

    // Live preview with 20k string
    const segments20k = parseMathSegments(exactly20k);
    expect(segments20k).toHaveLength(1);
    expect(segments20k[0]?.content.length).toBe(20000);

    // Segments with 20001 string
    const segmentsOver20k = parseMathSegments(over20k);
    expect(segmentsOver20k).toHaveLength(1);
    expect(segmentsOver20k[0]?.content.length).toBe(20001);

    // Segments with 50k string
    const segments50k = parseMathSegments(huge50k);
    expect(segments50k).toHaveLength(1);
    expect(segments50k[0]?.content.length).toBe(50000);
  });

  it("preserves unicode math, emojis, Greek symbols, RTL and CJK characters", () => {
    const unicodeInput =
      "Theorem: ∀x ∈ V, ∃y: (x,y) ∈ E. " +
      "Greek: α, β, γ, δ, ε, ζ, η, θ, λ, μ, π, σ, τ, φ, ψ, ω. " +
      "Operators: ∑, ∏, ∫, ∬, ∭, ∮, ∇, ∂, √, ∛, ∜, ∞, ∧, ∨, ∩, ∪, ⊂, ⊆. " +
      "Emojis: 🎉 🧠 📐 📊 🔴 🔵 🔺 🔹. " +
      "RTL Hebrew: נניח ש-$v_1$-הוא קודקוד. " +
      "CJK: 考虑完全图 $K_6$ 并在顶点 $v_1$ 分支。";

    const segments = parseMathSegments(unicodeInput);
    expect(segments.length).toBeGreaterThan(1);

    const element = React.createElement(MathText, { text: unicodeInput });
    const markup = renderToStaticMarkup(element);
    expect(markup).toContain("Theorem: ∀x ∈ V");
    expect(markup).toContain("Greek: α, β, γ");
    expect(markup).toContain("Emojis: 🎉");
    expect(markup).toContain("RTL Hebrew: נניח ש-");
    expect(markup).toContain("CJK: 考虑完全图");
    expect(markup).toContain("katex");
  });

  it("handles rapid consecutive and concurrent submissions with idempotency over loopback", async () => {
    const { client } = await spawnTestLoopback();
    const sessionId = SessionIdSchema.parse(newSessionId());
    await client.startSession(sessionId);

    // Concurrent submissions with same requestId (idempotency check)
    const fixedRequestId = RequestIdSchema.parse("req_idempotent_001");
    const [res1, res2] = await Promise.all([
      client.commitTypedInput(sessionId, "Let $v_1$ be vertex.", { requestId: fixedRequestId }),
      client.commitTypedInput(sessionId, "Let $v_1$ be vertex.", { requestId: fixedRequestId })
    ]);

    expect(res1.turnId).toBe(res2.turnId);
    expect(res1.inputEpisodeId).toBe(res2.inputEpisodeId);

    // Rapid consecutive distinct submissions
    const promises = Array.from({ length: 5 }, (_, i) =>
      client.commitTypedInput(sessionId, `Reasoning step ${String(i + 1)}`)
    );
    const results = await Promise.all(promises);
    expect(results).toHaveLength(5);
    for (const res of results) {
      expect(res.turnId).toBeDefined();
      expect(res.inputEpisodeId).toBeDefined();
    }

    const summary = await client.getSessionSummary(sessionId);
    expect(summary.started).toBe(true);
    expect(summary.sequence).toBeGreaterThanOrEqual(6);
  });
});

describe("Adversarial Test Suite 3: Full Oxford Ramsey R(3,3) Multi-Turn Socratic Interview Flow", () => {
  it("executes complete proof progression (K_6, deg(v)=5, PHP partition, monochromatic K_3) with overlay synchronization", async () => {
    const { client, store } = await spawnTestLoopback();
    const sessionId = SessionIdSchema.parse(newSessionId());

    // 1. Initialize session and Tldraw Whiteboard Adapter
    const startRes = await client.startSession(sessionId);
    expect(startRes.sessionId).toBe(sessionId);

    const editor = new InMemoryTldrawEditor();
    const whiteboardAdapter = new TldrawWhiteboardAdapter(editor);

    const presentedTexts: { text: string; deliveryId: string }[] = [];
    const textPresenter: TextPresenter = {
      presentText: (text, dId) => {
        presentedTexts.push({ text, deliveryId: dId });
      }
    };

    const mockAckSender: RendererAcknowledgementSender = {
      send: vi.fn(async (cmd: RendererAcknowledgementCommand) => {
        if (cmd.type === "ACK_DELIVERY_EXPOSED") {
          await client.acknowledgeDeliveryExposed(sessionId, cmd.deliveryId);
        } else {
          await client.acknowledgeDeliveryCompleted(sessionId, cmd.deliveryId);
        }
      })
    };

    const rendererClient = new RendererClient({
      sessionId,
      acknowledgementSender: mockAckSender,
      textPresenter,
      audioPlayer: { playAudio: vi.fn() },
      whiteboardPresenter: whiteboardAdapter
    });

    const transcriptItems: TranscriptItem[] = [];

    // =========================================================================
    // TURN 1: Problem Formulation & Graph Modeling ($K_6$)
    // =========================================================================
    const t1Input =
      "We model the 6 people as the vertices $V = \\{v_1, v_2, v_3, v_4, v_5, v_6\\}$ of a complete graph $K_6$. Every pair of people is connected by an edge colored either red (acquaintance) or blue (stranger).";

    // Student sketches the 6 vertices on the whiteboard
    for (let idx = 0; idx < 6; idx++) {
      const name = `v${String(idx + 1)}`;
      whiteboardAdapter.createStudentShape({
        id: `shape:${name}`,
        type: "geo",
        x: 100 + (idx % 3) * 80,
        y: 100 + Math.floor(idx / 3) * 80,
        props: { text: name }
      });
    }
    expect(editor.getCurrentPageShapes()).toHaveLength(6);
    expect(editor.getCurrentPageShapes().every((s) => s.meta?.["layer"] === "STUDENT")).toBe(true);

    const t1Commit = await client.commitTypedInput(sessionId, t1Input);
    transcriptItems.push({
      id: "student_msg_1",
      role: "student",
      text: t1Input,
      status: "ACKNOWLEDGED",
      timestamp: Date.now(),
      turnId: t1Commit.turnId,
      inputEpisodeId: t1Commit.inputEpisodeId
    });

    // AI delivers Socratic nudge + circles pivot vertex v1
    const t1TextDeliveryId = newDeliveryId();
    await rendererClient.handleMessage({
      protocolVersion: 1,
      type: "DELIVERY_COMMAND",
      command: {
        deliveryId: t1TextDeliveryId,
        content: {
          medium: "TEXT",
          text: "Excellent formulation. Now consider a single arbitrary vertex $v_1 \\in V$. How many edges are incident to $v_1$ in $K_6$?"
        }
      }
    });

    const t1BoardDeliveryId = newDeliveryId();
    await rendererClient.handleMessage({
      protocolVersion: 1,
      type: "DELIVERY_COMMAND",
      command: {
        deliveryId: t1BoardDeliveryId,
        content: {
          medium: "WHITEBOARD",
          action: {
            operation: "circle",
            targetShapeId: "shape:v1",
            expectedShapeRevision: 1,
            annotationPurpose: "highlight pivot vertex v1",
            layer: "AI_ANNOTATION"
          }
        }
      }
    });

    transcriptItems.push({
      id: "ai_msg_1",
      role: "interviewer",
      text: "Excellent formulation. Now consider a single arbitrary vertex $v_1 \\in V$. How many edges are incident to $v_1$ in $K_6$?",
      status: "COMPLETED",
      timestamp: Date.now(),
      deliveryId: t1TextDeliveryId
    });

    // Verify whiteboard layer isolation: 6 student vertices + 1 AI circle annotation = 7 shapes
    expect(editor.getCurrentPageShapes()).toHaveLength(7);
    const aiCircle = editor.getCurrentPageShapes().find((s) => s.meta?.["layer"] === "AI_ANNOTATION");
    expect(aiCircle).toBeDefined();
    expect(aiCircle?.meta?.["origin"]).toBe("AI");
    expect(aiCircle?.meta?.["targetShapeId"]).toBe("shape:v1");

    // =========================================================================
    // TURN 2: Degree of Vertex $\deg(v_1) = 5$
    // =========================================================================
    const t2Input =
      "For vertex $v_1$, since there are 6 vertices in total, the degree of $v_1$ is $\\deg(v_1) = |V \\setminus \\{v_1\\}| = 6 - 1 = 5$. Thus, 5 edges connect $v_1$ to the other 5 people.";

    // Student sketches the 5 incident edges from v1
    const edgeNames = ["e_12", "e_13", "e_14", "e_15", "e_16"];
    for (const eName of edgeNames) {
      whiteboardAdapter.createStudentShape({
        id: `shape:${eName}`,
        type: "arrow",
        x: 100,
        y: 100,
        props: { text: eName }
      });
    }
    expect(editor.getCurrentPageShapes().filter((s) => s.meta?.["layer"] === "STUDENT")).toHaveLength(11);

    const t2Commit = await client.commitTypedInput(sessionId, t2Input);
    transcriptItems.push({
      id: "student_msg_2",
      role: "student",
      text: t2Input,
      status: "ACKNOWLEDGED",
      timestamp: Date.now(),
      turnId: t2Commit.turnId,
      inputEpisodeId: t2Commit.inputEpisodeId
    });

    const t2TextDeliveryId = newDeliveryId();
    await rendererClient.handleMessage({
      protocolVersion: 1,
      type: "DELIVERY_COMMAND",
      command: {
        deliveryId: t2TextDeliveryId,
        content: {
          medium: "TEXT",
          text: "Correct! $\\deg(v_1) = 5$. Since each edge is colored either red or blue, what principle allows you to deduce a lower bound on the number of edges sharing the same color?"
        }
      }
    });

    transcriptItems.push({
      id: "ai_msg_2",
      role: "interviewer",
      text: "Correct! $\\deg(v_1) = 5$. Since each edge is colored either red or blue, what principle allows you to deduce a lower bound on the number of edges sharing the same color?",
      status: "COMPLETED",
      timestamp: Date.now(),
      deliveryId: t2TextDeliveryId
    });

    // =========================================================================
    // TURN 3: Pigeonhole Principle Partition ($\lceil 5/2 \rceil = 3$)
    // =========================================================================
    const t3Input =
      "By the Pigeonhole Principle, distributing 5 edges into 2 color classes (red and blue) guarantees that at least $\\lceil 5/2 \\rceil = 3$ edges must have the same color. Without loss of generality, let at least 3 incident edges from $v_1$ be red, connecting $v_1$ to $\\{v_2, v_3, v_4\\}$.";

    const t3Commit = await client.commitTypedInput(sessionId, t3Input);
    transcriptItems.push({
      id: "student_msg_3",
      role: "student",
      text: t3Input,
      status: "ACKNOWLEDGED",
      timestamp: Date.now(),
      turnId: t3Commit.turnId,
      inputEpisodeId: t3Commit.inputEpisodeId
    });

    const t3EqDeliveryId = newDeliveryId();
    // AI writes KaTeX equation on whiteboard and highlights the 3 red edges
    await rendererClient.handleMessage({
      protocolVersion: 1,
      type: "DELIVERY_COMMAND",
      command: {
        deliveryId: t3EqDeliveryId,
        content: {
          medium: "WHITEBOARD",
          action: {
            operation: "write_equation",
            content: "\\lceil 5/2 \\rceil = 3 \\implies \\text{at least 3 red edges}",
            annotationPurpose: "Pigeonhole Principle formula",
            layer: "AI_ANNOTATION"
          }
        }
      }
    });

    for (const edgeId of ["shape:e_12", "shape:e_13", "shape:e_14"]) {
      const hlDeliveryId = newDeliveryId();
      await rendererClient.handleMessage({
        protocolVersion: 1,
        type: "DELIVERY_COMMAND",
        command: {
          deliveryId: hlDeliveryId,
          content: {
            medium: "WHITEBOARD",
            action: {
              operation: "highlight",
              targetShapeId: edgeId,
              expectedShapeRevision: 1,
              annotationPurpose: "highlight 3 monochromatic edges",
              layer: "AI_ANNOTATION"
            }
          }
        }
      });
    }

    const t3TextDeliveryId = newDeliveryId();
    await rendererClient.handleMessage({
      protocolVersion: 1,
      type: "DELIVERY_COMMAND",
      command: {
        deliveryId: t3TextDeliveryId,
        content: {
          medium: "TEXT",
          text: "Spot on. Now examine the subgraph induced by those 3 vertices $\\{v_2, v_3, v_4\\}$. What happens if any one of their mutual edges is red? What if none are?"
        }
      }
    });

    transcriptItems.push({
      id: "ai_msg_3",
      role: "interviewer",
      text: "Spot on. Now examine the subgraph induced by those 3 vertices $\\{v_2, v_3, v_4\\}$. What happens if any one of their mutual edges is red? What if none are?",
      status: "COMPLETED",
      timestamp: Date.now(),
      deliveryId: t3TextDeliveryId
    });

    // Verify whiteboard shape count: 11 student shapes + 1 circle + 1 equation + 3 highlights = 16 shapes
    expect(editor.getCurrentPageShapes()).toHaveLength(16);
    expect(editor.getCurrentPageShapes().filter((s) => s.meta?.["layer"] === "STUDENT")).toHaveLength(11);
    expect(editor.getCurrentPageShapes().filter((s) => s.meta?.["layer"] === "AI_ANNOTATION")).toHaveLength(5);

    // =========================================================================
    // TURN 4: Monochromatic $K_3$ Case Split & Completion
    // =========================================================================
    const t4Input =
      "Consider the edges between $\\{v_2, v_3, v_4\\}$:\n" +
      "1. Case 1: If any edge between them (say $(v_2, v_3)$) is red, then $\\{v_1, v_2, v_3\\}$ forms a monochromatic red triangle $K_3$.\n" +
      "2. Case 2: If none of the edges between $\\{v_2, v_3, v_4\\}$ are red, then all three edges $(v_2, v_3), (v_3, v_4), (v_2, v_4)$ must be blue, forming a monochromatic blue triangle $K_3$.\n" +
      "In both cases, there exists at least one monochromatic $K_3$ (either 3 mutual acquaintances or 3 mutual strangers). This completes the proof that $R(3,3) \\le 6$.";

    const t4Commit = await client.commitTypedInput(sessionId, t4Input);
    transcriptItems.push({
      id: "student_msg_4",
      role: "student",
      text: t4Input,
      status: "ACKNOWLEDGED",
      timestamp: Date.now(),
      turnId: t4Commit.turnId,
      inputEpisodeId: t4Commit.inputEpisodeId
    });

    const t4TextDeliveryId = newDeliveryId();
    await rendererClient.handleMessage({
      protocolVersion: 1,
      type: "DELIVERY_COMMAND",
      command: {
        deliveryId: t4TextDeliveryId,
        content: {
          medium: "TEXT",
          text: "Congratulations! You have rigorously proven the Ramsey theorem $R(3,3) = 6$ via the complete graph $K_6$, vertex degree partitioning, and the Pigeonhole Principle. Full Socratic dialogue complete."
        }
      }
    });

    transcriptItems.push({
      id: "ai_msg_4",
      role: "interviewer",
      text: "Congratulations! You have rigorously proven the Ramsey theorem $R(3,3) = 6$ via the complete graph $K_6$, vertex degree partitioning, and the Pigeonhole Principle. Full Socratic dialogue complete.",
      status: "COMPLETED",
      timestamp: Date.now(),
      deliveryId: t4TextDeliveryId
    });

    // AI clears overlay annotations at interview conclusion
    await whiteboardAdapter.clearAiOverlay();
    expect(editor.getCurrentPageShapes()).toHaveLength(11);
    expect(editor.getCurrentPageShapes().every((s) => s.meta?.["layer"] === "STUDENT")).toBe(true);

    // =========================================================================
    // VERIFY TRANSCRIPT RECONCILIATION & UI RENDERING
    // =========================================================================
    expect(transcriptItems).toHaveLength(8);
    const transcriptElement = React.createElement(TranscriptFeed, {
      items: transcriptItems
    });
    const transcriptMarkup = renderToStaticMarkup(transcriptElement);

    expect(transcriptMarkup).toContain(">You<");
    expect(transcriptMarkup).toContain(">Interviewer<");
    expect(transcriptMarkup).toContain("Turn: " + t1Commit.turnId);
    expect(transcriptMarkup).toContain("Turn: " + t2Commit.turnId);
    expect(transcriptMarkup).toContain("Turn: " + t3Commit.turnId);
    expect(transcriptMarkup).toContain("Turn: " + t4Commit.turnId);
    expect(transcriptMarkup).toContain("Delivery: " + t1TextDeliveryId);
    expect(transcriptMarkup).toContain("Delivery: " + t2TextDeliveryId);
    expect(transcriptMarkup).toContain("Delivery: " + t3TextDeliveryId);
    expect(transcriptMarkup).toContain("Delivery: " + t4TextDeliveryId);
    expect(transcriptMarkup).toContain("katex");
    expect(transcriptMarkup).toContain("R(3,3)");

    // Verify session persistence in SQLite event store
    const events = store.load(sessionId);
    expect(events.length).toBeGreaterThanOrEqual(5);
    const replayed = replaySession(sessionId, events);
    expect(replayed.started).toBe(true);
    expect(Object.keys(replayed.turns)).toHaveLength(4);

    // Verify session summary
    const summary = await client.getSessionSummary(sessionId);
    expect(summary.started).toBe(true);
  });
});
