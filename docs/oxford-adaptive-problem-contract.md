# Oxford Mathematics adaptive problem metadata contract

> **Agent A** — canonical taxonomy/schema foundation for the Oxford Mathematics adaptive interview system.

This document is the shared contract for problem-authoring, calibration, auditing, evaluation, and future between-interview recommendation work. The implementation lives in `packages/problems/src/oxford-adaptive-taxonomy.ts`.

## Architecture decision

The adaptive layer extends the existing problem system; it does not create a second problem model.

Current architecture already separates:

- `InterviewProblem.public`: candidate-visible prompt/givens;
- `InterviewProblem.interviewer`: provider-visible topics, legacy difficulty, reasoning graph, and protected disclosures;
- `InterviewProblem.private`: canonical solution and verification notes;
- curated catalog metadata: authoring/catalog information that is not part of the provider problem fingerprint.

Adaptive metadata therefore lives on `CuratedProblemMetadata.oxfordAdaptive`, **outside** `InterviewProblem`. This preserves application-owned session state, disclosure semantics, same-ID/version problem provenance, and provider-context fingerprints.

The strict `InterviewProblemPublicViewSchema` remains unchanged. Adaptive metadata is backend-only and must never be spread into public problem/catalog views.

## Existing seams this contract uses

- `CuratedProblemSpec` is the canonical curated authoring path.
- The reasoning graph already supplies approaches, milestone IDs, milestone prerequisites, edges, common errors, and extensions.
- Curated hint levels compile to protected disclosure IDs and remain governed by disclosure integrity.
- `SessionEvaluation` already produces grounded `MilestoneEvaluation` records with evidence references, achievement state, assistance level, and approach IDs.
- Replay/longitudinal history already compares exact problem ID/version, tracks repeated problems, and aggregates grounded evidence. It currently declares `skillTaxonomyAvailable: false`; Wave 2 can join milestone evaluations to the metadata defined here without changing replay authority.
- Session configuration binds an exact problem ID/version. Future adaptation should select the next family **before** the next interview, not mutate a live interview into unrelated topics.

## Versioning

- Adaptive metadata schema: `1`
- Oxford taxonomy: `1.0.0`

Changing the meaning of an existing tag requires a version change. Adding a new canonical tag should be deliberate and reviewed; do not bypass the taxonomy with arbitrary strings.

## Canonical mathematical domains

Use these exact values:

`algebra`, `functions`, `graph-sketching`, `sequences-recurrences`, `trigonometry`, `coordinate-geometry`, `euclidean-geometry`, `calculus`, `elementary-analysis`, `probability`, `combinatorics`, `number-theory`, `graph-theory`, `logic-proof`, `functional-equations`, `set-theory`.

These are broad recommendation domains, not solution-revealing subtopic labels.

## Canonical reasoning/interview skills

Use these exact values:

`technique`, `visualization`, `graph-sketching`, `small-case-exploration`, `pattern-recognition`, `conjecture-formation`, `proof-construction`, `counterexample-construction`, `invariants`, `abstraction`, `modelling`, `definition-exploration`, `generalization`, `transfer`, `representation-switching`, `error-recovery`, `case-analysis`, `strategic-simplification`.

Skill evidence weights are intentionally ordinal:

- `secondary`
- `supporting`
- `primary`

Do not invent decimal weights. A later recommender may map these to numbers internally, but the authored contract should remain interpretable.

## Canonical prerequisite concepts

Use these exact values:

`arithmetic`, `algebraic-manipulation`, `equations-inequalities`, `polynomial-factorization`, `functions-graphs`, `sequences-series`, `exponentials-logarithms`, `trigonometric-identities`, `coordinate-geometry-basics`, `euclidean-geometry-basics`, `differentiation`, `integration`, `limits-continuity`, `induction`, `contradiction`, `divisibility`, `modular-arithmetic`, `prime-factorization`, `counting-principles`, `binomial-coefficients`, `basic-probability`, `conditional-probability`, `expectation`, `graph-basics`, `set-notation`, `logical-quantifiers`.

This vocabulary is intentionally school/interview-level. Extend the taxonomy version rather than inserting free-form prerequisite strings.

## Stage roles

Use these exact roles:

1. `warm-up`
2. `technique-check`
3. `core`
4. `deep-dive`
5. `transfer`
6. `stretch`

A family does not need all six roles. Every authored family must contain at least one `core` stage. A stage may group multiple reasoning milestones, including alternative approaches at the same interview depth.

