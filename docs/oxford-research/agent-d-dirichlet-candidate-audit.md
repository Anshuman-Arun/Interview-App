# Agent D — Dirichlet completion-pass originality and handoff audit

Agent: D — Dirichlet  
Branch: `agent-d-dirichlet-wave2`  
Wave: Oxford Mathematics Wave 2 completion pass  
Author-side audit date: 2026-09-05  
Final candidate count: 12  
Pruned in completion pass: 10  
Replacement families: 0

## Scope and gate status

This document is an **author-side fingerprint, pruning, timing, and collision-risk handoff**, not a self-approval. The canonical Oxford taxonomy/schema in `docs/oxford-adaptive-problem-contract.md` remains frozen and unchanged.

The completion pass intentionally reduces the batch from 22 to 12 families. The two Agent H hard rejects were removed rather than cosmetically mutated, and eight additional standard theorem/exercise kernels were proactively removed. No replacement family was introduced, so there is no reused ID, fingerprint, provenance, or inherited review outcome.

Every surviving family remains `authored` and outside the recommendation-ready bank. Completed independent findings are preserved field-by-field; all outstanding fields remain unreviewed. In particular, every timing estimate below is a **low-confidence family-specific author estimate** until Agent G independently calibrates it.

The deliberately related closure-classification families `oxford-d-thirds-closed-integers` and `oxford-d-midpoint-closed-residues` retain `similarityClusterId: "closure-classification-residue-affine"`. Agent H additionally warned not to schedule the thirds family adjacent to a surviving Euler closure family.

## Completion-pass removals

| Removed family | Reason | Prior correctness result preserved in audit? |
| --- | --- | --- |
| `oxford-d-switching-cuts` | Agent H `REJECT_TOO_CLOSE`: standard cut-space/cycle-space orthogonality kernel | not independently reviewed by I |
| `oxford-d-laminar-family` | Agent H `REJECT_TOO_CLOSE`: exact standard laminar-family `2n-1` theorem | yes — Agent I had approved correctness before pruning |
| `oxford-d-orientation-parities` | fresh search confirms prescribed parity orientations are a named/classical theorem family | yes — Agent I had approved correctness before pruning |
| `oxford-d-prime-divisor-three-cycles` | fresh search surfaces the exact `p | n^2+n+1 => p=3 or p≡1 mod3` exercise/result | yes — Agent I had approved correctness before pruning |
| `oxford-d-discrete-maximum-principle` | standard discrete harmonic maximum principle | no |
| `oxford-d-finite-map-cycles` | standard finite functional-graph one-cycle-plus-in-trees structure | no |
| `oxford-d-spanning-tree-exchange` | textbook graphic-matroid / spanning-tree basis exchange | no |
| `oxford-d-stable-binary-words` | standard forbidden-pattern recurrence family | no |
| `oxford-d-directed-flow-decomposition` | standard path/cycle flow decomposition | yes — Agent I had approved correctness before pruning |
| `oxford-d-idempotent-maps` | exact finite idempotent-map enumeration formula is standard | no |

No hard reject was cosmetically mutated. There are **no replacements** in this pass.

## Portfolio summary

Author-facing category distribution:

- number theory: 6
- combinatorics: 5
- graph theory: 1

Canonical domain incidence (families may have multiple domains):

- number-theory: 8
- combinatorics: 6
- graph-theory: 3
- set-theory: 3
- logic-proof: 2
- algebra: 2
- functions: 1
- sequences-recurrences: 1

Most-used content concepts after pruning: `modular-reasoning` (5), `counting-structure` (5), `parity` (4), `divisibility` (3), `paths-cycles-connectivity` (3), `prime-structure` (2), `relations-operations` (2), `logical-structure` (2), plus one each of `extremal-configuration`, `inequalities-bounds`, `parameter-dependent-algebra`, `composition-iteration`, `set-relations`, and `recurrence-structure`.

Mechanism portfolio now includes: graph-wide gcd descent; conditional trisection closure; convex-energy balancing; prime-exponent residue equivalence; sliding-window cancellation and gcd orbits; cyclic parameter recurrence; midpoint closure to subgroup/coset structure; composition of involutions to translations; symmetric-difference parity collapse; parity-subsequence permutation generation; divisor exponent-lattice geometry; and period-three binary reachability.

## Preserved independent review outcomes

