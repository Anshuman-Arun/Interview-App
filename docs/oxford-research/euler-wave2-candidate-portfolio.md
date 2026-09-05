# Agent E — Euler: Wave 2 candidate portfolio

Agent: E — Euler

This document is the author-side coverage, fingerprint, and risk handoff for the 17 surviving candidate Oxford Mathematics problem families authored in this branch. It does **not** approve originality, Oxford fidelity, mathematical correctness, difficulty, or timing. Those gates remain independent: Agent G owns calibration, Agent H owns originality/fidelity, and Agent I owns correctness.

## Completion-pass system rewrite

- Removed Hilbert hard rejects: `rectangle-area-table` and `difference-closed-sets`.
- Reclassified `quadrilateral-balance` provenance to `structural-adaptation / classic-mathematics` with internal `referenceFamilyId: british-flag-theorem`.
- Replaced generic timing tables with explicit family-ID and stage-ID timing profiles for all 17 survivors.
- Replaced difficulty-driven core inference with explicit stage-ID roles; each survivor has exactly one authored `core`.
- Applied Gauss calibration/taxonomy findings to `circle-sweep` and `self-averaging-sets`.
- Repaired `periodic-queue-model` so domains, initial state, phase, event order, and exact emptying question are candidate-visible and determinate.
- Tightened candidate-visible ranges/independence/nondegeneracy assumptions across the portfolio.
- All G/H/I review/calibration fields remain unapproved pending independent re-review.

## Portfolio summary

- Surviving candidate families: **17**.
- New-definition / mini-theory families: **at least 5**.
- Genuine modelling families: **at least 4**.
- Probability-domain families: **5**.
- Visualization-tagged families: **7**.
- Representation-switching families: **17**.
- Transfer/generalization is present across nearly the entire batch.
- Every family is authored as `expert-review`; none is in the live Oxford curated catalog and none is recommendation-ready.
- All adaptive metadata uses the frozen Wave 1 taxonomy. No new domain, content-concept, prerequisite, reasoning-skill, stage-role, or difficulty tag was introduced.
- `guided-adaptation` and `error-recovery` are not used as milestone-completion evidence. The Euler authoring helper filters all process-grounded skills out of milestone evidence mechanically.

## Family fingerprints