The stage graph uses `prerequisiteStageIds`. It must be acyclic, and any reasoning-milestone dependency crossing stages must be represented by reachability in the stage graph.

## Internal Oxford-anchored difficulty

This is **not an official Oxford score**.

Use the ordered internal bands:

1. `warm-up`
2. `introductory`
3. `introductory-plus`
4. `standard`
5. `strong`
6. `stretch`

Every authored family records:

- `entry`: barrier to productively start;
- `core`: difficulty of the central interview work;
- `ceiling`: deepest intended extension;
- `confidence`: `low`, `medium`, or `high`.

Validation requires `entry <= core <= ceiling`. Each stage also has its own difficulty, constrained to the family entry/ceiling range. At least one `core` stage must match the family core difficulty.

Do not replace this profile with one scalar. Existing `InterviewProblem.interviewer.difficulty` remains a legacy display/provider field; recommendation/calibration agents should use `oxfordAdaptive.difficulty`.

## Timing estimates

Timing is backend-only and initially represents expert estimates, not measured truth.

Every authored problem and stage records:

- `firstMeaningfulInsightMinutes: { min, max }`
- `independentCompletionMinutes: { min, max }`
- `promptedCompletionMinutes: { min, max }`
- optional `optionalExtensionMinutes: { min, max }`
- `softCutoffMinutes`
- estimate `confidence`: `low`, `medium`, or `high`

Ranges must be finite and nonnegative, with `min <= max`. The soft cutoff cannot precede the earliest first-insight estimate.

Do not assume prompted time must always be numerically below independent time; intervention can change pacing in nontrivial ways.

## Problem/stage/milestone skill attribution

Skill evidence exists at three levels:

- problem: broad competency signal of the family;
- stage: competency signal of a coherent interview phase;
- milestone: the grounded evidence attribution point.

Every authored reasoning milestone must be assigned to exactly one stage. Every reasoning-graph extension must also be assigned to exactly one stage through `extensionIds`. Milestone skills must be declared at stage level, and stage skills must be declared at problem level.

This is the intended Wave 2 evaluation seam:

`MilestoneEvaluation.milestoneId -> oxfordAdaptive.stages[].milestones[].milestoneId -> canonical skill evidence`.

Only grounded milestone evidence should update competency estimates. A problem merely being shown is not evidence of skill.

## Novelty, abstraction, and definitions

Authored families record problem-level:

- `novelty`: `low | moderate | high`
- `abstraction`: `low | moderate | high`
- `introducesNewDefinition`: boolean

Each stage records the same qualitative information. The problem-level definition flag must agree with whether any stage introduces a definition.

These are coarse descriptors for sequencing, not psychometric scores.

## Family and similarity identity

- `familyId`: stable lowercase kebab-case identity for the underlying interview problem family.
- `similarityClusterId`: optional lowercase kebab-case identity grouping families that are near-duplicates or structurally too similar for close repetition.

Different variants may share a `familyId`. Different families may share a `similarityClusterId`.

Future recommendation should use these identities to avoid recent repetition while keeping an individual interview coherent.

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

Optional `referenceFamilyId` is an internal canonical identifier only. **Do not store copied benchmark/source wording, copyrighted source text, or solution text in provenance metadata.**

Review statuses:

- `unreviewed`
- `in-review`
- `approved`
- `changes-required`

Tracked independently for:

- taxonomy classification;
- originality;
- Oxford fidelity;
- mathematical correctness.

Calibration statuses:

- `unreviewed`
- `expert-estimate`
- `empirically-calibrated`

Tracked independently for difficulty and timing.

Do not mark review fields `approved`, confidence `high`, or calibration `empirically-calibrated` unless that review/calibration actually occurred.

## Compatibility/migration

Existing Oxford problems do not need to be rewritten immediately.

When an existing Oxford `CuratedProblemSpec` omits `oxfordAdaptive`, authoring attaches a `provisional-legacy` record with:

- family ID equal to the existing problem ID;
- no domains;
- no prerequisite concepts;
- no skill weights;
- no stages;
- no difficulty/timing estimates;
- novelty/abstraction/definition status unknown;
- legacy/unknown provenance;
- every review/calibration state unreviewed.

This is deliberate. It preserves current behavior without fabricating metadata.

A `provisional-legacy` record is not recommendation-ready.

## Validation guarantees

The metadata integrity layer rejects:

- tags outside the canonical taxonomy;
- duplicate stage IDs;
- duplicate skill attribution;
- invalid evidence weights;
- unknown stage prerequisites;
- self-dependencies and cyclic stage graphs;
- unknown reasoning milestones or extensions;
- milestones/extensions assigned to multiple stages;
- authored milestones/extensions left unassigned;
- stage graphs that fail to preserve cross-stage reasoning dependencies;
- stage domains/skills not declared at family level;
- impossible timing ranges;
- soft cutoffs before the first-insight range;
- invalid difficulty ordering;
- core difficulty inconsistent with core stages;
- inconsistent new-definition flags;
- invalid provenance/review/calibration state;
- inferred claims inside `provisional-legacy` records;
- Oxford metadata on QUANT problems.

Existing problem integrity continues to enforce duplicate problem IDs/versions, reasoning graph validity, broken reasoning prerequisites, protected disclosure ownership, disclosure references, and other current invariants.

Because adaptive metadata is catalog-only, it does not alter provider context fingerprints. The strict public-view schema also rejects an `oxfordAdaptive` field.

---

# Wave 2 handoff

## Exact tags you must use

Use only the canonical domain, skill, prerequisite, stage-role, difficulty, provenance, review, and calibration values listed above. Import the exported constants/types instead of retyping strings where practical.

Do not add free-form tags to `oxfordAdaptive`.

## Exact required metadata for every new Oxford family

New Oxford authoring should set `oxfordAdaptive.status = "authored"` and provide:

- schema/taxonomy versions;
- `familyId`;
- optional `similarityClusterId` when a real near-duplicate cluster exists;
- one or more canonical `domains`;
- canonical `prerequisiteConcepts` (empty is allowed when genuinely none);
- problem-level `skillEvidence`;
- difficulty `entry/core/ceiling/confidence`;
- full problem-level timing estimate;
- problem novelty, abstraction, and definition flag;
- provenance and all review/calibration fields;
- one or more stages, including a `core` stage;
- for every stage: role, prerequisite stages, domains, skill evidence, difficulty, timing, novelty, abstraction, definition flag, and `extensionIds`;
- every reasoning milestone and reasoning-graph extension assigned exactly once to a stage;
- milestone-level skill evidence.

Keep the existing curated fields too: problem ID/version, prompt/givens, approaches, reasoning milestones/edges, errors, extensions, five-stage disclosure-aware hints, solution, verification notes, catalog title/category/follow-ups, and existing review status.

## Fields that may honestly remain provisional

These may begin conservatively:

- difficulty/timing confidence: normally `low` before expert calibration;
- originality/fidelity/correctness/taxonomy review: `unreviewed` or `in-review` until actually reviewed;
- difficulty/timing calibration: `expert-estimate` only when someone has actually made an expert estimate; otherwise `unreviewed`;
- `similarityClusterId`: omit when no justified cluster is known;
- `referenceFamilyId`: omit when there is no benchmark/reference family.

For a migrated existing fixture with no reviewed metadata, leave the entire record `provisional-legacy`; do not partially guess it.

## What you must not invent

- an “official Oxford difficulty score”;
- decimal skill weights or fake psychometric precision;
- `high` confidence without evidence;
- `approved` reviews that did not happen;
- `empirically-calibrated` status without usage calibration;
- source/reference text copied from real interview questions;
- a near-duplicate cluster just because two problems share a broad domain;
- solution-sensitive tags in public/student views;
- a second problem/session/evaluation state machine.

## How to add a new problem family correctly

1. Author through the existing curated problem path.
2. Choose a stable `familyId`; choose `similarityClusterId` only if justified.
3. Select canonical domains/prerequisites/skills from the exported taxonomy.
4. Build the reasoning graph and protected hint/disclosure structure as today.
5. Partition the reasoning milestones and extensions into coherent interview stages.
6. Add stage dependencies that preserve any cross-stage milestone dependencies.
7. Add problem/stage/milestone skill evidence using only `secondary/supporting/primary`.
8. Add internal entry/core/ceiling difficulty plus stage difficulty; start confidence conservatively.
9. Add timing ranges and soft cutoffs at problem and stage level; start confidence conservatively.
10. Record provenance without source text and set review/calibration states truthfully.
11. Keep new content in `expert-review` until the existing editorial/correctness process says it is ready.
12. Run the problem-bank and Oxford adaptive metadata integrity tests before merging.

The next recommender/evaluation wave should consume this contract rather than alter it ad hoc.