| Family | G taxonomy/difficulty | H originality/fidelity | I correctness | Timing |
| --- | --- | --- | --- | --- |
| `gcd-descent-network` | taxonomy approved; difficulty `introductory / standard / standard` applied as expert estimate | `PASS_WITH_NOTES / PASS` preserved as approved fields | unreviewed | new family-specific author estimate; G review required |
| `thirds-closed-integers` | unreviewed | `PASS_WITH_NOTES / PASS` preserved as approved fields | unreviewed | new family-specific author estimate; G review required |
| `midpoint-closed-residues` | unreviewed | unreviewed | approved | new family-specific author estimate; G review required |
| `triple-flip-circle` | taxonomy recommendation applied; difficulty `introductory / strong / strong` applied as expert estimate | unreviewed | approved | new family-specific author estimate; G review required |
| other 8 survivors | unreviewed | unreviewed | unreviewed | new family-specific author estimate; G review required |

All 12 survivors remain non-recommendation-ready.

## Generic-to-family-specific timing conversion

The old shared `WHOLE_TIMING` / `STAGE_TIMING` templates have been deleted. `support.ts` now requires a timing record keyed by exact family ID and exact stage ID; missing timing is a runtime construction error.

Whole-family low-confidence author estimates:

| Family | First insight | Independent completion | Prompted completion | Optional extension | Soft cutoff |
| --- | ---: | ---: | ---: | ---: | ---: |
| `gcd-descent-network` | 1–3 | 10–16 | 7–12 | 3–6 | 18 |
| `thirds-closed-integers` | 3–7 | 18–28 | 12–21 | 5–10 | 31 |
| `balancing-transfers` | 2–5 | 14–22 | 10–17 | 4–8 | 25 |
| `cube-twist-equivalence` | 3–6 | 16–25 | 11–19 | 5–9 | 28 |
| `sliding-window-parity` | 2–5 | 15–23 | 10–18 | 4–8 | 26 |
| `weighted-cycle-readings` | 3–7 | 18–27 | 13–21 | 5–10 | 30 |
| `midpoint-closed-residues` | 3–7 | 19–29 | 13–22 | 5–10 | 32 |
| `mirror-orbits` | 2–5 | 13–21 | 9–16 | 4–8 | 24 |
| `odd-symmetric-difference` | 1–4 | 10–17 | 7–13 | 3–6 | 20 |
| `three-reversal-permutations` | 2–5 | 14–23 | 10–18 | 5–9 | 26 |
| `divisor-step-geometry` | 2–5 | 15–24 | 10–18 | 5–9 | 27 |
| `triple-flip-circle` | 3–7 | 20–30 | 14–23 | 5–10 | 33 |

Stage-level estimates are separately keyed in code and reflect each family’s actual opening/core/transfer progression rather than a shared three-row template.

## Remaining originality risk after pruning

- **HIGH / deliberately retained with classic provenance:** `oxford-d-triple-flip-circle`. Fresh search surfaced the cycle Lights-Out period-three kernel directly. It is retained only as a transparently classic-provenance candidate and requires Agent H to decide whether the interview progression is worth keeping.
- **MEDIUM-HIGH / deliberately retained with classic provenance:** `oxford-d-midpoint-closed-residues`. The subgroup/coset closure mechanism is mathematically natural and likely classical; it also remains in the declared closure similarity cluster.
- **MEDIUM:** `oxford-d-divisor-step-geometry`. Divisor/exponent grids are known, but the bundled metric + geodesic-count + diameter + bipartition progression did not surface as one exact interview family in the author search.
- **MEDIUM:** `oxford-d-cube-twist-equivalence` and `oxford-d-mirror-orbits` use classical exponent-residue / dihedral mechanisms, though the exact bundled interview paths remain unreviewed.
- All other survivors still require Agent H’s full five-pool retrieval; “no exact author hit” is not approval.

## Correctness completion-pass recheck

Agent D rechecked all 12 survivors for small cases, parity splits, connectedness, quantifiers, construction sufficiency, extension claims, and hidden prerequisites. This remains an author check, **not** mathematical-correctness approval.

Specific boundary checks retained in the specs include: disconnected components for gcd descent; size-1/2/3 exceptions for thirds closure; the corrected `(0,4,2)` local-balancing counterexample; the cubefree-vs-squarefree distinction; `k=n` in sliding-window parity; all real singular parameters in weighted-cycle readings; odd-modulus invertibility and composite subgroup cosets for midpoint closure; arbitrary-start orbit cosets for mirror moves; nonempty-universe necessity for symmetric difference; `n=3` for three-reversals; `N=1` for divisor geometry; and `n=3` plus both divisibility cases for triple flips.

