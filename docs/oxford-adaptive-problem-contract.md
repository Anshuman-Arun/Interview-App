# Oxford Mathematics adaptive problem metadata contract

> **Agent A** — canonical taxonomy/schema foundation for the Oxford Mathematics adaptive interview system.

This document is the shared contract for problem authoring, calibration, auditing, grounded evaluation, and future between-interview recommendation work. The implementation lives in `packages/problems/src/oxford-adaptive-taxonomy.ts`.

## Architecture decision

The adaptive layer extends the existing problem system; it does not create a second problem model.

Current architecture already separates:

- `InterviewProblem.public`: candidate-visible prompt/givens;
- `InterviewProblem.interviewer`: provider-visible topics, legacy difficulty, reasoning graph, and protected disclosures;
- `InterviewProblem.private`: canonical solution and verification notes;
- curated catalog metadata: authoring/catalog information outside the provider problem fingerprint.

Adaptive metadata therefore lives on `CuratedProblemMetadata.oxfordAdaptive`, **outside** `InterviewProblem`. This preserves application-owned session state, disclosure semantics, same-ID/version problem provenance, and provider-context fingerprints.

The strict `InterviewProblemPublicViewSchema` remains unchanged. Adaptive metadata is backend-only and must never be spread into public problem/catalog views.

## Existing seams this contract uses

- `CuratedProblemSpec` remains the canonical curated authoring path.
- The reasoning graph remains authoritative for approaches, milestones, prerequisites, edges, common errors, and extensions.
- Curated hint levels still compile to protected disclosures and remain governed by disclosure integrity.
- `SessionEvaluation` already produces grounded `MilestoneEvaluation` records with evidence refs, achievement state, assistance level, and approach IDs.
- Replay/longitudinal history already tracks exact problem identity, repeated problems, and grounded evidence.
- Session configuration binds an exact problem ID/version. Adaptation should select the next family **between** interviews rather than switching unrelated topics inside one interview.

## Versioning

- Adaptive metadata schema: `1`
- Oxford taxonomy: `1.0.0`

This is the intended v1 freeze. Do not add free-form tags around it. Changing tag meaning or introducing a materially different taxonomy requires an explicit versioned contract change.

## Canonical mathematical domains

Use these exact broad domains:

`algebra`, `functions`, `graph-sketching`, `sequences-recurrences`, `trigonometry`, `coordinate-geometry`, `euclidean-geometry`, `calculus`, `elementary-analysis`, `probability`, `combinatorics`, `number-theory`, `graph-theory`, `logic-proof`, `functional-equations`, `set-theory`.

Domains are deliberately broad. They are useful for portfolio coverage and coarse weakness tracking, but they are not the only mathematical-content axis.

## Fine mathematical content: `contentConcepts`

A bounded finer layer is part of v1 because broad domains alone are too coarse for meaningful between-interview adaptation. For example, “number theory” does not distinguish divisibility, modular reasoning, parity, and prime structure. Prerequisites cannot fill this role because they describe what the problem assumes, not what it actually exercises or measures.

Use these exact values:

`algebraic-identities`, `equations-inequalities`, `polynomial-structure`, `parameter-dependent-algebra`, `function-transformations`, `composition-iteration`, `inverse-functions`, `roots-intersections`, `qualitative-function-behavior`, `asymptotic-behavior`, `turning-points-extrema`, `symmetry-periodicity`, `parameter-dependent-curves`, `recurrence-structure`, `monotonicity-boundedness`, `sequence-convergence`, `telescoping-structure`, `trigonometric-structure`, `periodicity-phase`, `loci-coordinate-constraints`, `analytic-curve-geometry`, `similarity-ratio`, `angle-distance-structure`, `geometric-constructions`, `spatial-configuration`, `derivative-structure`, `integral-accumulation`, `optimization-extrema`, `rate-change`, `continuity-fixed-points`, `limiting-arguments`, `inequalities-bounds`, `conditional-structure`, `expectation-structure`, `independence-symmetry`, `random-processes`, `counting-structure`, `bijections`, `recurrence-decomposition`, `pigeonhole-structure`, `extremal-configuration`, `tilings-coverings`, `divisibility`, `modular-reasoning`, `parity`, `prime-structure`, `diophantine-structure`, `degree-structure`, `paths-cycles-connectivity`, `graph-coloring`, `graph-traversal-structure`, `logical-structure`, `set-relations`, `substitution-symmetry`, `composition-constraints`, `fixed-point-constraints`, `countability`, `set-maps`, `relations-operations`.

