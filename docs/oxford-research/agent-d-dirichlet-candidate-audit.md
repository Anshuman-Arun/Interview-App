# Agent D — Dirichlet candidate originality and handoff audit

Agent: D — Dirichlet  
Branch: `agent-d-dirichlet-wave2`  
Wave: Oxford Mathematics Wave 2  
Author-side audit date: 2026-09-04  
Candidate count: 22

## Scope and gate status

This document is an **author-side fingerprint and collision-risk handoff**, not an independent approval. The canonical Oxford taxonomy/schema in `docs/oxford-adaptive-problem-contract.md` is unchanged.

All 22 families remain `authored` candidates with every independent review/calibration field `unreviewed`. They are intentionally **not** added to the recommendation-ready production bank. Agent H must independently repeat the required five-pool originality retrieval; Agent I must independently audit mathematical correctness; Agent G must independently calibrate difficulty and timing.

The two deliberately related closure-classification families use the shared `similarityClusterId` `closure-classification-residue-affine`.

## Portfolio summary

Author-facing category distribution:

- number theory: 7
- combinatorics: 7
- graph theory: 6
- logic and proof: 2

Canonical domain incidence (families may have multiple domains):

- combinatorics: 12
- number-theory: 9
- graph-theory: 9
- set-theory: 6
- functions: 3
- logic-proof: 2
- algebra: 2
- elementary-analysis: 1
- sequences-recurrences: 1

Most-used content concepts: `paths-cycles-connectivity` (8), `counting-structure` (7), `parity` (6), `modular-reasoning` (6), `divisibility` (4), `extremal-configuration` (3), `prime-structure` (3), `composition-iteration` (3).

Mechanism portfolio includes: gcd invariant + descent monovariant; cut/cycle parity; affine residue closure; spanning-tree parity construction; convex-energy descent; prime-exponent vectors; multiplicative orbit cycles; sliding-window cancellation + gcd orbits; cyclic linear recurrence with singular parameters; laminar inclusion trees; midpoint closure to subgroup structure; involution composition to translations; discrete maximum propagation; functional digraph decomposition; symmetric-difference parity; spanning-tree basis exchange; terminal-run recurrence decomposition; directed flow/cycle decomposition; idempotent image/fixed-point structure; parity-position permutation generation; divisor exponent lattices; and an F2 period-three reachability recurrence.

## Preliminary external-search ledger

The author performed broad and targeted web searches against standard problem/exercise language and the candidate kernels. These findings are **risk signals only**:

- `oxford-d-laminar-family`: exact/near-exact standard theorem that a laminar family on an n-element ground set has size at most `2n-1`; **high collision risk**.
- `oxford-d-spanning-tree-exchange`: standard spanning-tree exchange principle; **high collision risk**.
- `oxford-d-finite-map-cycles`: standard finite functional-digraph “one directed cycle plus in-trees” structure; **high collision risk**.
- `oxford-d-discrete-maximum-principle`: standard discrete harmonic maximum principle on finite connected graphs; **high collision risk**.
- `oxford-d-switching-cuts`: aligns strongly with the classical cut-space/cycle-space orthogonality characterization; **high collision risk**.
- `oxford-d-prime-divisor-three-cycles`: the conclusion `p | n^2+n+1 => p=3 or p≡1 (mod 3)` is a standard number-theory exercise/result; **high collision risk**.
- `oxford-d-stable-binary-words`: overlaps known literature on binary strings/sequences with forbidden isolated 1s; **high collision risk** even though the interview progression is independently authored.
- `oxford-d-directed-flow-decomposition`: strongly overlaps standard Eulerian/flow-decomposition arguments; **high collision risk**.
- `oxford-d-orientation-parities`: likely overlaps standard prescribed-degree-parity orientation theorems; **medium-high collision risk**.
- `oxford-d-midpoint-closed-residues`: subgroup/coset closure mechanism is mathematically natural and may be standard; **medium-high collision risk**.
- `oxford-d-idempotent-maps`: idempotent-map enumeration is likely known; **medium collision risk**.
- `oxford-d-divisor-step-geometry`: divisor graphs and exponent-grid representations are known objects; **medium collision risk**.

