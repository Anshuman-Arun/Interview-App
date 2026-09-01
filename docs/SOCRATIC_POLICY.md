# Socratic Policy Engine

The Socratic policy is application-owned. Provider/model output may realize wording for an authorized intervention, but it does not select the intervention, target, disclosure ceiling, or protected facts.

## Inputs

The production policy consumes:

- authoritative `SessionState`;
- the committed `TurnId`;
- the application-owned `InterviewProblem`, including its versioned reasoning graph and protected-disclosure metadata.

The problem is passed into policy selection rather than copied into mutable provider state. The session's presented problem ID/version must match.

## Decision hierarchy

The engine derives a typed `PolicyDecision` and then emits the existing `RealizationRequest` contract, with one backward-compatible optional extension: `allowedDisclosureIds`.

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
unsupported claim            -> PROBE_JUSTIFICATION
ambiguity                     -> CLARIFY
local error                   -> CHECK_LOCAL_STEP
structural error              -> CHANGE_REPRESENTATION
misunderstanding              -> SIMPLIFY_CASE
first confirmed stagnation    -> ASK_FOR_EXAMPLE
persistent stagnation         -> FOCUS_ATTENTION -> DIRECTIONAL_NUDGE
authorized persistent failure -> EXPLICIT_HINT
completed approach            -> ASK_ALTERNATE_SOLUTION / GENERALIZE
```

`WAIT` is wired as actual silence in the server turn orchestrator; it does not create a model generation merely to phrase a "wait" response.

## Evidence semantics

Only `ACTIVE` evidence-history records participate in policy. `STALE` and `SUPERSEDED` records remain available for replay/audit but are ignored by the live decision.

Evidence stays scoped to its problem plus claim/milestone/skill/approach subject and dimension. Repeated provenance IDs do not create additional votes because a policy signal is derived from the active evidence record, not by counting provenance entries.

Provider evidence proposals are not authoritative policy inputs by themselves. Accepted deterministic verification may inform the decision only while its `GenerationBasis` remains compatible with current state. Contradictory active evidence/verification is handled conservatively rather than converted into fabricated confidence.

## Reasoning graph and alternate approaches

Target selection uses stable IDs, not protected solution prose. The engine validates graph references iteratively and applies resource bounds before using runtime data.

The policy:

- recognizes progress on any authored approach;
- filters next milestones to the active branch when one is known;
- respects graph predecessors before authorizing target-specific disclosure;
- does not require every branch to be completed before recognizing a completed approach;
- asks for an alternate solution when another authored approach remains;
- generalizes once all authored approaches are complete.

The current DAG representation is treated as an implementation detail of the existing schema, not as a permanent assumption about future graph topology.

## Intervention escalation

Escalation is evidence/history-driven, not turn-count-driven.

Only assistance that reached `EXPOSED`, `COMPLETED`, or `POSSIBLY_EXPOSED` counts as disclosed assistance. Cancelled or merely queued content does not. `POSSIBLY_EXPOSED` therefore conservatively influences future escalation exactly as required by the architecture freeze.

A first stagnation signal never authorizes an explicit hint. Repeated exposed interventions move through lower-disclosure actions first. Once an explicit/high-disclosure intervention was exposed or possibly exposed for the target, the policy suppresses repeated high-disclosure assistance and returns to clarification rather than "forgetting" the earlier help.

New productive evidence de-escalates naturally back to `WAIT`.

## Disclosure interaction

The policy selects a maximum disclosure level, but the existing `DisclosureValidator` remains the delivery admission authority.

For nonzero-disclosure requests the policy also supplies `allowedDisclosureIds`. The validator rejects a protected disclosure even when its numeric level is below the maximum if that disclosure is not authorized for the selected target.

New protected disclosure is authorized only when:

1. the target is an authored milestone;
2. its graph predecessors make the milestone currently eligible;
3. the protected disclosure is explicitly attached to that milestone;
4. its minimum level fits the current intervention stage;
5. escalation history justifies that stage.

Already exposed disclosure IDs remain known through the authoritative ledger. The policy never reads or emits the private canonical solution.

## Determinism and malformed input

The policy uses no randomness, wall clock, network access, provider calls, or hidden mutable history. Stable ordering is defined for evidence, verification, graph traversal, and assistance.

Public/runtime structures are validated defensively. Unknown enum values, impossible graph references, multiple active records for one evidence key, problem mismatches, and resource-limit violations fail closed to a level-0 clarification rather than selecting a high-disclosure action.

## Deliberately deferred

This subsystem does not implement:

- provider routing or real provider realization quality;
- evidence extraction from raw speech/whiteboard content;
- new reasoning-graph authoring formats;
- real vision inference;
- voice/STT/TTS/VAD;
- desktop orchestration;
- post-session history UI.

A legacy call to `selectPedagogicalAction` without an `InterviewProblem` remains a zero-disclosure justification probe for compatibility with older harnesses. Production server orchestration passes the problem and therefore uses the graph-aware engine.
