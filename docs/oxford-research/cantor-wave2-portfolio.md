# Agent C — Cantor Wave 2 completion portfolio

**Status:** author-side completion pass for PR #132. The surviving families remain expert-review only. This document records author repairs and independent-review inputs; it does not self-approve any G/H/I gate.

The original batch contained **20** analytical / graphical Oxford Mathematics candidates. After Agent H — Hilbert's full five-pool audit, the completion portfolio contains **17 surviving families**, **3 removed families**, and **no replacements**.

## Final removals

Removed for Hilbert originality `REJECT_TOO_CLOSE`:

1. `oxford-cantor-tangent-intersection-locus`
2. `oxford-cantor-line-envelope`
3. `oxford-cantor-reciprocal-implicit-curve`

No rejected kernel was cosmetically mutated and no replacement family was introduced.

The reciprocal implicit curve was mathematically corrected and independently correctness-approved by Agent I — Itô before Hilbert's later full audit. The corrected origin/nonzero-branch distinction was not regressed; the family was subsequently removed solely because the independent originality gate rejected the kernel.

## Review findings applied

### Agent H — Hilbert

Hilbert's full five-pool certification at Cantor head `f577c1a78ae9c8f801fc4c6e0ced46efb330a3b1` reviewed all 18 then-surviving families. The later `reciprocal-implicit-curve` hard reject is now removed, leaving 17.

Provenance / originality repairs retained:

- `oxford-cantor-moving-v-envelope`: the Huber/Moreau relationship is explicit and it is never claimed independent-original. The frozen schema requires `structural-adaptation` to name a reference family ID; because this is an external classic construction rather than an internal reference family, current metadata uses `classic-problem / classic-mathematics`. This exact schema-compatible provenance should be re-pinned by Hilbert.
- `oxford-cantor-exponential-rotating-line`: `classic-problem / secondary-reference`.
- `oxford-cantor-cubic-divided-difference`: `classic-problem / secondary-reference`.
- `oxford-cantor-mobius-recurrence`: `classic-problem / secondary-reference`.
- `oxford-cantor-squared-error-recurrence`: `classic-problem / secondary-reference`.
- `oxford-cantor-three-cycle-map`: `classic-problem / secondary-reference`.
- `oxford-cantor-reciprocal-increment-recurrence`: `classic-problem / secondary-reference`.

Hilbert repetition-control recommendations are now represented through the existing `similarityClusterId` field:

- `cantor-cubic-graph-structure`: cubic two-thresholds, cubic divided-difference, shifted cubic intersections.
- `mobius-iteration`: Möbius recurrence, three-cycle map, Möbius involution.
- `cantor-reciprocal-symmetry`: reciprocal-root parabolas, reciprocal-paired inputs.
- `parameter-envelope`: retained historically on moving-V after the rejected line-envelope family was removed.

### Agent G — Gauss

Gauss completed 18/18 taxonomy/timing review on the pre-final-pruning head and identified one remaining difficulty change. It is now applied:

- `oxford-cantor-cubic-two-thresholds`: **introductory-plus / strong / strong**.
- `oxford-cantor-cubic-divided-difference`: **introductory-plus / strong / strong**.
- `oxford-cantor-reciprocal-increment-recurrence`: **introductory-plus / strong / stretch**.

All surviving families keep family-specific low-confidence timing profiles with whole-family soft cutoffs in the **20–25 minute** range. Optional extension time is separate and is not assumed to be reached.

The reciprocal-increment family now explicitly supplies a sum–integral comparison; lack of prior exposure to a harmonic/logarithmic comparison is not treated as weakness.

### Agent I — Itô

Itô independently correctness-reviewed all 18 then-surviving families at the prior current-version head. The completion pass after that review does not introduce a new mathematical kernel.

The Möbius transfer prompt still defines self-inverse directly as `S(S(x))=x`.

The only candidate-visible wording change after Itô's full pass is the reciprocal-increment guidance making the already-used sum–integral comparison explicit in words. Agent I should re-pin that wording/current head before graduation.

## Portfolio shape

- **17** surviving families.
- **13/17** declare `graph-sketching`.
- **16/17** use the `functions` domain; reciprocal-increment recurrence is the exception.
- Three nonlinear recurrence families retain distinct mechanisms: reciprocal-error linearization, exact error squaring, and nearly telescoping squared growth.
- Every survivor has five protected hint stages, five reasoning milestones, two extensions, a canonical solution, verification notes, and low-confidence author timing/difficulty estimates.
- Main asked-for mathematics is assigned to `core`; milestone five is transfer/deepening rather than an accidentally deferred core result.
- `guided-adaptation` / `error-recovery` remain process-grounded and are never milestone-completion evidence.

