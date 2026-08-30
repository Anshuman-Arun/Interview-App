import { describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DeliveryIdSchema,
  InputEpisodeIdSchema,
  RequestIdSchema,
  SessionIdSchema,
  TurnIdSchema,
  type DeliveryStatus
} from "../packages/domain/src/index.js";
import { sixPeopleProblem } from "../packages/problems/src/index.js";
import {
  MathText,
  parseMathSegments,
  renderKaTeXToString
} from "../apps/web/src/components/MathText.js";
import { ProblemCard } from "../apps/web/src/components/ProblemCard.js";
import { DeliveryBadge } from "../apps/web/src/components/DeliveryBadge.js";
import { StudentInputArea } from "../apps/web/src/components/StudentInputArea.js";
import {
  TranscriptFeed,
  type TranscriptItem
} from "../apps/web/src/components/TranscriptFeed.js";
import {
  BrowserCommandClient
} from "../apps/web/src/command-client.js";
import {
  RendererClient,
  type TextPresenter,
  type AudioPlayer
} from "../apps/web/src/renderer-client.js";

const CLIENT_TOKEN = "phase1_test_client_token_min_32_characters_long";
const BASE_URL = "http://127.0.0.1:43123";
const SESSION_ID = SessionIdSchema.parse("session_00000000-0000-4000-8000-000000000001");

