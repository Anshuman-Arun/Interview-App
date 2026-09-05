# Oxford Student Profile and Between-Interview Recommendation Engine

Agent F — Fourier

This module implements the deterministic Oxford Mathematics adaptation path:

```
authoritative session history
-> grounded session evaluation
-> canonical Oxford milestone/stage join
-> derived competency profile with uncertainty
-> recommendation-ready metadata filtering
-> deterministic next-family ranking
```

It does **not** mutate authoritative history, alter the live interview state machine, choose curriculum through an LLM, or expose backend-only Oxford metadata to candidate-facing views.

## Authority boundary

The profile is a derived read model. Its inputs are:

- grounded `SessionEvaluation` results;
- the exact problem/version metadata used by that session;
- optional explicit authoritative process relationships.

The projector never rewrites session events or treats its own estimates as historical truth.

Problem eligibility is fail-closed through the canonical `isOxfordRecommendationReady(...)` helper. The recommender does not reconstruct that readiness contract.

Wave 2 reviewer artifacts from G/Gauss, H/Hilbert, and I/Itô are **evidence packets**, not runtime approval. A JSON review record can exist and even recommend approval while the branch-local canonical problem metadata remains unapproved. Fourier never consumes those records as an admission override: the selectable pool changes only when the canonical metadata itself satisfies `isOxfordRecommendationReady(...)`.

## Competency layers

The profile retains all canonical taxonomy members so an unseen competency is represented explicitly rather than disappearing from the model.

It tracks independently:

1. canonical broad mathematical domains;
2. canonical `contentConcepts`;
3. canonical reasoning/interview skills.

For each competency the read model exposes:

- `estimatedStrength`;
- confidence and uncertainty;
- accumulated evidence weight/count;
- exposure count;
- recent grounded evidence;
- trend;
- last-practiced time.

`estimatedStrength: null` means there is no grounded evidence. It never means zero ability.

Assistance exposure, independent-work evidence, guided-adaptation evidence, and error-recovery evidence are retained separately. Needing assistance does not itself prove poor guided adaptation, and using a hint does not itself prove guided adaptation.

## Conservative evidence update math

The numbers are heuristic indices, not psychometric probabilities. Strength is not a probability that a candidate "knows" a topic, confidence is evidence sufficiency for this derived heuristic rather than statistical confidence, and uncertainty is a conservative lack-of-evidence signal rather than a posterior variance. Low-evidence competencies therefore remain uncertainty-heavy.

For grounded observation (i):

```
effectiveWeight_i
  = authoredWeight_i
  * supportWeight_i
  * assistance/stageWeight_i
  * recencyWeight_i
```

Support multipliers are:

| Support | Multiplier |
| --- | ---: |
| STRONG | 1.00 |
| MODERATE | 0.70 |
| WEAK | 0.35 |
| INSUFFICIENT | 0.00 |

Author-declared reasoning-skill weights are:

| Skill evidence weight | Multiplier |
| --- | ---: |
| primary | 1.00 |
| supporting | 0.72 |
| secondary | 0.50 |

Domain evidence derived from a fine-content milestone receives an additional 0.82 multiplier so the broader claim is weaker than the directly tagged content claim.

### Achievement and assistance

Grounded milestone achievement has outcome:

```
achievementOutcome = clamp(0.86 - 0.055 * assistanceLevel, 0, 1)
```

Its update weight is additionally multiplied by:

```
assistanceWeight = clamp(1 - 0.07 * assistanceLevel, 0.65, 1)
```

This deliberately distinguishes independent and heavily assisted achievement without treating assistance as failure.

### Non-achievement and stretch protection

Non-achievement contributes only when the milestone itself has non-insufficient support **and** grounded evidence references.

Negative evidence is deweighted by stage role:

| Stage | Weight | Outcome |
| --- | ---: | ---: |
| warm-up | 1.00 | 0.25 |
| technique-check | 0.95 | 0.28 |
| core | 0.90 | 0.32 |
| deep-dive | 0.65 | 0.38 |
| transfer | 0.55 | 0.42 |
| stretch | 0.30 | 0.48 |