## Final surviving inventory

| # | Family | Main mathematical kernel | author risk notes |
|---:|---|---|---|
| 1 | `oxford-cantor-moving-v-envelope` | constrained parameter minimization / Huber-Moreau envelope | classic provenance; H re-pin exact encoding |
| 2 | `oxford-cantor-reciprocal-root-parabolas` | reciprocal roots -> vertex locus | reciprocal-symmetry repetition |
| 3 | `oxford-cantor-cubic-two-thresholds` | distinct discriminant thresholds for extrema and roots | cubic repetition cluster |
| 4 | `oxford-cantor-cubic-divided-difference` | divided-difference quadratic / equal-height preimages | classic provenance; cubic repetition |
| 5 | `oxford-cantor-integral-sign-landscape` | accumulation-function sign landscape | no known author blocker |
| 6 | `oxford-cantor-reciprocal-paired-inputs` | reciprocal equal-output pairing | reciprocal-symmetry repetition |
| 7 | `oxford-cantor-exponential-rotating-line` | `e^x=ax` threshold | classic provenance |
| 8 | `oxford-cantor-mobius-recurrence` | reciprocal-error conjugacy to translation | classic provenance; Möbius repetition |
| 9 | `oxford-cantor-squared-error-recurrence` | exact error squaring | classic provenance |
| 10 | `oxford-cantor-absolute-quadratic-crossings` | folded quadratic level counts | no known author blocker |
| 11 | `oxford-cantor-radical-asymptote` | rationalization + domain bifurcation | calibration-sensitive |
| 12 | `oxford-cantor-shifted-cubic-intersections` | translated cubic difference -> quadratic | cubic repetition cluster |
| 13 | `oxford-cantor-moving-integral-window` | variable-limit integral window | no known author blocker |
| 14 | `oxford-cantor-three-cycle-map` | exact period-three fractional map | classic provenance; Möbius repetition |
| 15 | `oxford-cantor-quartic-horizontal-levels` | double-well quartic level counts | no known author blocker |
| 16 | `oxford-cantor-reciprocal-increment-recurrence` | squared increments -> `sqrt(2n)` asymptotic | classic provenance; stretch core |
| 17 | `oxford-cantor-mobius-involution` | symmetric hyperbola -> self-inverse map | Möbius repetition |

## Timing completion pass

| Family | soft cutoff |
|---|---:|
| moving V envelope | 24 |
| reciprocal-root parabolas | 23 |
| cubic two thresholds | 24 |
| cubic divided difference | 24 |
| integral sign landscape | 24 |
| reciprocal paired inputs | 22 |
| exponential / line | 21 |
| Möbius recurrence | 23 |
| squared-error recurrence | 21 |
| absolute quadratic crossings | 20 |
| radical asymptote | 25 |
| shifted cubic intersections | 23 |
| moving integral window | 23 |
| three-cycle map | 21 |
| quartic horizontal levels | 22 |
| reciprocal-increment recurrence | 25 |
| Möbius involution | 24 |

All timing confidence remains `low` on the author entries.

## Author-side all-family audit

Every current survivor was rechecked for:

- complete candidate-visible statement and explicit parameter domain where needed;
- non-spoilery title;
- coherent Oxford opening/core/transfer progression;
- canonical frozen domains/content concepts/prerequisites/reasoning skills;
- family-level containment of all milestone skill/content evidence;
- no process-grounded milestone-completion evidence;
- realistic difficulty barriers rather than stage-position inflation;
- family-specific interview-scale timing;
- truthful provisional provenance and repetition clustering.

No known author-side blocker remains after the third Hilbert hard reject was pruned and Gauss's final difficulty correction was applied.

## Independent review state / final requested re-pin

The author branch intentionally leaves canonical adaptive review fields unreviewed. `isOxfordRecommendationReady(...)` must remain false until independent certification is materialized through the authoritative review path.

### Agent C — Cantor -> Agent G — Gauss

Review **every surviving Cantor family not yet fully calibrated**, including any materially changed family previously reviewed. In particular, re-pin the 17-family current head after the cubic-two-threshold core correction and final pruning.

### Agent C — Cantor -> Agent H — Hilbert

Run the full five-pool originality/fidelity audit on **every surviving Cantor family not yet reviewed**, plus all materially revised provenance cases. Re-pin the current head after removal of `reciprocal-implicit-curve`, the schema-compatible moving-V provenance encoding, and the final similarity clusters.

### Agent C — Cantor -> Agent I — Itô

Independently verify **every surviving Cantor family not yet correctness-reviewed**, plus any family whose mathematical statement/solution/extensions materially changed. Re-pin the current head after final pruning and the reciprocal-increment guidance clarification.