`OXFORD_CONTENT_CONCEPT_DOMAINS` is the authoritative bounded parent relation. Validation requires every problem/stage content concept to have at least one parent domain declared at the same level.

Semantics:

- problem `contentConcepts`: mathematical content the family is designed to exercise;
- stage `contentConcepts`: content actually exercised in that coherent interview phase;
- milestone `contentConcepts`: content for which that milestone may provide grounded evidence.

Every authored problem and stage must declare at least one content concept. A milestone may intentionally declare none when it is purely a reasoning checkpoint. Fine-content competency updates should use only milestone concepts explicitly attached to grounded milestone evidence; problem/stage membership alone is not evidence of mastery.

Do not create author-specific subtopic strings. If a future bank genuinely needs a missing concept, change the taxonomy deliberately rather than adding free-form metadata.

## Canonical reasoning/interview skills

Use these exact values:

`technique`, `visualization`, `graph-sketching`, `small-case-exploration`, `pattern-recognition`, `conjecture-formation`, `proof-construction`, `counterexample-construction`, `invariants`, `abstraction`, `modelling`, `definition-exploration`, `generalization`, `transfer`, `representation-switching`, `error-recovery`, `case-analysis`, `strategic-simplification`, `guided-adaptation`, `precision-checking`.

The final two additions come from Agent B's Oxford research reconciliation:

- `guided-adaptation`: after a tutor prompt, hint, reframing, or supplied idea, the candidate productively incorporates it into subsequent mathematical reasoning;
- `precision-checking`: checks assumptions, exhaustive cases, signs/boundaries, visual claims, and whether an argument establishes the full claim.

`guided-adaptation` is distinct from needing guidance. Prompt count measures intervention frequency; guided adaptation measures what the candidate does **after** intervention. It is also distinct from `error-recovery`, `transfer`, and session-level independence.

Skill weights remain ordinal and interpretable:

- `secondary`
- `supporting`
- `primary`

Do not invent decimal authoring weights.

## Evidence-source semantics: milestone-grounded vs process-grounded

Every canonical reasoning skill has one authoritative `OxfordSkillEvidenceBasis` in `OXFORD_SKILL_EVIDENCE_BASIS`.

### Milestone-grounded

These may receive competency evidence from grounded achievement/support on an explicitly tagged reasoning milestone:

- `technique`
- `visualization`
- `graph-sketching`
- `small-case-exploration`
- `pattern-recognition`
- `conjecture-formation`
- `proof-construction`
- `counterexample-construction`
- `invariants`
- `abstraction`
- `modelling`
- `definition-exploration`
- `generalization`
- `transfer`
- `representation-switching`
- `case-analysis`
- `strategic-simplification`
- `precision-checking`

### Process-grounded

These require relationships across authoritative events/evidence:

- `error-recovery`
- `guided-adaptation`

A reasoning milestone **must not** tag either process-grounded skill. Validation rejects this.

Problem/stage `skillEvidence` may still declare a process-grounded skill because those levels describe competencies the family/stage is designed to elicit. They do not by themselves prove the candidate demonstrated the skill.

Wave 2 evidence semantics:

- `error-recovery`: require a grounded error/false start followed by a later supported correction or repaired argument;
- `guided-adaptation`: require a recorded tutor intervention/prompt/reframing/new idea followed by subsequent grounded mathematical progress that productively uses it;
- raw hint count, disclosure level, time spent, or eventual milestone completion alone must not become positive process-skill evidence;
- session-level `independence` remains separate from these reasoning-skill tags.

No full profile projector or recommender is implemented here.

## Canonical prerequisite concepts

Use these exact values:

`arithmetic`, `algebraic-manipulation`, `equations-inequalities`, `polynomial-factorization`, `functions-graphs`, `sequences-series`, `exponentials-logarithms`, `trigonometric-identities`, `coordinate-geometry-basics`, `euclidean-geometry-basics`, `differentiation`, `integration`, `limits-continuity`, `induction`, `contradiction`, `divisibility`, `modular-arithmetic`, `prime-factorization`, `counting-principles`, `binomial-coefficients`, `basic-probability`, `conditional-probability`, `expectation`, `graph-basics`, `set-notation`, `logical-quantifiers`.

A prerequisite means “the family expects this without teaching it.” It does **not** mean the concept is assessed. A concept may legitimately appear in both `prerequisiteConcepts` and `contentConcepts` when the family both assumes and meaningfully exercises it; the fields still have different semantics.

## Stage roles

Use exactly:

