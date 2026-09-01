# Grounded Session Evaluation

## Purpose

The post-interview evaluator is a deterministic read model over application-owned session state and the exact InterviewProblem version. It does not create authoritative student evidence, reinterpret the transcript, call a model, or infer performance from activity volume.

Flow:

    authoritative SessionState
    + exact InterviewProblem/version
            |
            v
    grounded evidence extraction
            |
            v
    dimension-specific deterministic evaluation
            |
            v
    support + provenance
            |
            v
    SessionEvaluation

A missing signal is represented as missing support. It is not converted to a neutral, failing, or passing numeric score.

## Removed proxy behavior

The evaluator does not use these former proxies:

- turn count as milestone completion;
- turn count as rigor;
- accepted verification-request count as rigor or correctness;
- average answer length as communication quality;
- number of turns as error recovery;
- number of delivered atoms as a blanket independence penalty;
- completion status as proof of correctness.

Adding words or meaningless turns cannot improve a grounded score.

## Evaluation inputs and authority

The evaluator reads:

- active scoped evidence from SessionState.evidenceHistory;
- evidence history transitions for recovery analysis;
- accepted deterministic verification results;
- the problem's versioned, approach-aware reasoning graph;
- exposed, completed, or possibly exposed deliveries;
- generation basis metadata for generation provenance, but not as a substitute for exposure chronology;
- authoritative session lifecycle state.

It does not copy the private canonical solution, full transcript, or delivered hint text into SessionEvaluation.

Stale and superseded evidence is useful only for historical transition analysis such as error recovery. It cannot establish current milestone achievement or current correctness.

## Milestone achievement

A milestone is achieved only when current scoped milestone evidence supports it.

Supported completion patterns are:

- PROGRESS = COMPLETE; or
- CORRECTNESS = CORRECT together with JUSTIFICATION = JUSTIFIED or NOT_APPLICABLE.

Current contradictory evidence blocks achievement when it records:

- PROGRESS = REGRESSING;
- CORRECTNESS = LOCAL_ERROR;
- CORRECTNESS = STRUCTURAL_ERROR; or
- UNDERSTANDING = MISUNDERSTOOD_PROBLEM.

The evaluator does not infer achievement from turn ordering.

Reasoning-graph predecessors and optional prerequisites are used to judge support quality, not to force a canonical route. Direct scoped evidence can establish an alternate branch. A milestone whose graph context is weak or missing may remain achieved with downgraded support rather than being converted into an invented canonical-path failure.

## Technical correctness

Technical correctness is computed over distinct grounded subjects.

Sources include:

- active scoped CORRECTNESS evidence;
- accepted deterministic verifier results;
- grounded milestone achievement when no more specific correctness sample exists for that milestone.

| Grounded result | Score contribution |
| --- | ---: |
| CORRECT / VERIFIED | 100 |
| LOCAL_ERROR | 50 |
| STRUCTURAL_ERROR / CONTRADICTED | 0 |
| UNKNOWN / UNRESOLVED | no score contribution |

UNRESOLVED is retained as provenance but never treated as correctness. Absence of contradiction is not correctness.

## Rigor

Rigor is based on active scoped JUSTIFICATION evidence:

| Grounded result | Score contribution |
| --- | ---: |
| JUSTIFIED | 100 |
| INCOMPLETE | 50 |
| UNJUSTIFIED | 0 |
| NOT_APPLICABLE | omitted from rigor scoring |

A current correctness error on the same subject constrains the rigor contribution:

- STRUCTURAL_ERROR caps the contribution at 0;
- LOCAL_ERROR caps it at 50.

Turn count, response length, and unused verification requests do not affect rigor.

## Communication

Communication is currently not scored by the deterministic evaluator.

The current authoritative evidence taxonomy does not contain a validated natural-language communication-quality signal. Word count, response length, or stylistic model judgments are not substitutes.

The result therefore contains a null score, INSUFFICIENT support, and an explicit notScoredReason.

A future qualitative evaluator can propose communication judgments through the non-authoritative proposal seam described below.

## Assistance and independence

Only deliveries whose authoritative status is EXPOSED, COMPLETED, or POSSIBLY_EXPOSED count as potentially delivered assistance.

Queued, delivering-but-unacknowledged, validated-only, and cancelled atoms do not count as exposed assistance.

Assistance is attributed through protected disclosure IDs. A delivery affects a milestone only when the milestone references that disclosure ID. The same disclosure exposed more than once is deduplicated for the milestone's distinct-assistance count.

For a grounded achieved milestone, the base independence mapping is:

| Highest attributable disclosure level | Milestone independence |
| --- | ---: |
| 0 | 100 |
| 1 | 90 |
| 2 | 75 |
| 3 | 55 |
| 4 | 30 |
| 5 | 10 |

Multiple distinct relevant disclosure IDs may reduce the milestone score further, bounded by 20 additional points. Re-rendering the same disclosed fact does not create another penalty.

The current SessionState records generation basis but not the authoritative event sequence at which a delivery became EXPOSED, COMPLETED, or POSSIBLY_EXPOSED. Generation basis is therefore never treated as exposure time.

When a protected disclosure is relevant to an achieved milestone, the evaluator conservatively attributes that assistance and degrades independence support to WEAK because before/after ordering cannot be established from SessionState alone. It does not invent a precise chronology.

POSSIBLY_EXPOSED is treated as exposure for evaluation, matching the architecture's crash-uncertainty rule.

