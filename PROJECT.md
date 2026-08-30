# Project: Phase 1 Typed Interview MVP

## Architecture
The Phase 1 Typed Interview MVP delivers a full-stack, typed Socratic interview experience for complex mathematical problems (specifically Oxford Ramsey $R(3,3)$) under frozen architectural invariants.

```text
                                       [ Browser Frontend (apps/web) ]
                                      /                               \
                                     /                                 \
                     (POST /v1/commands)                    (POST /v1/renderer-stream)
                            |                                            ^
                            v                                            | (SSE: delivery)
              +----------------------------+                +----------------------------+
              |   Loopback Command Server  |                |    Renderer Stream Server  |
              +--------------+-------------+                +--------------+-------------+
                             |                                             |
                             +----------------------+----------------------+
                                                    |
                                                    v
                                    +-------------------------------+
                                    |         SessionWriter         |
                                    |    (SQLite Immutable Log)     |
                                    +---------------+---------------+
                                                    |
                                                    v
                                    +-------------------------------+
                                    |         TurnCoordinator       |
                                    +---------------+---------------+
                                                   / \
                                                  /   \
                                                 v     v
                         +--------------------------+  +--------------------------+
                         |    ContextCoordinator    |  |    ProviderCoordinator   |
                         +--------------------------+  +------------+-------------+
                                                                    |
                                                                    v
                                                     [ Guarded Execution Session ]
                                                                    |
                                                                    v
                                                     +------------------------------+
                                                     |    GeminiApiAdapter (R3)     |
                                                     |  (No-Metered Billing Proof)  |
                                                     +------------------------------+
```

## Feature Inventory
| # | Feature | Description | Milestone | Source | Status |
|---|---------|-------------|-----------|--------|--------|
| 1 | `GeminiApiAdapter` Implementation | Model provider adapter implementing `ReasoningProvider` and honest `ModelCapabilities` | M1 | ORIGINAL_REQUEST §R3 | DONE |
| 2 | No-Metered Billing Proof | Deterministic billing verification proving zero spend when `allowMeteredUsage = false` | M1 | ORIGINAL_REQUEST §R3 | DONE |
| 3 | Provider Session Admission & Redaction | Guarded session admission via `openProviderExecutionSession` with credential/error sanitization | M1 | ORIGINAL_REQUEST §R3 | DONE |
| 4 | Whiteboard Shape Layer Isolation | 3-layer architecture (`STUDENT`, `AI_ANNOTATION`, `SYSTEM_DECORATION`) ensuring AI cannot mutate student strokes | M2 | ORIGINAL_REQUEST §R2 | DONE |
| 5 | Non-Destructive AI Overlay Actions | Implementation of 7 overlay actions (`circle`, `highlight`, `draw_arrow`, `point_at`, `write_text`, `write_equation`, `erase_ai_annotation`) & `clearAiOverlay` | M2 | ORIGINAL_REQUEST §R2 | DONE |
| 6 | Shape Revision & Stale Reference Guard | Validation of `targetShapeId` and `expectedShapeRevision` before applying overlay hints | M2 | ORIGINAL_REQUEST §R2 | DONE |
| 7 | KaTeX Math Rendering Engine | Delimiter parsing (`$...$`, `$$...$$`) and safe KaTeX rendering in problem statement, input preview, transcript, and overlay | M3 | ORIGINAL_REQUEST §R1 | DONE |
| 8 | Problem Statement & Formulation Display | Formatted presentation of Oxford Ramsey $R(3,3)$ problem statement, given facts, and topic tags | M3 | ORIGINAL_REQUEST §R1 | DONE |
| 9 | Student Typed Input Lifecycle | Live draft preview, character validation, optimistic submission (`TurnId` / `InputEpisodeId`), idempotency retry | M3 | ORIGINAL_REQUEST §R1 | DONE |
| 10 | Socratic Response Streaming & Badges | SSE stream consumption, token streaming, delivery status badges (`QUEUED`, `DELIVERING`, `EXPOSED`, `COMPLETED`) | M3 | ORIGINAL_REQUEST §R1 | DONE |
| 11 | Session Start & Recovery | Session start/attach, state recovery via `getSessionSummary`, and reconnection handling | M3 | ORIGINAL_REQUEST §R1 | DONE |
| 12 | Architecture Invariants & Quality Gates | Static boundary checks (`check-architecture-boundaries.mjs`), `tsc`, `eslint`, `vitest` 100% pass | M4 | ORIGINAL_REQUEST §R4 | DONE |
| 13 | End-to-End Ramsey $R(3,3)$ Functional Verification | Complete interactive interview session validating reasoning turns, overlay annotations, and provider gating | M4 | ORIGINAL_REQUEST §AC | DONE |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Gated Gemini Provider Adapter | `packages/providers/src/gemini-api-adapter.ts`, tests | none | DONE (20/20 tests passed) |
| M2 | Whiteboard Canvas & AI Overlay | `apps/web/src/tldraw-whiteboard-adapter.ts`, whiteboard components, tests | none | DONE (25/25 tests passed) |
| M3 | Frontend UI Shell & Socratic Stream | `apps/web/src/App.tsx`, KaTeX components, session hooks, transcript, inputs, Vite setup | M1, M2 | DONE (25/25 tests passed) |
| M4 | System Integration & Quality Gates | End-to-end integration, quality gates (`tsc`, `eslint`, boundaries, `vitest`), Ramsey $R(3,3)$ | M1, M2, M3 | DONE (619/619 tests passed, Gate PASSED) |

