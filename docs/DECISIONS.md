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

## D022 — Dependency build scripts require package-specific approval

- Decision: `pnpm-workspace.yaml` explicitly sets the only currently detected build-script package, `esbuild`, to `false` under `allowBuilds`; CI performs an ordinary frozen-lockfile install subject to that package policy.
- Reason: Phase 0 does not require this dependency lifecycle script, and `tsx`/Vitest use the locked platform binary package successfully without it. An explicit decision prevents pnpm's ignored-build policy from failing ambiguously. A blanket `--ignore-scripts` install was rejected after repeatable Windows relinking hangs during clean-install verification.
- Alternatives considered: allow all dependency scripts; explicitly approve the `esbuild` script; leave the generated placeholder unresolved.
- Consequences: a dependency that genuinely requires an installation script must receive a package-specific review and explicit policy change before CI can use it.
- Reversible: yes, package by package after review.

## D023 — pnpm uses the hoisted linker on the Windows-first workspace

- Decision: set `node-linker=hoisted` in the repository `.npmrc`.
- Reason: repeated clean installs with pnpm's default isolated linker stalled during Windows relinking with sustained CPU use and no `.bin` output, while the same frozen lockfile completed with the hoisted linker and passed every repository gate.
- Alternatives considered: retain the isolated linker and rely on long waits; manually reconstruct package links; use a machine-local override.
- Consequences: dependency layout is flatter, so code must not rely on undeclared transitive packages. CI uses the same layout as local development.
- Reversible: yes, after pnpm/Windows linker behavior is re-evaluated.

## D024 — Transcript worker results require deterministic application recomputation

- Decision: persist a transcript-analysis request basis, then accept its worker result only if the request remains pending, callback and result revisions equal both the request basis and current transcript revision, and application code independently reproduces the normalized text and token count from the committed speech InputEpisode.
- Reason: the worker is disposable and non-authoritative. Schema and correlation validation establish shape and identity, but do not establish semantic correctness.
- Alternatives considered: trust any schema-valid worker result; persist raw worker traffic; accept revision-matching output without recomputation.
- Consequences: accepted transcript analysis is replayable application truth, uncertain or tampered output terminates as discarded, and new compute operations need operation-specific validators. Worker error messages remain transient and only bounded application-owned reason codes enter events.
- Reversible: the normalization algorithm is reversible; independent validation and fail-closed admission are not.

## D025 — The first deterministic verifier accepts only complete formal graph interpretations

- Decision: the Oxford graph verifier consumes strict protocol-v1 JSON containing every unordered vertex pair exactly once and produces a non-abstaining result only when interpretation confidence is exactly 1.
- Reason: deterministic mathematics cannot compensate for an uncertain natural-language-to-formal interpretation. Complete graph encoding makes the checked claim precise and keeps abstention explicit.
- Alternatives considered: parse free-form mathematical prose; infer omitted edges; accept a confidence threshold below 1.
- Consequences: valid K6 encodings are exhaustively checkable and K5 counterexamples are correctly contradicted, while partial or ambiguous interpretations remain `UNRESOLVED` rather than being guessed.
- Reversible: the protocol and confidence policy are versionable; deterministic checking with abstention is not.

## D026 — Verification admission independently reruns the named verifier

- Decision: capture the formal interpretation, verifier identity, evidence scope, student-event provenance, and full revision basis in a semantic request; admit a callback only after application code reruns that named verifier and obtains an exactly matching runtime-valid result.
- Reason: callback shape, identity, and revision checks cannot establish mathematical correctness. Rerunning the deterministic implementation prevents a stale, switched, malformed, or tampered result from becoming authoritative.
- Alternatives considered: trust schema-valid callbacks; invoke the verifier and append its output without a separate request lifecycle; treat verifier output as an EvidenceProposal.
- Consequences: `VERIFIED`, `CONTRADICTED`, and `UNRESOLVED` are replayable statuses with provenance. Only `VERIFIED` atomically commits scoped claim-correctness evidence; contradiction and abstention remain recorded without inferring a student rating whose semantics may be ambiguous.
- Reversible: verifier registration and evidence policy are reversible; application-owned admission, provenance, and abstention are not.

## D027 — Evidence keeps scoped history with explicit supersession and conservative correction staleness

