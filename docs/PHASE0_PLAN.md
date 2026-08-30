# Phase 0 Execution Plan

Each slice ends with tests, type checking, linting, replay checks where relevant, and an invariant scan. A slice is complete only when its listed acceptance criteria are executable and green.

## 1. Workspace/package skeleton

- Files: root pnpm/TypeScript/Vitest/ESLint configuration; `apps/server`; `packages/*`; `workers/python`; `tests`.
- Types/functions: none.
- Tests: toolchain smoke test.
- Dependencies: Node >=22.5, pnpm.
- Complete when installation is reproducible and `typecheck`, `lint`, and `test` run from the root.

## 2. Shared IDs and schema primitives

- Files: `packages/domain/src/ids.ts`, `revisions.ts`.
- Types/functions: all required branded IDs, ID factories, non-negative revision schemas.
- Tests: reject empty IDs/negative revisions; generated IDs round-trip.
- Dependencies: Zod.
- Complete when every persisted/external identity has a runtime schema and loose ID strings do not cross package boundaries.

## 3. Discriminated event schemas

- Files: `packages/events/src/schemas.ts`.
- Types/functions: versioned envelope and typed payload union for the initial semantic events.
- Tests: event-specific payload validation; unknown type/payload rejected.
- Dependencies: slices 2, 9, 15-18.
- Complete when unchecked payloads cannot enter the store.

## 4. SQLite event store

- Files: `packages/persistence/src/sqlite-event-store.ts`.
- Types/functions: schema migration, ordered load, transactional append, unique `(session,sequence)`, event ID and request ID constraints.
- Tests: ordering is sequence-based; duplicate sequence/event/request behavior; rollback.
- Dependencies: slice 3, `node:sqlite`.
- Complete when events plus idempotency results commit atomically and wall time cannot alter order.

## 5. Event upcaster interface

- Files: `packages/events/src/upcasters.ts`.
- Types/functions: `EventUpcaster`, registry, current-version parser.
- Tests: v1 pass-through; missing upcast path fails.
- Dependencies: slice 3.
- Complete when all loaded rows pass through the registry before reduction.

## 6. Pure session reducer

- Files: `packages/events/src/state.ts`, `reducer.ts`.
- Types/functions: initial state, exhaustive reducer, `replaySession`.
- Tests: deterministic replay, strict sequence, no I/O.
- Dependencies: slices 3, 5.
- Complete when equal streams reconstruct equal state without provider/session caches.

## 7. Serialized session writer

- Files: `packages/interview-engine/src/session-writer.ts`.
- Types/functions: per-session promise queue, registry, atomic write/reduce path.
- Tests: concurrent submissions have strict sequences and one final state.
- Dependencies: slices 4, 6.
- Complete when no supported callback path can append or mutate outside the writer.

## 8. Command/result envelopes and idempotency

- Files: `packages/domain/src/commands.ts`; writer/store extensions.
- Types/functions: request/causation/correlation identity, canonical logical-command fingerprint, and cached command result.
- Tests: identical duplicate provider result and renderer ack produce no additional event/state change, including after restart; conflicting or legacy-unverifiable `RequestId` reuse fails closed.
- Dependencies: slices 4, 7.
- Complete when the same `RequestId` returns the persisted prior result only for the same logical command and conflicting reuse cannot append or mutate state.

## 9. InputEpisode/Turn/Generation lifecycle

- Files: domain lifecycle types; event schemas; `turn-coordinator.ts`.
- Types/functions: start/update/commit input; commit turn; start/supersede generation.
- Tests: speech-board-speech episode, false onset discard, late superseded generation.
- Dependencies: slices 2, 3, 7.
- Complete when speech onset is distinct from turn commit and identities cannot be conflated.

## 10. GenerationBasis and compatibility

- Files: `generation.ts`, `packages/events/src/generation-compatibility.ts`, interview-engine re-export, delivery admission.
- Types/functions: basis schema and three-valued compatibility.
- Tests: board/transcript/problem/policy/epoch staleness, late generation, missing provenance returns `UNKNOWN`.
- Dependencies: slice 9.
- Complete when only `COMPATIBLE` can enter proposal validation or transition from queued to physical delivery; missing provenance and stale/superseded generations fail closed inside the serialized transition.

