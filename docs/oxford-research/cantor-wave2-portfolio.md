# Agent C — Cantor Wave 2 completion portfolio

**Status:** author-side completion pass for PR #132. The surviving families remain expert-review only. This document records author repairs and review inputs; it is not an independent G/H/I approval.

The original batch contained **20** analytical / graphical Oxford Mathematics candidates. Agent H — Hilbert hard-rejected two families for originality, so the completion portfolio contains **18 surviving families** and **no replacement families**.

## Completion-pass decisions

- Removed `oxford-cantor-tangent-intersection-locus` after Hilbert `REJECT_TOO_CLOSE / PASS`.
- Removed `oxford-cantor-line-envelope` after Hilbert `REJECT_TOO_CLOSE / PASS`.
- Kept `oxford-cantor-moving-v-envelope`, but changed provenance to `classic-problem / classic-mathematics` and explicitly recorded the Huber/Moreau relationship. Its historical `parameter-envelope` similarity marker is retained for repetition control.
- Kept `oxford-cantor-exponential-rotating-line` as `classic-problem / secondary-reference`.
- Changed `oxford-cantor-cubic-divided-difference` ceiling from `stretch` to `strong` per Gauss.
- Kept `oxford-cantor-reciprocal-increment-recurrence` at `introductory-plus / strong / stretch`; supplied a decreasing-sum/integral comparison so unfamiliarity with harmonic/logarithmic comparison is not treated as weakness.
- Preserved Itô's repaired `oxford-cantor-reciprocal-implicit-curve`: the origin is an isolated solution and global closest point; the four square-root points are closest only on the nonzero branches.
- Reworded the Möbius transfer prompt so “self-inverse” is operationalized as `S(S(x))=x`.
- Re-audited all 18 stage progressions. Twelve families were adjusted so the main prompt result is completed in the `core` milestone rather than being mislabeled as the final extension milestone.

## Portfolio shape

- **14/18** surviving families declare `graph-sketching`.
- **17/18** use the `functions` domain; the reciprocal-increment recurrence is the exception.
- **3** families remain centered on nonlinear recurrences, with distinct mechanisms: reciprocal-error linearization, error squaring, and telescoping squared growth.
- Every surviving family has five protected hint stages, five reasoning milestones, a mathematically substantive `core`, two authored extensions, a canonical solution, verification notes, and low-confidence author timing/difficulty estimates.
- `guided-adaptation` and `error-recovery` remain process-grounded only and are never milestone-completion evidence.
- Similarity/repetition markers:
  - `parameter-envelope` remains on the moving-V classic-adjacent presentation so the reviewed overlap history is not erased when the rejected line-envelope candidate is removed.
  - `mobius-iteration` remains on the related fractional-iteration material.

## Surviving candidate inventory

