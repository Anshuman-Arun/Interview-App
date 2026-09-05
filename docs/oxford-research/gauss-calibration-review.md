# Agent G — Gauss: Oxford taxonomy and calibration review

> **Agent:** G — Gauss  
> **Base:** `main` at `454a2fe993c8fd70676d04e5d262a1780161f0d6`  
> **Frozen contracts:** `oxford-adaptive-problem-contract.md` and Agent B's `docs/oxford-research` foundation  
> **Machine-readable audit:** `gauss-existing-bank-audit.json`

This document defines the independent Wave 2 review/calibration layer for Oxford family metadata. It does **not** create another taxonomy, another recommendation-readiness rule, or another problem model. The canonical Agent A metadata remains authoritative and the existing `isOxfordRecommendationReady` helper remains the only production eligibility gate.

## Review framework

The reusable implementation is `packages/problems/src/oxford-calibration-review.ts`. A Gauss review record independently records:

- the canonical broad domains, `contentConcepts`, prerequisites, reasoning skills, and milestone content/skill attribution;
- separate entry/core/ceiling difficulty recommendations;
- qualitative 0–3 worksheet ratings for Agent B's eight observable difficulty factors;
- stage difficulty reviews when authored stages exist;
- family/stage backend-only timing estimates;
- the evidence basis supporting a calibration status/confidence;
- migration disposition and blockers;
- explicit ownership boundaries leaving originality/fidelity to Agent H and mathematical correctness to Agent I.

The 0–3 factor ratings are review notes, **not** a new difficulty score. They are never summed to determine the band. They expose why two families with the same ordinal band can still feel very different.

### Taxonomy checklist

For each reviewed family:

1. Use only Agent A's frozen domains, content concepts, prerequisites, skills, and stage roles.
2. Treat prerequisites as knowledge assumed without teaching.
3. Treat content concepts as mathematical content actually exercised/measured.
4. Treat reasoning skills as a separate evidence axis.
5. Require every reviewed content concept to have a declared canonical parent domain.
6. Attribute milestone content only when completing that milestone can ground evidence about that content.
7. Never attribute `guided-adaptation` or `error-recovery` to a milestone. They remain process-grounded.
8. If a family is awkward to classify, flag a schema blocker instead of inventing a tag.

**Result for the existing bank:** no true frozen-taxonomy blocker was found. Some families require broad canonical labels rather than author-specific micro-topics; that is expected.

### Difficulty checklist

Calibrate `entry`, `core`, and `ceiling` separately using:

- prerequisite burden;
- initial insight barrier;
- conceptual jumps;
- abstraction;
- proof/rigor burden;
- representation changes;
- productive prompt dependency;
- extension ceiling.

The framework requires `entry <= core <= ceiling`, stage bands inside the family range, and a reviewed core stage matching family core whenever stage assessments are present. An optional stretch branch does not inflate the entry/core.

### Timing checklist

The only reliable Oxford anchor used here is the whole-interview scale: about 25 minutes for Maths and a typical 20–30 minute range in the prospectus. Per-stage timing remains an internal estimate.

Every reviewed estimate considers:

- time to first meaningful insight;
- independent completion range;
- prompted completion range;
- optional extension range;
- soft cutoff / natural transition point.

The review helper adds conservative sanity checks: a soft cutoff cannot precede the upper end of the first-insight estimate, and completion ranges cannot begin before the earliest plausible first insight. These checks do not turn timing into runtime control. Interview transitions remain mathematically driven.

## Calibration confidence and status

The framework preserves Agent A's statuses:

- `unreviewed`
- `expert-estimate`
- `empirically-calibrated`

It also records the evidence behind a claim:

- `expert-judgment`
- `independent-expert-agreement`
- `empirical-distribution`

A single expert judgment may support an `expert-estimate`, normally at low/medium confidence. It may **not** support `high` confidence. `high` requires at least independent expert agreement or empirical evidence.

`empirically-calibrated` is rejected unless actual usage-distribution evidence is recorded with a positive sample size, conditioning axes, and a distribution summary. Merely running a problem several times or having an author feel confident is not empirical calibration.

## Existing-bank audit

All current Oxford entries are still `provisional-legacy` in the adaptive contract because their curated specs do not yet author `oxfordAdaptive`. The audit therefore records independent **proposals** without mutating them or making them recommendation-ready.

