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

## Final Wave 2 C/D/E certification

Agent I — Itô completed a final diff-based synchronization against the author heads below. Previously certified mathematics was not blindly re-solved: only surviving families whose candidate-visible or protected mathematical payload changed were independently re-checked.

| Author PR | Final reviewed head | Final survivors | Approved | Changes required |
| --- | --- | ---: | ---: | ---: |
| Agent C — Cantor #132 | `8b22dc5df99111fb95e27a2c006d5e74544dd385` | 17 | 17 | 0 |
| Agent D — Dirichlet #133 | `1d9222ed89895f643b4f25429b0a5dbe1dac0a4c` | 11 | 11 | 0 |
| Agent E — Euler #134 | `8846c612825d2b8ae53a81f6f8861fd851f452c6` | 13 | 13 | 0 |

**Final surviving total: 41. Final correctness approvals: 41. Current C/D/E correctness blockers: 0.**

Every retained author-PR record is pinned to its exact final author head. Removed families are not retained as current certifications.

### Cantor final diff-based recheck

Compared final head `8b22dc5...` against the latest previously reviewed Cantor head `794fe228...`.

Final pruning removed `oxford-cantor-reciprocal-implicit-curve`, leaving 17 survivors. No replacement family was introduced.

Among surviving families, the only mathematical-payload change was candidate-visible guidance in:

- `oxford-cantor-reciprocal-increment-recurrence`.

The final given explicitly permits the decreasing-sum/integral comparison

`sum_{k=1}^{n-1} h(k) <= h(1) + integral_1^n h(t) dt`

for positive decreasing `h`. Agent I independently rechecked this guidance: for `k>=2`, monotonicity gives `h(k) <= integral_{k-1}^k h(t)dt`; summing yields the supplied inequality. Applying it to `h(t)=1/(a_0^2+2t)` gives a logarithmic bound on the reciprocal-square error, which is exactly what the canonical proof needs to conclude `a_n/sqrt(2n) -> 1`. The guidance is correct and removes the risk of treating harmonic/logarithmic comparison as hidden prior knowledge.

No other surviving Cantor statement, candidate-visible given, canonical solution, protected hint, approach, or extension changed. Existing correctness decisions were therefore re-pinned rather than re-solved.

### Dirichlet final diff-based recheck

Compared final head `1d9222ed...` against previously reviewed head `ecece220...`.

Final pruning removed:

- `oxford-d-mirror-orbits`.

The remaining 11 survivors have no changes to statement, candidate-visible givens, canonical solution, protected hints, approaches, or extensions. A later post-prune diff to `1d9222ed...` also leaves all six mathematical payload fields unchanged. The changed Dirichlet files contain pruning plus author-side support/taxonomy/calibration/provenance work. The existing independent correctness decisions were re-pinned to the final head.

### Euler final diff-based recheck

Compared final head `8846c612...` against previously reviewed head `b0ac8821...`.

Final pruning removed:

- `oxford-euler-locally-balanced-labels`;
- `oxford-euler-random-adjacent-consecutives`;
- `oxford-euler-random-subset-blocks`;
- `oxford-euler-stop-on-change`.

The remaining 13 family source files are unchanged. A later post-prune diff removes the stale `random-subset-blocks` similarity-cluster entry from authoring metadata; the final `8846c612...` commit after that is documentation-only. No surviving mathematical payload changes. Existing independent correctness decisions were therefore re-pinned to the final head without unnecessary re-solving.

The previously repaired `oxford-euler-periodic-queue-model` remains among the final survivors and remains correctness-approved with explicit domains, `q_0`, starting phase, event order, and exact emptying target.

### Final retained review state

Across the final author snapshot plus the separate 14-family existing-bank baseline:

- Retained review records: **55**
- Final C/D/E author records: **41**
- Final C/D/E correctness approvals: **41**
- Existing-bank correctness approvals: **7**
- Existing-bank changes required: **7**
- Total retained approvals: **48**
- Total retained changes required: **7**
- Reject recommendations in the correctness ledger: **0**
- Unresolved mathematical uncertainties: **0**

The seven remaining `changes-required` records are the pre-existing legacy-bank self-containment/prerequisite holds documented below. They are not blockers on the final C/D/E Wave 2 survivor set.

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
- regular-polygon random-chord midpoint expectations through `n=14`;
- exhaustive small-set checks for the thirds-closed classification;
- exhaustive sliding-window parity counts for every `1<=k<=n<=8`;
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

Agent I — Itô final Wave 2 correctness snapshot is head-pinned and complete:

- Cantor #132: **17/17** final survivors approved at `8b22dc5df99111fb95e27a2c006d5e74544dd385`;
- Dirichlet #133: **11/11** final survivors approved at `1d9222ed89895f643b4f25429b0a5dbe1dac0a4c`;
- Euler #134: **13/13** final survivors approved at `8846c612825d2b8ae53a81f6f8861fd851f452c6`.

Final total: **41/41 mathematicalCorrectness approved**.

Removed author families are not retained as current certifications. Correctness decisions remain separate from Agent G taxonomy/difficulty/timing and Agent H originality/fidelity decisions.