Agent I’s prior six-family correctness review is preserved historically. Four of those correct families were removed solely for originality/classic-risk reasons; the two survivors, `midpoint-closed-residues` and `triple-flip-circle`, retain mathematical-correctness approval in metadata.

## Fingerprints

### 1. oxford-d-gcd-descent-network

- family_id: `oxford-d-gcd-descent-network`
- primary_domain: number-theory
- secondary_domains: graph-theory, combinatorics
- surface_objects: connected graph with positive-integer vertex labels
- constraints: along an edge, subtract the smaller endpoint label from the larger
- target_type: characterize termination and terminal label
- central_mechanism: total-sum strict descent plus global gcd invariance
- secondary_mechanisms: connectedness forces a terminal constant state; componentwise extension
- critical_representation_change: local Euclidean subtraction -> global graph invariant/monovariant
- diagram_topology: arbitrary connected graph; disconnected transfer
- small_case_signature: paths/triangles rapidly reveal Euclidean-style descent
- progression_signature: opening=simulate; first_deepening=find decreasing quantity; core=prove gcd invariant and termination; transfer=identify terminal gcd; stretch=disconnect into components
- solution_dependency_graph_summary: legal-move analysis -> positive integer monovariant -> gcd preservation -> terminal edge equality -> connected constancy -> gcd identification
- distinctive_features: graph-wide Euclidean algorithm whose terminal value is forced without a chosen pivot
- known_classic_overlap: Euclidean algorithm is classic; exact graph process not found in preliminary search
- author_provenance: independently authored from mechanism composition; Agent H independently returned originality PASS_WITH_NOTES and fidelity PASS

### 2. oxford-d-thirds-closed-integers

- family_id: `oxford-d-thirds-closed-integers`
- primary_domain: number-theory
- secondary_domains: combinatorics, algebra
- surface_objects: finite sets of integers
- constraints: whenever x,y are congruent mod3, both integer trisection points between them belong to the set
- target_type: classify all finite sets
- central_mechanism: residue ordering plus forced equal-gap arithmetic progression
- secondary_mechanisms: small-cardinality residue exceptions; modulo-3 obstruction
- critical_representation_change: closure rule on pairs -> ordered residue pattern and gap recurrence
- diagram_topology: linearly ordered set
- small_case_signature: sizes 1,2,3 are exceptional; four ordered points trigger rigidity
- progression_signature: opening=classify tiny sets; first_deepening=sort and inspect residues; core=force equal consecutive gaps; transfer=prove AP with step not divisible by3; stretch=compare other affine closure rules
- solution_dependency_graph_summary: small-size cases -> pigeonhole among residues -> closure inserts trisection points -> adjacency forbids insertion unless gaps equal -> global AP
- distinctive_features: threshold at four points and two internal trisection points
- known_classic_overlap: related structurally to affine-closure problems; paired with midpoint family under shared similarity cluster
- author_provenance: independently authored; similarity cluster declared; Agent H independently returned originality PASS_WITH_NOTES and fidelity PASS

### 3. oxford-d-balancing-transfers

- family_id: `oxford-d-balancing-transfers`
- primary_domain: combinatorics
- secondary_domains: number-theory
- surface_objects: n boxes with nonnegative integer counters
- constraints: if a>=b+2, move one counter from fuller box to poorer box
- target_type: prove termination and characterize all terminal states
- central_mechanism: conserved total plus strictly decreasing sum of squares
- secondary_mechanisms: quotient/remainder classification of balanced terminal multisets
- critical_representation_change: balancing move -> convex energy decrement
- diagram_topology: complete interaction graph; path-restricted counterexample extension
- small_case_signature: highly unequal triples visibly smooth toward floor/ceiling average
- progression_signature: opening=simulate; first_deepening=reject total as termination measure; core=sum-of-squares descent; transfer=classify q/q+1 state; stretch=show locality breaks uniqueness
- solution_dependency_graph_summary: total invariant -> energy decrement -> finite termination -> no pair differs by2 -> q/r multiset forced -> restricted-interaction contrast
- distinctive_features: terminal multiset is unique although terminal labelled arrangement need not be
- known_classic_overlap: smoothing/convexity is standard; exact interview kernel not found in preliminary search
- author_provenance: independently authored; requires Agent H

### 4. oxford-d-cube-twist-equivalence

