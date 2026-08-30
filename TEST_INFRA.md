# E2E Test Infra: Phase 1 Typed Interview MVP

## Test Philosophy
- Requirement-driven, opaque-box testing derived from `ORIGINAL_REQUEST.md`.
- No reliance on internal implementation details; tests interact through public interfaces (`BrowserCommandClient`, `RendererClient`, `GeminiApiAdapter`, `TldrawWhiteboardAdapter`, React UI DOM components, and loopback HTTP/SSE endpoints).
- Methodology: 4-tier testing hierarchy (Feature Coverage, Boundary/Corner, Cross-Feature Combinations, Real-World Application Scenarios).

## Feature Inventory
| # | Feature | Source (Requirement) | Tier 1 | Tier 2 | Tier 3 |
|---|---------|---------------------|:------:|:------:|:------:|
| 1 | `GeminiApiAdapter` & Capabilities | ORIGINAL_REQUEST §R3 | 5 | 5 | ✓ |
| 2 | No-Metered Billing Proof & Fail-Closed Gating | ORIGINAL_REQUEST §R3 | 5 | 5 | ✓ |
| 3 | Provider Session Admission & Redaction | ORIGINAL_REQUEST §R3 | 5 | 5 | ✓ |
| 4 | Whiteboard Shape Layer Isolation | ORIGINAL_REQUEST §R2 | 5 | 5 | ✓ |
| 5 | Non-Destructive AI Overlay Actions | ORIGINAL_REQUEST §R2 | 5 | 5 | ✓ |
| 6 | Shape Revision & Stale Reference Guard | ORIGINAL_REQUEST §R2 | 5 | 5 | ✓ |
| 7 | KaTeX Math Rendering Engine | ORIGINAL_REQUEST §R1 | 5 | 5 | ✓ |
| 8 | Problem Statement & Formulation Display | ORIGINAL_REQUEST §R1 | 5 | 5 | ✓ |
| 9 | Student Typed Input Lifecycle | ORIGINAL_REQUEST §R1 | 5 | 5 | ✓ |
| 10 | Socratic Response Streaming & Badges | ORIGINAL_REQUEST §R1 | 5 | 5 | ✓ |
| 11 | Session Start & Recovery | ORIGINAL_REQUEST §R1 | 5 | 5 | ✓ |
| 12 | Architecture Invariants & Quality Gates | ORIGINAL_REQUEST §R4 | 5 | 5 | ✓ |
| 13 | End-to-End Ramsey $R(3,3)$ Verification | ORIGINAL_REQUEST §AC | 5 | 5 | ✓ |

## Test Architecture
- Test Runner: `vitest run`
- Quality Checkers:
  - `tsc -p tsconfig.json --noEmit`
  - `eslint .`
  - `node scripts/check-architecture-boundaries.mjs`
- Test Files Layout:
  - `tests/gemini-api-adapter.test.ts` (Provider adapter, capabilities, billing proof, cancellation, redaction)
  - `tests/whiteboard-adapter.test.ts` (Whiteboard adapter, shape isolation, 7 overlay actions, immutability)
  - `tests/ui-shell.test.ts` (KaTeX parser/renderer, input lifecycle, transcript badges, session hook)
  - `tests/e2e-typed-interview.test.ts` (End-to-end Ramsey $R(3,3)$ typed interview flow with mock and loopback)

## Real-World Application Scenarios (Tier 4)
| # | Scenario | Features Exercised | Complexity |
|---|----------|--------------------|------------|
| 1 | Full Oxford Ramsey $R(3,3)$ proof progression: $K_6$ node selection, degree calculation $\deg(v)=5$, Pigeonhole Principle partition (3 same color), monochromatic triangle $K_3$ completion. | F1-F13 | High |
| 2 | Whiteboard sketch & AI overlay coordination: Student draws 6 vertices and monochromatic edges; AI overlays circle around vertex $v_1$ and highlights incident edges without mutating student strokes. | F4-F6, F8-F10 | High |
| 3 | Session disconnect and recovery mid-interview: Network drops during streaming Socratic probe; client reconnects, recovers delivery status map, marks unacked deliveries `POSSIBLY_EXPOSED`, and resumes transcript. | F9-F11 | High |
| 4 | Metered usage attack attempt / Fail-closed preflight: Adapter configured with metered billing account while `allowMeteredUsage=false`; session admission fails closed before network dispatch. | F1-F3, F12 | Medium |
| 5 | Complex LaTeX formula drafting and Socratic rendering: Student submits expressions like $\lceil (6-1)/2 \rceil = 3$ and $R(s,t) \le R(s-1,t) + R(s,t-1)$; UI renders KaTeX cleanly with no syntax crashes. | F7-F10 | Medium |

## Coverage Thresholds
- Tier 1: ≥5 per feature (Total ≥ 65 tests)
- Tier 2: ≥5 per feature where boundaries exist (Total ≥ 65 tests)
- Tier 3: Pairwise coverage of major feature interactions (Total ≥ 13 tests)
- Tier 4: ≥5 realistic application scenarios (Total ≥ 5 tests)
- Total minimum: ≥ 148 test cases across all test suites