For the remaining custom kernels, preliminary author searches did not surface a plausible exact same problem + mechanism + reveal path, but that is not evidence of independence. Agent H must repeat the mandated external retrieval and make the actual decision.

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
- author_provenance: independently authored from mechanism composition; not approved for originality

### 2. oxford-d-switching-cuts

- family_id: `oxford-d-switching-cuts`
- primary_domain: graph-theory
- secondary_domains: combinatorics
- surface_objects: graph edges with two colors; vertex switches flip incident edges
- constraints: target black-edge set from all-white start
- target_type: characterize reachable edge sets
- central_mechanism: parity of target intersection with every cycle
- secondary_mechanisms: vertex-subset cuts; spanning-tree construction
- critical_representation_change: sequence of switches -> parity vector of switched vertices -> cut
- diagram_topology: arbitrary graph with cycle/tree decomposition
- small_case_signature: triangle shows even-cycle-intersection obstruction
- progression_signature: opening=try switches; first_deepening=collapse repeated switches mod2; core=derive cycle condition; transfer=construct via spanning tree; stretch=components/cut-space view
- solution_dependency_graph_summary: switch parity -> cut representation -> cycle orthogonality necessary -> tree-based vertex assignment -> sufficiency
- distinctive_features: interview begins as a physical switching process before exposing cut-space language
- known_classic_overlap: strong overlap with classical cut/cycle-space orthogonality; HIGH RISK
- author_provenance: independently written presentation of a likely classical kernel; requires Agent H decision

### 3. oxford-d-thirds-closed-integers

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
- author_provenance: independently authored; similarity cluster declared; requires Agent H

### 4. oxford-d-orientation-parities

- family_id: `oxford-d-orientation-parities`
- primary_domain: graph-theory
- secondary_domains: combinatorics
- surface_objects: undirected connected graph with desired outdegree parities
- constraints: orient every edge to realize prescribed parity bit at each vertex
- target_type: necessary-and-sufficient existence condition plus construction
- central_mechanism: total outdegree parity equals edge-count parity
- secondary_mechanisms: spanning tree; leaf-to-root orientation
- critical_representation_change: global parity prescription -> local decisions on a rooted spanning tree
- diagram_topology: arbitrary connected graph reduced to spanning tree plus free non-tree edges
- small_case_signature: paths and cycles expose one dependent parity equation
- progression_signature: opening=test small graphs; first_deepening=find global parity constraint; core=orient non-tree edges then process leaves; transfer=prove root automatic; stretch=componentwise version
- solution_dependency_graph_summary: global necessity -> choose spanning tree -> freeze non-tree orientations -> leaf elimination -> root equation forced by global parity
- distinctive_features: constructive proof isolates exactly one redundant constraint
- known_classic_overlap: likely standard prescribed-parity orientation result; MEDIUM-HIGH RISK
- author_provenance: independently authored interview path; requires Agent H

### 5. oxford-d-balancing-transfers

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

### 6. oxford-d-cube-twist-equivalence

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

### 7. oxford-d-prime-divisor-three-cycles

