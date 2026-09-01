# Grounded Session Evaluation

## Purpose

The post-interview evaluator is a deterministic read model over application-owned session state and the exact session-bound InterviewProblem definition. It does not create authoritative student evidence, reinterpret the transcript, call a model, or infer performance from activity volume. For started sessions, the supplied problem must match the session's ID, version, public prompt, and provider-context fingerprint.

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

- active scoped evidence from SessionState.evidenceHistory, cross-checked against SessionState.studentEvidence;
- valid supersession history for recovery analysis;
- accepted deterministic verification results, their application-owned request/evidence provenance, and current GenerationBasis compatibility where a standalone verifier outcome is used;
- the problem's versioned, approach-aware reasoning graph;
- exposed, completed, or possibly exposed deliveries;
- generation basis metadata for generation provenance, but not as a substitute for exposure chronology;
- authoritative session lifecycle state.

It does not copy the private canonical solution, full transcript, or delivered hint text into SessionEvaluation.

Superseded evidence may participate in historical negative-to-positive recovery transitions. STALE evidence has been explicitly invalidated and is excluded from current scoring and from error-recovery opportunities. Neither stale nor superseded evidence can establish current milestone achievement or current correctness.

Evidence chronology is checked against the authoritative event index. An evidence record's lastUpdatedSequence must point to that record's own STUDENT_EVIDENCE_UPDATED event identity, and every cited provenance event must occur earlier. This prevents a corrupted projection from manufacturing error/recovery ordering by editing sequence numbers.

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
- specifically linked VERIFIED requests when the active evidence record cites that verification request's authoritative request event;
- unambiguous current-context CONTRADICTED verifier outcomes.

Milestone completion is not a correctness sample. A PROGRESS = COMPLETE record can establish milestone achievement without establishing technical correctness.

| Grounded result | Score contribution |
| --- | ---: |
| CORRECT, including specifically verifier-backed CORRECT | 100 |
| LOCAL_ERROR | 50 |
| STRUCTURAL_ERROR | 0 |
| unambiguous current CONTRADICTED | 0 |
| UNKNOWN / UNRESOLVED / conflicting current verifier outcomes | no score contribution |

The current SessionState retains verification request provenance but not the authoritative sequence of the later VERIFICATION_RESULT_ACCEPTED event. Request ordering is therefore not treated as result-acceptance ordering. Standalone CONTRADICTED or UNRESOLVED outcomes are considered current only while their complete GenerationBasis remains compatible with the current session state: committed input, transcript, board, problem-state, policy, context epoch, and turn/episode provenance must still match. A later committed input therefore prevents an old contradiction from leaking into current correctness.

If simultaneously current accepted verifier outcomes conflict, or a current CORRECT model inference conflicts with an accepted deterministic contradiction, the affected subject is treated as unresolved rather than choosing an invented winner.

A VERIFIED request is never resurrected from historical request state after its committed correctness evidence has been invalidated or superseded. Verifier-backed support requires the exact evidence chain committed by VerificationCoordinator: CORRECT, matching interpretation confidence, the original verification provenance events, and the authoritative verification-request event. Every accepted VERIFIED request must have that historical correctness evidence somewhere in evidenceHistory, even if the record is later superseded or invalidated. Absence of contradiction is not correctness.

### Claim-granularity resistance

CLAIM identifiers are not an authoritative versioned claim catalog, so the evaluator does not let a fallible producer multiply weight merely by inventing more IDs for the same observation. Unverified claim-scoped correctness records with the same normalized authoritative provenance-event set form one scoring unit. If multiple such records disagree, the conservative lowest grounded score is used for that unit and provenance/support are merged conservatively.

Verifier-backed claims remain distinct because their authoritative verifier-request provenance distinguishes the deterministic checks. Structured MILESTONE, APPROACH, and SKILL subjects retain their explicit subject identity.

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
- LOCAL_ERROR caps it at 50;
- an unambiguous deterministic contradiction caps it at 0 when no active CORRECT record conflicts with that contradiction;
- unresolved or conflicting deterministic correctness evidence degrades rigor support instead of inventing certainty.

