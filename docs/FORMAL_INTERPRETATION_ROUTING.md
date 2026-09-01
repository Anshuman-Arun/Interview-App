# Formal interpretation and deterministic verifier routing

This subsystem is the application-owned boundary between fallible mathematical interpretation and deterministic verification. It does **not** make a model authoritative for truth, verifier selection, evidence scope, freshness, or correctness.

## Authority boundary

The flow is:

```text
bounded authoritative source
        |
FormalInterpretationRequest
        |
fallible FormalInterpretationProvider
        |
0..N bounded candidates
        |
application admission + routing
        |
existing VerificationCoordinator
        |
deterministic verifier + recomputation
        |
scoped authoritative evidence
```

Providers may propose only a formal protocol family/version, structured formal statement, interpretation confidence, and provenance that echoes the request. Candidate schemas intentionally contain no verifier ID. The application resolves the verifier from its own registry and requires an exact verifier-to-`EvidenceKey` authorization before any verification request is persisted.

The request contains a bounded source-text span from one authoritative committed turn rather than a transcript or private problem material. The coordinator rechecks the span against current session state and requires the authoritative turn event ID to remain available. Canonical solutions, grading keys, credentials, raw provider responses, and full transcripts are not part of the request or diagnostics.

## Formal protocol taxonomy

Registry schema version 1 currently exposes these application protocol families:

| Application protocol | Deterministic protocol | Verifier |
| --- | --- | --- |
| `MODULAR_ARITHMETIC@1` | `INTERVIEW_APP_MODULAR_ARITHMETIC_CLAIM@1` | `deterministic-modular-arithmetic-verifier@1` |
| `RATIONAL_ARITHMETIC@1` | `INTERVIEW_APP_RATIONAL_ARITHMETIC_CLAIM@1` | `deterministic-rational-arithmetic-verifier@1` |
| `FINITE_RECURRENCE@1` | `INTERVIEW_APP_FINITE_RECURRENCE_CLAIM@1` | `deterministic-finite-recurrence-verifier@1` |
| `COMBINATORIAL_COUNTING@1` | `INTERVIEW_APP_COMBINATORIAL_COUNTING_CLAIM@1` | `deterministic-combinatorial-counting-verifier@1` |
| `PROBABILITY_ARITHMETIC@1` | `INTERVIEW_APP_PROBABILITY_ARITHMETIC_CLAIM@1` | `deterministic-probability-arithmetic-verifier@1` |

The routing registry is data-driven and versioned; callers do not switch on verifier IDs. At runtime every route is reconciled against `DETERMINISTIC_MATH_VERIFIERS`. A missing, duplicated, or protocol/version-inconsistent deterministic descriptor fails closed as verifier unavailable.

Adding a future family requires an explicit application route, its deterministic parser/schema, a matching deterministic registry descriptor, and explicit evidence-scope authorization. Merely adding a provider string cannot create a route.

## Request and provenance

`createFormalInterpretationRequest` builds requests from current `SessionWriter` state. A request binds:

- request, session, generation, InputEpisode, and turn identities;
- the exact `GenerationBasis`;
- source revision and authoritative event provenance;
- a bounded UTF-16 source-text span from the committed turn;
- exact problem ID and version;
- a claim-correctness `EvidenceKey`;
- a bounded allow-list of formal protocol family/version pairs.

The runtime schema is strict and rejects unknown fields. The coordinator independently rechecks all state-derived values after provider inference and again immediately before verification dispatch.

## Ambiguity and confidence

Interpretation confidence means only “confidence that this formalization represents the source assertion.” It is not mathematical truth confidence and is never used as evidence that the proposition is true.

The current deterministic verifier contract requires interpretation confidence exactly 1 before it will produce a verified/contradicted result. The interpretation coordinator therefore abstains before verification when the single surviving interpretation has confidence below 1. This is a downstream safety contract, not a newly invented probabilistic calibration.

A provider may return zero through eight candidates. Zero candidates abstain. Multiple materially distinct well-formed candidates return `AMBIGUOUS`; the coordinator does not pick the largest confidence. Candidates that validate to the same protocol, target, and canonical structured statement collapse deterministically. Their retained confidence is the **minimum** supplied confidence, preventing duplicates from inflating confidence.

## Formal statement validation

Statements remain verifier-specific JSON. There is no universal expression evaluator or `eval` path.

Before dispatch, the router uses the same generic structured-input budget and exact domain Zod schema used by the deterministic verifier:

- 100,000-character statement limit;
- JSON-only input;
- bounded generic nesting, node count, and array sizes;
- verifier-specific integer/rational/cardinality/expression limits;
- exact deterministic protocol and protocol-version match.

Malformed, unsupported, or over-budget statements abstain before authoritative verification work is opened.

## Freshness and terminal sessions

Freshness uses the existing `GenerationBasis` compatibility implementation. The interpretation coordinator does not define a weaker parallel notion.

Admission fails closed if the generation is superseded, a newer committed turn changes the committed-input sequence, transcript/board/problem-state/policy revisions differ, the context epoch changes, the problem identity/version changes, provenance disappears, or the session is no longer active.

The existing `VerificationCoordinator` also performs an atomic active-session check both when opening verification and when admitting a verifier result. This closes the race in which a session becomes completed or archived between interpretation preflight and serialized verification admission.

## Evidence ownership and verification composition

Providers cannot manufacture evidence scope. The request target is application-owned, must be `CLAIM/CORRECTNESS`, must match the exact problem, and must be explicitly authorized for the resolved verifier.

Accepted candidates are translated into the repository's existing `FormalInterpretationProposal` shape and passed to `VerificationCoordinator.requestVerificationFromProposal`. No parallel verification events or evidence model are introduced.

Verifier results are then sent through `VerificationCoordinator.processResult`, which re-executes the deterministic verifier and compares the supplied result against recomputation. Existing `VERIFIED`, `CONTRADICTED`, and `UNRESOLVED` semantics are preserved. Only the existing coordinator decides whether authoritative correctness evidence is committed.

## Idempotency and concurrency

Within one coordinator instance, a request ID and canonical request fingerprint map to one in-flight promise. Same-ID/same-payload retries share work. Same-ID/conflicting-payload retries fail closed.

The interpretation request fingerprint is also included in the existing `SessionWriter` command identity when verification is opened. Therefore callback retries across application restart use the durable processed-request mechanism, and a conflicting reuse of the same request ID cannot silently alias an earlier verification request.

A bounded per-coordinator cache holds settled request tombstones. The number of concurrent provider inferences, cached request records, provider candidates, protocols, source events, source text, formal-statement characters, and diagnostics are all hard bounded. No global mutable coordinator state exists.

Cancellation during provider inference does not require provider cooperation: the callback is ignored and no verification work is opened. Once a verification request has been serialized, it is driven to an admitted or discarded deterministic result instead of leaving hidden partially authoritative state.

## Diagnostics and privacy

Diagnostics are a bounded structured ring containing only request ID, state, candidate count, protocol family, resolved verifier ID, and stable rejection reason. They do not contain source text, transcripts, formal statements, provider errors, provider responses, protected solutions, secrets, or arbitrary stack traces.

## Deferred integration

This PR deliberately provides only a production-neutral `FormalInterpretationProvider` interface and deterministic fake/test provider. Gemini, OpenAI, local LLM, or other real model wiring is deferred. New theorem-proving domains, Socratic policy, evaluation, voice, vision, and whiteboard integrations are also outside this subsystem.
