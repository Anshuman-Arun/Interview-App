# Agent E — Euler: Wave 2 Oxford Candidate Coverage

Agent: E — Euler

## Status

This batch contributes **13 surviving candidate Oxford Mathematics interview families** through the existing curated authoring path. Every candidate is deliberately quarantined as `expert-review`; none is added to the live Oxford catalog and none is recommendation-ready.

The frozen Oxford adaptive taxonomy/schema from PR #126 is used unchanged. No domain, content-concept, prerequisite, stage-role, difficulty-band, reasoning-skill, provenance, or review-status tags are added by this work.

All independent gates remain pending:

- taxonomy classification: `in-review`;
- originality: `in-review`;
- Oxford fidelity: `in-review`;
- mathematical correctness: `in-review`;
- difficulty calibration: `unreviewed`;
- timing calibration: `unreviewed`.

The authored timing estimates are low-confidence planning metadata only. They are never candidate-visible.

## Final synchronization changes

- Removed Hilbert hard rejects `locally-balanced-labels`, `random-adjacent-consecutives`, `stop-on-change`, and `random-subset-blocks`; final count is **13**.
- No replacement families were added.
- Preserved all Gauss-approved taxonomy/difficulty metadata.
- Applied the four exact Gauss timing corrections to circle sweep, box diagonal bisector, periodic queue, and kiosk grid.
- Added structural-adaptation/classic-mathematics provenance for corner-balanced tables, periodic queue, cooling data, and random halving interval.
- Did not change any surviving mathematical prompt, solution, protected hint, recurrence, or extension.

## Portfolio coverage

The 13 surviving families include:

- **7 visualization-heavy families**;
- **4 modelling-tagged families**;
- **4 unfamiliar-definition / mini-theory families**;
- **2 probability-domain families**;
- **13 representation-switching families**;
- **12 transfer-tagged families**.

The batch is intentionally biased toward gaps identified in the Wave 1 portfolio: Euclidean/coordinate visualization, whiteboard-native structure, modelling, unfamiliar definitions, converse/boundary work, and elementary probability.

### Whiteboard-native families

The strongest whiteboard-native families are:

1. `oxford-euler-quadrilateral-balance`;
3. `oxford-euler-random-chord-midpoint`;
4. `oxford-euler-circle-sweep`;
5. `oxford-euler-triangle-midpoint-cycle`;
6. `oxford-euler-box-diagonal-bisector`;
8. `oxford-euler-diagonal-blend-transform`;
10. `oxford-euler-corner-balanced-tables`;
11. `oxford-euler-kiosk-grid-model`;
13. `oxford-euler-random-halving-interval`.

These are designed so an interviewer can learn from what the candidate chooses to draw, how they label it, whether they test boundary configurations, and whether they can replace a suggestive sketch with an exact algebraic/combinatorial model.

## Fingerprints and diagram topology

