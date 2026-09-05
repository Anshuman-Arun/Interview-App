# Oxford mathematical correctness and solvability audit

> **Owner:** Agent I — Itô  
> **Scope:** independent `mathematicalCorrectness` review only. Taxonomy/classification remains Agent G's responsibility; originality and Oxford fidelity remain Agent H's responsibility.

This directory is the retained Wave 2 correctness-review packet. It applies the frozen Oxford adaptive contract without adding new taxonomy tags or a competing readiness rule.

## Review principle

A family is reviewed from the candidate-visible statement outward. The reviewer must attempt an independent solution before relying on the authored canonical solution, then compare the independently derived mathematics against every authored approach, milestone, protected hint, extension, and prerequisite claim.

Correctness includes **solvability under the intended knowledge assumptions**. A true theorem can still require `changes-required` when an authored route or extension relies on an undeclared advanced concept, lacks enough information to determine the task, or does not actually reach the stated target.

Authors do not self-approve this gate.

## Required per-family pass

For each family:

1. **Statement:** check quantified domains, parameter ranges, notation, existence/uniqueness assumptions, diagram dependence, and sufficiency of candidate-visible givens.
2. **Independent derivation:** solve the core problem without using the canonical solution as the source of truth.
3. **Approaches:** verify every declared route, including prerequisite order, alternate-route completeness, circularity, and hidden theorem use.
4. **Canonical solution:** compare line-by-line against the independent derivation; check cases, converses, divisions, signs, endpoints, limits, symmetry, probability spaces, and degeneracies.
5. **Hints:** verify each protected hint as a mathematical claim and check consistency across the ladder and across valid alternate routes.
6. **Extensions:** treat each extension as a separate mathematical task. It must be true, related, self-contained at the intended prerequisite level, and have a viable solution path.
7. **Prerequisites:** distinguish what is assumed from what the problem teaches. Unfamiliar machinery must be supplied when the family intends to use it.
8. **Computation where useful:** use enumeration, symbolic checks, or numerical sweeps to catch fragile finite/parameter errors. Finite checking is retained as supporting evidence, never as proof of a general theorem.

## Decision mapping

The audit record uses the **canonical** Oxford review states from `oxford-adaptive-taxonomy.ts`.

| Audit recommendation | `mathematicalCorrectness` | Meaning |
| --- | --- | --- |
| `approve` | `approved` | Independently solved; no open error-level finding or unresolved mathematical uncertainty. |
| `revise` | `changes-required` | Core or family-level solvability needs repair before approval. |
| `reject` | `changes-required` | The current family should not be repaired in place; canonical schema has no separate `rejected` state. |
| incomplete | `unreviewed` / `in-review` | No approval is permitted. |

`packages/problems/src/oxford-correctness-review.ts` enforces the fail-closed invariants above. In particular, an `approved` record cannot coexist with an open error finding or unresolved uncertainty.

## Structured record

The retained record contains:

- stable family ID and problem version;
- source (`existing-bank` or an author PR with agent name and PR number);
- reviewer/date;
- canonical mathematical-correctness status and audit recommendation;
- confirmation that statement, approaches, solution, hints, extensions, and prerequisites were checked;
- a concise independent solution;
- supporting computational checks;
- findings keyed by stable finding ID;
- unresolved mathematical uncertainties.

The retained review records are in `existing-bank-review-records.json`; despite the historical filename, the batch now contains the existing-bank baseline plus keyed author-PR reviews.

## Existing-bank baseline