- family_id: `oxford-d-cube-twist-equivalence`
- primary_domain: number-theory
- secondary_domains: algebra
- surface_objects: positive integers under relation a~b iff ab^2 is a perfect cube
- constraints: perfect-cube condition prime by prime
- target_type: prove equivalence relation and classify classes
- central_mechanism: prime-exponent vectors modulo 3
- secondary_mechanisms: cubefree kernels; r-th-power generalization
- critical_representation_change: multiplicative perfect-power statement -> coordinatewise congruence of exponent vectors
- diagram_topology: none; exponent-vector lattice
- small_case_signature: powers of 2 and 3 reveal exponent residues
- progression_signature: opening=test examples; first_deepening=factor primes; core=derive exponent congruence and equivalence; transfer=identify cubefree representative; stretch=r-th powers
- solution_dependency_graph_summary: factorization ->  e(a)+2e(b)=0 mod3 -> e(a)=e(b) mod3 -> coordinate equivalence -> canonical kernel
- distinctive_features: asymmetric-looking surface relation becomes symmetric after representation switch
- known_classic_overlap: routine perfect-power exponent technique; MEDIUM risk
- author_provenance: independently authored; requires Agent H

### 5. oxford-d-sliding-window-parity

- family_id: `oxford-d-sliding-window-parity`
- primary_domain: combinatorics
- secondary_domains: number-theory
- surface_objects: cyclic binary lamp strings
- constraints: every k-consecutive window has the same parity
- target_type: classify and count configurations
- central_mechanism: subtract adjacent window equations to obtain x_i=x_{i+k}
- secondary_mechanisms: gcd orbit decomposition; parity count
- critical_representation_change: overlapping window constraints -> permutation orbits under index shift by k
- diagram_topology: cycle with length-k windows
- small_case_signature: n=6,k=2/3 separates gcd behavior
- progression_signature: opening=small circles; first_deepening=compare adjacent windows; core=gcd orbit classification; transfer=count 2^gcd(n,k); stretch=which common window parity occurs
- solution_dependency_graph_summary: equal window parities -> cancellation -> shift invariance -> gcd cycles -> free orbit bits -> count and parity refinement
- distinctive_features: all long local constraints collapse to a single shift-period condition
- known_classic_overlap: periodic binary-string methods are standard; no exact same prompt found preliminarily
- author_provenance: independently authored; requires Agent H

### 6. oxford-d-weighted-cycle-readings

- family_id: `oxford-d-weighted-cycle-readings`
- primary_domain: graph-theory
- secondary_domains: algebra
- surface_objects: real labels on vertices of an n-cycle with readings s_i=x_i+t x_{i+1}
- constraints: real t !=0; cyclic indices
- target_type: determine uniqueness, singular parameters, and consistency conditions
- central_mechanism: first-order recurrence propagated around a cycle
- secondary_mechanisms: closure coefficient; exceptional alternating-sum relations
- critical_representation_change: simultaneous cyclic linear equations -> one seeded recurrence plus closure equation
- diagram_topology: cycle
- small_case_signature: odd/even n at t=±1 exposes exceptions
- progression_signature: opening=solve small n; first_deepening=propagate x_{i+1}; core=close cycle; transfer=classify singular parameters; stretch=derive consistency relation
- solution_dependency_graph_summary: recurrence -> n-step return map -> coefficient 1-(-1/t)^n -> uniqueness unless zero -> exceptional consistency/null direction
- distinctive_features: parity of cycle length changes exactly which parameter degenerates
- known_classic_overlap: cyclic linear-system theme is standard; exact parameterized interview path not found preliminarily
- author_provenance: independently authored; requires Agent H

### 7. oxford-d-midpoint-closed-residues

- family_id: `oxford-d-midpoint-closed-residues`
- primary_domain: number-theory
- secondary_domains: set-theory, algebra
- surface_objects: nonempty subsets of residues modulo an odd prime p
- constraints: midpoint of every two members is again in the set
- target_type: classify all closed subsets
- central_mechanism: translate to contain 0, use finite halving bijection to gain doubling, then additive closure
- secondary_mechanisms: subgroup classification in prime cyclic group; composite coset extension
- critical_representation_change: midpoint closure -> subgroup closure after translation
- diagram_topology: cyclic residue group
- small_case_signature: small primes suggest singleton or whole space
- progression_signature: opening=experiment; first_deepening=translate; core=extract halving/doubling/addition; transfer=prime subgroup conclusion; stretch=odd composite cosets
- solution_dependency_graph_summary: translate -> midpoint with 0 gives halving -> finite bijection gives doubling -> midpoint+doubling gives sums -> additive subgroup -> prime dichotomy
- distinctive_features: obtains group structure without assuming subtraction/addition closure
- known_classic_overlap: affine midpoint-closure to subgroup/coset structure is deliberately treated as classic mathematics; shares the declared closure cluster with thirds-closed; MEDIUM-HIGH RISK and requires full Agent H review
- author_provenance: classic-problem / classic-mathematics provenance recorded in metadata; interview progression independently written; Agent I mathematical-correctness APPROVED