Turn count, response length, verification-request count, and unrelated or historical VERIFIED requests do not affect rigor. Claim-scoped justification records with identical normalized authoritative provenance are likewise one rigor scoring unit, so claim-ID splitting cannot manufacture extra weight.

## Communication

Communication is currently not scored by the deterministic evaluator.

The current authoritative evidence taxonomy does not contain a validated natural-language communication-quality signal. Word count, response length, or stylistic model judgments are not substitutes.

The result therefore contains a null score, INSUFFICIENT support, and an explicit notScoredReason.

A future qualitative evaluator can propose communication judgments through the non-authoritative proposal seam described below.

## Assistance and independence

Only deliveries whose authoritative status is EXPOSED, COMPLETED, or POSSIBLY_EXPOSED count as potentially delivered assistance.

Queued, delivering-but-unacknowledged, validated-only, and cancelled atoms do not count as exposed assistance.

Assistance association is derived through protected disclosure IDs. A delivery is associated with a milestone only when the milestone references that disclosure ID. Re-rendering the same disclosure does not create duplicate disclosure identities. For a multi-disclosure atom, each milestone's assistanceLevel is derived from that disclosure's problem-defined minimum level rather than smearing the atom-wide maximum level onto every referenced milestone.

A protected disclosure whose problem-defined minimum level is 0 is not positive assistance and does not create independence timing ambiguity. Conversely, if a delivery's authoritative effectiveDisclosureLevel is greater than the highest level explained by its recognized disclosure IDs, that residual positive severity is retained as unattributed assistance rather than disappearing behind a mapped level-zero or lower-level disclosure.

The current SessionState records generation basis but not the authoritative event sequence at which a delivery became EXPOSED, COMPLETED, or POSSIBLY_EXPOSED. Generation basis is therefore never treated as exposure time.

Because before/after exposure ordering is unavailable, the evaluator does not apply a guessed numeric assistance penalty. Independence follows a fail-closed rule:

- with no grounded achieved milestone, independence is not scored;
- if relevant protected assistance was exposed or possibly exposed for an achieved milestone, independence is not scored;
- if exposed level-positive assistance cannot be mapped to a milestone, independence is not scored;
- only when at least one milestone is grounded as achieved and the exposure ledger contains no relevant or unattributed assistance does independence score 100.

The null result in assistance-ambiguous cases is intentional: a protected disclosure may have been exposed before or after the candidate's progress, and SessionState alone cannot prove which. Milestone assistance IDs/levels remain structural exposure associations, not causal claims that the disclosure caused achievement.

POSSIBLY_EXPOSED is treated as exposure for this ambiguity check, matching the architecture's crash-uncertainty rule.

## Hint responsiveness

Hint responsiveness is currently not scored.

The authoritative SessionState records which protected disclosures were exposed, but it does not retain the exposure event sequence needed to prove that a delivery preceded later progress. Generation basis sequence identifies the state used to generate content; it does not prove when the renderer exposed that content.

Until evaluation receives authoritative exposure ordering, hint responsiveness returns a null score with INSUFFICIENT support rather than manufacturing a temporal or causal association.

## Error recovery

Error recovery is based on evidence-history transitions, not session length.

An error episode can begin from a non-stale LOCAL_ERROR, STRUCTURAL_ERROR, MISUNDERSTOOD_PROBLEM, UNJUSTIFIED, or REGRESSING record.

A later non-stale supported replacement such as CORRECT, UNDERSTANDS, JUSTIFIED, COMPLETE, or PROGRESSING records recovery. A STALE record is invalidated evidence, not proof that the student made an error, so stale-to-fresh revalidation by itself is not scored as error recovery.

Repeated negative evidence without a later supported replacement records an unrecovered episode. A later supported different APPROACH can record a grounded approach-switch recovery only on the same evidence dimension and only after the latest unresolved error on the abandoned approach.