- family_id: `oxford-d-prime-divisor-three-cycles`
- primary_domain: number-theory
- secondary_domains: combinatorics
- surface_objects: prime p dividing n^2+n+1
- constraints: p != 3
- target_type: derive congruence class of p
- central_mechanism: multiplication by n partitions nonzero residues into 3-cycles
- secondary_mechanisms: n^3=1 mod p but n!=1; orbit counting
- critical_representation_change: divisibility identity -> permutation action on nonzero residues
- diagram_topology: disjoint directed cycles in residue set
- small_case_signature: primes dividing sample values suggest p≡1 mod3
- progression_signature: opening=compute; first_deepening=factor n^3-1; core=build multiplication orbits; transfer=count 3-cycles; stretch=quadratic analogue for mod4
- solution_dependency_graph_summary: divisor relation -> n^3≡1 -> no fixed nonzero residue under multiply-by-n -> all orbits length3 -> 3|(p-1)
- distinctive_features: deliberately avoids quoting multiplicative-order theorem
- known_classic_overlap: conclusion is a standard number-theory result/exercise; HIGH RISK
- author_provenance: independently authored orbit-counting presentation of classical result; requires Agent H

### 8. oxford-d-sliding-window-parity

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

### 9. oxford-d-weighted-cycle-readings

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

### 10. oxford-d-laminar-family

- family_id: `oxford-d-laminar-family`
- primary_domain: combinatorics
- secondary_domains: set-theory
- surface_objects: laminar family of subsets of an n-element set
- constraints: any two sets are disjoint or nested
- target_type: extremal maximum and equality structure
- central_mechanism: inclusion forest/tree with leaves as atoms
- secondary_mechanisms: internal-node counting; full-binary equality case
- critical_representation_change: family of sets -> rooted inclusion forest
- diagram_topology: laminar inclusion tree/forest
- small_case_signature: n=2,3 suggests singleton leaves and unions
- progression_signature: opening=build large examples; first_deepening=draw inclusion poset; core=count leaves/internal nodes; transfer=reach 2n-1; stretch=classify equality
- solution_dependency_graph_summary: laminarity -> unique containment parent -> rooted tree -> at least two children per internal node -> internal<=leaves-1 -> total<=2n-1
- distinctive_features: equality corresponds to binary hierarchical merging
- known_classic_overlap: exact standard theorem; HIGH RISK, likely revise/reject after H
- author_provenance: independently written but theorem collision discovered in author search; not originality-approved

### 11. oxford-d-midpoint-closed-residues

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
- known_classic_overlap: affine-convex/subgroup closure may be standard; shares declared cluster with thirds-closed family; MEDIUM-HIGH RISK
- author_provenance: independently authored; similarity cluster declared; requires Agent H

### 12. oxford-d-mirror-orbits

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

### 13. oxford-d-discrete-maximum-principle

- family_id: `oxford-d-discrete-maximum-principle`
- primary_domain: graph-theory
- secondary_domains: elementary-analysis
- surface_objects: real-valued function on finite connected graph vertices
- constraints: each value equals average of neighbor values
- target_type: prove constancy and boundary maximum extension
- central_mechanism: a global maximum can average to itself only if all neighbors share it
- secondary_mechanisms: connected propagation
- critical_representation_change: averaging equations -> extremal propagation
- diagram_topology: arbitrary finite connected graph
- small_case_signature: paths make the propagation obvious
- progression_signature: opening=small graphs; first_deepening=choose maximum; core=propagate equality through neighbors; transfer=connected constancy; stretch=boundary maximum principle
- solution_dependency_graph_summary: finite maximum exists -> average equality at max -> every neighbor max -> connected propagation -> constant
- distinctive_features: no linear algebra required
- known_classic_overlap: exact standard discrete harmonic maximum principle; HIGH RISK
- author_provenance: independently written classical theorem presentation; requires Agent H

### 14. oxford-d-finite-map-cycles