## 11. Context Epoch

- Files: reducer and epoch command helpers.
- Types/functions: monotonic epoch increment on non-monotonic truth corrections.
- Tests: transcript correction increments epoch and invalidates old generation/provider context.
- Dependencies: slices 6, 10.
- Complete when replay reconstructs the epoch and sessions can be rebuilt fresh.

## 12. Context Compiler contracts

- Files: `context-compiler.ts`.
- Types/functions: minimal `CompiledContext`, safe public projection.
- Tests: private solution/protected forbidden facts and prompt-injection control text never enter provider input.
- Dependencies: problem partitions, policy action, disclosure ledger.
- Complete when explicit allowlisted fields—not object omission conventions—form provider context.

## 13. Scoped StudentEvidence contracts

- Files: `evidence.ts`.
- Types/functions: subject/dimension keys, proposal/value provenance.
- Tests: invalid global subject rejected; confidence/range/event provenance required.
- Dependencies: IDs/Zod.
- Complete when authoritative evidence can only be committed by an event and remains locally scoped.

## 14. Reasoning graph contracts

- Files: `reasoning.ts`, hard-coded problem graph, `packages/problems/src/problem-integrity.ts`, `problem-catalog.ts`.
- Types/functions: version, approaches, milestones, optional prerequisites, merges, errors, extensions, fixture/catalog integrity assertions.
- Tests: graph/disclosure reference integrity, unique authored identities, provisional DAG validation, and at least two approaches.
- Dependencies: slice 2.
- Complete when the live model cannot rewrite the stored graph and malformed authored fixtures fail before interview execution. **Complete for the Phase 0 catalog.**

## 15. Pedagogical action contracts

- Files: `pedagogy.ts`, `pedagogical-policy.ts`.
- Types/functions: action taxonomy, `RealizationRequest`, separate maximum disclosure.
- Tests: action selected deterministically from current evidence; model cannot broaden it.
- Dependencies: slices 13-14.
- Complete when policy selection is application-owned.

## 16. InterviewerProposal

- Files: `proposal.ts`.
- Types/functions: proposal schema, claimed action/disclosures, speech and board proposal payloads.
- Tests: malformed/unknown output rejected.
- Dependencies: slices 15, 18.
- Complete when provider output is never a delivery type.

## 17. Disclosure/protected-fact contracts

- Files: `disclosure.ts`, problem metadata, `disclosure-validator.ts`.
- Types/functions: levels 0-5, protected facts, independent analyzer, fail-closed outcome.
- Tests: understated model metadata, protected level above authorization, uncertainty.
- Dependencies: slices 12, 16.
- Complete when claims are ignored for authorization and uncertain validation rejects.

## 18. DeliveryAtom exposure semantics

- Files: `delivery.ts`.
- Types/functions: TEXT/AUDIO/WHITEBOARD, all seven statuses, atom/command schemas.
- Tests: valid transitions and disclosed status predicate.
- Dependencies: IDs/disclosure.
- Complete when generation and delivery identities/statuses are distinct.

## 19. Delivery Coordinator state machine

- Files: `packages/delivery/src/delivery-coordinator.ts`, `renderer.ts`.
- Types/functions: queue/start/expose/complete/cancel/recover/reconnect using stable DeliveryId.
- Tests: every crash boundary, duplicate ack, retry no duplicate output, audio starts as exposed.
- Dependencies: slices 7-8, 18.
- Complete when uncertain `DELIVERING` recovery becomes `POSSIBLY_EXPOSED` and affects the ledger.

## 20. MockModelAdapter

- Files: `packages/providers/src/mock-model-adapter.ts`, `execution.ts`.
- Types/functions: deterministic capability declaration, proposal stream, adapter-specific in-process no-spend proof, cancellation behavior variants, guarded output suppression.
- Tests: provider ignores cancellation, output released after cancellation is dropped, and provider switching remains isolated by GenerationId.
- Dependencies: slices 10, 12, 16.
- Complete when no provider memory is needed to replay authoritative state. **Complete for the Phase 0 mock path.**

