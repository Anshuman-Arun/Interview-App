# Oxford Problem Originality / Anti-Lifting Audit

> **Owner:** Agent B  
> **Primary consumer:** Agent H (fidelity/originality auditor)  
> **Goal:** verify that a generated family is Oxford-like in pedagogy without being a copy, cosmetic mutation, or structurally disguised version of an official/classic/current-bank problem.

This gate is intentionally stricter than ordinary plagiarism checking. Text can be completely different while the mathematical problem is still the same.

---

## 1. What counts as acceptable inspiration

Acceptable inspiration lives at the **pedagogical-shape** level:

- start with small cases, form a conjecture, prove it, then generalize;
- sketch a graph, identify important features, then modify a parameter;
- introduce a definition, generate examples, derive consequences, test a converse;
- begin with familiar technique, then change one assumption and deepen;
- let a candidate learn a mechanism and test transfer on a related situation.

These patterns are generic mathematical teaching/interview structures.

A generated problem should have its own:

- mathematical objects;
- constraint system;
- target claim/question;
- central mechanism/invariant;
- critical representation change;
- solution dependency graph;
- diagram topology where relevant;
- ordered progression of follow-ups;
- extension/generalization path.

---

## 2. Automatic rejection conditions

Return `REJECT_TOO_CLOSE` if **any** of the following is true.

### R1 — direct copying

- distinctive source wording is copied;
- a source subquestion is reproduced nearly verbatim;
- tutor prompts or solution prose are copied beyond unavoidable mathematical terminology.

### R2 — cosmetic substitution

The same problem remains after only changing:

- variable names;
- numbers/constants without changing the argument;
- people/objects/story context;
- colors/labels;
- coordinate names;
- diagram labels;
- phrasing/order of sentences.

Example failure pattern: replacing a board with a floor plan while preserving the same coloring invariant, same removed positions, same impossibility target, and same extensions.

### R3 — same mathematical kernel

Reject when the source and candidate share the same combination of:

- core object/configuration;
- constraint;
- target;
- decisive invariant/trick/construction;

even if prose and surface context differ.

### R4 — disguised diagram

Reject when the diagram has the same essential incidence/adjacency/topological structure and the same mathematical purpose, with only relabeling or cosmetic geometry changes.

### R5 — same progression signature

Reject when the source and candidate substantially preserve the ordered ladder of subquestions, for example:

1. identical small cases;
2. same pattern;
3. same proof mechanism;
4. same parameter modification;
5. same final extension.

Changing the statement but preserving the entire pedagogical reveal is too close.

### R6 — same trick + same reveal path

A famous invariant/trick can sometimes appear in many independent problems. It becomes unacceptable when the candidate also preserves the source's opening and route by which the trick is uncovered.

### R7 — source mutation workflow

If author notes show that the family was produced by taking a specific official problem and repeatedly editing it until it “looks different,” require a fresh re-author from the skill/domain brief. Do not try to rescue it with more cosmetic edits.

---

## 3. Required mathematical fingerprint

Every authored family must provide a source-independent fingerprint **before** originality review.

```text
family_id:
primary_domain:
secondary_domains:

surface_objects:
constraints:
target_type:

central_mechanism:
secondary_mechanisms:

critical_representation_change:
diagram_topology:
small_case_signature:

progression_signature:
  - opening:
  - first_deepening:
  - core:
  - transfer:
  - stretch:

solution_dependency_graph_summary:

distinctive_features:
known_classic_overlap:
author_provenance:
```

### Fingerprint semantics

- **surface_objects:** integers, curves, polygons, games, processes, etc.
- **constraints:** the rules that make the problem nontrivial.
- **target_type:** prove/existence/classify/optimize/sketch/count/model/etc.
- **central_mechanism:** the decisive invariant, bijection, monotonicity fact, recurrence, contradiction, representation, construction, etc.
- **critical_representation_change:** e.g. geometry → algebra, sequence → graph, process → state machine.
- **diagram_topology:** relationships that survive relabeling; write `none` for nonvisual problems.
- **small_case_signature:** which cases reveal structure and why.
- **progression_signature:** conceptual role of each authored stage, not the exact prompt wording.
- **solution_dependency_graph_summary:** the minimum chain/branch of insights needed for the core result.
- **distinctive_features:** features a search/reviewer should use to find nearest neighbours.
- **known_classic_overlap:** famous theorem/puzzle family if known.
- **author_provenance:** “independent-original” or the broad benchmark pattern used; never claim independence if an official problem was the starting object.

---

## 4. Pairwise similarity dimensions

For each generated family, compare against the nearest official benchmarks, existing Interview App problems, same-wave generated families, and obvious classics.

