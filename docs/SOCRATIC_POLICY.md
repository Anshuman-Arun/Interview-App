# Socratic Policy Engine

The Socratic policy is application-owned. Provider/model output may realize wording for an authorized intervention, but it does not select the intervention, target, disclosure ceiling, or protected facts.

## Inputs and provenance

The production policy consumes:

- authoritative `SessionState`;
- the latest committed `TurnId`;
- the application-owned `InterviewProblem`, including its reasoning graph and protected-disclosure metadata.

Policy selection requires the exact problem definition that was bound to the session. Matching only problem ID/version is not sufficient: the application recomputes the provider-context/problem fingerprint and rejects a same-ID/version definition whose public or interviewer-owned metadata changed.

Runtime inputs are preflight-bounded before deep schema parsing or fingerprint traversal. Malformed or oversized problem, evidence, verification, delivery, ledger, and graph state fails closed.

## Decision hierarchy

The engine derives a typed `PolicyDecision` and emits the existing `RealizationRequest` contract with target-scoped `allowedDisclosureIds`.

The main classifications are:

- productive progress;
- local error;
- structural error;
- unsupported claim;
- ambiguous statement;
- misunderstanding;
- true stagnation;
- repeated stagnation;
- unexpected valid approach;
- completed primary approach;
- insufficient current evidence.

Conflicting active signals fail closed to clarification at disclosure level 0. Absence of evidence is not interpreted as failure or lack of progress.

Typical behavior is:

```text
productive progress          -> WAIT
unsupported claim            -> PROBE_JUSTIFICATION / VERIFY
ambiguity                     -> CLARIFY / VERIFY
local error                   -> CHECK_LOCAL_STEP
structural error              -> CHANGE_REPRESENTATION
misunderstanding              -> SIMPLIFY_CASE
first confirmed stagnation    -> ASK_FOR_EXAMPLE
persistent stagnation         -> FOCUS_ATTENTION -> DIRECTIONAL_NUDGE
authorized persistent failure -> EXPLICIT_HINT
completed approach            -> ASK_ALTERNATE_SOLUTION / GENERALIZE
```

`WAIT` is actual silence in the server turn orchestrator; it does not create a model generation just to phrase a waiting response.

## Evidence and verification semantics

Only `ACTIVE` evidence-history records participate in live policy. `STALE` and `SUPERSEDED` records remain in durable history for replay/audit but do not drive decisions.

Evidence remains scoped to its problem plus claim/milestone/skill/approach subject and dimension. The policy verifies active-record identity, authoritative event ordering, projection consistency, bounded provenance, allowed rating/dimension combinations, and unique active evidence-event ownership.

Evidence below the actionable confidence threshold is not promoted into a confident correction or progress claim. A newer low-confidence inference can force clarification rather than silently losing to older confident evidence.

Accepted deterministic verification is also application-owned evidence. The policy validates request/result identity, result-arrival ordering, verifier identity, interpretation confidence, evidence provenance, claim/correctness scope, and `GenerationBasis` compatibility. Low-interpretation-confidence accepted results are treated as unresolved rather than confidently verified/contradicted. A `CORRECT` evidence record derived from verification inherits that same basis freshness through its verification-request provenance; stale or malformed verification mirrors cannot remain actionable after the verification itself becomes incompatible.

## Reasoning graph and alternate approaches

Target selection uses stable IDs, never protected solution prose. Graph structure is validated iteratively, including duplicate references, cycles introduced through either authored edges or prerequisite references, and bounded fan-in/reference counts.

Readiness is branch-aware:

- a root milestone is ready immediately;
- a milestone on one approach requires every explicit predecessor on that approach;
- a shared join may be satisfied by any explicitly authored approach branch, but all predecessors relevant to the chosen branch must be complete;
- an approach tag with no incoming prerequisite does not invent an implicit shortcut.

The policy recognizes progress on any authored approach, filters branch-specific evidence/interventions to the active approach when it can be determined, and does not drag the student back to an older abandoned branch merely because an older error remains there.

A completed primary approach triggers an alternate-solution request when another authored approach remains. Once all authored approaches are complete, the policy generalizes.

## Intervention escalation

Escalation is evidence/history-driven, not turn-count-driven.

