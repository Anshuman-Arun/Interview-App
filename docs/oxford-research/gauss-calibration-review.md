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
| `oxford-monotone-cauchy` | introductory-plus / strong / stretch | safe for later calibration | migrate after H/I |
| `oxford-even-odd-degrees` | introductory / introductory-plus / standard | retain legacy | canonical handshaking family |
| `oxford-divisibility-chain` | introductory-plus / standard / strong | safe for later calibration | migrate after H/I |
| `oxford-continuous-fixed-point` | introductory / introductory-plus / standard | safe for later calibration | migrate after H/I |
| `oxford-prefix-sums-mod-n` | introductory-plus / standard / strong | safe for later calibration | migrate after H/I |
| `oxford-triangle-medians` | introductory / standard / strong | safe for later calibration | migrate after H/I |
| `oxford-catalan-paths` | standard / strong / stretch | needs revision | resolve existing expert-review issue first |
| `oxford-six-people` | introductory / standard / strong | retain legacy | famous Ramsey classic |
| `oxford-hilbert-hotel` | warm-up / introductory / strong | retain legacy | famous conceptual classic |
| `oxford-prisoner-hats` | standard / strong / stretch | retain legacy | highly circulated parity puzzle |

“Safe for later calibration” means the taxonomy/difficulty/timing proposal is coherent enough to hand to a migration author. It does **not** mean recommendation-ready and does not approve Agent H/I fields.

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

Initial snapshot on 4 September 2026: no open PR whose title carried a required Agent C, Agent D, or Agent E marker was available. The Gauss PR is independently useful without those author branches.

Before final handoff, Agent G re-checks open C/D/E PRs. Any available family review is recorded by family ID and PR number here and in the PR body; author branches are never modified by Gauss.

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