Score each dimension:

- `0` — no meaningful overlap;
- `1` — generic/shared mathematical genre;
- `2` — material structural overlap;
- `3` — essentially the same feature.

| Dimension | Question |
| --- | --- |
| wording | Are distinctive phrases or prompts the same? |
| setup | Are the mathematical objects and constraints materially the same? |
| target | Is the candidate being asked to establish essentially the same result? |
| kernel | Is the underlying mathematical construction the same? |
| decisive mechanism | Is the same non-obvious trick/invariant doing the work? |
| diagram | Is the essential diagram topology the same? |
| progression | Are the stages/subquestions revealed in the same order? |
| transfer/stretch | Is the same modification/generalization used as the ceiling? |

### Hard-fail combinations

Reject regardless of total score if:

- wording = 3;
- kernel >= 2 **and** decisive mechanism >= 2;
- diagram >= 2 **and** kernel >= 2;
- progression >= 2 **and** decisive mechanism >= 2;
- setup >= 2 **and** target >= 2 **and** decisive mechanism >= 2.

### Escalation rule

If no hard-fail condition fires:

- total 0–5: normally safe;
- total 6–8: manual explanation required;
- total 9+: presumptively too close; `REVISE` or `REJECT_TOO_CLOSE`.

The total is only a triage device. A reviewer may reject below 9 when the overlap is qualitatively decisive.

---

## 5. Retrieval / automated prefilter

Text similarity alone is insufficient. The practical pipeline should retrieve nearest neighbours using multiple normalized views.

### 5.1 Lexical pass

Compare normalized problem/prompt text using:

- case/punctuation normalization;
- n-gram/shingle overlap;
- distinctive phrase matching;
- edit/sequence similarity.

Flag nontrivial phrase overlap.

### 5.2 Number/variable-normalized pass

Create a copy where:

- variable names are canonicalized;
- numeric constants are replaced by typed placeholders;
- object names are generalized where safe;
- formatting differences are removed.

This detects “same problem, different 7/11/x/y.”

### 5.3 Semantic pass

Embed/search over short structural summaries:

- setup;
- target;
- central mechanism;
- progression signature.

Retrieve top-k nearest neighbours. Do **not** use embedding score as the final originality verdict.

### 5.4 Mathematical-structure pass

Where feasible, canonicalize:

- equations/inequalities;
- graph/recurrence forms;
- combinatorial state descriptions;
- incidence/adjacency structure;
- proof mechanism tags.

A later implementation may use symbolic/AST-like normalization, but human review remains mandatory.

### 5.5 Diagram pass

For visual questions, compare a textual topology fingerprint rather than image pixels only:

- number/type of objects;
- incidence;
- adjacency;
- fixed/moving relationships;
- symmetries;
- which quantities are constrained;
- which part is modified in extensions.

A rotated/recolored/redrawn source diagram should still match structurally.

---

## 6. Review set

Agent H must compare against four pools.

### Pool A — official benchmark corpus

`docs/oxford-research/official-benchmark-corpus.json`

Purpose: prevent direct or structural lifting from the very examples used to learn Oxford style.

### Pool B — current Interview App bank

Purpose:

- prevent internal duplicates;
- prevent new “original” items from merely reworking legacy classics;
- populate `similarityClusterId` for repetition control.

### Pool C — same-wave proposals

Purpose: concurrent authors can independently converge on the same classic/invariant. Cross-compare all proposals before merge.

### Pool D — known classics

If a proposal resembles a famous puzzle/theorem, search/identify it even if it is absent from the official corpus.

Examples of high-risk classic families include:

- mutilated-board coloring;
- standard Euclid-prime contradiction;
- standard handshaking parity;
- textbook Hilbert Hotel;
- canonical hat/prisoner puzzles;
- textbook Fibonacci tilings.

Classic material can remain in a legacy/training bank with explicit provenance, but should not be approved as a newly original Oxford family.

---

## 7. Independence test for authors

Before audit, the author must be able to answer **yes** to all of these:

1. Could I describe why this problem was chosen using only target domain + reasoning skills + abstract family pattern, without naming an official source problem?
2. Is the central mechanism different from the nearest official benchmark?
3. Is the key representation change different or used for a different mathematical purpose?
4. If I remove the story/context, is the mathematical problem still visibly distinct?
5. If I normalize all numbers and variable names, is it still distinct?
6. Is the follow-up/extension path independently designed?
7. Would a mathematically knowledgeable reviewer recognize it as a separate problem rather than “the X problem with new clothes”?

Any “no” sends the problem back to authoring before Agent H review.

---

## 8. Oxford fidelity is a separate gate

Originality and fidelity must not be collapsed.

### Fidelity dimensions

