# Agent C — Cantor Wave 2 authoring portfolio

**Status:** author candidate batch only. Nothing in this document is an independent originality, Oxford-fidelity, mathematical-correctness, difficulty, or timing approval.

This batch contains **20** analytical / graphical Oxford Mathematics candidate families. They are registered only in the expert-review catalog. The default problem bank and recommendation-ready pool are unchanged.

## Portfolio shape

- **16/20** families declare `graph-sketching`, deliberately filling the Wave 1 portfolio's largest identified gap.
- **19/20** families use the `functions` domain; the exception is the asymptotic reciprocal-increment recurrence.
- **3** families are centered on nonlinear recurrences, with distinct mechanisms: reciprocal-error linearization, error squaring, and telescoping squared growth.
- The batch includes qualitative graph behavior, transformations, roots/intersections, asymptotics, extrema, parameter-dependent curves, composition/iteration, inverse reasoning, recurrence structure, convergence/monotonicity, inequalities, derivative structure, integral accumulation, and optimization.
- Reasoning coverage includes graph sketching, visualization, strategic simplification, conjecture formation, proof construction, representation switching, case analysis, precision checking, transfer, and generalization.
- `guided-adaptation` and `error-recovery` occur only as problem/stage process evidence. They are never milestone-completion evidence.
- Every family has five protected hint stages, five reasoning milestones, a genuine `core` stage, two authored extensions, a canonical solution, verification notes, and low-confidence author estimates for difficulty/timing.
- Similarity clusters are explicit where deliberate overlap exists:
  - `parameter-envelope`: moving V lower envelope + line upper envelope.
  - `mobius-iteration`: reciprocal-error Möbius recurrence + fractional-map iteration/involution material.

## Candidate inventory

| # | Family | Main mathematical kernel | Author risks (O/C/K) |
|---:|---|---|---|
| 1 | `oxford-cantor-moving-v-envelope` | constrained parameter minimization of moving absolute-value graphs | M / L / M |
| 2 | `oxford-cantor-reciprocal-root-parabolas` | reciprocal roots -> effective coefficient -> vertex locus | M / L / M |
| 3 | `oxford-cantor-cubic-two-thresholds` | distinct discriminant thresholds for extrema and roots | M / L / M |
| 4 | `oxford-cantor-cubic-divided-difference` | divided-difference quadratic classifies equal-height preimages | L / M / H |
| 5 | `oxford-cantor-integral-sign-landscape` | sketch accumulation function from factored derivative before integrating | M / L / M |
| 6 | `oxford-cantor-reciprocal-paired-inputs` | reciprocal input pairing + exact range + inverse branches | M / L / M |
| 7 | `oxford-cantor-tangent-intersection-locus` | fixed-gap parabola tangent intersections trace another parabola | **H** / L / M |
| 8 | `oxford-cantor-exponential-rotating-line` | root-count threshold for `e^x=ax` | **H / classic** / L / M |
| 9 | `oxford-cantor-mobius-recurrence` | reciprocal fixed-point error conjugates recurrence to translation | M / M / M |
| 10 | `oxford-cantor-squared-error-recurrence` | exact error squaring | **classic** / L / M |
| 11 | `oxford-cantor-absolute-quadratic-crossings` | fold quadratic and classify horizontal-level counts | M / L / M |
| 12 | `oxford-cantor-radical-asymptote` | rationalization + derivative-sign comparison + domain bifurcation | L / M / **H** |
| 13 | `oxford-cantor-shifted-cubic-intersections` | translated cubic difference collapses to quadratic | M / L / **H** |
| 14 | `oxford-cantor-moving-integral-window` | moving/dilating integral window + endpoint derivative | L / L / M |
| 15 | `oxford-cantor-reciprocal-implicit-curve` | isolated origin + reciprocal-coordinate circle + four outer branches | L / M / **H** |
| 16 | `oxford-cantor-three-cycle-map` | fractional-linear map with exact period three | **classic** / L / M |
| 17 | `oxford-cantor-quartic-horizontal-levels` | double-well quartic + quadratic in `x²` | M / L / M |
| 18 | `oxford-cantor-reciprocal-increment-recurrence` | nearly telescoping square increments -> `sqrt(2n)` asymptotic | L / M / **H** |
| 19 | `oxford-cantor-line-envelope` | pointwise maximum of a line family -> tangent parabola envelope | **H** / L / M |
| 20 | `oxford-cantor-mobius-involution` | symmetric implicit hyperbola -> involution + exceptional degeneration | M / M / **H** |

Risk legend: **O** = originality, **C** = correctness, **K** = calibration; L/M/H are low/medium/high author-side audit priority, not review verdicts.