Audited against `main` at commit `454a2fe993c8fd70676d04e5d262a1780161f0d6` (PR #127 merged).

- Families independently solved/reviewed: **14**
- Correctness approvals: **7**
- Changes required: **7**
- Reject recommendations: **0**
- Unresolved mathematical uncertainties: **0** (all non-approvals have concrete, identified repair items)

| Family | Correctness | Migration recommendation | Main correctness/solvability result |
| --- | --- | --- | --- |
| `oxford-six-people` | approved | safe after G/H review | Standard R(3,3)=6 proof and five-person C5 counterexample verified. |
| `oxford-hilbert-hotel` | approved | safe after G/H review | Explicit assignments are collision-free and exhaustive; infinite-bus extension is constructively viable. |
| `oxford-prisoner-hats` | approved | safe after G/H review | Parity strategy and induction are valid; small analogue exhaustively checked. |
| `oxford-domino-chessboard` | approved | safe after G/H review | Same-colour corner removal gives the required 30/32 obstruction. |
| `oxford-divisors-square-parity` | approved | safe after G/H review | Divisor involution proves both directions; factorization route agrees. |
| `oxford-euclid-primes` | approved | safe after G/H review | Product-plus-one argument correctly uses a prime divisor, not primality of the Euclid number. |
| `oxford-nested-radical-sequence` | approved | safe after G/H review | Bound, monotonicity, convergence, fixed point, and error identity all verified. |
| `oxford-even-odd-degrees` | changes-required | keep manual until repaired | Core proof is correct; Euler-trail extension introduces an undefined extra concept/target. |
| `oxford-divisibility-chain` | changes-required | keep manual until repaired | Core odd-part proof is correct; poset extension is not self-contained. |
| `oxford-continuous-fixed-point` | changes-required | keep manual until repaired | Core IVT proof is correct; higher-dimensional Brouwer extension jumps outside supplied prerequisites. |
| `oxford-prefix-sums-mod-n` | changes-required | keep manual until repaired | Core prefix-residue proof is correct; cyclic-block extension is under-specified. |
| `oxford-triangle-medians` | changes-required | keep manual until repaired | Vector proof is correct; declared mass-points route assumes undeclared machinery. |
| `oxford-monotone-cauchy` | changes-required | keep manual until repaired | Core rational squeeze is correct; Hamel-basis extension is not self-contained. |
| `oxford-catalan-paths` | changes-required | keep expert-review/manual | Reflection proof is correct; `n` lacks an explicit domain and the recurrence route does not independently reach the requested closed form. |

These decisions are **mathematical-correctness decisions only**. They do not approve taxonomy classification, difficulty/timing, originality, or Oxford fidelity.

## Full C/D/E certification

Agent I — Itô completed independent current-version mathematical certification for every surviving Wave 2 author family. Each retained author-PR record is pinned to the exact author head reviewed.

| Author PR | Reviewed head | Surviving families | Approved | Changes required |
| --- | --- | ---: | ---: | ---: |
| Agent C — Cantor #132 | `29ae86d5bccfa10eb91987bfaccc94adfbd57fcf` | 18 | 18 | 0 |
| Agent D — Dirichlet #133 | `ecece22058c997d37c4b352fa5ed32bd1daf5243` | 12 | 12 | 0 |
| Agent E — Euler #134 | `b0ac88218da1079ea2b99b52bf4dc8222bf7b0c6` | 17 | 17 | 0 |

**Surviving total: 47. Correctness approvals: 47. Current C/D/E blockers: 0.**

The review standard for every retained family was: solve the candidate-visible problem independently; inspect the authored solution only afterward; verify all intended approaches, protected hints, extensions, prerequisites, parameter domains, and exceptional cases; and use finite computation only as supporting evidence, never as the general proof.

### Cantor current-version recheck

All 18 surviving Cantor families are correctness-approved at head `29ae86d5...`.

The previously repaired `oxford-cantor-reciprocal-implicit-curve` remains correct: the isolated origin is preserved separately from the four closest points on the nonzero branches, and the scaled extension retains that distinction.

Cantor pruned `oxford-cantor-tangent-intersection-locus` and `oxford-cantor-line-envelope` and later changed protected hints/givens/extensions in surviving families. Agent I rechecked the current candidate-visible/protected material, including:

- `oxford-cantor-moving-v-envelope`;
- `oxford-cantor-reciprocal-root-parabolas`;
- `oxford-cantor-cubic-two-thresholds`;
- `oxford-cantor-integral-sign-landscape`;
- `oxford-cantor-mobius-recurrence`;
- `oxford-cantor-squared-error-recurrence`;
- `oxford-cantor-three-cycle-map`;
- `oxford-cantor-reciprocal-increment-recurrence`;
- `oxford-cantor-mobius-involution`;
- `oxford-cantor-radical-asymptote`;
- `oxford-cantor-shifted-cubic-intersections`;
- `oxford-cantor-reciprocal-implicit-curve`.

The revised material remains mathematically valid and route-consistent. The current Möbius-involution hint explicitly defines the self-inverse composition property, resolving the earlier vocabulary concern. No replacement family was introduced. Latest post-certification Cantor commits were also diffed field-by-field and do not change any family statement, canonical solution, hint, extension, approach, or given; the decisions are therefore re-pinned to the newest head.

One non-blocking wording warning remains recorded: the `three-cycle-map` stretch asks broadly for “simple algebraic relations” rather than one unique target. This does not create a false mathematical claim or block correctness.

### Dirichlet current-version recheck

Dirichlet pruned 10 previously present candidate families while this certification was in progress. The surviving 12 families at head `ecece220...` are:

- `oxford-d-gcd-descent-network`
- `oxford-d-thirds-closed-integers`
- `oxford-d-balancing-transfers`
- `oxford-d-cube-twist-equivalence`
- `oxford-d-sliding-window-parity`
- `oxford-d-weighted-cycle-readings`
- `oxford-d-midpoint-closed-residues`
- `oxford-d-mirror-orbits`
- `oxford-d-odd-symmetric-difference`
- `oxford-d-three-reversal-permutations`
- `oxford-d-divisor-step-geometry`
- `oxford-d-triple-flip-circle`

Their mathematical payloads did not materially change after the independent solves; the concurrent edits removed families and changed author-side metadata/support. Agent I therefore re-pinned the unchanged mathematical decisions to the latest author head and removed stale correctness records for the 10 non-surviving families.

Important discrete checks included small-cardinality exceptions for thirds-closure, gcd/component assumptions, cyclic gcd-orbit counts, singular parity/readout cases, reachability kernels, and construction coverage.

### Euler current-version recheck and repairs

Euler pruned two previously present candidate families, leaving 17 survivors. Mathematical source was certified at `e5f5b431...`; the subsequent `b0ac8821...` commits do not change mathematical family source, so Agent I re-pinned the unchanged mathematical decisions after inspecting that diff. The removed families are not counted as current certifications.

The earlier queue specification blocker is repaired and independently reverified. The current `oxford-euler-periodic-queue-model` now explicitly states:

- `a,b,q_0` are nonnegative integers;
- `s` is a positive integer;
- `q_0` is measured before odd minute 1;
- arrivals occur before service;
- the exact target is whether the queue ever reaches zero.

With `Delta=a+b-2s`, Agent I independently verified that `Delta<0` forces eventual emptying, while for `Delta>=0` exact emptying is decided by the first two updated queue lengths; if both are positive, the same two-step map starts from a weakly larger even-phase queue and cannot create a later first zero. Exhaustive small-parameter simulation agreed with the proof.

The circular random-adjacency domain is also repaired: candidate-visible givens now state `n>=3` for the circular version. The biased stop-on-change family explicitly states `0<p<1`, so its reciprocal waiting-time hints are valid. Euler also added explicit path/cycle size domains, kiosk positivity assumptions, and other boundary givens; Agent I rechecked these current candidate-visible versions.

### Aggregate retained review state

Across the retained existing-bank and current author-PR records:

- Families independently solved/reviewed: **61**
- Correctness approvals: **54**
- Changes required: **7**
- Reject recommendations: **0**
- Unresolved mathematical uncertainties: **0**

All seven remaining `changes-required` records are the pre-existing legacy-bank solvability/prerequisite holds documented below. There are **no unresolved correctness blockers among surviving C/D/E families**.

## Computational regression checks retained

`tests/oxford-correctness-audit.test.ts` adds targeted checks for claims where a small mistake is easy to miss:

- Catalan path counts through `n=8`;
- every `(n+1)`-subset of `{1,...,2n}` through `n=6`;
- exhaustive prefix-sum checks over `{-2,-1,0,1,2}` through sequence length 5;
- all `2^15` two-colourings of `K6`, plus the `C5` lower-bound colouring;
- every hat assignment in a six-prisoner parity-strategy analogue;
- the nested-radical rationalized error identity across a grid in `[0,2]`;
- an explicit composite Euclid number;
- triple-flip move-map kernel/image counts through `n=10`;
- representative diagonal-bisector box-section vertex counts on both sides of the transition;
- a finite-grid check of the circle-sweep sign-product criterion;
- exhaustive line/circular random-subset block expectations through `n=7`;
- regular-polygon random-chord midpoint expectations through `n=14`;
- exhaustive small-set checks for the thirds-closed classification;
- exhaustive sliding-window parity counts for every `1<=k<=n<=8`;
- exhaustive random-adjacent linear/circular expectations through `n=7`;
- exhaustive small-parameter queue checks for the revised emptying criterion.

These checks are regression evidence only. The retained review records contain independent mathematical arguments for the general claims.

## Repair notes for the seven held families

### `oxford-even-odd-degrees`

Either define an Euler trail and state the intended extension precisely, or remove that extension. The core handshaking/parity family needs no mathematical change.

### `oxford-divisibility-chain`

Either define a partial order/poset inside the extension before asking for the interpretation, or remove the poset route. The sharpness extension is sound.

### `oxford-continuous-fixed-point`

The interval generalization is sound. The higher-dimensional prompt should be background for the interviewer, or must state enough of the higher-dimensional setup to make a candidate task meaningful; it should not assume prior Brouwer knowledge.

### `oxford-prefix-sums-mod-n`

State exactly what “cyclic consecutive block” means and whether wrap-around is required. Then state a concrete theorem/question. The existing wording does not determine what the candidate is supposed to prove.

### `oxford-triangle-medians`

The vector route is fully sufficient. If mass points remain a declared authored approach, supply the balancing rule it is allowed to use; otherwise remove that approach/milestone.

### `oxford-monotone-cauchy`

The bounded-interval extension is mathematically sound. The Hamel-basis note should either supply the required definition/background and be clearly interviewer-led, or be removed from a candidate-solvable extension set.

### `oxford-catalan-paths`

Specify `n` as an integer in the candidate-visible statement. Keep the reflection route. For the recurrence route, either add a real derivation from the Catalan recurrence to the requested closed form (with route-consistent hints/milestones), or stop advertising it as a complete alternate solution route. The reflection inverse should also be stated explicitly: in the transformed path, locate the first point where `x=y+1` and reflect the prefix back.

## Cross-agent handoff

Agent I — Itô full-certification state is head-pinned and current:

- Cantor #132: 18/18 surviving families approved at `29ae86d5...`;
- Dirichlet #133: 12/12 surviving families approved at `ecece220...`;
- Euler #134: 17/17 surviving families approved at `b0ac8821...`.

Removed author families are not retained as current certifications. Correctness decisions remain separate from Agent G taxonomy/difficulty/timing and Agent H originality/fidelity decisions.