| # | Family | Main mathematical kernel | Author risks (O/C/K) |
|---:|---|---|---|
| 1 | `oxford-cantor-moving-v-envelope` | constrained parameter minimization of moving absolute-value graphs | **H / classic-adjacent** / L / M |
| 2 | `oxford-cantor-reciprocal-root-parabolas` | reciprocal roots -> effective coefficient -> vertex locus | M / L / M |
| 3 | `oxford-cantor-cubic-two-thresholds` | distinct discriminant thresholds for extrema and roots | M / L / M |
| 4 | `oxford-cantor-cubic-divided-difference` | divided-difference quadratic classifies equal-height preimages | **classic** / M / H |
| 5 | `oxford-cantor-integral-sign-landscape` | sketch accumulation function from factored derivative before integrating | M / L / M |
| 6 | `oxford-cantor-reciprocal-paired-inputs` | reciprocal input pairing + exact range + inverse branches | M / L / M |
| 7 | `oxford-cantor-exponential-rotating-line` | root-count threshold for `e^x=ax` | **classic** / L / M |
| 8 | `oxford-cantor-mobius-recurrence` | reciprocal fixed-point error conjugates recurrence to translation | **classic** / M / M |
| 9 | `oxford-cantor-squared-error-recurrence` | exact error squaring | **classic** / L / M |
| 10 | `oxford-cantor-absolute-quadratic-crossings` | fold quadratic and classify horizontal-level counts | M / L / M |
| 11 | `oxford-cantor-radical-asymptote` | rationalization + derivative-sign comparison + domain bifurcation | L / M / **H** |
| 12 | `oxford-cantor-shifted-cubic-intersections` | translated cubic difference collapses to quadratic | M / L / **H** |
| 13 | `oxford-cantor-moving-integral-window` | moving/dilating integral window + endpoint derivative | L / L / M |
| 14 | `oxford-cantor-reciprocal-implicit-curve` | isolated origin + reciprocal-coordinate circle + four outer branches | L / M / **H** |
| 15 | `oxford-cantor-three-cycle-map` | fractional-linear map with exact period three | **classic** / L / M |
| 16 | `oxford-cantor-quartic-horizontal-levels` | double-well quartic + quadratic in `x²` | M / L / M |
| 17 | `oxford-cantor-reciprocal-increment-recurrence` | nearly telescoping square increments -> `sqrt(2n)` asymptotic | **classic** / M / **H** |
| 18 | `oxford-cantor-mobius-involution` | symmetric implicit hyperbola -> self-inverse map + exceptional degeneration | M / M / **H** |

Risk legend: **O** = originality, **C** = correctness, **K** = calibration. L/M/H are author-side audit priorities, not independent verdicts.

## Provenance corrections and author-side external checks

Hilbert's retained five-pool record identifies `oxford-cantor-moving-v-envelope` as the Moreau-Yosida envelope of `|x|`, equivalently a scaled Huber function after a variable substitution. The frozen schema reserves `structural-adaptation` for records with a reference family ID. Because Hilbert's Huber/Moreau match is an external classic construction rather than an internal reference family, this family uses `classic-problem / classic-mathematics`; the moving-V representation does not make the kernel independent-original.

The completion-pass exact-formula sweep also found established public instances for three kernels the first author check missed:

- `oxford-cantor-cubic-divided-difference`: exact equation `x^3-x=a^3-a` and factorization by `x-a`: https://math.stackexchange.com/questions/3786413/how-to-find-the-number-of-solutions-for-x-in-x3-%E2%88%92-x-a3-%E2%88%92-a
- `oxford-cantor-mobius-recurrence`: exact recurrence `x_{n+1}=1/(2-x_n)` and reciprocal-error transform: https://math.stackexchange.com/questions/3557190/find-general-term-of-recursive-sequences-x-n1-frac12-x-n-x-1-1-2
- `oxford-cantor-reciprocal-increment-recurrence`: exact recurrence and `sqrt(2n)` asymptotic target: https://math.stackexchange.com/questions/4778663/finding-the-asymptotic-of-the-sequence-a-n1-a-n-frac1fa-n

Those now use `classic-problem / secondary-reference`. The previously identified classics remain:

- `oxford-cantor-exponential-rotating-line`: https://math.stackexchange.com/questions/4805351/the-number-of-real-solutions-of-the-equation-ex-3x
- `oxford-cantor-squared-error-recurrence`: https://math.stackexchange.com/questions/1524376/show-that-the-sequence-x-n1-x-n2-x-n-is-convergent
- `oxford-cantor-three-cycle-map`: https://math.stackexchange.com/questions/2785394/what-is-the-solution-to-the-functional-equation-fffx-x

All other provenance remains a provisional author claim pending Hilbert's required full five-pool audit.

## Difficulty completion pass

- `oxford-cantor-cubic-divided-difference`: **introductory-plus / strong / strong** (Gauss recommendation applied exactly).
- `oxford-cantor-reciprocal-increment-recurrence`: **introductory-plus / strong / stretch** retained (Gauss supported it).
- `oxford-cantor-shifted-cubic-intersections`: ceiling lowered from `stretch` to `strong`; its extensions are transfer/deepening of the same finite-difference kernel.
- `oxford-cantor-mobius-involution`: ceiling lowered from `stretch` to `strong`; the shifted self-inverse construction is transfer rather than a qualitatively new stretch barrier.
- Other authored difficulty bands are unchanged after the all-family pass and remain low-confidence until Gauss reviews them.