### 8. oxford-d-mirror-orbits

- family_id: `oxford-d-mirror-orbits`
- primary_domain: number-theory
- secondary_domains: set-theory
- surface_objects: residues modulo m with reflections R(x)=-x and S(x)=c-x
- constraints: start at 0, then arbitrary compositions
- target_type: characterize reachable orbit; determine when all residues are reachable
- central_mechanism: composition of two involutions is translation by c
- secondary_mechanisms: subgroup generated by c; arbitrary-start double-coset-style orbit description
- critical_representation_change: two mirror moves -> translations plus one reflection
- diagram_topology: cycle of residues
- small_case_signature: gcd(c,m) visually partitions residues
- progression_signature: opening=compose short words; first_deepening=find translation; core=generate multiples of c; transfer=gcd criterion; stretch=arbitrary starting residue
- solution_dependency_graph_summary: S∘R/R∘S -> ±c translations -> subgroup H=<c> -> orbit of 0=H -> all iff gcd=1 -> arbitrary orbit (a+H)∪(-a+H)
- distinctive_features: geometric-looking involutions collapse to arithmetic subgroup motion
- known_classic_overlap: dihedral-group mechanism is classical; exact interview wording not found preliminarily
- author_provenance: independently authored; requires Agent H

### 9. oxford-d-odd-symmetric-difference

- family_id: `oxford-d-odd-symmetric-difference`
- primary_domain: combinatorics
- secondary_domains: set-theory, graph-theory
- surface_objects: all subsets of an n-element universe
- constraints: connect A,B when |A triangle B| is odd
- target_type: identify graph and solve pairwise odd/even extremal questions
- central_mechanism: |A triangle B| parity = |A|+|B| parity
- secondary_mechanisms: complete bipartite collapse; parity classes
- critical_representation_change: set symmetric difference -> one parity bit per subset
- diagram_topology: complete bipartite graph between even- and odd-cardinality subsets
- small_case_signature: n=2,3 makes parity partition visible
- progression_signature: opening=list subsets; first_deepening=reduce parity formula; core=identify K_{2^{n-1},2^{n-1}}; transfer=pairwise-odd max; stretch=pairwise-even max
- solution_dependency_graph_summary: symmetric-difference parity identity -> edge iff opposite parity -> complete bipartite graph -> clique/independent-set consequences
- distinctive_features: enormous subset graph collapses to two equivalence classes
- known_classic_overlap: parity identity standard; exact bundled problem not found preliminarily
- author_provenance: independently authored; requires Agent H

### 10. oxford-d-three-reversal-permutations

- family_id: `oxford-d-three-reversal-permutations`
- primary_domain: combinatorics
- secondary_domains: none
- surface_objects: ordered cards 1,...,n
- constraints: move reverses three consecutive positions
- target_type: characterize reachability, count states, find exact minimum moves
- central_mechanism: a length-3 reversal is a swap of positions i and i+2, preserving each card's position parity
- secondary_mechanisms: compress odd/even slots; adjacent-swap inversion metric
- critical_representation_change: original row -> two independent parity subsequences
- diagram_topology: path positions split into two interleaved paths
- small_case_signature: n=3,4 immediately reveals parity classes
- progression_signature: opening=inspect one move; first_deepening=state card-position parity invariant; core=recognize adjacent swaps in compressed lists; transfer=construct all allowed targets; stretch=inversion-distance formula
- solution_dependency_graph_summary: distance-two swap -> parity invariant -> compressed adjacent swaps generate symmetric groups independently -> count factorial product -> inversion lower bound + bubble-sort equality
- distinctive_features: gives both orbit classification and exact word metric with same representation switch
- known_classic_overlap: adjacent-transposition machinery is standard; exact three-reversal package not found preliminarily
- author_provenance: independently authored; requires Agent H

### 11. oxford-d-divisor-step-geometry

