# Wave 2 same-wave collision report

**Reviewer: Agent H — Hilbert**  
**Baseline main:** `454a2fe993c8fd70676d04e5d262a1780161f0d6`  
**Latest audit date:** 2026-09-05 (America/Los_Angeles)

## Author PRs audited

Hilbert started before author PRs were available, then re-swept before final handoff and audited a risk-prioritized batch once all three appeared:

- **Agent C — Cantor, PR #132:** 4 of 20 families audited.
- **Agent D — Dirichlet, PR #133:** 4 of 22 families audited.
- **Agent E — Euler, PR #134:** 4 of 19 families audited.

The structured records are in `same-wave-high-risk-batch.json`. The batch deliberately prioritizes author-flagged originality risks, known/classic-adjacent kernels, and cross-agent collision candidates rather than easy random samples.

### Same-wave decision counts

Originality across 12 audited proposals:

- `PASS`: 0
- `PASS_WITH_NOTES`: 4
- `REVISE`: 2
- `REJECT_TOO_CLOSE`: 6

Fidelity across the same 12:

- `PASS`: 9
- `PASS_WITH_NOTES`: 3
- `REVISE`: 0
- `REJECT_NOT_OXFORD_LIKE`: 0

This split is intentional: several proposals are excellent Oxford interview structures but still fail originality because the mathematical kernel is classical.

## Major same-wave findings

### Agent C — Cantor (#132)

- `oxford-cantor-moving-v-envelope`: **REVISE originality / PASS fidelity**. The lower envelope is a scaled Huber/Moreau envelope of absolute value. The moving-V representation is useful, but `independent-original` provenance overstates novelty.
- `oxford-cantor-tangent-intersection-locus`: **REJECT_TOO_CLOSE / PASS**. Same classical parabola tangent-parameter locus kernel and elimination route.
- `oxford-cantor-exponential-rotating-line`: **PASS_WITH_NOTES / PASS_WITH_NOTES**. Exact classic `e^x=ax` threshold problem, but Cantor already truthfully labels it `classic-problem`.
- `oxford-cantor-line-envelope`: **REJECT_TOO_CLOSE / PASS**. Affine/scaled form of the standard tangent-line envelope of a parabola.

Cantor's existing `parameter-envelope` cluster is appropriate for moving-V and line-envelope repetition control, though the latter is rejected as a new original.

### Agent D — Dirichlet (#133)

- `oxford-d-gcd-descent-network`: **PASS_WITH_NOTES / PASS**. Subtractive Euclid is classical, but the graph-wide terminal-gcd process appears structurally distinct in the searched material.
- `oxford-d-switching-cuts`: **REJECT_TOO_CLOSE / PASS**. The switching story is a wrapper around the classical theorem that cut space is the cycle-space orthogonal complement over GF(2).
- `oxford-d-thirds-closed-integers`: **PASS_WITH_NOTES / PASS**. General affine-closure literature exists, but no exact finite conditional-trisection classification was found.
- `oxford-d-laminar-family`: **REJECT_TOO_CLOSE / PASS_WITH_NOTES**. Exact standard `2n-1` laminar-family theorem.

Dirichlet's existing `closure-classification-residue-affine` cluster should remain.

### Agent E — Euler (#134)

- `oxford-euler-quadrilateral-balance`: **REVISE / PASS**. The arbitrary-quadrilateral classification is a meaningful extension, but the classic rectangle/British-flag squared-distance identity is structurally central; `independent-original` is too strong.
- `oxford-euler-rectangle-area-table`: **REJECT_TOO_CLOSE / PASS_WITH_NOTES**. Same 2×2 rectangle-area product puzzle and discovery mechanism; converse/grid extensions do not sanitize the core.
- `oxford-euler-diagonal-blend-transform`: **PASS_WITH_NOTES / PASS**. Standard linear-transformation ideas, but no exact same rule/progression was found.
- `oxford-euler-difference-closed-sets`: **REJECT_TOO_CLOSE / PASS**. Same finite absolute-difference closure classification and repeated-subtraction mechanism as a known result.

Euler's `euler-distance-loci` and `euler-affine-dynamics` clusters are useful and should remain.

## Cross-agent collision finding

A broader repetition family exists around **finite closure rules that force arithmetic structure**:

- Dirichlet `oxford-d-thirds-closed-integers`
- Dirichlet `oxford-d-midpoint-closed-residues` (author-declared related family)
- Euler `oxford-euler-difference-closed-sets`

The Euler family is currently rejected for an external collision. If Euler replaces it with a genuinely different surviving closure family, Hilbert recommends a shared broader cluster such as `finite-closure-arithmetic-structure` so it is not scheduled adjacent to the Dirichlet closure-classification families.

This is a repetition-control recommendation, **not** a new taxonomy tag.

## Current-bank repetition findings

- `oxford-six-people` and `oxford-even-odd-degrees` both use a people/party-to-graph representation. Their targets and decisive mechanisms differ, so this is sequencing risk rather than an originality collision.
- `oxford-divisibility-chain` and `oxford-prefix-sums-mod-n` both use pigeonhole reasoning in elementary number theory. Odd-part chains and prefix residues remain materially distinct.
- `oxford-nested-radical-sequence` and `oxford-continuous-fixed-point` both involve fixed-point language, but one is an iteration-convergence proof and the other an IVT existence proof.

## Current-bank classic findings

The 14-fixture baseline continues to classify all current fixtures as requiring provenance/originality revision before approval because they are still `provisional-legacy`. Named classics include Ramsey's six-person problem, Hilbert Hotel, the parity hats puzzle, mutilated chessboard, Euclid's proof, handshaking, centroid concurrency, and Catalan paths.

Truthful classic provenance remains acceptable. A classic does not become original merely because its wording or staging is new.

## Handoff to recommendation readiness

Same-wave families whose **Hilbert gates can progress to G/I completion** from this audited batch:

- `oxford-cantor-exponential-rotating-line` — truthfully classic, H pass with notes.
- `oxford-d-gcd-descent-network` — H pass with notes / fidelity pass.
- `oxford-d-thirds-closed-integers` — H pass with notes / fidelity pass.
- `oxford-euler-diagonal-blend-transform` — H pass with notes / fidelity pass.

The following require Hilbert-owned provenance revision and re-review before readiness:

- `oxford-cantor-moving-v-envelope`
- `oxford-euler-quadrilateral-balance`

The following are originality hard rejects as authored, even though their Oxford fidelity is good:

- `oxford-cantor-tangent-intersection-locus`
- `oxford-cantor-line-envelope`
- `oxford-d-switching-cuts`
- `oxford-d-laminar-family`
- `oxford-euler-rectangle-area-table`
- `oxford-euler-difference-closed-sets`

Agent G still owns taxonomy/difficulty/timing calibration and Agent I still owns correctness. Hilbert's decisions do not substitute for either gate.