| Family | Mathematical fingerprint | Diagram topology / whiteboard structure |
| --- | --- | --- |
| `quadrilateral-balance` | alternating sum of four squared distances -> quadratic cancellation -> affine line / empty / whole-plane classification | convex 4-cycle plus a free point P; diagonal-midpoint structure becomes decisive only in the exceptional case |
| `random-chord-midpoint` | chord midpoint vector -> dot-product reduction -> zero-sum regular-polygon symmetry -> expectation -> with-replacement transfer | regular n-cycle, a chord, its midpoint, and radius from center |
| `circle-sweep` | diameter-circle equation -> linear parameter elimination -> between-endpoints criterion -> sign-product region -> parameter transfer | positive coordinate axes, moving endpoints A/B, one-parameter family of diameter circles, two endpoint boundary circles |
| `triangle-midpoint-cycle` | three midpoint maps -> one affine cycle map -> weighted fixed point -> exact contraction -> order transfer | triangle ABC plus moving P and three successive midpoint moves |
| `box-diagonal-bisector` | equidistance plane -> scaled cube -> edge-validity inequalities -> 4/6-vertex topology transition | rectangular box, opposite body-diagonal vertices, central oblique plane, edge-intersection polygon |
| `diagonal-blend-transform` | custom coordinate transform -> second iterate is scalar -> uniform metric scaling -> invariant-direction equation -> parameter family | coordinate axes, sample points/simple shapes, image vectors and candidate invariant lines |
| `self-averaging-sets` | unfamiliar averaging rule -> affine self-map on finite set -> contraction around mean -> orbit contradiction -> definition variant | diagram not essential; optional number line showing mean and contracted images |
| `corner-balanced-tables` | adjacent 2x2 diagonal-sum rule -> propagated differences -> row+column decomposition -> converse -> degrees of freedom | m-by-n cell table; adjacent 2x2 blocks and first-row/first-column boundary data |
| `tank-gauge-model` | height observations -> explicit piecewise-prismatic assumption -> equal-volume constraints -> identifiable ratios -> non-identifiability/model revision | side profile with seams at heights 2 and 3 and gauge marks at 0,2,3,4 |
| `periodic-queue-model` | reflected queue recurrence -> period compression -> net drift -> stability vs exact emptying -> longer-period transfer | optional staircase/time table or queue bars; exact event order should be written |
| `kiosk-grid-model` | square-cell reduction -> expected Manhattan access distance -> 1/m versus m^2 objective -> continuous relaxation -> discrete/assumption audit | square tessellated into m-by-m cells with one center kiosk per cell |
| `cooling-data-model` | raw data -> recenter at ambient -> geometric gap recurrence -> prediction/sanity check -> changed ambient | temperature-time points plus an ambient reference line |
| `random-halving-interval` | repeated halving -> binary word -> dyadic cell index -> discrete-uniform midpoint moments -> biased-digit transfer | interval binary tree and dyadic subdivision of [0,1] |

## Originality work performed by Agent E

Local comparisons were made against:

- all 20 deep benchmark families in `official-benchmark-corpus.json`;
- all 34 compact references in `reference-inventory.json`;
- the current built-in Oxford/Quant curated problems;
- the other Euler proposals in this batch via explicit similarity clusters.

External nearest-neighbor searches were also run for likely classic mechanisms. Search patterns included combinations of the mathematical kernel rather than only the story wording, for example:

- squared-distance quadrilateral locus/classification;
- four rectangle areas / opposite products / 2x2 factorization;
- regular-polygon random chord midpoint expectation;
- moving diameter circles with a linear endpoint constraint;
- repeated midpoint maps in a triangle;
- central plane sections of rectangular boxes;
- local-average path/cycle labels;
- custom coordinate transform whose square is scalar;
- finite sets closed under averages of the other elements;
- adjacent 2x2 equal diagonal sums;
- tank-height inverse models;
- periodic reflected queues;
- facility/kiosk grid spacing objectives;
- cooling gap recurrences;
- adjacent consecutive values in random permutations;
- stop-on-first-change coin processes;
- expected runs/blocks in random subsets;
- repeated random interval halving.

This search is **not** an originality approval. Agent H still owns the independent originality/fidelity gate and must repeat/extend external retrieval.

### Proposals discarded before submission

The following draft kernels were rejected by Agent E after finding direct or overly close precedents:

- equal-perimeter cevian construction — direct AMC/legacy geometry precedent;
- standard central cube slice `x+y+z=s` — classic cube-section family;
- real betweenness-preserving function classification — known theorem/standard result;
- one-dimensional bus-stop spacing optimization — near-identical established modelling exercises;
- fair random subset parity — standard parity-pairing result;
- weighted squared-distance level-set family — established weighted-distance identity family;
- random chord crossing/matching family — classic probability/combinatorics neighborhood.

Those are intentionally absent rather than being cosmetically rewritten.

## Similarity clusters inside the Euler batch