- family_id: `oxford-d-finite-map-cycles`
- primary_domain: logic-proof
- secondary_domains: set-theory, functions
- surface_objects: self-map of a finite set and its arrow diagram
- constraints: iterate each point forward
- target_type: characterize injectivity through cycle membership; classify components
- central_mechanism: finite iteration repetition and indegree structure
- secondary_mechanisms: functional digraph components have one directed cycle with in-trees
- critical_representation_change: repeated function application -> directed functional graph
- diagram_topology: pseudoforest with one directed cycle per weak component
- small_case_signature: three/four-point maps show tails versus cycles
- progression_signature: opening=draw maps; first_deepening=follow orbit; core=injective iff every point lies on cycle; transfer=component classification; stretch=count/structural variants
- solution_dependency_graph_summary: finite orbit repeats -> eventual cycle -> injectivity forbids noncycle tails -> converse cycles imply permutation behavior -> one-cycle-per-component structure
- distinctive_features: proof moves between iteration and graph pictures
- known_classic_overlap: standard finite functional-graph theorem; HIGH RISK
- author_provenance: independently written standard kernel; requires Agent H

### 15. oxford-d-odd-symmetric-difference

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

### 16. oxford-d-spanning-tree-exchange

- family_id: `oxford-d-spanning-tree-exchange`
- primary_domain: graph-theory
- secondary_domains: combinatorics
- surface_objects: two spanning trees T and U of same connected graph
- constraints: one edge exchange at a time while staying a spanning tree
- target_type: construct transformation and minimize number of exchanges
- central_mechanism: add target edge to create unique cycle, remove a non-target edge on that cycle
- secondary_mechanisms: symmetric-difference potential; MST exchange transfer
- critical_representation_change: compare whole trees -> one target-edge insertion cycle at a time
- diagram_topology: tree plus one fundamental cycle
- small_case_signature: square/diagonal examples show exchange
- progression_signature: opening=try two trees; first_deepening=add one U\T edge; core=cycle exchange reducing |T\U|; transfer=exact distance; stretch=weighted/MST principle
- solution_dependency_graph_summary: add target edge -> unique cycle -> cycle must contain non-U edge -> swap -> intersection grows -> repeat -> lower bound one target edge per move
- distinctive_features: monotone path in spanning-tree graph toward a specified target
- known_classic_overlap: exact standard spanning-tree/basis exchange principle; HIGH RISK
- author_provenance: independently written classical kernel; requires Agent H

### 17. oxford-d-stable-binary-words

- family_id: `oxford-d-stable-binary-words`
- primary_domain: combinatorics
- secondary_domains: sequences-recurrences
- surface_objects: binary words
- constraints: every run of 1s has length at least 2
- target_type: count words and derive recurrence/generalization
- central_mechanism: decompose by final run
- secondary_mechanisms: cumulative recurrence elimination
- critical_representation_change: forbidden local pattern -> terminal block decomposition
- diagram_topology: linear word
- small_case_signature: counts for short lengths expose non-Fibonacci recurrence
- progression_signature: opening=count small n; first_deepening=split ending 0 vs final 1-run; core=sum recurrence; transfer=compress to short recurrence; stretch=min run length L
- solution_dependency_graph_summary: terminal 0 contributes a_{n-1}; terminal 1-run length j>=2 contributes prefix ending 0/empty -> cumulative recurrence -> subtract adjacent n equations -> short recurrence
- distinctive_features: progression emphasizes deriving, then algebraically compressing, the recurrence
- known_classic_overlap: known literature on binary sequences without isolated 1s; HIGH RISK
- author_provenance: independently authored interview derivation; requires Agent H

### 18. oxford-d-directed-flow-decomposition

- family_id: `oxford-d-directed-flow-decomposition`
- primary_domain: graph-theory
- secondary_domains: combinatorics
- surface_objects: finite directed graph with edge set and vertex indegree/outdegree imbalance
- constraints: +1 at s, -1 at t, zero elsewhere
- target_type: partition edges into directed cycles plus one s-to-t directed path
- central_mechanism: add artificial edge t->s to balance every vertex, decompose balanced digraph into cycles
- secondary_mechanisms: trail following; remove artificial edge
- critical_representation_change: nearly balanced flow -> balanced Eulerian edge multiset
- diagram_topology: arbitrary directed graph
- small_case_signature: branching examples show why path alone does not absorb all edges
- progression_signature: opening=trace edges; first_deepening=solve balanced case; core=add t->s; transfer=cycle decomposition and remove edge; stretch=imbalance r
- solution_dependency_graph_summary: balanced lemma -> artificial edge -> all-balanced graph -> cycle partition -> unique cycle containing artificial edge becomes s-t path -> remaining cycles
- distinctive_features: one artificial edge converts source-sink defect into exact conservation
- known_classic_overlap: standard Eulerian/flow decomposition mechanism; HIGH RISK
- author_provenance: independently authored presentation of standard mechanism; requires Agent H