describe("UI Shell & KaTeX Math Rendering", () => {
  describe("1. KaTeX Math Delimiter Parsing", () => {
    it("returns empty segments for empty input", () => {
      const segments = parseMathSegments("");
      expect(segments).toEqual([]);
    });

    it("parses plain text without math delimiters as a single text segment", () => {
      const text = "In a group of six people, prove there are three mutual acquaintances.";
      const segments = parseMathSegments(text);
      expect(segments).toHaveLength(1);
      expect(segments[0]).toEqual({
        type: "text",
        content: text
      });
    });

    it("parses inline LaTeX math surrounded by single dollar signs ($...$)", () => {
      const text = "Let $v \\in V$ be an arbitrary vertex.";
      const segments = parseMathSegments(text);
      expect(segments).toHaveLength(3);
      expect(segments[0]).toEqual({ type: "text", content: "Let " });
      expect(segments[1]).toEqual({ type: "inline-math", content: "v \\in V" });
      expect(segments[2]).toEqual({ type: "text", content: " be an arbitrary vertex." });
    });

    it("parses block LaTeX math surrounded by double dollar signs ($$...$$)", () => {
      const text = "The Ramsey formula is: $$\\sum_{i=1}^n \\deg(v_i) = 2|E|$$ which concludes the proof.";
      const segments = parseMathSegments(text);
      expect(segments).toHaveLength(3);
      expect(segments[0]).toEqual({ type: "text", content: "The Ramsey formula is: " });
      expect(segments[1]).toEqual({
        type: "block-math",
        content: "\\sum_{i=1}^n \\deg(v_i) = 2|E|"
      });
      expect(segments[2]).toEqual({ type: "text", content: " which concludes the proof." });
    });

    it("parses LaTeX math with parenthesis \\(...\\) and bracket \\[...] delimiters", () => {
      const text = "Inline \\(R(3,3)=6\\) and block \\[\\lceil 5/2 \\rceil = 3\\] in one sentence.";
      const segments = parseMathSegments(text);
      expect(segments).toHaveLength(5);
      expect(segments[0]).toEqual({ type: "text", content: "Inline " });
      expect(segments[1]).toEqual({ type: "inline-math", content: "R(3,3)=6" });
      expect(segments[2]).toEqual({ type: "text", content: " and block " });
      expect(segments[3]).toEqual({ type: "block-math", content: "\\lceil 5/2 \\rceil = 3" });
      expect(segments[4]).toEqual({ type: "text", content: " in one sentence." });
    });

    it("parses complex Ramsey proof reasoning with multiple inline formulas", () => {
      const reasoning = "Pick vertex $v_1$. Since $|V|=6$, the remaining vertices $|V \\setminus \\{v_1\\}|=5$. By PHP, $\\deg_{red}(v_1) \\ge 3$ or $\\deg_{blue}(v_1) \\ge 3$.";
      const segments = parseMathSegments(reasoning);
      expect(segments.filter((s) => s.type === "inline-math")).toHaveLength(5);
      expect(segments[1]?.content).toBe("v_1");
      expect(segments[3]?.content).toBe("|V|=6");
      expect(segments[5]?.content).toBe("|V \\setminus \\{v_1\\}|=5");
      expect(segments[7]?.content).toBe("\\deg_{red}(v_1) \\ge 3");
      expect(segments[9]?.content).toBe("\\deg_{blue}(v_1) \\ge 3");
    });
  });

  describe("2. KaTeX HTML Generation and MathText Component", () => {
    it("renders valid LaTeX formula to HTML string with KaTeX markup", () => {
      const html = renderKaTeXToString("R(3,3) = 6", false);
      expect(html).toContain("katex");
      expect(html).toContain("R");
      expect(html).toContain("3");
      expect(html).toContain("6");
    });

    it("renders block displayMode with katex-display class", () => {
      const html = renderKaTeXToString("K_6", true);
      expect(html).toContain("katex-display");
    });

    it("renders MathText component with mixed text and formulas into HTML", () => {
      const element = React.createElement(MathText, {
        text: "Consider complete graph $K_6$ where $\\deg(v) = 5$."
      });
      const rendered = renderToStaticMarkup(element);

      expect(rendered).toContain("Consider complete graph");
      expect(rendered).toContain("katex-inline-wrapper");
      expect(rendered).toContain("where");
      expect(rendered).toContain("katex");
    });

    it("gracefully falls back when invalid syntax is provided to KaTeX", () => {
      // Intentionally pass syntax with bad arguments that renderKaTeX handles
      const element = React.createElement(MathText, {
        text: "Formula: $\\frac{broken$"
      });
      const rendered = renderToStaticMarkup(element);
      expect(rendered).toContain("Formula:");
    });
  });

  describe("3. ProblemCard Component", () => {
    it("renders Oxford Ramsey R(3,3) problem statement and metadata", () => {
      const element = React.createElement(ProblemCard, {
        problem: sixPeopleProblem
      });
      const markup = renderToStaticMarkup(element);

      expect(markup).toContain("Oxford Mathematics: Ramsey Theorem");
      expect(markup).toContain("In a group of six people");
      expect(markup).toContain("three mutual acquaintances or three mutual strangers");
      expect(markup).toContain("Acquaintance is symmetric");
      expect(markup).toContain("Ramsey Theory");
      expect(markup).toContain("Complete Graph");
      expect(markup).toContain("Pigeonhole Principle");
      expect(markup).toContain("combinatorics");
      expect(markup).toContain("graph theory");
    });

    it("defaults to sixPeopleProblem when problem prop is null/undefined", () => {
      const element = React.createElement(ProblemCard, {});
      const markup = renderToStaticMarkup(element);

      expect(markup).toContain("oxford-six-people");
      expect(markup).toContain("introductory-oxford");
    });
  });

  describe("4. DeliveryBadge Component", () => {
    const statuses: readonly DeliveryStatus[] = [
      "QUEUED",
      "DELIVERING",
      "EXPOSED",
      "COMPLETED",
      "POSSIBLY_EXPOSED"
    ];

    it.each(statuses)("renders badge for delivery status %s", (status) => {
      const element = React.createElement(DeliveryBadge, { status });
      const markup = renderToStaticMarkup(element);

      expect(markup).toContain(`data-status="${status}"`);
      expect(markup).toContain("delivery-badge");
    });

    it("renders badge for student input statuses (PENDING, ACKNOWLEDGED, ERROR)", () => {
      const pendingMarkup = renderToStaticMarkup(
        React.createElement(DeliveryBadge, { status: "PENDING" })
      );
      expect(pendingMarkup).toContain("Sending...");

      const ackMarkup = renderToStaticMarkup(
        React.createElement(DeliveryBadge, { status: "ACKNOWLEDGED" })
      );
      expect(ackMarkup).toContain("Committed");

      const errorMarkup = renderToStaticMarkup(
        React.createElement(DeliveryBadge, { status: "ERROR" })
      );
      expect(errorMarkup).toContain("Failed");
    });
  });

  describe("5. StudentInputArea Component", () => {
    it("renders reasoning input form with textarea and character limits", () => {
      const element = React.createElement(StudentInputArea, {
        onSubmit: vi.fn()
      });
      const markup = renderToStaticMarkup(element);

      expect(markup).toContain("student-reasoning-input");
      expect(markup).toContain("Your Mathematical Reasoning");
      expect(markup).toContain("0 / 20,000 chars");
      expect(markup).toContain("Submit Reasoning");
      expect(markup).toContain("Ctrl+Enter");
    });
  });

  describe("6. TranscriptFeed Component", () => {
    it("renders empty state when no transcript items exist", () => {
      const element = React.createElement(TranscriptFeed, {
        items: []
      });
      const markup = renderToStaticMarkup(element);

      expect(markup).toContain("The interview dialogue has not started yet.");
      expect(markup).toContain("0 entries");
    });

    it("renders student reasoning bubbles and AI Socratic responses with KaTeX math", () => {
      const studentTurnId = TurnIdSchema.parse("turn_1");
      const inputEpId = InputEpisodeIdSchema.parse("input_ep_1");
      const deliveryId = DeliveryIdSchema.parse("delivery_1");

      const items: readonly TranscriptItem[] = [
        {
          id: "msg_1",
          role: "student",
          text: "Let $v_1 \\in V$. Since $|V|=6$, there are 5 edges incident to $v_1$.",
          status: "ACKNOWLEDGED",
          timestamp: 1724985600000,
          turnId: studentTurnId,
          inputEpisodeId: inputEpId
        },
        {
          id: "msg_2",
          role: "interviewer",
          text: "Correct. By the Pigeonhole Principle $\\lceil 5/2 \\rceil = 3$, what can you deduce about the colors of those 5 edges?",
          status: "COMPLETED",
          timestamp: 1724985605000,
          deliveryId
        }
      ];

      const element = React.createElement(TranscriptFeed, {
        items
      });
      const markup = renderToStaticMarkup(element);

      expect(markup).toContain("Student (You)");
      expect(markup).toContain("Socratic Interviewer");
      expect(markup).toContain("student-math-bubble");
      expect(markup).toContain("ai-math-bubble");
      expect(markup).toContain("Turn: turn_1");
      expect(markup).toContain("Episode: input_ep_1");
      expect(markup).toContain("Delivery: delivery_1");
      expect(markup).toContain("katex");
    });
  });

  describe("7. Command & Stream Client Integration in Session State", () => {
    it("handles optimistic input commitment and turn reconciliation", async () => {
      const requestId = RequestIdSchema.parse("request_turn_1");
      const turnId = TurnIdSchema.parse("turn_001");
      const inputEpisodeId = InputEpisodeIdSchema.parse("input_ep_001");

      const mockFetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            protocolVersion: 1,
            ok: true,
            type: "INPUT_COMMITTED",
            requestId,
            inputEpisodeId,
            turnId
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        )
      );

      const client = new BrowserCommandClient({
        baseUrl: BASE_URL,
        clientToken: CLIENT_TOKEN,
        fetchImpl: mockFetch
      });

      const response = await client.commitTypedInput(
        SESSION_ID,
        "Let $v \\in V$ be a vertex.",
        { requestId }
      );

      expect(response.type).toBe("INPUT_COMMITTED");
      expect(response.turnId).toBe(turnId);
      expect(response.inputEpisodeId).toBe(inputEpisodeId);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("handles session recovery and maps delivery statuses", async () => {
      const requestId = RequestIdSchema.parse("request_summary");
      const deliveryId = DeliveryIdSchema.parse("delivery_recovered_1");

      const mockFetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            protocolVersion: 1,
            ok: true,
            type: "SESSION_SUMMARY",
            requestId,
            sessionId: SESSION_ID,
            sequence: 14,
            started: true,
            contextEpoch: 1,
            deliveryStatuses: {
              [deliveryId]: "POSSIBLY_EXPOSED"
            }
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        )
      );

      const client = new BrowserCommandClient({
        baseUrl: BASE_URL,
        clientToken: CLIENT_TOKEN,
        fetchImpl: mockFetch
      });

      const summary = await client.getSessionSummary(SESSION_ID, { requestId });
      expect(summary.sequence).toBe(14);
      expect(summary.started).toBe(true);
      expect(summary.contextEpoch).toBe(1);
      expect(summary.deliveryStatuses[deliveryId]).toBe("POSSIBLY_EXPOSED");
    });

    it("handles Socratic text presentation and exposure / completion acknowledgement flow", async () => {
      const deliveryId = DeliveryIdSchema.parse("delivery_00000000-0000-4000-8000-000000000001");
      const sentAcks: unknown[] = [];

      const mockAckSender = {
        send: vi.fn(async (cmd) => {
          sentAcks.push(cmd);
        })
      };

      const presentedTexts: { text: string; deliveryId: string }[] = [];
      const textPresenter: TextPresenter = {
        presentText: (text, dId) => {
          presentedTexts.push({ text, deliveryId: dId });
        }
      };

      const mockAudioPlayer: AudioPlayer = {
        playAudio: vi.fn()
      };

      const renderer = new RendererClient({
        sessionId: SESSION_ID,
        acknowledgementSender: mockAckSender,
        textPresenter,
        audioPlayer: mockAudioPlayer
      });

      await renderer.handleMessage({
        protocolVersion: 1,
        type: "DELIVERY_COMMAND",
        command: {
          deliveryId,
          content: {
            medium: "TEXT",
            text: "Notice that $\\deg(v_1) = 5$."
          }
        }
      });

      expect(presentedTexts).toHaveLength(1);
      expect(presentedTexts[0]?.text).toBe("Notice that $\\deg(v_1) = 5$.");
      expect(presentedTexts[0]?.deliveryId).toBe(deliveryId);

      const snapshot = renderer.snapshot();
      expect(snapshot).toHaveLength(1);
      expect(snapshot[0]?.phase).toBe("COMPLETED");
      expect(snapshot[0]?.exposedAcknowledged).toBe(true);
      expect(snapshot[0]?.completedAcknowledged).toBe(true);
    });

    it("streams whiteboard AI overlay actions and creates non-destructive annotations", async () => {
      const deliveryId = DeliveryIdSchema.parse("delivery_00000000-0000-4000-8000-000000000002");
      const { InMemoryTldrawEditor, TldrawWhiteboardAdapter } = await import(
        "../apps/web/src/tldraw-whiteboard-adapter.js"
      );

      const editor = new InMemoryTldrawEditor();
      const whiteboardAdapter = new TldrawWhiteboardAdapter(editor);

      // Student creates a node shape first
      const studentShape = whiteboardAdapter.createStudentShape({
        id: "shape:node_v1",
        type: "geo",
        x: 100,
        y: 100,
        props: { text: "v1" }
      });
      expect(studentShape.meta?.["layer"]).toBe("STUDENT");

      const sentAcks: unknown[] = [];
      const mockAckSender = {
        send: vi.fn(async (cmd) => {
          sentAcks.push(cmd);
        })
      };

      const renderer = new RendererClient({
        sessionId: SESSION_ID,
        acknowledgementSender: mockAckSender,
        textPresenter: { presentText: vi.fn() },
        audioPlayer: { playAudio: vi.fn() },
        whiteboardPresenter: whiteboardAdapter
      });

      await renderer.handleMessage({
        protocolVersion: 1,
        type: "DELIVERY_COMMAND",
        command: {
          deliveryId,
          content: {
            medium: "WHITEBOARD",
            action: {
              operation: "circle",
              targetShapeId: "shape:node_v1",
              annotationPurpose: "highlight pivot vertex",
              layer: "AI_ANNOTATION"
            }
          }
        }
      });

      // Confirm AI shape was created on the editor
      const shapes = editor.getCurrentPageShapes();
      const aiShape = shapes.find((s) => s.meta?.["layer"] === "AI_ANNOTATION");
      expect(aiShape).toBeDefined();
      expect(aiShape?.meta?.["deliveryId"]).toBe(deliveryId);
      expect(aiShape?.meta?.["origin"]).toBe("AI");

      // Confirm student shape was NOT mutated
      const remainingStudentShape = editor.getShape("shape:node_v1");
      expect(remainingStudentShape?.meta?.["layer"]).toBe("STUDENT");

      // Confirm acknowledgements
      expect(sentAcks).toHaveLength(2);
    });
  });
});
