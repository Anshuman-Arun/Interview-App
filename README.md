# Oxford Technical Interview App — Phase 1 Typed MVP

A local-first, mathematically rigorous technical interview application designed to conduct Oxford-style tutorial dialogues against the Ramsey Theorem $R(3,3) = 6$ problem. Built under a single-writer architecture with append-only SQLite persistence, deterministic replay, KaTeX math typesetting, tldraw whiteboard canvas with layer-isolated AI overlays, and gated provider adapters.

---

## Key Features & Architecture

- **Oxford Ramsey $R(3,3) = 6$ Pedagogical Engine**: Conducts Socratic dialogue through the formal milestones of the Oxford six-people problem (graph representation, vertex selection, degree calculation, Pigeonhole Principle partition, and monochromatic $K_3$ closure).
- **Single-Writer Event Log & Pure Replay**: All state changes are serialized through `SessionWriter` into an append-only SQLite event log. Replaying events from disk bit-for-bit reconstructs identical runtime state.
- **Authenticated Loopback Transport**:
  - Command Server (`POST /v1/commands`): Handles session lifecycle, typed student reasoning commits, and delivery acknowledgements.
  - Renderer Stream (`POST /v1/renderer-stream`): Server-Sent Events (SSE) stream pushing Socratic text and whiteboard commands to the client.
  - Origin Validation & Constant-Time Auth: Enforces exact Origin checks and minimum 32-character bearer token comparisons.
- **KaTeX Mathematical Typesetting**: Supports inline math (`$...$`, `\(...\)`) and display block formulas (`$$...$$`, `\[...\]`) in problem statements, student inputs, and interviewer responses, with graceful fallback on syntax errors.
- **Layer-Isolated Whiteboard Canvas (`tldraw`)**: Partitions canvas elements into `STUDENT`, `AI_ANNOTATION`, and `SYSTEM_DECORATION` layers. Interviewer hints (circles, highlights, arrows, notes) render exclusively as non-destructive overlays and never mutate or overwrite student-owned strokes.
- **Gated Provider Adapter (`GeminiApiAdapter`)**: Declares honest capabilities (`CLOSE_CLIENT_STREAM` cancellation) and enforces fail-closed billing preflight under no-metered policies.
- **Delivery Lifecycle & Reconnect Safety**: Tracks message delivery through `QUEUED` $\to$ `DELIVERING` $\to$ `EXPOSED` $\to$ `COMPLETED` phases. Lost acknowledgements recover conservatively as `POSSIBLY_EXPOSED` on reconnection and are never replayed.

---

## Project Structure

```
Interview-App/
├── apps/
│   ├── server/           # Loopback command server, SSE stream, and turn orchestrator
│   └── web/              # React 19 + Vite web client, tldraw canvas, and KaTeX UI
├── packages/
│   ├── domain/           # Branded IDs, schemas, capabilities, and pedagogy types
│   ├── events/           # Semantic event schemas and pure replay reducer
│   ├── persistence/      # SQLite append-only event store and idempotency cache
│   ├── interview-engine/ # TurnCoordinator, ProviderCoordinator, Context, and Policy
│   ├── delivery/         # DeliveryCoordinator, SSE framing, and acknowledgements
│   ├── problems/         # Oxford Ramsey R(3,3) reasoning graph and disclosures
│   └── providers/        # ReasoningProvider interface, MockModelAdapter, and GeminiApiAdapter
├── scripts/
│   └── check-architecture-boundaries.mjs # Static architectural boundary enforcement
└── tests/                # 49 test suites (unit, property, adversarial, and end-to-end)
```

---

## Quick Start

### Prerequisites

- **Node.js**: $\ge 22.12.0$ (required by the pinned `tldraw@5.3.2` dependency; current Node 22 LTS is recommended)
- **pnpm**: `11.19.0` (managed via `corepack enable && corepack pnpm`)

### Installation

```powershell
corepack pnpm install --frozen-lockfile
```

### Running Locally

1. **Start the Loopback Interview Server**:
   ```powershell
   corepack pnpm start:server
   ```
   The server binds to `127.0.0.1:43123` (command) and `127.0.0.1:43124` (stream) and outputs an authenticated launch link.

2. **Start the Frontend Web Application**:
   ```powershell
   corepack pnpm dev:web
   ```
   Open `http://localhost:5173` in your browser.

3. **Run the Synthetic Demo**:
   ```powershell
   corepack pnpm demo
   ```

---

## Quality Gates & Verification

All changes must pass the full automated quality matrix:

```powershell
# 1. Architectural boundary verification (scans dependency direction, single-writer invariants, and secret leaks)
node scripts/check-architecture-boundaries.mjs

# 2. Public-release hygiene (tracked secrets, local paths, emails, local data)
corepack pnpm security:public

# 3. TypeScript type-checking (zero errors)
corepack pnpm typecheck

# 4. ESLint static analysis (zero warnings/errors)
corepack pnpm lint

# 5. Production web application build (Vite client bundle)
corepack pnpm build:web

# 6. Vitest automated test suite
corepack pnpm test

# 7. End-to-end typed interview test suite
corepack pnpm test:e2e

# 8. Run full check aggregate
corepack pnpm check
```