Thus failure on a stretch extension is weak evidence about underlying competency and cannot erase a long record of strong foundational performance.

### Recency

Evidence decays gradually with a 180-day half-life and a floor of 0.35:

```
recencyWeight
  = max(0.35, 0.5 ^ (ageDays / 180))
```

Old history therefore matters less but never disappears abruptly.

### Aggregation

For non-empty grounded evidence:

```
strength
  = (0.60 * 1.25 + sum(outcome_i * effectiveWeight_i))
    / (1.25 + sum(effectiveWeight_i))

confidence
  = 1 - exp(-sum(effectiveWeight_i) / 3)

uncertainty
  = 1 - confidence
```

The 0.60/1.25 prior is deliberately modest. It prevents one observation from producing extreme estimates, while missing evidence still remains `null` rather than becoming 0.60.

Trend is emitted only after at least four grounded observations. The two most recent observations are compared against up to three preceding observations; changes below 0.08 remain `STABLE`.

## Milestone-grounded versus process-grounded skills

The projector follows the frozen Agent A evidence-basis contract.

### Milestone-grounded

A reasoning skill receives milestone evidence only when:

- canonical milestone metadata explicitly tags that skill;
- the grounded evaluator supports that milestone;
- the milestone is joined through the exact canonical stage/milestone metadata.

Process-grounded skills are skipped even if they appear at problem/stage level.

### Error recovery

`error-recovery` is process-grounded.

Two safe paths exist:

1. an explicit authoritative relationship:
   - grounded error/failed approach;
   - later grounded recovery/progress;
   - valid authoritative ordering;
2. the existing deterministic session evaluator's grounded `errorRecovery` dimension, which already derives its result from authoritative evidence-history error -> later recovery transitions.

Malformed or unordered explicit relationships contribute no evidence.

### Guided adaptation

`guided-adaptation` is also process-grounded.

It requires an explicit authoritative relationship:

```
intervention/hint/reframing/new idea
-> later grounded progress
-> evidence that the later progress incorporated the intervention
```

The current `SessionEvaluation.hintResponsiveness` field is **not** converted into guided-adaptation evidence. Existing session state cannot safely prove exposure-before-progress ordering or that later progress used the intervention. Until such a relationship is available, the competency remains uncertain.

This is an integration seam, not a taxonomy blocker.

## Replay and double counting

Sessions are deduplicated by authoritative session ID.

- identical replayed session evidence is counted once;
- conflicting evidence for the same session ID throws;
- processing order does not affect the resulting competency estimates;
- exact problem ID/version remains present in profile history.

The new profile does not reinterpret the older replay layer's exact-problem improvement statistics as skill estimates.

## Recommendation hard filters

Candidates are filtered before ranking.

The engine rejects, as applicable:

1. non-Oxford Mathematics entries;
2. missing adaptive metadata;
3. provisional legacy metadata;
4. anything for which `isOxfordRecommendationReady(...)` is false;
5. explicitly unmet prerequisites;
6. exact recent repeats unless deliberately allowed;
7. recent family repeats;
8. recent similarity-cluster repeats;
9. candidates whose minimum prompted completion exceeds known available time;
10. large difficulty mismatch when the profile has sufficiently grounded ability evidence.

Unknown prerequisite status is not treated as unmet. It remains uncertainty and is exposed as a backend reason code.

Default cooldown windows are two recent interviews for exact problem/version, family, and similarity cluster.

## Ranking

Only eligible candidates are scored.

For established profiles:

| Factor | Weight |
| --- | ---: |
| appropriate challenge | 0.22 |
| content development | 0.17 |
| uncertainty / information gain | 0.17 |
| reasoning-skill development | 0.12 |
| spaced exposure | 0.10 |
| topic diversity | 0.08 |
| recent trajectory | 0.06 |
| calibration confidence | 0.05 |
| session fit | 0.03 |