- Decision: retain every accepted value as an `EvidenceRecordState`; require a new update to identify the currently active evidence event it supersedes; mark active evidence stale and remove it from the latest-active projection after transcript correction.
- Reason: silently overwriting `studentEvidence[key]` discarded provenance and could leave policy acting on an inference whose supporting student statement had been corrected. The frozen architecture explicitly requires evidence to become stale or be superseded.
- Alternatives considered: overwrite latest values only; invalidate evidence only when a model proposes a contradiction; implement confidence decay and dimension-specific aggregation immediately.
- Consequences: replay reconstructs the complete scoped history and at most one active value per key. Transcript correction currently invalidates all active evidence conservatively because Phase 0 lacks fine-grained transcript dependency tracking.
- Reversible: invalidation granularity and later aggregation policy are reversible; retained provenance and explicit supersession are not.

## D028 — Renderer delivery uses authenticated SSE plus the existing command acknowledgement path

- Decision: use a bounded authenticated POST-attached SSE stream for server-to-renderer delivery commands while retaining the existing authenticated command endpoint for exposed/completed acknowledgements.
- Reason: Phase 0 needs a concrete server-to-client path and crash harness, but does not require bidirectional WebSocket framing. Reusing command acknowledgements preserves durable RequestId idempotency and one delivery state machine.
- Alternatives considered: WebSocket; polling; a second acknowledgement endpoint; Electron-only IPC.
- Consequences: delivery is not claimed exactly once. Stable DeliveryId identity, renderer deduplication, explicit physical-exposure callbacks, and conservative restart recovery provide the safety properties.
- Reversible: the wire transport is reversible; stable identity and shared acknowledgement semantics are not.

## D029 — Renderer retries require positive proof that exposure did not begin

- Decision: a presenter may release a received DeliveryId for retry only by raising `RendererPresentationNotExposedError` before its exposure callback; generic failures retain the DeliveryId and suppress repeat presentation.
- Reason: an arbitrary exception cannot prove whether text became visible or audio began. Retrying an ambiguous failure could duplicate user-visible disclosure.
- Alternatives considered: retry every presenter exception; suppress every failed presentation permanently; add a generic boolean return value.
- Consequences: detached DOM and rejected-before-start audio can retry safely, while uncertain outcomes stay conservative and application restart remains governed by `POSSIBLY_EXPOSED` recovery.
- Reversible: the signaling API is reversible; uncertainty must continue to fail against duplicate exposure.

## D030 — Phase 0 problem fixtures fail at authoring-load boundaries

- Decision: validate every curated `InterviewProblem` and catalog entry when loaded, including identity/reference uniqueness, disclosure-registry consistency, normalized equivalent formulations, and an initial DAG integrity check.
- Reason: malformed application-owned content must fail before it can silently change policy, disclosure, or verification behavior during an interview.
- Alternatives considered: rely only on TypeScript shape checking; validate after a session starts; let the model repair graph defects.
- Consequences: the first catalog is deterministic and rejects structural authoring errors. DAG topology remains an explicitly reversible Phase 0 implementation choice, not a permanent architecture constraint.
- Reversible: yes for exact graph topology and validation placement; authored content must remain application-owned and validated.

## D031 — Provider policy rejection is runtime-valid and code-addressable

- Decision: accept policy and billing evidence as runtime input, validate malformed values before comparison, and return fixed `ProviderPolicyErrorCode` values without reflecting evidence content.
- Reason: compile-time interfaces cannot establish the validity or freshness of configuration/evidence crossing an adapter or configuration boundary, and policy failures must not leak credentials.
- Alternatives considered: typed-only comparison; permissive defaults for malformed data; provider-specific raw error propagation.
- Consequences: unknown, stale, future-dated, adapter-mismatched, or structurally invalid evidence fails closed. Real adapters still need separate provider-specific proof that spend is technically impossible.
- Reversible: error names and parsing organization are reversible; fail-closed runtime verification is not.

## D032 — Browser command retries retain caller-owned RequestId

- Decision: expose a typed browser command client whose authentication token is held in a private field and whose optional caller-supplied RequestId survives an uncertain network or response-body failure.
- Reason: a transport failure may occur after the authoritative command committed, so retry safety depends on reusing the same durable idempotency identity.
- Alternatives considered: generate a new RequestId for every HTTP attempt; expose raw fetch calls to UI code; infer success from transport state.
- Consequences: responses and correlation identities are schema-checked, raw error bodies/causes are not retained, and the UI must deliberately reuse the original RequestId for the same logical retry.
- Reversible: the client API is reversible; stable command identity across uncertain retry is not.

## D033 — Browser preflight is an exact non-mutating allowlist gate