1. `warm-up`
2. `technique-check`
3. `core`
4. `deep-dive`
5. `transfer`
6. `stretch`

A family need not use every role. Every authored family must contain at least one `core` stage.

The stage graph uses `prerequisiteStageIds`, must be acyclic, and must preserve cross-stage reasoning-milestone dependencies. Every reasoning milestone and reasoning-graph extension belongs to exactly one stage.

## Internal Oxford-anchored difficulty

This is **not an official Oxford score**.

Ordered bands:

1. `warm-up`
2. `introductory`
3. `introductory-plus`
4. `standard`
5. `strong`
6. `stretch`

Every authored family records separate `entry`, `core`, and `ceiling` bands plus estimate confidence. Validation requires `entry <= core <= ceiling`; stage difficulty must lie within the family range, and a core stage must match family core difficulty.

Existing `InterviewProblem.interviewer.difficulty` remains a legacy display/provider field. Recommendation/calibration work should consume `oxfordAdaptive.difficulty`.

## Timing estimates

Timing remains backend-only and initially represents product/expert estimates, not official Oxford timing.

Every authored problem and stage records:

- `firstMeaningfulInsightMinutes: { min, max }`
- `independentCompletionMinutes: { min, max }`
- `promptedCompletionMinutes: { min, max }`
- optional `optionalExtensionMinutes: { min, max }`
- `softCutoffMinutes`
- confidence `low | medium | high`

Do not convert these into hard-stop behavior or claim Oxford publishes stage-level timing.

## Provenance and review

Origin types:

- `original`
- `structural-adaptation`
- `classic-problem`
- `legacy-unknown`

Source categories:

- `independent-original`
- `official-interview-pattern`
- `official-preparation-material`
- `classic-mathematics`
- `secondary-reference`
- `unknown`

`referenceFamilyId` is an internal identifier only. Never store copied benchmark wording, source problem text, or source solution text in provenance metadata.

Independent review statuses are:

- `unreviewed`
- `in-review`
- `approved`
- `changes-required`

Tracked for taxonomy classification, originality, Oxford fidelity, and mathematical correctness.

Calibration statuses are:

- `unreviewed`
- `expert-estimate`
- `empirically-calibrated`

Tracked separately for difficulty and timing.

Classic problems remain truthful classics. “Originality approved” means provenance/originality review passed; it does not relabel a classic problem as original.

## Authoritative recommendation-readiness gate

Future consumers must call `isOxfordRecommendationReady(metadata.oxfordAdaptive)`. They must **not** reconstruct readiness from arbitrary combinations of fields or from legacy `reviewStatus = "ready"`.

The helper fails closed and requires:

- adaptive metadata status `authored`;
- metadata integrity valid;
- taxonomy classification `approved`;
- originality/provenance review `approved`;
- Oxford fidelity `approved`;
- mathematical correctness `approved`;
- difficulty calibration at least `expert-estimate`;
- timing calibration at least `expert-estimate`.

Both `expert-estimate` and `empirically-calibrated` satisfy the calibration threshold.

A `provisional-legacy` problem is never recommendation-ready. A correctly reviewed classic problem may be recommendation-ready while retaining `originType = "classic-problem"`.

This helper is the single v1 eligibility definition for the future adaptive recommendation pool.

## Compatibility/migration

Existing Oxford problems continue working.

When an existing Oxford `CuratedProblemSpec` omits `oxfordAdaptive`, authoring attaches a `provisional-legacy` record with:

- family ID equal to the existing problem ID;
- no domains;
- no content concepts;
- no prerequisite concepts;
- no skill evidence;
- no stages;
- no difficulty/timing estimates;
- novelty/abstraction/definition status unknown;
- legacy/unknown provenance;
- all review/calibration states unreviewed.

This deliberately avoids fabricated calibration or taxonomy claims.

## Validation guarantees

The adaptive metadata integrity layer rejects:

- mathematical domains/content/prerequisites/skills outside the canonical taxonomy;
- content concepts whose parent domain is not declared;
- stage content concepts absent at problem level;
- milestone content concepts absent at stage level;
- duplicate stage IDs;
- invalid or duplicate skill attribution;
- process-grounded skills tagged as ordinary milestone-completion evidence;
- unknown stage prerequisites;
- self-dependencies and cyclic stage graphs;
- unknown reasoning milestones/extensions;
- milestones/extensions assigned to multiple stages;
- authored milestones/extensions left unassigned;
- stage graphs that fail to preserve cross-stage reasoning dependencies;
- stage domains/skills absent at family level;
- impossible timing ranges;
- invalid difficulty ordering;
- inconsistent core difficulty or new-definition flags;
- invalid provenance/review/calibration state;
- inferred claims inside `provisional-legacy`;
- Oxford adaptive metadata on QUANT problems.