The development terms are confidence-weighted around a neutral 0.5. Therefore uncertain competencies do not masquerade as weak ones; uncertainty is rewarded separately through information gain.

This prevents the recommender from simply hammering the lowest estimated skill.

Tie-breaking is deterministic:

1. higher score;
2. lexicographically smaller problem ID;
3. lexicographically smaller version.

No random selection is used.

The ranking score is a **heuristic priority index**, not a probability, expected success rate, calibrated utility, or statistical confidence. A score gap such as 0.712 versus 0.705 must not be presented as evidence that the first problem is meaningfully or measurably better. The factor breakdown exists for deterministic explainability and debugging, not inferential precision.

## Cold start

Cold start means there is no grounded competency evidence.

Cold-start scoring favors:

- accessible entry/core difficulty;
- broad diagnostic value;
- uncertainty reduction;
- calibration confidence;
- recent-topic diversity;
- reasonable session fit.

Weights are:

| Factor | Weight |
| --- | ---: |
| accessible challenge | 0.20 |
| information gain | 0.20 |
| diagnostic breadth | 0.16 |
| calibration | 0.16 |
| diversity | 0.12 |
| spacing | 0.08 |
| session fit | 0.08 |

If only one recommendation-ready candidate remains, it is returned rather than introducing randomness.

If **zero** candidates pass the canonical readiness gate, Fourier returns:

```
outcome: "NO_RECOMMENDATION_READY_CANDIDATES"
selected: undefined
recommendationReadyCandidateCount: 0
```

It does not fall back to author/expert-review candidates, branch-local G/H/I review records, provisional legacy, or an invented recommendation.

If one or more candidates are canonical-ready but every one is removed by prerequisite, cooldown, time, or difficulty filters, the distinct outcome is `NO_ELIGIBLE_CANDIDATES`. This keeps certification shortage separate from ordinary scheduling/suitability filtering.

## Output contract

The recommendation result contains:

- selected problem ID/version and family ID;
- deterministic score and factor breakdown;
- target domains, content concepts, and reasoning skills;
- estimated session fit;
- backend reason codes and explanation;
- relevant uncertainty;
- top alternatives;
- exclusion reasons, with hypothetical scores where safe to compute.

These are backend/integration objects. Candidate-facing views must not serialize backend-only difficulty, timing, reasoning-skill, provenance, calibration, solution, stage, or protected-disclosure metadata.

## Portfolio counts

The Wave 1/Agent B portfolio distribution is coverage planning data only.

It is **not** accepted as an input to the recommender and is never used as:

- observed Oxford frequency;
- a selection probability;
- a Bayesian prior;
- a ranking weight.

Tests explicitly verify that extraneous portfolio-count-shaped data cannot alter deterministic ranking.

### Wave 2 certification compatibility

At the current Wave 2 authoring heads inspected by Agent F — Fourier:

- C / Cantor contributes 20 author candidates;
- D / Dirichlet contributes 22 author candidates;
- E / Euler contributes 19 author candidates.

That is a temporary 61-family expert-review pool, but the author branches explicitly keep their canonical independent review/calibration gates non-ready. Fourier is intentionally mergeable before those branches finish certification: synthetic fixtures exercise admission and ranking without importing C/D/E branch-local files. When certification later lands in canonical metadata, the same readiness helper admits the newly approved families without a recommender-specific migration.

## Deferred integration

Intentionally deferred:

- UI recommendation widgets;
- automatic interview launch;
- live in-interview topic switching;
- persistence of the derived profile as authority;
- LLM-driven curriculum selection;
- bulk problem-bank authoring;
- inventing exposure/progress chronology for guided adaptation.

### Handoff — Agent F — Fourier

Later integration should construct `OxfordProfileSessionEvidence` from authoritative completed/archived Oxford sessions, their grounded `SessionEvaluation`, and the exact problem metadata snapshot/version. If a future event projection can prove ordered intervention -> incorporated progress, it should populate the explicit process relationship seam rather than teaching this projector to infer chronology from delivery counts or prose.