The application-owned `ProviderCoordinator` now executes the mock path end to end: Generation creation, safe context compilation, admitted session opening, one-final-proposal consumption, authoritative proposal admission, and session disposal. Cancellation is GenerationId-scoped and remains effective when the raw provider ignores it. A provider switch creates a fresh Generation; output from the superseded provider remains inert.

## 21. Provider capability/policy contracts

- Files: `provider.ts`, `packages/providers/src/policy.ts`, `execution.ts`, `scripts/check-architecture-boundaries.mjs`.
- Types/functions: runtime capability schemas; distinct `DROP_OUTPUT`, `CLOSE_CLIENT_STREAM`, `CANCEL_PROVIDER_COMPUTE`, and `INTERRUPT_LOCAL_PROCESS` results; policy/privacy/clock preflight; adapter-owned provider-specific billing proof; admitted execution session.
- Tests: malformed/missing/stale/future/unknown/metered verification; exact adapter-version binding; invalid runtime policy; excessive data use before adapter invocation; cancellation overclaim; ignored cancellation; invalid output; secret-free deterministic errors; static direct-session bypass rejection.
- Dependencies: clock and configuration.
- Complete when no-metered mode requires current technical no-spend proof, not a boolean label. **Complete for the generic gate and MockModelAdapter; real-adapter proof remains provider-specific.**

## 22. ReasoningProvider/VisionProvider split

- Files: `provider.ts`.
- Types/functions: independent reasoning and board-observation request/result contracts.
- Tests: text-only reasoner is valid; late vision revision is rejected.
- Dependencies: board observations and async envelopes.
- Complete when image support is not required of the reasoner.

## 23. Replay harness

- Files: `reducer.ts`, `tests/replay.test.ts`, demo.
- Types/functions: load/upcast/reduce and state canonicalizer.
- Tests: restart/replay equals live state.
- Dependencies: slices 4-6.
- Complete when SQLite alone reconstructs application truth.

## 24. Crash/idempotency tests

- Files: `tests/delivery-crash.test.ts`, `idempotency.test.ts`.
- Types/functions: fault injection checkpoints.
- Tests: all specified delivery boundaries, provider/renderer duplicates, restart.
- Dependencies: slices 8, 19, 23.
- Complete when every uncertainty is conservative and repeatable.

## 25. Randomized concurrency/property tests

- Files: `tests/concurrency.property.test.ts`.
- Types/functions: randomized callback schedules and invariant assertions.
- Tests: strict sequence, no stale/superseded delivery, idempotency, protected facts, overlay ownership.
- Dependencies: fast-check and prior state machines.
- Complete when deterministic seeds reproduce failures.

## 26. One hard-coded Oxford problem

- Files: `packages/problems/src/six-people.ts`.
- Types/functions: Ramsey `R(3,3)` problem partitions, graph, common error, zero-disclosure probe, protected hints, alternate graph/complement framing.
- Tests: schema/graph/protected metadata integrity and public/private separation.
- Dependencies: slices 14, 17.
- Complete when the one problem exercises the architecture without becoming a content-bank project.

## 27. Thin end-to-end synthetic path

- Files: `synthetic-interview.ts`, `run-synthetic.ts`, `vertical-slice.test.ts`.
- Types/functions: synthetic input through writer/store/reducer/policy/compiler/mock model/validator/delivery/mock renderer/replay.
- Tests: expected events, exposure ledger, replay identity.
- Dependencies: slices 1-23, 26.
- Complete when the preferred vertical flow runs locally with no network or UI.

## 28. Real-provider adapter experiments

- Files: disabled Gemini/Antigravity adapter shells plus experiment docs/tests.
- Types/functions: provider-specific billing/security/cancellation probes.
- Tests: deny by default; no real call until core invariants and explicit configuration pass.
- Dependencies: all core slices.
- Complete when empirical evidence proves a provider is safe under the configured no-metered/data/security policy. This slice must not become authoritative.

## Current-run target

Complete slices 1-23, 26-27 at a coherent baseline, plus the highest-risk tests from 24-25. Any remaining work stays explicitly incomplete rather than represented by permissive stubs.

## Continuation progress — asynchronous inbox slice

Implemented after the initial vertical slice:

- utterance onset/discard/finalization without conflating onset and Turn commitment;
- speech → board → speech grouping inside one InputEpisode;
- barge-in invalidation of active generation and delivery state;
- vision request/result events with broad revision and dependency checks;
- scoped evidence proposal and application-authoritative evidence update events;
- runtime validation of every persisted command result, including duplicate reads;
- file-backed SQLite close/reopen replay and idempotency tests;
- expanded randomized multimodal/vision callback schedules.

## Continuation progress — authenticated loopback protocol slice

Implemented after the asynchronous inbox slice:

- protocol-v1 discriminated command and response schemas;
- Node built-in HTTP server bound exclusively to `127.0.0.1` or `::1`;
- exact Origin allowlisting and constant-time client-token authentication before command construction;
- bounded JSON bodies and generic, schema-validated, secret-free errors;
- browser RequestId propagation into the durable writer for session start, typed Turn commitment, delivery reconnect, exposure acknowledgement, and completion acknowledgement;
- allowlisted read-only session summary instead of serializing authoritative state;
- stable DeliveryId reconnect behavior and renderer-side visible-output deduplication tests.
- first-use crash recovery that marks persisted in-flight deliveries `POSSIBLY_EXPOSED` before a restarted server handles reconnect.

Still pending in Phase 0: dimension-specific evidence aggregation, production audio generation, additional local-compute and verification operations, and provider-specific adapter experiments. The thin authenticated renderer stream and deterministic audio callback harness are implemented; polished UI and a full voice stack remain deferred.

## Continuation progress — local-compute worker boundary

Implemented after the authenticated loopback slice:

- protocol-v1 discriminated Zod schemas for health and transcript-analysis requests/results;
- a supervised Python subprocess over NDJSON stdio with isolated mode and an allowlisted environment;
- strict RequestId and source-revision correlation;
- bounded, non-authoritative duplicate-result caches and conflicting-ID rejection;
- fail-closed handling for malformed, unsolicited, oversized, stale-basis, late, and timed-out results;
- explicit whole-process `INTERRUPT_LOCAL_PROCESS` semantics;
- a deterministic Python worker that has no event, SQLite, provider, or application-state authority;
- real-process and fault-injection tests.

## Continuation progress — local-compute result admission

Implemented after the worker process boundary:

- semantic request, accepted-result, and discarded-result events with pure replay state;
- transcript-analysis issuance only for committed speech InputEpisodes;
- callback admission through the single serialized `SessionWriter` with durable RequestId idempotency;
- exact persisted/callback/current transcript-revision checks;
- independent application recomputation of normalized text and token count before acceptance;
- bounded application-owned discard reasons with untrusted worker error messages excluded from events;
- real-worker, duplicate, stale, tampered, malformed, miscorrelated, restart, and replay tests.

Additional worker operations remain deferred. Each must define its own independently checkable admission rule rather than inheriting authority from the subprocess.

## Continuation progress — deterministic Oxford graph verifier

Implemented as an isolated verification package slice:

- strict protocol-v1 JSON interpretation for a complete two-colour graph;
- structural rejection of unknown vertices, self-edges, duplicate unordered pairs, missing pairs, and extra fields;
- deterministic monochromatic-triangle search returning `VERIFIED` or `CONTRADICTED` only for complete, unambiguous interpretations at confidence 1;
- `UNRESOLVED` abstention for malformed, incomplete, ambiguous, or lower-confidence interpretations;
- exhaustive testing of all 32,768 two-colourings of K6 plus the triangle-free five-cycle/complement K5 colouring.

## Continuation progress — authoritative verification admission

Implemented after the isolated Oxford verifier:

- runtime schemas for verifier results, persisted formal work items, and durable admission results;
- full Context Epoch and revision basis captured when verification is requested;
- callback identity/basis checks plus the existing three-valued compatibility check;
- independent application rerun of the registered deterministic verifier before accepting a supplied result;
- semantic request, accepted-result, and discarded-result events with pure replay state;
- atomic positive claim-correctness evidence only for independently reproduced `VERIFIED` results;
- authoritative `UNRESOLVED` and `CONTRADICTED` results without fabricated positive or negative student evidence;
- fail-closed handling for stale work, verifier switching, tampering, exceptions, invalid output, malformed callbacks, duplicates, and restart.