Existing problem integrity continues to enforce the reasoning graph, duplicate identities, protected disclosures, and other current application invariants.

Because adaptive metadata stays catalog-only, it does not change provider fingerprints or student-visible views.

---

# Wave 2 handoff

## Exact vocabulary

Import and use the exported constants/types:

- `OXFORD_MATH_DOMAINS`
- `OXFORD_CONTENT_CONCEPTS`
- `OXFORD_REASONING_SKILLS`
- `OXFORD_SKILL_EVIDENCE_BASIS`
- `OXFORD_PREREQUISITE_CONCEPTS`
- `OXFORD_STAGE_ROLES`
- `OXFORD_DIFFICULTY_BANDS`
- provenance/review/calibration enums.

Do not invent parallel subtopic tags, process-skill semantics, or readiness rules.

## Required metadata for a new Oxford family

Set `oxfordAdaptive.status = "authored"` and provide:

- schema/taxonomy versions;
- stable `familyId`;
- justified `similarityClusterId` when applicable;
- one or more broad `domains`;
- one or more assessed `contentConcepts`;
- only genuinely assumed `prerequisiteConcepts`;
- problem-level `skillEvidence`;
- entry/core/ceiling difficulty plus confidence;
- problem timing estimate plus confidence;
- novelty, abstraction, and definition flag;
- provenance and all review/calibration fields;
- one or more stages including a core stage;
- each stage's role, prerequisites, domains, content concepts, skill targets, difficulty, timing, novelty, abstraction, definition flag, milestones, and extension IDs;
- every reasoning milestone/extension assigned exactly once;
- milestone skill evidence only for milestone-grounded skills;
- milestone content concepts only where grounded milestone achievement legitimately says something about that content.

Keep all existing curated problem/disclosure/solution fields too.

## Process-skill authoring rule

A family may declare `guided-adaptation` or `error-recovery` at problem/stage level when it is intentionally designed to elicit that behavior.

Do **not** attach either skill to a milestone's `skillEvidence`. Wave 2 profile work must derive those skills from event relationships, not completion.

`precision-checking` may be milestone-grounded when the milestone itself requires checking completeness, assumptions, edge cases, or sufficiency of proof.

## Fields that may remain provisional

Use conservative truth:

- difficulty/timing confidence is normally `low` initially;
- taxonomy/originality/fidelity/correctness remain `unreviewed` or `in-review` until reviewed;
- calibration becomes `expert-estimate` only after an actual expert estimate;
- `empirically-calibrated` requires usage data;
- omit `similarityClusterId` or `referenceFamilyId` when unjustified.

Existing unclassified fixtures should remain wholly `provisional-legacy`, not partially guessed.

## What authors/recommender agents must not invent

- an official Oxford difficulty score;
- decimal authored skill weights;
- new free-form domain/content/skill/prerequisite tags;
- positive process-skill evidence from raw hint counts;
- positive process-skill evidence from milestone completion alone;
- high confidence or approved reviews without evidence;
- empirical calibration without data;
- copied source/reference wording;
- a new definition of “recommendation ready”;
- a second problem/session/evaluation state machine.

## Correct new-family workflow

1. Author through the existing curated problem path.
2. Choose family/similarity identity.
3. Choose canonical broad domains and assessed content concepts.
4. List only prerequisites assumed without teaching.
5. Choose reasoning skills, respecting evidence-basis semantics.
6. Build the existing reasoning graph and disclosure-aware hints.
7. Partition milestones/extensions into coherent stages.
8. Add stage and milestone content/skill attribution.
9. Add entry/core/ceiling difficulty and backend timing estimates conservatively.
10. Record truthful provenance.
11. Complete independent taxonomy/originality/fidelity/correctness review and calibration.
12. Keep new content in the existing editorial review path until ready.
13. Only place a problem in the adaptive recommendation pool when `isOxfordRecommendationReady` returns true.
14. Run problem-bank and Oxford adaptive-contract tests before merge.

## Intentionally deferred

v1 does **not** implement:

- the longitudinal student competency projector;
- numerical mappings from ordinal skill weights;
- causal process-evidence scoring;
- empirical timing/difficulty fitting;
- the recommendation ranking algorithm.

Those consumers should build against this contract without changing its vocabulary ad hoc.
