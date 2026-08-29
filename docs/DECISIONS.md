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

## D012 — Runtime-validate every durable idempotency result

- Decision: `SessionWriter.execute` requires a command-specific Zod result schema and parses both newly produced and previously persisted duplicate results.
- Reason: the idempotency table is an external/persisted boundary; unchecked generic JSON would undermine the otherwise validated command/event path.
- Alternatives considered: type assertions after `JSON.parse`; validating only event payloads; one permissive JSON-value schema.
- Consequences: adding a command requires an explicit result schema, and corrupted/stale duplicate results fail closed before reaching callers.
- Reversible: no in principle; individual schema organization is reversible.

## D013 — Speech onset invalidates output before utterance validity is known

- Decision: `UTTERANCE_STARTED` supersedes active generations, cancels queued atoms, and marks unacknowledged in-flight atoms `POSSIBLY_EXPOSED`; a later false-onset discard does not revive them.
- Reason: this directly implements the frozen distinction between speech onset and Turn commitment while keeping barge-in independent of provider cancellation.
- Alternatives considered: wait for STT validity before invalidation; revive superseded work after a false onset.
- Consequences: occasional false onset can cause conservative regeneration or disclosure-budget consumption.
- Reversible: no for the safety behavior; detection thresholds remain reversible.

## D014 — Phase 0 vision freshness uses whole-board revision plus exact dependency identity

- Decision: accept a vision result only when request revision, envelope revision, observation revision, region, and relevant shape-ID set all match current state.
- Reason: fine-grained shape revision tracking is explicitly unfrozen; broad rejection is safe and testable now.
- Alternatives considered: accept any same-region result; track per-shape revisions immediately.
- Consequences: unrelated board edits can discard useful observations and trigger recomputation.
- Reversible: yes.

## D015 — Evidence commit threshold is a conservative Phase 0 constant

- Decision: record valid `EVIDENCE_PROPOSED` events, but commit `STUDENT_EVIDENCE_UPDATED` only when scope and event provenance are valid, the dimension/value pair is allowed, and inference confidence is at least `0.7`.
- Reason: the aggregation algorithm is unfrozen, but the authority boundary needs an executable conservative rule for the harness.
- Alternatives considered: model output commits directly; no evidence commits in Phase 0; dimension-specific thresholds.
- Consequences: low-confidence proposals remain auditable without becoming authoritative. The threshold is not a product-quality claim.
- Reversible: yes.

## D016 — Browser-MVP transport is versioned loopback HTTP

- Decision: use one bounded `POST /v1/commands` endpoint on Node's built-in HTTP server, with a strict discriminated Zod union for protocol version 1.
- Reason: the architecture leaves WebSocket versus equivalent IPC unfrozen. Request/response HTTP is enough for the current command, acknowledgement, and reconnect boundary without adding transport dependencies or implying streaming semantics that are not implemented.
- Alternatives considered: WebSocket; Electron IPC; a framework router.
- Consequences: provider/audio streaming events need a later server-to-client channel or polling extension; existing command types can migrate behind the same schemas.
- Reversible: yes.

## D017 — Authentication is consumed before domain command construction

- Decision: bind to `127.0.0.1` or `::1`, require an exact allowed `Origin`, compare a dedicated client-token header in constant time, and construct the domain `CommandEnvelope` only after those checks pass.
- Reason: the browser-MVP boundary must reject unexpected local and web clients while ensuring the secret cannot leak into event payloads, idempotency results, frontend state, or errors.
- Alternatives considered: unauthenticated loopback; bearer token inside the JSON command; cookie authentication.
- Consequences: the desktop launcher must transfer the token to the expected browser client out of band; OS credential integration remains deferred.
- Reversible: header/bootstrap mechanics are reversible; pre-domain authentication and secret exclusion are not.

## D018 — Renderer reconnect resumes only known in-flight DeliveryIds

- Decision: a queued delivery reconnect atomically persists `DELIVERY_STARTED`; a delivering reconnect in the same live server runtime reissues the same `DeliveryCommand` and `DeliveryId` without another event; each server runtime first recovers persisted in-flight deliveries to `POSSIBLY_EXPOSED`, and terminal or uncertain statuses return no command.
- Reason: delivery retry needs stable identity while avoiding a claim of transport-level exactly-once output.
- Alternatives considered: mint a new delivery per reconnect; resend terminal deliveries; automatically convert reconnect to exposure.
- Consequences: renderers must retain a bounded processed-`DeliveryId` cache and send separate idempotent exposure/completion acknowledgements.
- Reversible: the transport shape is reversible; stable identity and conservative status semantics are frozen.

## D019 — Local compute uses isolated NDJSON stdio

- Decision: supervise one Python process from Node using protocol-v1 newline-delimited JSON over stdin/stdout, launched with Python isolated mode and a small allowlisted environment.
- Reason: worker language/process topology is unfrozen. Stdio avoids opening another authenticated network surface while still providing explicit, testable request/result envelopes.
- Alternatives considered: loopback HTTP; Unix socket/named pipe; embedded Python; one process per request.
- Consequences: stdout is protocol-only, diagnostics are bounded/redacted from stderr, and production streaming audio/frame transport will need a separate transient channel or framing extension.
- Reversible: yes.

## D020 — Worker timeout interrupts the whole local process

- Decision: when a request times out or the worker emits malformed, unsolicited, oversized, or basis-mismatched output, reject pending work and terminate the subprocess with semantics named `INTERRUPT_LOCAL_PROCESS`.
- Reason: the Phase 0 worker has no reliable per-request cancellation primitive. Continuing to trust the process after a framing/provenance violation would be unsafe, and calling termination provider-compute cancellation would be inaccurate.
- Alternatives considered: ignore malformed lines; leave timed-out work running; implement in-process task cancellation immediately.
- Consequences: unrelated concurrent worker requests are also rejected and must be retried through application-owned idempotent commands after a new process is started.
- Reversible: yes, once a demonstrably safe request-level cancellation mechanism exists.

## D021 — Worker duplicate cache is operational only

- Decision: both Node supervision and Python retain bounded recent `RequestId` fingerprints/results; identical duplicates reuse the result and conflicting reuse fails closed.
- Reason: this makes retries inexpensive and testable while preserving the frozen rule that only application events and durable command results are authoritative.
- Alternatives considered: no worker deduplication; durable worker database; trusting duplicate callback ordering.
- Consequences: caches disappear on restart, so application-level `SessionWriter` idempotency remains required when a result is admitted to session state.
- Reversible: cache size and placement are reversible; conflicting identity reuse must continue to fail closed.