## Timing completion pass

Top-level soft cutoffs are now family-specific planning values in the **20–25 minute** range. Optional extension time is separate; the cutoff is not a scripted transition and does not imply every extension is reached.

| Family | soft cutoff |
|---|---:|
| moving V envelope | 24 |
| reciprocal-root parabolas | 23 |
| cubic two thresholds | 24 |
| cubic divided difference | **24 (Gauss)** |
| integral sign landscape | 24 |
| reciprocal paired inputs | 22 |
| exponential/line | 21 |
| Möbius recurrence | 23 |
| squared-error recurrence | 21 |
| absolute quadratic crossings | 20 |
| radical asymptote | 25 |
| shifted cubic intersections | 23 |
| moving integral window | 23 |
| reciprocal implicit curve | 25 |
| three-cycle map | 21 |
| quartic horizontal levels | 22 |
| reciprocal-increment recurrence | **25 (Gauss)** |
| Möbius self-inverse family | 24 |

The reviewed Gauss estimates for cubic divided difference and reciprocal-increment recurrence are copied exactly, including their stage timings. All timing confidence remains `low`.

## Correctness-sensitive preservation

Agent I — Itô reviewed six families on the prior Cantor version. The mathematical statements/solutions for those families remain intact in this completion pass except for non-mathematical staging/guidance clarifications.

Most importantly, `oxford-cantor-reciprocal-implicit-curve` still states:

1. `(0,0)` is an isolated solution.
2. `(0,0)` is globally closest to the origin.
3. `(±sqrt(2),±sqrt(2))` are closest only on the **nonzero branches**.
4. Premature division by `x²y²` deletes the isolated origin.
5. The scaled `c>0` extension keeps the same global-vs-branch distinction.

The Möbius transfer prompt now defines the intended property directly as `S(S(x))=x`.

## Author-side all-family audit

Every surviving family was re-read for:

- complete candidate-visible statement and explicit parameter domains;
- non-spoilery title relative to what the prompt itself already states;
- coherent one-family Oxford progression;
- main mathematical target completed in `core`;
- extensions that continue the learned mechanism rather than topic-switch;
- canonical domains/content concepts/prerequisites/reasoning tags only;
- no process-grounded milestone completion evidence;
- difficulty reflecting actual barriers rather than stage position;
- family-specific low-confidence timing with natural transition points;
- truthful provisional provenance.

No additional author-side blocker was found. This is not a substitute for the required independent full-family G/H/I certification.

## Independent review state

The canonical adaptive review fields remain fail-closed and unreviewed on the author branch. `isOxfordRecommendationReady(...)` must remain false until independent records are complete.

### Agent C — Cantor -> Agent G — Gauss

Review **every surviving Cantor family not yet fully calibrated**, including any materially changed family previously reviewed. Re-check taxonomy, difficulty, whole-family timing, and stage timing. The two Gauss-reviewed timing records were applied exactly, but the author branch does not self-promote their calibration status.

### Agent C — Cantor -> Agent H — Hilbert

Run the full five-pool originality/fidelity audit on **every surviving Cantor family not yet reviewed**, plus the materially revised provenance cases. Re-review `moving-v-envelope` after its structural-adaptation provenance change. The two hard rejects were removed, not replaced.

### Agent C — Cantor -> Agent I — Itô

Independently verify **every surviving Cantor family not yet correctness-reviewed**. Re-check any family if this completion pass changed mathematical meaning; the intended changes here are staging, timing, provenance, or explanatory guidance rather than new mathematical kernels. Preserve the reciprocal-implicit-curve origin/branch distinction as a hard regression condition.