Approach-switch lookup is indexed by evidence dimension and sequence so the declared evidence bound cannot degrade into a quadratic recovery scan.

If no grounded negative evidence creates an error opportunity, error recovery is not scored. The evaluator does not award 100 merely for avoiding a recorded error.

## Support levels

Every dimension and milestone separates the score from how well the authoritative record supports it.

- STRONG
- MODERATE
- WEAK
- INSUFFICIENT

These are bounded deterministic categories, not probabilities.

Where an authoritative evidence record has inferenceConfidence, that recorded value may affect the categorical support bucket. Where a verifier has interpretation confidence, that recorded value may affect verifier-backed support.

Grounded coverage counts can strengthen structural support, while recorded evidence inferenceConfidence and verifier interpretationConfidence can constrain it. Recovery support is tied to the recorded confidence of the negative and replacement evidence rather than to episode count alone. Repeated model-inferred evidence cannot become STRONG merely by being repeated. No synthetic probabilistic confidence is generated.

INSUFFICIENT always implies score = null.

## Evidence provenance

Evaluation results retain compact references rather than copied source content.

Reference kinds are EVIDENCE_EVENT, VERIFICATION_REQUEST, DELIVERY, TURN, and MILESTONE. Evidence and verification provenance IDs used by scoring are checked against SessionState.eventIds; an invented or missing event reference fails evaluation structurally rather than becoming support. Verification request events must occur after their committed-input basis, and their source evidence must not come from beyond that basis.

VERIFIED provenance is attached to current correctness only when the active evidence record specifically cites that verification request's authoritative request event. Historical VERIFIED requests with the same EvidenceKey are not treated as current support merely because the key matches.

Milestone results also retain the protected disclosure IDs structurally associated with exposure and the milestone's valid approach IDs.

A future replay UI can resolve these references against authoritative history to explain a result without embedding transcripts or protected solution text into the evaluation object.

Milestone results retain protected disclosure IDs structurally associated with exposure and the milestone's valid approach IDs. The legacy description field is preserved for compatibility, but it contains only an ordinal structural label such as "Reasoning milestone 2". Evaluation output never copies the interviewer-owned reasoning-graph description, because that text can contain solution-bearing material.

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

Unknown dimensions are never silently assigned 0 or 100. SessionEvaluationSchema also cross-checks the serialized score breakdown, included/omitted dimensions, composite status, renormalized composite score, and composite support level so a tampered but individually well-typed result cannot claim inconsistent composite metadata.

The rubric is strict:

- each weight must be finite and in [0, 1];
- the complete effective rubric must sum to 1;
- unknown fields are rejected.

A Partial<EvaluationRubric> call still merges with defaults first. If that effective rubric no longer sums to 1, evaluation rejects it rather than silently normalizing malformed intent.

## Grounded feedback

Strength and improvement text is derived from the same counted evidence facts as the dimensions. It does not use generic score bands such as "80+ is a strength" or "below 70 needs improvement."

- correctness/rigor strength statements require positively grounded subjects, no negative subjects in that dimension, and at least MODERATE support;
- correctness/rigor improvement statements are emitted whenever grounded negative subjects remain, regardless of the overall average;
- an independence strength is emitted only when independence itself was scoreable at 100, so unattributed or timing-ambiguous assistance suppresses that claim;
- recovery is called a strength only when grounded recovery episodes exist and no recorded recovery opportunity remains unresolved.

## Lifecycle and incomplete sessions

Evaluation reports both sessionStatus and a derived completion state:

- NOT_STARTED;
- IN_PROGRESS;
- COMPLETED;
- ARCHIVED_INCOMPLETE;
- ARCHIVED_COMPLETED.

Summary language reports lifecycle context separately from score. An incomplete or archived-incomplete session is not described as though the candidate completed an interview. Evaluator input validation also rejects contradictory lifecycle projections such as a CREATED session marked started, an ACTIVE session carrying terminal timestamps, or terminal states missing their required timestamp. Serialized lifecycle metadata is cross-validated as well, so CREATED/ACTIVE/COMPLETED cannot be paired with the wrong derived completion state.