Independence is not scored when no milestone has grounded achievement evidence.

## Hint responsiveness

Hint responsiveness is currently not scored.

The authoritative SessionState records which protected disclosures were exposed, but it does not retain the exposure event sequence needed to prove that a delivery preceded later progress. Generation basis sequence identifies the state used to generate content; it does not prove when the renderer exposed that content.

Until evaluation receives authoritative exposure ordering, hint responsiveness returns a null score with INSUFFICIENT support rather than manufacturing a temporal or causal association.

## Error recovery

Error recovery is based on evidence-history transitions, not session length.

An error episode can begin from LOCAL_ERROR, STRUCTURAL_ERROR, MISUNDERSTOOD_PROBLEM, UNJUSTIFIED, REGRESSING, or evidence invalidated as STALE.

A later supported replacement such as CORRECT, UNDERSTANDS, JUSTIFIED, COMPLETE, or PROGRESSING records recovery.

Repeated negative evidence without a later supported replacement records an unrecovered episode. A later supported different APPROACH can record a grounded approach-switch recovery.

If no error opportunity exists, error recovery is not scored. The evaluator does not award 100 merely for avoiding a recorded error.

## Support levels

Every dimension and milestone separates the score from how well the authoritative record supports it.

- STRONG
- MODERATE
- WEAK
- INSUFFICIENT

These are bounded deterministic categories, not probabilities.

Where an authoritative evidence record has inferenceConfidence, that recorded value may affect the categorical support bucket. Where a verifier has interpretation confidence, that recorded value may affect verifier-backed support.

For structural signals such as grounded achieved milestones or recovery opportunities, support uses deterministic coverage counts directly. No synthetic probabilistic confidence is generated.

INSUFFICIENT always implies score = null.

## Evidence provenance

Evaluation results retain compact references rather than copied source content.

Reference kinds are EVIDENCE_EVENT, VERIFICATION_REQUEST, DELIVERY, TURN, and MILESTONE.

Milestone results also retain the protected disclosure IDs attributed as assistance and the milestone's valid approach IDs.

A future replay UI can resolve these references against authoritative history to explain a result without embedding transcripts or protected solution text into the evaluation object.

## Composite score

The legacy score field names are retained, but dimension scores may now be null.

For positively weighted rubric dimensions:

1. supported dimensions are included;
2. unsupported dimensions are omitted;
3. included weights are renormalized deterministically;
4. omitted dimensions are listed explicitly.

Composite metadata is:

- FULL: every positively weighted rubric dimension was scored;
- PARTIAL: one or more positively weighted dimensions was unsupported and omitted;
- NOT_SCORED: no positively weighted dimension was supported.

Unknown dimensions are never silently assigned 0 or 100.

The rubric is strict:

- each weight must be finite and in [0, 1];
- the complete effective rubric must sum to 1;
- unknown fields are rejected.

A Partial<EvaluationRubric> call still merges with defaults first. If that effective rubric no longer sums to 1, evaluation rejects it rather than silently normalizing malformed intent.

## Lifecycle and incomplete sessions

Evaluation reports both sessionStatus and a derived completion state:

- NOT_STARTED;
- IN_PROGRESS;
- COMPLETED;
- ARCHIVED_INCOMPLETE;
- ARCHIVED_COMPLETED.

Summary language reports lifecycle context separately from score. An incomplete or archived-incomplete session is not described as though the candidate completed an interview.

## Determinism and timestamp handling

Scoring is pure with respect to wall time.

Callers may inject evaluatedAt through the fourth evaluateInterviewSession options argument.

If no timestamp is supplied, the evaluator uses an authoritative terminal session timestamp when one exists. Otherwise it uses the deterministic sentinel 1970-01-01T00:00:00.000Z.

Changing evaluatedAt cannot alter scores, support, provenance, milestones, or feedback.

Object/map insertion order does not affect evaluation output.

## Resource bounds and diagnostics

Evaluation rejects structurally pathological input instead of silently truncating it.

Current explicit bounds cover:

- turns;
- evidence-history records;
- deliveries;
- verification requests;
- reasoning-graph milestones;
- disclosure references.

Errors identify the structural bound or identity problem. They do not copy transcripts, canonical solutions, provider secrets, or raw provider/worker error payloads.

## Future fallible qualitative evaluator

evaluation-model-seam.ts defines a deliberately non-authoritative boundary:

    application-owned grounded facts
            |
            v
    fallible qualitative proposal
            |
            v
    provenance validation
            |
            v
    optional future application policy

The current seam accepts a communication proposal only when every cited evidence reference is in the application-supplied allowlist.

Passing that provenance check does not make the proposed score authoritative. The deterministic SessionEvaluation scorer does not consume these proposals in this implementation.

No model or network call is made by session evaluation.

## Compatibility

The public SessionEvaluation shape retains its existing high-level fields: scores, milestones, disclosedInterventions, milestone counts, total turns, strengths, improvement areas, and summary.

It adds narrow support/provenance/lifecycle metadata.

The intentional compatibility correction is that legacy dimension and composite numeric fields are now nullable. This is necessary to represent unsupported dimensions honestly. Consumers must handle null as "not scored".

No EVALUATION_COMPLETED event is currently persisted by the repository's event schema, so this branch does not change the durable event schema and requires no event upcaster. If evaluation persistence is added later, its schema/version migration must follow the existing event-upcaster conventions.