Only assistance that reached `EXPOSED`, `COMPLETED`, or `POSSIBLY_EXPOSED` counts as prior disclosed assistance. Cancelled or merely queued content does not. Assistance is tied to the generation-bound action snapshot and exact target, not to a generic "latest step" label. Historical assistance must also correspond to a recorded, schema-valid interviewer proposal and to a realization that proposal actually contained; a forged `VALIDATED` status or unrelated exposed atom fails closed.

A first stagnation/error never jumps directly to an explicit hint. Repeated exposed interventions progress through lower-disclosure actions first. An explicit hint is available only when the graph/disclosure metadata authorizes a new protected fact at the appropriate level. Once high-disclosure assistance was exposed or possibly exposed for the target, the policy suppresses repeated high disclosure and returns to clarification rather than forgetting the help.

New productive evidence de-escalates naturally back to `WAIT`.

## Disclosure interaction

The policy selects both a numeric maximum and the protected disclosure IDs allowed for the selected target. The `DisclosureValidator` remains the delivery admission authority.

The validator:

- checks the provider realized the application-selected action;
- independently analyzes every speech/board textual realization;
- fails closed on analyzer exceptions, malformed/oversized results, `UNSAFE`, uncertainty, or unknown disclosure IDs;
- enforces protected-disclosure metadata as a floor even if a custom analyzer understates it;
- treats provider self-claims conservatively when analysis cannot localize them;
- rejects any effective protected disclosure outside `allowedDisclosureIds` or above the numeric ceiling.

The target's own protected facts are authorized only when that milestone is ready. For low-level reframing at a premature join, already-completed prerequisites on the active approach may be referenced, but uncompleted siblings and the unready join's own protected facts remain locked.

Disclosure is attributed per delivery atom after aggregate proposal admission. A protected board annotation therefore does not falsely mark a safe speech atom as having exposed the same fact. If a provider claims a protected disclosure that application analysis cannot localize to a realization, every realization remains conservatively tainted by that claim.

The authoritative disclosure ledger must exactly match protected IDs actually carried by exposed/completed/possibly-exposed atoms. Duplicate, forgotten, unknown, or over-level historical disclosure authorization fails closed.

## Generation and delivery freshness

A generation is bound to the latest committed turn/input episode, the selected pedagogical action, problem fingerprint, provider identity, and the current `GenerationBasis`. A turn may not have multiple concurrent nonterminal generations; failover/retry requires the previous generation to be explicitly superseded.

Authoritative input, transcript, board, evidence, problem-state, or policy changes invalidate undelivered policy output. Queued stale atoms are cancelled. Delivering atoms are marked `POSSIBLY_EXPOSED`, because physical output may already have occurred.

A renderer reconnect never redisplays `POSSIBLY_EXPOSED` content. If a delayed persisted renderer acknowledgement later confirms exposure, `POSSIBLY_EXPOSED -> EXPOSED` is allowed as a certainty refinement; the disclosure was already counted conservatively, so this does not forget or weaken exposure history.

Provider callbacks are bound to generation/provider identity and generation basis. Late output from a superseded or otherwise inactive generation is inert and cannot create delivery atoms.

## Determinism and malformed input

The policy uses no randomness, wall clock, network access, provider calls, or hidden mutable history. Stable ordering is defined for evidence, verification results, graph traversal, and assistance.

Runtime structures are treated as hostile at public boundaries. Unknown enums, impossible graph references, duplicate IDs, inconsistent event sequence/index data, multiple active evidence records, mismatched generation/turn/input provenance, problem-definition mismatches, malformed disclosure ledgers, and resource-limit violations fail closed to a level-0 clarification or reject admission before delivery.

`RealizationRequest.target` is bounded and must contain non-whitespace content while preserving exact target identity.

## Deliberately deferred

This subsystem does not implement:

- general semantic natural-language validation that a provider's wording truly performs the selected Socratic action;
- evidence extraction from raw speech/whiteboard content;
- new reasoning-graph authoring formats beyond the existing schema;
- real vision inference;
- voice/STT/TTS/VAD implementation;
- desktop orchestration;
- post-session history UI.

The server's current mock realization templates are integration scaffolding, not a substitute for the later semantic proposal-admission layer.