## Provenance and author-side external spot checks

The authoring method began from content + reasoning behavior + desired interview progression, not by mutating an Oxford source problem. The official benchmark corpus and reference inventory were used only for pedagogical shapes.

A limited external fingerprint spot-check was then used to avoid overstating originality. It found exact or clearly established prior examples for three kernels:

- `oxford-cantor-exponential-rotating-line`: the `e^x=ax` threshold-at-`e` root-count problem is a standard calculus exercise. Example discussion: https://math.stackexchange.com/questions/4805351/the-number-of-real-solutions-of-the-equation-ex-3x
- `oxford-cantor-squared-error-recurrence`: the recurrence `x_{n+1}=x_n(2-x_n)` and the transform `1-x_{n+1}=(1-x_n)^2` are explicitly documented. Example discussion: https://math.stackexchange.com/questions/1524376/show-that-the-sequence-x-n1-x-n2-x-n-is-convergent
- `oxford-cantor-three-cycle-map`: `f(x)=1-1/x` is explicitly documented as a real example satisfying `f^3=id`. Example discussion: https://math.stackexchange.com/questions/2785394/what-is-the-solution-to-the-functional-equation-fffx-x

Those three are therefore labeled `classic-problem` / `secondary-reference` in adaptive provenance rather than `independent-original`. Their conversational progressions remain author-created, but this does **not** make the underlying kernel original.

Two further families are deliberately marked high originality risk even though the exact formulation was not confirmed in this spot-check:

- `oxford-cantor-tangent-intersection-locus` uses classical parabola tangent geometry.
- `oxford-cantor-line-envelope` uses classical envelope-of-lines machinery.

Agent H should search those particularly aggressively. The structured fingerprints for all 20 families are in `docs/oxford-research/cantor-wave2-fingerprints.json`.

## Correctness-sensitive families

Agent I should prioritize:

1. **`oxford-cantor-cubic-divided-difference`** — distinct-preimage counting has two different special parameter values; multiplicity must never be confused with distinct inputs.
2. **`oxford-cantor-mobius-recurrence`** — the `x_0>1` extension depends on when the transformed arithmetic progression hits the pole.
3. **`oxford-cantor-radical-asymptote`** — left/right asymptotics differ because `sqrt(x²)~|x|`; `a=±2` and `|a|>2` change the domain structure.
4. **`oxford-cantor-reciprocal-implicit-curve`** — division by `x²y²` would delete the isolated origin `(0,0)`; the reciprocal-circle representation applies only to the nonzero branches.
5. **`oxford-cantor-reciprocal-increment-recurrence`** — the `sqrt(2n)` conclusion needs a genuinely sublinear cumulative error bound, not the trivial `O(n)` bound.
6. **`oxford-cantor-mobius-involution`** — `a=-1` is a true degeneration; generic cancellation would falsely assert the involution there.

## Calibration-sensitive families

Agent G should treat every author estimate as low confidence. In particular, the following are intentionally flagged high calibration risk because the core proof burden or extension ceiling may vary sharply with candidate insight:

- `oxford-cantor-cubic-divided-difference`
- `oxford-cantor-radical-asymptote`
- `oxford-cantor-shifted-cubic-intersections`
- `oxford-cantor-reciprocal-implicit-curve`
- `oxford-cantor-reciprocal-increment-recurrence`
- `oxford-cantor-mobius-involution`

No estimate in this batch is an official Oxford rating or empirical timing claim.

## Review state and handoff

All six independent review/calibration fields remain pending:

- `taxonomyClassification: unreviewed`
- `originality: unreviewed`
- `fidelity: unreviewed`
- `mathematicalCorrectness: unreviewed`
- `difficultyCalibration: unreviewed`
- `timingCalibration: unreviewed`

### Agent C — Cantor -> Agent G

Reclassify taxonomy/difficulty/timing independently. The frozen tags are author proposals only; if a tag is wrong, correct the classification rather than adding a parallel taxonomy. Pay special attention to the six calibration-sensitive families listed above and to whether 16 graph-heavy entries create the intended breadth rather than excessive correlation.

### Agent C — Cantor -> Agent H

Run the full originality/fidelity audit required by `originality-audit.md` across the deep benchmark corpus, reference inventory, current Interview App bank, this Cantor batch, and external search. Do not inherit the author-side provenance decision as an approval. Start with tangent-intersection locus and line-envelope, then the three explicitly classic kernels.

### Agent C — Cantor -> Agent I

Independently re-work every canonical solution and extension. Prioritize domain restrictions, equality cases, distinct-root counting, the isolated origin in the implicit curve, Möbius pole behavior, radical boundary cases, and the asymptotic recurrence error bound.