Same-wave near-neighbor mechanisms are explicitly clustered so a later recommender does not place them adjacent merely because both survive review:

- `euler-distance-loci`: quadrilateral balance; circle sweep;
- `euler-affine-dynamics`: triangle midpoint cycle; diagonal blend transform;
- `euler-discrete-dynamics-model`: periodic queue; cooling data;

A similarity cluster is not an originality failure; it is a conservative curriculum-separation signal.

## High-risk originality areas for Agent H

Highest-priority external retrieval:

- **quadrilateral balance** — contains the classical rectangle squared-distance identity as an exceptional subcase; the full quadrilateral classification needs independent novelty scrutiny;
- **corner-balanced tables** — additive-separability / vanishing mixed-difference structure is standard, so provenance now reflects structural adaptation;
- **diagonal blend transform** — changing coefficients in a linear map is not itself originality; compare the full progression and invariant-line mechanism;
- **cooling data model** — multiplicative decay about an ambient level is classical, so fidelity/originality must rest on the interview progression and model-revision work rather than the recurrence alone;
- **random chord midpoint** — the zero-sum regular-polygon vector trick may have direct expectation variants.

## High-risk correctness areas for Agent I

Priority checks:

- **box diagonal bisector**: edge-family inequalities, equality transition, vertex deduplication, and cube-only regularity;
- **circle sweep**: sign-product interpretation, topology of the union of circumferences, endpoint inclusion, and the strict-endpoint extension;
- **quadrilateral balance**: equivalence of opposite-vertex vector sum with the parallelogram case and rectangle characterization;
- **periodic queue**: event-order convention, reflecting boundary, zero-drift periodic cases, and any statement about emptying;
- **random chord midpoint**: ordered-vs-unordered conditioning and with-replacement treatment;
- **random halving interval**: dyadic endpoint conventions and biased-bit expectation;

All other families still require full independent correctness review; this list is only triage.

## Calibration notes for Agent G

Every survivor now has a distinct family timing estimate and five stage-ID-specific timing estimates. All remain deliberately **low confidence**, and all calibration statuses remain `unreviewed`.

Particular calibration traps:

- visually simple openings can have a high proof ceiling (`circle-sweep`, `box-diagonal-bisector`);
- unfamiliar definitions have low prerequisite burden but can become abstract quickly (`self-averaging-sets`, `diagonal-blend-transform`);
- modelling stages may consume time in assumption negotiation rather than algebra (`tank-gauge-model`, `periodic-queue-model`, `kiosk-grid-model`);
- elementary probability openings can be fast while the transfer/boundary discussion is the real discriminator.

Stage timing must remain a planning aid, not a scripted timer.

## Process-grounded skill semantics

No Euler milestone uses `guided-adaptation` or `error-recovery` as completion evidence. The shared Euler authoring helper filters any process-grounded skill from milestone evidence by consulting the frozen `getOxfordSkillEvidenceBasis` contract.

The candidates therefore preserve the Wave 1 rule: needing guidance and using guidance effectively are distinct, and process-grounded evidence must come from authoritative event relationships rather than milestone completion.

## Candidate-visible leakage

Adaptive metadata, stage difficulty/timing, skill evidence, provenance, review status, canonical solution, and verification notes remain outside `InterviewProblem.public`. The integrity test asserts this for every Euler candidate.

## Agent E — Euler handoff

**Agent G:** independently calibrate entry/core/ceiling and stage/family timing; do not inherit Agent E's low-confidence estimates as approval.

**Agent H:** independently run the full originality and Oxford-fidelity audit for every family, prioritizing the high-risk items above and treating local/reference-corpus absence as non-evidence.

**Agent I:** independently verify all mathematics, degeneracies, endpoint/sample-space conventions, parameter ranges, converses, and extensions. Do not promote `mathematicalCorrectness` based on Agent E's verification notes alone.

Until G/H/I re-pin the final synchronization head, these 13 surviving families remain in expert-review quarantine and outside recommendation eligibility.