| Family ID | Gauss difficulty (entry / core / ceiling) | Disposition | Migration view |
| --- | --- | --- | --- |
| `oxford-domino-chessboard` | introductory / standard / strong | retain legacy | famous classic benchmark |
| `oxford-divisors-square-parity` | introductory / introductory-plus / standard | safe for later calibration | migrate after H/I |
| `oxford-euclid-primes` | introductory / introductory-plus / standard | retain legacy | canonical classic |
| `oxford-nested-radical-sequence` | introductory-plus / standard / strong | safe for later calibration | migrate after H/I |
| `oxford-monotone-cauchy` | introductory-plus / strong / stretch | needs revision | repair Hamel-basis extension first |
| `oxford-even-odd-degrees` | introductory / introductory-plus / standard | needs revision | repair Euler-trail extension first |
| `oxford-divisibility-chain` | introductory-plus / standard / strong | needs revision | repair poset extension first |
| `oxford-continuous-fixed-point` | introductory / introductory-plus / standard | needs revision | repair Brouwer extension first |
| `oxford-prefix-sums-mod-n` | introductory-plus / standard / strong | needs revision | make cyclic extension determinate first |
| `oxford-triangle-medians` | introductory / standard / strong | needs revision | remove/self-contain mass-points route first |
| `oxford-catalan-paths` | standard / strong / stretch | needs revision | resolve existing expert-review issue first |
| `oxford-six-people` | introductory / standard / strong | retain legacy | famous Ramsey classic |
| `oxford-hilbert-hotel` | warm-up / introductory / strong | retain legacy | famous conceptual classic |
| `oxford-prisoner-hats` | standard / strong / stretch | retain legacy | highly circulated parity puzzle |

“Safe for later calibration” means the current family plus Gauss taxonomy/difficulty/timing proposal has no known authoring blocker from the independent reviews inspected so far. It does **not** mean recommendation-ready and does not approve Agent H/I fields. “Needs revision” may still have a sound core calibration; it means a declared route/extension must be repaired before migration.

### Major disagreements with legacy single labels

- **`oxford-continuous-fixed-point`:** `standard-oxford` is too high as a family-wide/core label when IVT is explicitly allowed. Gauss recommends introductory entry, introductory-plus core, standard ceiling.
- **`oxford-monotone-cauchy`:** `stretch-oxford` describes the ceiling better than the entry. Integer/rational consequences are accessible; the rational-to-real bridge is strong and the pathology extensions are stretch.
- **`oxford-catalan-paths`:** the complete two-route treatment is stretch, but entry is better described as standard and the primary core as strong.
- **`oxford-six-people`:** the statement is accessible, but the Ramsey/pigeonhole reduction is a real structural step; core is standard rather than introductory.
- **`oxford-prisoner-hats`:** the parity communication invariant is a substantial insight; core is strong and the multi-colour generalization supports stretch.

Timing ranges and milestone-level classifications are retained in the JSON audit rather than duplicated here.

## Fields reviewed vs intentionally pending

Gauss independently reviewed/proposed:

- taxonomy classification;
- milestone content/skill attribution;
- difficulty profile and factor rationale;
- timing profile and rationale;
- calibration status/confidence support;
- migration disposition.

Gauss intentionally leaves pending:

- originality approval — **Agent H**;
- Oxford fidelity approval — **Agent H**;
- mathematical correctness approval — **Agent I**;
- recommendation readiness until all Agent A gates are satisfied.

The framework hard-codes those ownership boundaries in review records so a Gauss artifact cannot masquerade as H/I approval.

## Agent C/D/E cross-review

The initial/pre-PR snapshots found no author PRs, but a later sweep after PR #130 opened found all three required author branches. Gauss therefore reviewed a representative **six-family batch** against the actual PR heads and recorded machine-readable findings in `gauss-cross-agent-review.json`:

- **Agent C — Cantor, PR #132** at `c0140b480ca3d40e7bdc9e9ee6fdddbb18b201c9`
  - `oxford-cantor-cubic-divided-difference`
  - `oxford-cantor-reciprocal-increment-recurrence`
- **Agent D — Dirichlet, PR #133** at `017759febfd7d49ea032d6474bcc9177a76b2c2b`
  - `oxford-d-gcd-descent-network`
  - `oxford-d-triple-flip-circle`
- **Agent E — Euler, PR #134** at `a18db48700800c1987e2abd43726254ba25267dd`
  - `oxford-euler-circle-sweep`
  - `oxford-euler-self-averaging-sets`

This is a representative batch rather than an attempt to rubber-stamp all 61 newly authored families.

### Cross-agent findings