- Decision: allow command preflight only for an exact configured Origin, `POST`, and `content-type` / `x-interview-client-token`; preflight never authenticates a token value or enters session dispatch.
- Reason: browser CORS negotiation must enable the intended client without expanding the actual command surface or mutating authoritative state.
- Alternatives considered: reflect arbitrary origins; accept arbitrary requested headers; include `OPTIONS` as an application method; require the secret on preflight.
- Consequences: allowed clients can read scoped command responses, rejected origins are never reflected, and actual POSTs still require timing-safe token authentication.
- Reversible: exact header names and caching duration are reversible; origin scoping and non-mutating preflight are not.

## D034 — Shared ID generation uses the Web Crypto runtime surface

- Decision: generate branded UUID-backed IDs through `globalThis.crypto.randomUUID()` and scan the transitive browser-shared domain/delivery import graph for Node builtins.
- Reason: importing `node:crypto` from the shared domain barrel made otherwise browser-facing command and renderer clients dependent on Node-specific bundler behavior.
- Alternatives considered: maintain separate browser/server ID factories; require a Node-polyfill plugin; fall back to `Math.random()`.
- Consequences: Node 22 and modern secure browser contexts use one cryptographically secure implementation, while a deterministic repository test prevents Node builtins from silently re-entering the shared graph. A real browser production build is still pending.
- Reversible: the secure UUID provider and static-graph test organization are reversible; weak-random fallback is not acceptable.

## D035 — Session crash recovery is shared above transport adapters

- Decision: compose command and renderer-stream servers over one process-lifetime `SessionRecoveryCoordinator`, while independently rechecking delivery status inside each serialized recovery transition.
- Reason: adapter-local recovery maps allowed both transports to observe the same persisted `DELIVERING` atom and race two semantic recovery commands. Recovery is application lifecycle work, not transport authority.
- Alternatives considered: retain one cache per server; move recovery into every reconnect handler; rely only on reducer tolerance for duplicate events.
- Consequences: concurrent first use shares one recovery promise and waits before serving the session. A deliberately duplicated caller still appends at most one recovery event because the SessionWriter transition rechecks current state.
- Reversible: the composition API and cache placement are reversible; conservative recovery before transport use and serialized current-state validation are not.

## D036 — Durable RequestId idempotency is bound to a canonical command fingerprint

- Decision: every authoritative `SessionWriter` command supplies a runtime-valid operation and JSON-compatible payload identity. The writer hashes the canonical command envelope and identity with SHA-256; SQLite stores that fixed-length fingerprint beside the durable result and returns a duplicate only when fingerprints match exactly.
- Reason: a processed `RequestId` alone cannot distinguish a retry of the same logical command from conflicting reuse, such as acknowledging exposure and completion with one ID. Binding the cached result to command identity makes conflicting reuse fail closed before state can advance.
- Alternatives considered: key idempotency by `RequestId` alone; persist raw command payloads; compare only command names; silently trust legacy rows without fingerprints.
- Consequences: identical retries remain durable across restart, different commands or payloads using the same `RequestId` raise a fixed `REQUEST_ID_CONFLICT`, and legacy processed-request rows without proof cannot be replayed as duplicates. Raw command identity and possible credentials are never persisted in the idempotency table.
- Reversible: the canonical encoding and collision-resistant hash algorithm are versionable with a migration; binding a durable result to the exact logical command and failing closed when that proof is absent are not.

## D037 — Delivery start rechecks generation compatibility inside the serialized transition

- Decision: both ordinary delivery start and queued reconnect resolve the atom's generation and evaluate its current `GenerationBasis` while holding the session's serialized transition position. Missing generation provenance, rejected/superseded status, `INCOMPATIBLE`, or `UNKNOWN` rejects the command without appending `DELIVERY_STARTED`.
- Reason: proposal validation and physical delivery are separated in time. Transcript, board, problem, policy, or Context Epoch state can change while an atom remains queued, so validation-time compatibility cannot authorize later exposure.
- Alternatives considered: check only when accepting the proposal; eagerly cancel every queued atom on every revision event; let the renderer decide freshness; allow reconnect to bypass the start gate.
- Consequences: stale or unprovable output remains `QUEUED` and undisclosed, and every path from `QUEUED` to `DELIVERING` shares the same fail-closed gate. The pure checker lives with event state so delivery can depend on it without creating a delivery-to-engine cycle.
- Reversible: checker placement and later fine-grained dependencies are reversible; serialized admission and rejection of `UNKNOWN` are not.