| Family | Primary mathematical fingerprint | Diagram topology / whiteboard use | Main audit risk |
| --- | --- | --- | --- |
| `oxford-euler-quadrilateral-balance` | four fixed vertices + variable point -> alternating squared-distance sum -> cancellation of quadratic terms -> affine locus -> parallelogram degeneration | Convex 4-cycle A-B-C-D plus free point P; no auxiliary construction is required. Candidate sketches symmetric/non-symmetric examples before coordinates. | Squared-distance identities are classic-adjacent; compare especially against British-flag/Leibniz-style identities. |
| `oxford-euler-random-chord-midpoint` | regular polygon chord -> midpoint vector -> zero-sum vertex symmetry -> expected squared radius -> sampling-rule transfer | Regular n-cycle, center O, one random chord, midpoint M. Drawing is useful for small n but the proof changes representation to vectors. | Random chord questions are a broad classic family; the zero-sum finite-polygon mechanism needs external nearest-neighbor review. |
| `oxford-euler-circle-sweep` | axis intercepts under linear constraint -> moving diameter circles -> point-existence affine parameter -> sign-product region between endpoint disks | Perpendicular axes with O, moving A and B, and the circle with diameter AB; the swept boundary is compared to two endpoint circles. | Locus problems can collide structurally with Oxford's official ladder sample; H should compare topology/mechanism, not just wording. |
| `oxford-euler-triangle-midpoint-cycle` | repeated ordered midpoint moves -> one affine cycle map -> fixed weighted point -> exact contraction -> order transfer | Triangle A-B-C, free P, successive midpoint updates; candidate may draw iterates before compressing to an affine map. | Affine-iteration / chaos-game relatives exist; check exact ordered three-midpoint kernel. |
| `oxford-euler-box-diagonal-bisector` | opposite box vertices -> equidistance plane -> scaled cube -> edge-intersection inequalities -> 4/6-vertex transition | Cuboid graph, chosen body-diagonal endpoints, central cutting plane, resulting quadrilateral/hexagon. | Plane-section classification can be textbook-adjacent; correctness risk is highest at threshold equality and edge-family counting. |
| `oxford-euler-locally-balanced-labels` | local neighbor-average definition -> path first-difference propagation -> cycle maximum principle -> topology transfer | Path graph followed by simple cycle; labels are written at vertices. | Discrete harmonic functions are established mathematics; H should distinguish pedagogical self-contained definition from a standard exercise. |
| `oxford-euler-diagonal-blend-transform` | custom planar linear rule -> compose twice -> scalar identity -> metric scaling -> invariant directions -> parameter transfer | Coordinate axes with sample points/shape and invariant lines through origin; no fixed diagram required. | Linear-map algebra may match matrix-eigenvector exercises; search exact transform and parametric form. |
| `oxford-euler-self-averaging-sets` | average-of-others definition -> affine self-map -> centering at global mean -> strict contraction + finite orbit obstruction -> boundary n=2 | No essential diagram; orbit arrows around the mean are optional. | Average-closure / finite-map arguments may have known contest variants; also check the exact include-self extension. |
| `oxford-euler-corner-balanced-tables` | every adjacent 2x2 has equal diagonal sums -> horizontal/vertical difference propagation -> row+column decomposition -> degree count | m×n value grid with highlighted adjacent 2x2 windows. | Additive matrices / vanishing mixed differences are standard; external search should test whether the exact interview ladder is too close to classics. |
| `oxford-euler-tank-gauge-model` | height readings + equal volume increments -> choose band-area model -> infer ratios -> expose non-identifiability -> relax flow/shape assumptions | Side-view tank with horizontal seams at heights 2,3,4; widths intentionally unspecified. | Correctness depends on separating observed data from the piecewise-constant cross-section assumption. |
| `oxford-euler-periodic-queue-model` | periodic arrivals/service -> reflected recurrence -> period drift -> distinguish large-state drift from boundary/emptying behavior -> longer-period transfer | Timeline or queue-state plot optional; no required geometry. | Queue recurrences are standard modelling material; fidelity depends on keeping model-building—not formula application—central. |
| `oxford-euler-kiosk-grid-model` | 2D cell model -> expected Manhattan access distance -> 1/m versus m^2 resource terms -> cube-root optimum -> revise demand/metric | Square hall partitioned into m×m cells with one center kiosk per cell. | Facility-location/spacing optimization is an established area; this replaced a more direct bus-stop classic, but H should still search 2D grid variants. |
| `oxford-euler-cooling-data-model` | raw readings -> choose ambient-centered state -> geometric recurrence -> sanity-check limit -> ambient-change revision | Time-temperature sketch optional; no essential diagram. | Cooling models are common. The intended novelty is model comparison/revision, not claiming the recurrence itself is novel. |
| `oxford-euler-random-adjacent-consecutives` | random permutation -> local adjacency indicators -> linearity of expectation -> boundary/circle transfer | n positions on a line, then optionally around a circle. | Indicator-expectation adjacency problems are common classics; high H-search priority. |
| `oxford-euler-stop-on-change` | condition on first coin result -> initial-run stopping distribution -> expectation by recursion -> biased conditional mixture -> endpoint behavior | Small state/process tree optional. | Geometric-waiting processes are standard; H should decide whether the staged conditional/bias treatment is sufficiently independent. |
| `oxford-euler-random-subset-blocks` | random binary line -> count maximal blocks by starts -> boundary correction -> circular transition count + all-selected exception -> biased p | Selected/unselected positions on a line, then a cycle. | Expected run-count is a known probability motif; correctness risk centers on line boundary and all-selected circular exception. |
| `oxford-euler-random-halving-interval` | repeated random half-selection -> binary word -> dyadic cell -> discrete-uniform midpoint -> moments -> biased binary digits | Interval recursively bisected; binary tree of choices is whiteboard-native. | Binary-expansion / dyadic-process neighbors exist; H should search exact midpoint-distribution progression. |

## Same-wave similarity controls

