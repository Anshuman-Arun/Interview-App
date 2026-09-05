# Wave 2 full same-wave collision report

**Reviewer:** Agent H — Hilbert  
**Baseline main:** `454a2fe993c8fd70676d04e5d262a1780161f0d6`  
**Certification date:** 2026-09-05 (America/Los_Angeles)

## Certified author heads and surviving totals

Hilbert reviewed every survivor at the exact materially relevant version:

- **Agent C — Cantor, PR #132:** 18 survivors at `29ae86d5bccfa10eb91987bfaccc94adfbd57fcf`.
- **Agent D — Dirichlet, PR #133:** 12 survivors at `ecece22058c997d37c4b352fa5ed32bd1daf5243`.
- **Agent E — Euler, PR #134:** 17 survivors at `b0ac88218da1079ea2b99b52bf4dc8222bf7b0c6`.

**Total surviving / audited: 47 / 47.**

All 47 records independently complete Pools A–E. Author self-search was used only as a retrieval lead. No replacement families were introduced during the completion passes, so the replacement re-audit count is zero.

Pruning history:

- Cantor removed 2 prior Hilbert hard rejects: tangent-intersection locus and line-envelope.
- Dirichlet reduced 22 to 12 by removing the two prior Hilbert rejects plus eight additional standard/classic theorem kernels.
- Euler removed the two prior Hilbert hard rejects: rectangle-area-table and difference-closed-sets.

## Final decision counts

Originality:

- `PASS`: 0
- `PASS_WITH_NOTES`: 35
- `REVISE`: 6
- `REJECT_TOO_CLOSE`: 6

Oxford fidelity:

- `PASS`: 40
- `PASS_WITH_NOTES`: 7
- `REVISE`: 0
- `REJECT_NOT_OXFORD_LIKE`: 0

The asymmetry is expected: several mathematically familiar or classic families remain good Oxford interview material even when they fail the independent-original gate.

## Current hard originality rejects

These six surviving families remain too close to established kernels as currently authored:

- `oxford-cantor-reciprocal-implicit-curve` — exact implicit-curve equation/trace structure is externally established.
- `oxford-d-mirror-orbits` — classical two-reflection → rotation/translation plus gcd-orbit mechanism.
- `oxford-euler-locally-balanced-labels` — second-difference-zero path characterization plus discrete harmonic maximum principle.
- `oxford-euler-random-adjacent-consecutives` — standard random-permutation adjacency statistic and indicator method.
- `oxford-euler-stop-on-change` — standard initial-run/geometric waiting problem.
- `oxford-euler-random-subset-blocks` — standard expected-run-count kernel.

Each is independently Oxford-like; rejection is an originality decision, not a fidelity decision.

## Current originality revisions

These six add meaningful authored structure but still overstate independence or remain too centrally built on established mathematics for the current provenance:

- `oxford-d-three-reversal-permutations` — the length-3 reversal/parity-subsequence mechanism is established; broader reachability/count/distance adds depth.
- `oxford-d-divisor-step-geometry` — prime-exponent Cartesian-product divisor representation is standard; the metric/geodesic bundle is authored.
- `oxford-euler-corner-balanced-tables` — vanishing mixed differences / row-plus-column decomposition is standard.
- `oxford-euler-periodic-queue-model` — Lindley/reflected-queue recurrence is standard; the repaired periodic/emptying analysis is authored.
- `oxford-euler-cooling-data-model` — Newton-style temperature-gap decay is standard; model comparison/revision is authored.
- `oxford-euler-random-halving-interval` — coin-toss binary/dyadic encoding is standard; the midpoint moments/bias ladder adds structure.

These require provenance/core revision and another Hilbert pass before recommendation readiness.

## Truthfully retained classics and structural adaptations

A known classic can clear provenance only as a classic. Current examples include:

- Cantor moving-V envelope — structural adaptation / classic mathematics (Moreau/Huber construction).
- Cantor cubic divided difference — classic problem / secondary reference.
- Cantor exponential/rotating-line — classic problem / secondary reference.
- Cantor Möbius recurrence — classic problem / secondary reference.
- Cantor squared-error recurrence — classic problem / secondary reference.
- Cantor three-cycle map — classic problem / secondary reference.
- Cantor reciprocal-increment recurrence — classic problem / secondary reference.
- Dirichlet midpoint-closed residues — classic problem / classic mathematics.
- Dirichlet triple-flip circle — classic problem / classic mathematics.
- Euler quadrilateral balance — structural adaptation / classic mathematics.

Their authored interview progressions can still be useful, but none may be re-described as independent-original.

## Final passing-family repetition controls

The following groups contain families distinct enough to keep after H review but too correlated to schedule adjacent by default:

- **`closure-classification-residue-affine`** — retain:
  - `oxford-d-thirds-closed-integers`
  - `oxford-d-midpoint-closed-residues`
- **`euler-distance-loci`** — retain:
  - `oxford-euler-quadrilateral-balance`
  - `oxford-euler-circle-sweep`
- **`euler-affine-dynamics`** — retain:
  - `oxford-euler-triangle-midpoint-cycle`
  - `oxford-euler-diagonal-blend-transform`
- **`cantor-cubic-graph-structure`** — propose:
  - `oxford-cantor-cubic-two-thresholds`
  - `oxford-cantor-cubic-divided-difference`
  - `oxford-cantor-shifted-cubic-intersections`
- **`mobius-iteration`** — refine to:
  - `oxford-cantor-mobius-recurrence`
  - `oxford-cantor-three-cycle-map`
  - `oxford-cantor-mobius-involution`
- **`cyclic-binary-parity-dynamics`** — propose:
  - `oxford-d-sliding-window-parity`
  - `oxford-d-triple-flip-circle`
- **`cantor-reciprocal-symmetry`** — propose:
  - `oxford-cantor-reciprocal-root-parabolas`
  - `oxford-cantor-reciprocal-paired-inputs`

No cross-agent finite-closure cluster is needed now because Euler's difference-closed family was removed. The old `parameter-envelope` pair no longer has two survivors. Euler's local-indicator pair is rejected, and the discrete-dynamics/model pair remains revision-blocked, so neither is promoted as a final passing-family H cluster.

## Current-bank context

The separate 14-fixture baseline remains unchanged. Its legacy fixtures are still provisional and therefore remain provenance/originality revisions rather than independent-original approvals. Truthful classic provenance remains acceptable after the other independent gates pass.

## Handoff boundary

Hilbert has completed originality/fidelity review for all 47 current survivors at the heads above. A family with H `PASS_WITH_NOTES` still requires any outstanding Agent G taxonomy/difficulty/timing work and Agent I mathematical-correctness review before `isOxfordRecommendationReady` can become true. Hilbert does not import or overwrite G/I decisions.