## D038 — Model formalizations consume one generation and open verification atomically

- Decision: accept a model-produced formal interpretation only as a strict proposal tied to one active GenerationId, exact callback identity/basis fields, and a fully compatible current GenerationBasis; in the same serialized transition, record the proposal and create application-scoped verifier work.
- Reason: a formal-looking model result is not mathematical authority, and a separately appended proposal/request pair could be duplicated or become detached from its source generation under concurrent callbacks or restart.
- Alternatives considered: let a provider invoke the verifier directly; treat formal JSON as verified evidence; create verifier work without generation provenance; reserve low-confidence proposals outside the verifier path.
- Consequences: only one callback can consume a generation, stale or unknown compatibility fails closed, application code chooses the verifier and evidence scope, and low confidence remains explicit so the deterministic verifier can abstain. Natural-language interpretation generation is still deferred.
- Reversible: the proposal schema and coordinator API are versionable; model proposals remaining non-authoritative and independently verified are not.

## D039 — Generation context identity uses canonical SHA-256 manifests

- Decision: before provider use, compile the allowlisted safe context for one active generation, hash its canonical JSON and the authored reasoning graph with SHA-256, and persist only the versioned manifest through the serialized writer.
- Reason: reproducibility requires stable prompt/problem identity, while persisting a second raw prompt copy in the semantic event would unnecessarily duplicate student content and expand the sensitive event surface. Hashing outside the writer also requires a current-state recheck before admission.
- Alternatives considered: hash ordinary `JSON.stringify` output; persist the full compiled context event; trust provider request logs; compute hashes without binding them to GenerationBasis.
- Consequences: object insertion order cannot change identity, private problem partitions do not affect provider-context hashes, arrays retain semantic order, and a revision change during hashing fails closed. The idempotent command result retains the validated safe context for the caller, while the event contains hashes and provenance only.
- Reversible: canonicalization/version labels and manifest fields are versionable; provider inputs remaining allowlisted, generation-bound, and reproducibly identifiable are not.

## D040 — Provider session creation is reachable only through admitted execution

- Decision: production code may create a raw `ReasoningSession` only inside `openProviderExecutionSession`, after runtime capability validation, application policy/privacy/clock preflight, and any required adapter-specific billing verification. The returned guarded session drops post-cancellation output locally and reports the adapter's actual cancellation effect separately.
- Reason: validating caller-supplied billing evidence without controlling session creation leaves a bypass around the no-metered policy. Cancellation APIs also cannot safely equate closing a client stream with stopping provider compute.
- Alternatives considered: rely on call-site discipline; pass billing evidence in from each caller; expose raw sessions after admission; describe every cancellation as server-side cancellation.
- Consequences: the static architecture checker rejects direct production `provider.createSession()` calls; malformed policy and privacy failures invoke no adapter method; no-metered proof is obtained just in time from the selected adapter; cancellation always suppresses output for that GenerationId even when the adapter ignores it. No adapter proof or provider error content is persisted.
- Reversible: wrapper APIs and cancellation report fields are versionable; technical admission before provider use, fail-closed no-metered verification, and truthful cancellation semantics are not.

## D041 — Provider generation orchestration is disposable and consumes one final proposal

- Decision: compose Generation creation, safe context compilation, admitted provider execution, cancellation, and proposal admission in an application-owned `ProviderCoordinator`. One execution allocates a stable provider-result RequestId and admits at most the first final `InterviewerProposal`; additional stream results are ignored. Production direct calls to `TurnCoordinator.processProposal` are statically rejected outside this coordinator.
- Reason: leaving these steps at call sites permits missing basis provenance, duplicate final results, raw-session bypass, and cancellation races. Persisting an execution actor or provider session would contradict provider-independent reconstruction.
- Alternatives considered: let each server/UI call the lower-level coordinators directly; persist provider session handles; resume a provider session after restart; accept every proposal yielded by a stream.
- Consequences: in-flight state remains disposable, a restart uses SQLite truth and starts fresh provider work under a new Generation, and late output from cancelled or stale Generations cannot create deliverable atoms. Context/provider failures supersede the Generation with fixed non-secret outcomes. Cancellation racing with accepted output cancels known-queued atoms before returning.
- Reversible: the coordinator API and first-final-event stream convention may evolve with a typed streaming protocol; generation provenance, application-owned admission, idempotent callback identity, and provider-independent replay are not.
