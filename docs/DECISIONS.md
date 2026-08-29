# Implementation Decisions

Only decisions left unfrozen by the architecture are recorded here.

## D001 — pnpm workspace with strict TypeScript source packages

- Decision: use pnpm workspaces and one strict root TypeScript project during the harness stage.
- Reason: npm on this machine resolves to a broken roaming shim; pnpm 11.19.0 is available. A single typecheck still enforces package boundaries documented in `IMPLEMENTATION_MAP.md` without premature publish/build plumbing.
- Alternatives considered: npm workspaces; separate project references per package; a single undivided `src` directory.
- Consequences: simple Phase 0 execution; package build artifacts and API Extractor are deferred.
- Reversible: yes.

## D002 — Node 22 built-in SQLite

- Decision: use synchronous `node:sqlite` behind an asynchronous repository interface.
- Reason: the serialized session writer already sequences operations; the built-in driver avoids native-addon installation risk and supplies real transactions for the local harness.
- Alternatives considered: `better-sqlite3`, `sqlite3`, a WASM SQLite build.
- Consequences: Node >=22.5 is required; the API can be swapped behind `EventStore` if benchmarks or stability require it.
- Reversible: yes.

## D003 — Transactional request-result table beside events

- Decision: persist processed `RequestId` results in the same SQLite transaction as their emitted events.
- Reason: event ID uniqueness alone cannot return the original command result after restart. Atomic result persistence makes duplicated callbacks idempotent across crashes.
- Alternatives considered: deriving duplicate results from events; in-memory deduplication; embedding request IDs only in payloads.
- Consequences: the idempotency table is non-authoritative operational metadata but must be retained with the event database.
- Reversible: yes, with migration.

## D004 — Promise-chain actor per session

- Decision: implement the Phase 0 single writer as a per-session promise-chain queue owned by `SessionRuntimeRegistry`.
- Reason: it is small, inspectable, and sufficient for one Node process while preserving the frozen single-writer path.
- Alternatives considered: worker thread actors; external queue; mutex library.
- Consequences: multi-process access is not supported yet; SQLite constraints remain a second safety layer.
- Reversible: yes, provided the writer interface stays stable.

## D005 — Conservative broad revision compatibility

- Decision: Phase 0 requires exact equality for context epoch, last committed input sequence, transcript, board, problem-state, and policy revisions; missing provenance is `UNKNOWN`.
- Reason: dependency-granular compatibility is explicitly unfrozen and premature.
- Alternatives considered: shape/region dependency tracking; treating unrelated revision changes as compatible.
- Consequences: safe extra regeneration may occur; stale output cannot be delivered.
- Reversible: yes.

## D006 — Explicit allowlist context projection

- Decision: construct provider context from a new object containing only public prompt, current student work, selected realization request, delivered facts, and forbidden disclosure IDs.
- Reason: serialization of a broad state object followed by deletion is fragile and risks private-data leakage.
- Alternatives considered: redaction after serialization; provider-managed transcript history.
- Consequences: new context fields require deliberate review and tests.
- Reversible: yes, though the allowlist principle remains required by the freeze.

## D007 — Short semantic DeliveryAtoms with durable start-before-send

- Decision: persist `DELIVERY_STARTED` before emitting a renderer command; on restart, any still-delivering atom becomes `POSSIBLY_EXPOSED`.
- Reason: this places the physical send inside a conservative uncertainty window and makes crash recovery auditable.
- Alternatives considered: persist after send; exactly-once transport claims.
- Consequences: a crash after start but before actual display can conservatively consume disclosure budget.
- Reversible: acknowledgement detail may evolve; conservative recovery is frozen.

## D008 — Phase 0 disclosure analyzer is closed-world

- Decision: independently recognize protected formulations and approved zero-disclosure probe templates; anything semantically unclassified returns `UNKNOWN` and is rejected.
- Reason: a general semantic leakage classifier is unfrozen and cannot be honestly claimed in the first offline harness.
- Alternatives considered: trust model claims; permissive keyword absence; immediate second-model classifier.
- Consequences: the mock adapter must emit a known-safe probe; real free-form output remains disabled until a validated analyzer exists.
- Reversible: yes.

## D009 — Ramsey six-person problem as first fixture

- Decision: use the classic six-person acquaintances/strangers proof problem.
- Reason: it has multiple milestones, a protected pigeonhole disclosure, a common transitivity error, and graph/complement formulations while remaining small.
- Alternatives considered: polynomial inequality; divisibility problem.
- Consequences: deterministic checking is mostly structural and may abstain; that is consistent with verifier contracts.
- Reversible: yes.

## D010 — No snapshots in the first slice

- Decision: replay the complete semantic stream.
- Reason: the first fixture is small and snapshots are explicitly non-authoritative optimizations.
- Alternatives considered: snapshot every turn.
- Consequences: replay behavior is exercised continuously; performance benchmarking is deferred.
- Reversible: yes.

## D011 — Real provider adapters remain disabled shells until gated experiments

- Decision: define provider contracts first and do not ship callable Gemini or Antigravity implementations in the initial vertical slice.
- Reason: their billing, cancellation, data-use, and Antigravity isolation mechanisms require provider-specific empirical proof.
- Alternatives considered: API integration behind `allowMeteredUsage=false`; CLI invocation using the user's normal configuration.
- Consequences: Phase 0 executes entirely through `MockModelAdapter`; no cost or credential risk is introduced.
- Reversible: yes after gates pass.