- family_id: `oxford-d-divisor-step-geometry`
- primary_domain: number-theory
- secondary_domains: graph-theory, combinatorics
- surface_objects: graph of positive divisors of N
- constraints: adjacent divisors differ by multiplication/division by one prime
- target_type: derive metric, shortest-path counts, diameter, bipartition, tree criterion
- central_mechanism: prime-exponent vector representation turns graph into an integer box grid
- secondary_mechanisms: L1 distance; multinomial geodesics; exponent-sum parity
- critical_representation_change: divisors -> exponent vectors in product of paths
- diagram_topology: Cartesian product grid of path graphs
- small_case_signature: N=p^a and p^a q^b show path versus rectangular grid
- progression_signature: opening=draw divisor graphs; first_deepening=encode exponents; core=one-coordinate edge rule and L1 distance; transfer=count shortest paths; stretch=diameter/bipartition/tree classification
- solution_dependency_graph_summary: unique factorization -> exponent box -> coordinate-unit edges -> L1 lower/upper bound -> multinomial ordering -> global structural corollaries
- distinctive_features: several graph properties fall out of one arithmetic representation switch
- known_classic_overlap: divisor graphs/exponent grids are known objects; MEDIUM RISK
- author_provenance: independently authored bundle; requires Agent H

### 12. oxford-d-triple-flip-circle

- family_id: `oxford-d-triple-flip-circle`
- primary_domain: combinatorics
- secondary_domains: number-theory, sequences-recurrences
- surface_objects: n lamps on a circle; moves flip three consecutive lamps
- constraints: start all off; only parity of each move use matters
- target_type: complete reachability classification and multiplicity of move subsets
- central_mechanism: F2 convolution equation x_i=y_i+y_{i-1}+y_{i-2}; homogeneous kernel has period 3
- secondary_mechanisms: cyclic closure; mod-3 class parity invariant; kernel-image counting
- critical_representation_change: move sequence -> binary move-subset vector and linear recurrence
- diagram_topology: cycle with length-3 local windows
- small_case_signature: n=3,4,5,6 shows sharp split at 3|n
- progression_signature: opening=small circles; first_deepening=write move equations; core=classify zero-effect period-3 patterns; transfer=injectivity/bijection for 3∤n or equal class-parity obstruction for 3|n; stretch=match counts and move multiplicity
- solution_dependency_graph_summary: encode F2 -> kernel recurrence -> kernel size 1 or4 by cyclic closure -> image size -> visible mod3 invariant -> cardinality equality proves sufficiency
- distinctive_features: combines a visible invariant with a kernel count to prove the invariant is complete
- known_classic_overlap: fresh search surfaced the cycle Lights-Out period-three kernel directly; deliberately retained with classic provenance; HIGH RISK and requires full Agent H review
- author_provenance: classic-problem / classic-mathematics provenance recorded in metadata; Agent I mathematical-correctness APPROVED; Agent G taxonomy/difficulty calibration applied

## Mechanism-level nearest-neighbor notes

Internal comparisons were made against the Wave 1 official benchmark corpus, reference inventory, current curated app problems, and the surviving Agent D portfolio.

- Existing `oxford-euclid-primes` occupies the Euclid-prime kernel; gcd descent uses a graph-wide subtractive process instead.
- Existing `oxford-prefix-sums-mod-n` occupies prefix-sum pigeonhole; no survivor uses that reveal path.
- Existing `oxford-divisors-square-parity` occupies divisor-pairing/square parity; divisor-step geometry uses the full prime-exponent grid.
- Existing `oxford-even-odd-degrees` occupies handshaking parity; odd symmetric difference uses set-cardinality parity instead.
- The two affine closure families remain explicitly clustered rather than presented as independent.
- The high-collision graph theorem kernels from the first pass have been removed rather than reworded.

## Required completion-pass handoff

**Agent D — Dirichlet to G:** perform full independent taxonomy/difficulty/timing review of **every surviving family with an unreviewed G field**. The timing template blocker is removed, but all new family/stage ranges are low-confidence author estimates until G reviews them.

**Agent D — Dirichlet to H:** perform the full five-pool originality/fidelity gate on **every survivor whose H fields remain unreviewed**, with special attention to the deliberately retained classic-provenance midpoint and triple-flip families and the medium-risk divisor/cube/mirror mechanisms. Preserve the prior H results for gcd and thirds; do not reuse outcomes from removed families.

**Agent D — Dirichlet to I:** independently solve/audit **every survivor whose mathematicalCorrectness field remains unreviewed**. Preserve the prior approvals for midpoint and triple-flip. Recheck exceptional cases, quantifiers, construction sufficiency, and extensions rather than sampling.

No surviving Agent D candidate should become recommendation-ready until all required independent fields are complete.