The authoring metadata deliberately groups only obvious same-wave mechanisms so a later recommender cannot treat them as unrelated:

- `euler-distance-loci`: quadrilateral balance + circle sweep.
- `euler-affine-dynamics`: triangle midpoint cycle + diagonal blend transform.
- `euler-local-balance`: locally balanced labels + corner-balanced tables.
- `euler-discrete-dynamics-model`: periodic queue + cooling data model.
- `euler-local-indicator-expectation`: adjacent consecutive values + random subset blocks.

These clusters are not originality approvals; they are anti-repeat metadata.

## Author-side rejection log

The following initial proposals were removed before submission because an external nearest-neighbor sweep found direct or too-close established structures. They are **not** included in the 17-family batch:

- an equal-perimeter cevian family;
- a standard `x+y+z=s` cube-slice family;
- a betweenness-preserving real-map characterization;
- one-dimensional bus-stop spacing optimization;
- fair random-subset parity by an odd-element toggle;
- weighted squared-distance level sets;
- expected crossings of a random perfect matching on a circle.

Independent Hilbert review subsequently hard-rejected `oxford-euler-rectangle-area-table` and `oxford-euler-difference-closed-sets` as too close to established kernels. They were removed from source, registries, and disclosure tooling rather than cosmetically rewritten. This rejection history is not an originality approval for the 17 survivors.

## Reference-inventory comparison

The batch intentionally avoids mutating the official ladder locus, official tiling/rectangle demonstrations, radial level-set example, moving-parabola area optimization, cylinder optimization, and other benchmark mathematics. Structural proximity that still deserves scrutiny includes:

- `circle-sweep` versus the broad visual-model-proof-transfer shape of the official ladder benchmark: the diagram topology and mathematical kernel are different, but both are moving-geometry loci.
- `kiosk-grid-model` versus the broad constrained-design modelling pattern: the model has a different decision variable, two-dimensional count scaling, access metric, and objective balance.
- `triangle-midpoint-cycle` / `diagonal-blend-transform` versus the broad sketch/iterate/prove pattern: neither uses the official iterated-function graph kernel.
- `locally-balanced-labels` and `self-averaging-sets` use the benchmark-supported unfamiliar-definition pedagogical shape but introduce their definitions and mechanisms self-containedly.

## External-search themes already used by Agent E

Searches included combinations around: squared-distance quadrilateral loci; midpoint cycles; central plane sections of boxes/cubes; local-average graph labelings; average-of-others finite sets; additive 2x2 tables; constant-volume tank inference; periodic queue recurrences; facility/kiosk spacing; cooling recurrences; permutation adjacency expectations; run-length stopping times; random-subset run counts; and random dyadic interval processes. Agent H should rerun independent searches rather than trusting these author-side queries.

## Correctness / calibration risk handoff

**Agent G:** every survivor now has its own low-confidence family timing plus stage-ID-specific timing and an explicit authored core stage. These are calibration hypotheses only; independently recalibrate them rather than inheriting them as approval.

**Agent H:** treat every surviving originality/fidelity state as pending. `quadrilateral-balance` now uses `structural-adaptation / classic-mathematics` provenance with `referenceFamilyId: british-flag-theorem` per H's REVISE finding. Re-audit all 17 survivors, especially locally balanced labels, corner-balanced tables, and the indicator-expectation probability families. Verify diagram topology against visual benchmark neighbors as well as algebraic kernels.

**Agent I:** prioritize geometry degeneracies/boundaries (`circle-sweep`, `box-diagonal-bisector`, quadrilateral exceptional cases), probability sample spaces and exceptional configurations, and modelling identifiability assumptions. `periodic-queue-model` now fixes integer parameter domains, q_0, odd starting phase, and arrivals-before-service, and derives an exact emptying criterion. Candidate solutions and verification notes are author drafts, not correctness approvals.

## Agent E — Euler handoff state

All 17 surviving candidates remain `expert-review`. Adaptive review states are `in-review` for taxonomy classification, originality, fidelity, and mathematical correctness, and `unreviewed` for both difficulty and timing calibration. They therefore fail the authoritative recommendation-readiness gate by construction.