### 19. oxford-d-idempotent-maps

- family_id: `oxford-d-idempotent-maps`
- primary_domain: set-theory
- secondary_domains: functions, combinatorics
- surface_objects: self-maps f:X->X on labelled n-element set
- constraints: f(f(x))=f(x)
- target_type: structural classification and enumeration by image size
- central_mechanism: image equals fixed-point set
- secondary_mechanisms: depth-one functional stars; choose roots then assign nonroots
- critical_representation_change: functional equation -> functional digraph
- diagram_topology: disjoint rooted stars with loops at roots
- small_case_signature: n=2,3 shows all arrows land directly at fixed points
- progression_signature: opening=draw maps; first_deepening=prove image=fixed points; core=star structure; transfer=count C(n,k)k^{n-k}; stretch=contrast f^3=f
- solution_dependency_graph_summary: y=f(x) -> f(y)=y -> image=fixed -> choose k roots -> independent assignments -> sum over k
- distinctive_features: algebraic iteration law turns immediately into an enumerable graph structure
- known_classic_overlap: idempotent-map enumeration is likely known; MEDIUM RISK
- author_provenance: independently authored; requires Agent H

### 20. oxford-d-three-reversal-permutations

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

### 21. oxford-d-divisor-step-geometry

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

### 22. oxford-d-triple-flip-circle

- family_id: `oxford-d-triple-flip-circle`
- primary_domain: combinatorics
- secondary_domains: number-theory
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
- known_classic_overlap: lights-out style linear systems are a broad classic family, but exact triple-circle classification was not found in preliminary author search; MEDIUM RISK
- author_provenance: independently authored; requires Agent H

## Mechanism-level nearest-neighbor notes

Internal comparisons were made against the Wave 1 official benchmark corpus, reference inventory, current curated app problems, and the other 21 Agent D candidates.

- Existing `oxford-euclid-primes` occupies the Euclid-prime kernel; none of these candidates reuse that proof.
- Existing `oxford-even-odd-degrees` occupies handshaking parity; parity-orientation and symmetric-difference families use different central mechanisms.
- Existing `oxford-prefix-sums-mod-n` occupies the standard prefix-sum pigeonhole mechanism; no candidate uses that reveal path.
- Existing `oxford-divisors-square-parity` occupies divisor-pairing/square parity; divisor-step geometry instead uses the full prime-exponent grid.
- Existing `oxford-catalan-paths` occupies Catalan/path counting; no candidate uses reflection/Catalan machinery.
- The two affine closure families are intentionally marked as related rather than pretending independence.
- The graph candidates deliberately span different kernels: cut parity, rooted parity orientation, cyclic recurrence, maximum propagation, tree exchange, directed decomposition, and divisor-grid geometry.

## Required downstream handoff

**Agent D — Dirichlet handoff to G:** independently calibrate entry/core/ceiling bands and timing. Treat current values as low-confidence author estimates only.

**Agent D — Dirichlet handoff to H:** independently perform the five-pool originality gate. Pay special attention to the high-risk families listed above. Do not treat this document's “no exact match found” notes as approval evidence.

**Agent D — Dirichlet handoff to I:** independently solve/audit every family, including exceptional cases, quantifiers, connected/disconnected cases, parity cases, and the exact formulas/counts in extensions.

No Agent D candidate should become recommendation-ready until the independent gates required by the frozen contract have passed.