**Cantor (#132).** The authoring structure is the closest of the three to calibratable as-is because timing is per-family rather than copied from a generic table. The two high-risk families reviewed still have soft cutoffs extending beyond the public whole-interview anchor. For `cubic-divided-difference`, Gauss keeps introductory-plus entry and strong core but lowers the ceiling from stretch to strong; the extensions deepen the same mechanism rather than introducing a new stretch-level barrier. For `reciprocal-increment-recurrence`, the authored difficulty profile is retained, but timing is shortened to a ~25-minute natural transition. In both families, `guided-adaptation` remains process-grounded only and is not accepted as milestone evidence.

**Dirichlet (#133).** The shared authoring helper assigns the exact same `WHOLE_TIMING` and opening/core/transfer `STAGE_TIMING` objects to all 22 candidates. That is a planning default, not calibration; no Dirichlet family should receive `timingCalibration` approval from those values. The reviewed `gcd-descent-network` is materially faster/easier than the template and is calibrated introductory / standard / standard. The reviewed `triple-flip-circle` is materially harder than its authored standard core: the mod-2 encoding, period-three recurrence, cyclic closure, invariant and image-size sufficiency form a strong core. It also directly measures `recurrence-structure`, so Gauss adds the existing `sequences-recurrences` / `recurrence-structure` taxonomy rather than inventing a new tag.

**Euler (#134).** All 19 candidates share one `FAMILY_TIMING` and one five-position `STAGE_TIMING` table, so those values likewise remain author planning estimates rather than calibratable family timing. The helper also derives the `core` role mechanically as the first interior stage whose difficulty equals the author family core. That can put the core on setup rather than the substantive mathematical development. For `circle-sweep`, the coordinate circle equation is a technique check; the parameter-existence test is the strong core. For `self-averaging-sets`, encoding the affine map is setup; the finite permutation plus strict-contraction argument is the strong core. The latter is also better classified with the frozen `set-theory` / `set-maps` concepts than with `combinatorics` / `counting-structure`; no taxonomy expansion is needed.

All six reviewed author families are marked `needs-revision` in the Gauss cross-agent record before calibration approval. This does **not** mean the mathematical families should be rejected. It means their authored taxonomy/difficulty/timing fields do not yet match the independent Gauss review.

A concurrent correctness review, **Agent I — Itô PR #128**, had previously handed prerequisite/solvability findings to Gauss in **issue #129**. Gauss incorporated only the calibration-relevant consequences from that handoff and did not inherit Itô's correctness statuses.

Author branches were not modified and Gauss does not self-merge them.

## Future empirical-calibration plan

An `expert-estimate` can be created from an actual independent review, but empirical upgrade requires real interview usage data tied to the exact problem/version/family/stage. The later calibration pipeline should retain distributions rather than collapse everything to one average.

For timing, collect at minimum:

- first meaningful insight time;
- independent/prompted completion time;
- extension time when reached;
- stage reached and natural stopping point;
- assistance/intervention history;
- a defensible candidate-strength stratum or proxy;
- censored/unfinished observations rather than treating them as slow completions.

For difficulty, compare observed progress/support distributions against the authored entry/core/ceiling profile and the qualitative factor rationale. Missing observations remain uncertainty rather than weakness.

Empirical analysis should:

1. condition distributions on candidate strength, assistance history, and stage reached;
2. report quantiles/ranges and uncertainty, not only means;
3. retain exact family/problem versions so authoring changes do not silently pool incompatible data;
4. check stability across repeated cohorts and reviewers;
5. record sample size and the actual distribution summary used for the status upgrade;
6. avoid a fabricated universal minimum-N rule—the evidence must be sufficient for stable estimates in context;
7. keep timing advisory and mathematically natural; no empirical fit should become a hard hint/transition timer.

Only after actual distributions exist should either field become `empirically-calibrated`. High confidence should remain conservative even then.

## Handoff to F and integration

Agent F should consume the canonical Agent A metadata and readiness helper, not the Gauss worksheet scores. Gauss records can support editorial review and explain why a field is or is not calibrated; they are not candidate-visible signals and are not recommendation weights.

For a migrated family:

1. an author supplies complete canonical `oxfordAdaptive` metadata;
2. Gauss review/checker confirms the authored taxonomy/difficulty/timing claims match an independent review record;
3. H and I complete their owned approvals;
4. only the existing `isOxfordRecommendationReady` helper decides eligibility.

No difficulty, timing, skill, provenance, or solution-sensitive Gauss material belongs in the candidate-facing problem view.