## Interface Contracts

### 1. `GeminiApiAdapter` Contract (`packages/domain/src/provider.ts`)
- Implements `ReasoningProvider`
- `capabilities`:
  - `inputModalities`: `Set(["text"])`
  - `textStreaming`: `false`
  - `structuredOutput`: `"FINAL_ONLY"`
  - `cancellation`: `"CLOSE_CLIENT_STREAM"`
  - `dataUse`: `"REMOTE_MAY_BE_USED_FOR_IMPROVEMENT"`
- `verifyBillingSafety({ now })`: Returns valid `BillingVerification` with `spendImpossible: true` when free-only mode is active.

### 2. `TldrawWhiteboardAdapter` Contract (`packages/domain/src/whiteboard.ts` & `apps/web/src/renderer-client.ts`)
- Implements `WhiteboardAdapter` and `WhiteboardPresenter`
- `applyAiOverlayAction(action: BoardAction)`: Creates or updates shapes with `meta.layer = "AI_ANNOTATION"`. Fails closed if attempting to touch `STUDENT` layer shapes.
- `clearAiOverlay()`: Atomically removes all shapes where `meta.layer === "AI_ANNOTATION"`.
- `presentWhiteboard(action: BoardAction, deliveryId: DeliveryId)`: Executes overlay action and triggers exposure / completion callbacks.

### 3. `BrowserCommandClient` & `RendererClient` (`apps/web`)
- `commandClient.startSession(sessionId)`: Initiates session over loopback.
- `commandClient.commitTypedInput(sessionId, text)`: Submits reasoning input, returns `TurnId` and `InputEpisodeId`.
- `consumeAuthenticatedRendererStream`: Consumes SSE delivery commands and forwards to `RendererClient`.

## Code Layout
- `packages/providers/src/gemini-api-adapter.ts`: Gated Gemini API adapter.
- `apps/web/src/tldraw-whiteboard-adapter.ts`: Tldraw whiteboard adapter & overlay presenter.
- `apps/web/src/components/MathText.tsx`: KaTeX math parser and renderer.
- `apps/web/src/components/ProblemCard.tsx`: Oxford Ramsey problem card.
- `apps/web/src/components/TranscriptFeed.tsx`: Chat transcript with KaTeX and delivery badges.
- `apps/web/src/components/StudentInputArea.tsx`: Text input with live KaTeX preview.
- `apps/web/src/components/WhiteboardCanvas.tsx`: Tldraw canvas container.
- `apps/web/src/hooks/useInterviewSession.ts`: React session state & transport lifecycle hook.
- `apps/web/src/App.tsx`: Main split-pane application shell.
- `apps/web/vite.config.ts`: Vite frontend development and build configuration.
- `tests/gemini-api-adapter.test.ts`: Provider adapter unit and integration tests.
- `tests/whiteboard-adapter.test.ts`: Whiteboard isolation and overlay unit tests.
- `tests/ui-shell.test.ts`: UI shell and KaTeX rendering unit tests.
- `tests/e2e-typed-interview.test.ts`: End-to-end integration and Ramsey $R(3,3)$ verification tests.
- `tests/adversarial-challenger-1.test.ts`: Adversarial Whiteboard immutability & Gemini gating tests.
- `tests/adversarial-ui-katex-ramsey.test.ts`: Adversarial KaTeX fuzzing & Ramsey $R(3,3)$ multi-turn execution tests.