## Determinism and timestamp handling

Scoring is pure with respect to wall time.

Callers may inject evaluatedAt through the fourth evaluateInterviewSession options argument.

If no timestamp is supplied, the evaluator uses an authoritative terminal session timestamp when one exists. Otherwise it uses the deterministic sentinel 1970-01-01T00:00:00.000Z.

Changing evaluatedAt cannot alter scores, support, provenance, milestones, or feedback.

Object/map insertion order does not affect evaluation output.

## Authoritative state projection checks

Because evaluation consumes SessionState rather than replaying raw events itself, it validates the projection fields that materially affect scoring:

- session and turn sequences must be safe and in bounds;
- committed turn sequences are unique;
- every committed turn references a COMMITTED InputEpisode;
- lastCommittedInputSequence equals the latest committed turn sequence;
- generation bases reference an existing turn, and any stored inputEpisodeId must match that turn;
- evidence update sequence/provenance ordering is consistent with SessionState.eventIds;
- accepted verification request provenance fits its committed-input basis;
- accepted VERIFIED results retain their atomically committed historical correctness evidence;
- delivery disclosure IDs are unique, known to the exact problem, and cannot understate the problem-defined disclosure minimum;
- the disclosure ledger equals the union of authoritatively exposed/completed/possibly-exposed delivery disclosures.

These checks reject corrupted/tampered projections rather than allowing projection metadata to alter verifier freshness, recovery ordering, or independence.

## Resource bounds and diagnostics

Evaluation rejects structurally pathological input instead of silently truncating it.

Current explicit safety ceilings cover:

| Input | Ceiling |
| --- | ---: |
| turns | 10,000 |
| authoritative event IDs | 250,000 |
| evidence-history records | 50,000 |
| evidence provenance references | 150,000 |
| deliveries | 20,000 |
| delivery disclosure references | 50,000 |
| verification requests | 20,000 |
| verification provenance references | 100,000 |
| reasoning-graph milestones | 5,000 |
| reasoning-graph edges | 50,000 |
| approaches | 10,000 |
| protected disclosures | 20,000 |
| aggregate milestone reasoning references | 100,000 |
| auxiliary problem items, including formulations/common errors/extensions | 100,000 |
| problem-definition string characters processed for fingerprint validation | 2,000,000 |

These ceilings are execution-safety limits, not score heuristics. Evaluation rejects an oversized input instead of truncating it. Aggregate bounds cover nested provenance/reference arrays so a small top-level object count cannot hide unbounded work.

Errors identify the structural bound or identity problem. They do not copy transcripts, canonical solutions, provider secrets, protected disclosure facts, or raw provider/worker error payloads.

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

The current seam accepts a communication proposal only when the proposal is schema-valid and every cited evidence reference is in the application-supplied allowlist. Malformed fallible proposals fail closed as INVALID_PROPOSAL rather than throwing through the evaluator boundary.

Passing that provenance check does not make the proposed score authoritative. Duplicate qualitative proposal evidence references are rejected, and the deterministic SessionEvaluation scorer does not consume these proposals in this implementation.

No model or network call is made by session evaluation.

## Compatibility

The public SessionEvaluation shape retains its existing high-level fields: scores, milestones, disclosedInterventions, milestone counts, total turns, strengths, improvement areas, and summary.

It adds narrow support/provenance/lifecycle metadata.

The intentional compatibility correction is that legacy dimension and composite numeric fields are now nullable. This is necessary to represent unsupported dimensions honestly. Consumers must handle null as "not scored".

No EVALUATION_COMPLETED event is currently persisted by the repository's event schema, so this branch does not change the durable event schema and requires no event upcaster. If evaluation persistence is added later, its schema/version migration must follow the existing event-upcaster conventions.