Agent H separately checks:

- productive accessible opening;
- opportunity to think aloud;
- meaningful mathematical reasoning rather than puzzle trivia;
- tutor-promptable intermediate structure;
- low enough prerequisite burden for the intended candidate;
- at least one route to deeper explanation/proof;
- coherent transfer/generalization where natural;
- high enough ceiling for stronger candidates;
- ability to observe one or more Agent A reasoning skills;
- no reliance on a single obscure fact/name.

### Failure examples

- **Original but not Oxford-like:** a long computation with no useful prompts, representation choices, or extensions.
- **Oxford-like but not original:** an official sample problem with different constants.
- **Both bad:** a copied contest puzzle with a brittle trick and no conversation.
- **Both good:** a new mathematical kernel with an accessible start, diagnostic prompts, proof/deepening, and transfer.

---

## 9. Agent H decision format

Use this exact shape in review notes:

```text
ORIGINALITY_DECISION:
  PASS | PASS_WITH_NOTES | REVISE | REJECT_TOO_CLOSE

FIDELITY_DECISION:
  PASS | PASS_WITH_NOTES | REVISE | REJECT_NOT_OXFORD_LIKE

NEAREST_MATCHES:
  - id/source:
    similarity:
      wording: 0-3
      setup: 0-3
      target: 0-3
      kernel: 0-3
      decisive_mechanism: 0-3
      diagram: 0-3
      progression: 0-3
      transfer_stretch: 0-3
    explanation:

HARD_FAIL_RULES_TRIGGERED:
  - none | R1 | R2 | R3 | R4 | R5 | R6 | R7

CLASSIC_PROBLEM_CHECK:
  result:
  notes:

FIDELITY_NOTES:
  accessible_opening:
  promptability:
  reasoning_evidence:
  transfer:
  ceiling:
  prerequisite_burden:

REQUIRED_CHANGES:
  - ...

REVIEWER:
DATE:
```

A `PASS` requires both originality and fidelity to pass independently.

---

## 10. Recommended provenance mapping to Agent A

When Agent A’s adaptive schema is available:

### Independent original

```text
originType = original
sourceCategory = independent-original
referenceFamilyId = optional abstract pattern id, not a copied problem id
originality review = approved
```

### Structurally inspired but mathematically independent

Only use if the author intentionally followed an official pedagogical shape:

```text
originType = structural-adaptation
sourceCategory = official-interview-pattern
referenceFamilyId = abstract pattern/benchmark family id
```

This must still pass the same mathematical originality checks.

### Classic / legacy problem

```text
originType = classic-problem
sourceCategory = classic-mathematics
```

Do not mark as original because the wording was rewritten.

### Similarity cluster

Use `similarityClusterId` to group mathematically related families even when both are original enough to coexist. This helps:

- avoid near-repeat interviews;
- prevent a recommender from selecting two families with the same mechanism in adjacent sessions;
- make future bank audits easier.

---

## 11. Audit examples at the right abstraction level

### Acceptable

Official benchmark shape:

> small cases → detect recurrence → explain recurrence → alter the object

Candidate family:

> explores small values of a newly invented algebraic transformation, conjectures a periodic classification, proves it via a state decomposition, then changes the transformation rule.

Why acceptable: shared teaching shape, different objects, target, mechanism, representation, and transfer.

### Too close

Official benchmark:

> small rectangular tilings → Fibonacci recurrence → larger grid/tile transfer

Candidate:

> same rectangular tiling geometry with different grid dimensions and renamed tile colors → same two-way decomposition → same Fibonacci recurrence → same changed-dimension extension.

Why rejected: same kernel, same decisive recurrence mechanism, same progression, cosmetic differences only.

### Too close despite new story

Source:

> moving geometric object traces a locus; midpoint case first; then a fractional point extension.

Candidate:

> a crane/door/robot-arm story induces the same geometric constraint, same locus, same midpoint-first derivation, and same fractional-point extension.

Why rejected: story changed but kernel/progression/extension did not.

### Acceptable use of a common technique

Two problems both use parity, but one concerns a recursively defined algebraic operation and the other a graph process; their constraints, target, invariant formulation, and extension path differ.

Why acceptable: “parity” is a broad technique, not proprietary problem structure.

---

## 12. Merge gate

A new Oxford family may enter the production-ready bank only if:

- mathematical correctness review passes;
- taxonomy classification is complete;
- originality passes this audit;
- fidelity passes this audit;
- difficulty is at least expert-estimated;
- timing is explicitly internal/estimated unless empirically calibrated;
- provenance is recorded;
- nearest-neighbour/similarity cluster is recorded where relevant.

No author should self-approve originality for their own family.