Natural-language-to-formal interpretation generation remains outside this deterministic slice. The model-proposal admission bridge described below now enforces the boundary through which any later interpreter must enter.

## Continuation progress — formal interpretation proposal admission

Implemented after authoritative verification admission:

- a strict `FormalInterpretationProposal` schema containing only a bounded candidate interpretation and explicit confidence;
- exact source generation identity and callback basis-field checks, followed by full current `GenerationBasis` compatibility, before a proposal can open verifier work;
- three-valued compatibility admission in which `INCOMPATIBLE` and `UNKNOWN` both fail closed and supersede the source generation;
- application-owned verifier identity and scoped claim-correctness target selection;
- one serialized transition that records the provider proposal and creates the semantic verification request;
- one-consumer generation semantics under concurrent provider callbacks;
- durable RequestId idempotency across duplicate callbacks and application restart;
- replay-preserved proposal provenance linking verifier work to its source GenerationId and provider RequestId;
- low-confidence proposals routed to deterministic abstention without creating student evidence.

The natural-language interpreter itself remains unimplemented. No model output can directly commit verification status or evidence, and no real provider dependency was added.

## Continuation progress — scoped evidence supersession

Implemented after verification admission:

- per-`EvidenceKey` immutable history records with `ACTIVE`, `SUPERSEDED`, and `STALE` status;
- explicit prior evidence-event identity required whenever a new update supersedes an active value;
- latest-active `studentEvidence` projection retained for policy consumption without becoming the historical authority;
- conservative invalidation of active evidence after transcript self-correction;
- fresh evidence may follow stale history without erasing or reviving the earlier record;
- both model-proposed and deterministically verified evidence use the same supersession contract;
- reducer conflict tests and randomized update/correction schedules continuously assert at most one active value and replay identity.

Dimension-specific aggregation, decay, and contradiction policy remain Phase 2 work. Phase 0 records history and fails safely rather than inventing a universal aggregation score.

## Continuation progress — authenticated renderer stream

Implemented in parallel and integrated after scoped evidence history:

- strict protocol-v1 delivery stream schemas over authenticated loopback SSE;
- bounded connections, attachment bodies, stream messages, and renderer DeliveryId cache;
- one stable DeliveryId abstraction for TEXT, AUDIO, and contract-only WHITEBOARD;
- TEXT exposure only after visible insertion and AUDIO exposure only on the playback `playing` callback;
- separate idempotent exposed/completed acknowledgements through the existing command server;
- exact-Origin CORS preflight and response headers without weakening POST token authentication;
- reconnect deduplication, same-ID acknowledgement retry, and conservative POSSIBLY_EXPOSED restart recovery;
- explicit distinction between a presenter-proven pre-exposure failure, which permits safe retry, and an ambiguous failure, which suppresses duplicate presentation;
- real loopback, deterministic fake-audio, crash, malformed-input, cache-bound, secret-exclusion, and no-replay tests.

No TTS, audio-frame persistence, polished frontend, production whiteboard surface, or exactly-once network claim is introduced.

## Continuation progress — shared transport recovery ownership

Implemented after browser transport reconciliation:

- one `SessionRecoveryCoordinator` shared by command and renderer transports;
- one `LocalInterviewTransportRuntime` composition root that constructs both adapters over that coordinator;
- concurrent startup coalescing and partial-start rollback;
- failed recovery eviction for safe retry;
- serialized current-state revalidation before every `POSSIBLY_EXPOSED` recovery append;
- real file-backed restart coverage in which command and renderer first use race but produce exactly one recovery event and no visible replay.

The coordinator's promise map is disposable process state. SQLite events remain authoritative, and the transition-level state recheck preserves correctness even if callers bypass the normal composition root.

## Continuation progress — generation context reproducibility

Implemented as an independent Context Compiler hardening slice:

- a versioned `ContextCompilationManifest` containing the exact GenerationId/Basis, problem identity, compiler version, and SHA-256 algorithm identity;
- canonical JSON encoding with sorted object keys and array-order preservation;
- separate SHA-256 hashes for the complete safe provider context and application-owned reasoning graph;
- semantic `GENERATION_CONTEXT_COMPILED` persistence before the synthetic provider is invoked;
- no prompt, student text, protected-fact text, canonical solution, or verification notes in the manifest event;
- serialized current-state and command-basis revalidation after asynchronous hashing;
- one manifest per active generation under duplicate, concurrent, and restart execution;
- fail-closed results for stale, unknown, mismatched, changed-during-hash, conflicting, or unavailable-hash conditions;
- deterministic replay of the manifest as application-owned generation provenance.

This establishes the Phase 0 prompt/problem hash boundary without making provider history authoritative. Broader build, SDK, operating-system, and media reproducibility metadata remains later work.

## Continuation progress — GitHub branch reconciliation and browser boundary hardening

Recovered and integrated after review of closed PRs #3–#7:

- complete authored-problem fixture and catalog integrity checks for graph references, provisional DAG structure, protected disclosures, normalized formulations, and `(problemId, version)` uniqueness;
- strict runtime validation and deterministic rejection codes at the provider billing/data-use policy gate;
- syntax-aware, bounded, idempotent secret redaction for JSON-like, header-like, query-like, quoted, camel-case, and multiline diagnostics;
- an exported typed browser command client for every protocol-v1 command, with private token storage, strict response/correlation validation, and caller-stable RequestId retry;
- conservative classification of fetch and response-body failures as transport uncertainty rather than malformed server responses;
- exact command preflight validation for Origin, `POST`, and the two allowed non-simple headers, with no session mutation during preflight.
- browser-safe Web Crypto UUID generation plus a transitive guard that rejects Node builtin imports from the shared domain/delivery runtime graph.

Dedicated recovered suites pass together with the existing loopback and renderer integration tests. These slices add no real provider, paid API path, polished UI, or provider/session authority.

## Continuation progress — admitted provider execution boundary

The synthetic path now opens `MockModelAdapter` only through `openProviderExecutionSession`. Runtime capability validation and application policy/privacy/clock preflight happen before any adapter method. In no-metered mode, the selected adapter must then supply current provider-specific proof that the generic policy gate accepts before session construction. Production calls to raw `provider.createSession()` outside that boundary fail the static architecture check.

The guarded session independently drops output for a cancelled GenerationId even if a provider ignores or throws during cancellation. Its report preserves the narrower adapter result, so closing a client stream is never described as provider-side compute cancellation. Provider proposals are runtime-validated and provider error details are replaced with fixed non-secret failures. No real provider or network path was enabled.

## Continuation progress — provider generation orchestration

`packages/interview-engine/src/provider-coordinator.ts` now owns the disposable asynchronous execution between a committed Turn and `TurnCoordinator.processProposal`. It persists no provider memory. Each run records a new Generation and safe context manifest before provider use, allocates one stable proposal RequestId, supplies full basis provenance, accepts at most one final proposal, and closes the provider session.

Context, policy, admission, empty-stream, and provider-stream failures supersede the Generation with fixed non-secret outcomes. Explicit cancellation marks the Generation before awaiting provider behavior, suppresses late output, and cancels any known-queued atoms before exposure. Static repository checks prevent production code from calling raw proposal admission outside this coordinator. Durable restart reconstruction remains entirely event based; a restarted application begins a fresh Generation rather than resuming provider memory.

## Continuation progress — session-bound problem provenance

New sessions persist a SHA-256 fingerprint of the exact provider-visible problem contract: identity/version, public content, reasoning graph, and protected-disclosure registry. Context compilation and proposal admission recompute and compare that fingerprint, so a same-ID/version substituted problem cannot change prompts, graph semantics, or disclosure policy. The private solution partition is excluded from both the fingerprint input and semantic events.

Event schema v2 includes a built-in monotonic v1→v2 upcast. Legacy events remain replayable, but their absent problem fingerprint is intentionally not fabricated: provider context compilation fails with `PROBLEM_PROVENANCE_UNKNOWN`. Tests cover prompt, reasoning-graph, and disclosure substitution; private-only authoring changes; proposal rejection; legacy replay; and absence of private material from persisted provenance.
