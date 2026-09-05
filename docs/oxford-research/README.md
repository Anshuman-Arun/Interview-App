# Oxford Mathematics Interview Benchmark Foundation

> **Owner:** Agent B  
> **Scope:** research, benchmark classification, calibration guidance, and originality controls for Oxford Mathematics problem authoring.  
> **Not in scope:** bulk-authoring the production question bank or changing live interview/runtime behavior.

This document is the engineering-facing synthesis. The machine-readable benchmark records live in [`official-benchmark-corpus.json`](./official-benchmark-corpus.json), and the independent anti-lifting procedure lives in [`originality-audit.md`](./originality-audit.md).

## 0. Executive contract

The most important conclusion is that an Oxford-like problem is **not defined by a topic or by olympiad difficulty**. The strongest official evidence describes an interview as a short tutorial-like mathematical conversation in which tutors observe how a candidate thinks, responds to unfamiliar ideas, uses prompts, and develops an argument.

For the Interview App, preserve these rules:

1. **Separate prerequisite knowledge, mathematical subject, and reasoning skill.** TMUA content is a useful lower-bound/toolkit reference, not the full interview topic space.
2. **Prefer accessible entry + deep ceiling.** A strong family should often let a candidate begin productively before the central insight is available.
3. **Keep prompts diagnostic.** Tutor interventions should redirect, simplify, request a representation, or surface a local observation before they reveal the decisive step.
4. **Use follow-ups to test learning and transfer.** A good extension often changes one parameter, dimension, representation, definition, or constraint while preserving the conceptual thread.
5. **Do not make completion the objective.** Official sources explicitly support interviews in which candidates receive help, make mistakes, or do not finish.
6. **Do not equate fidelity with copying.** Reuse broad pedagogical shapes; change the mathematical kernel, central mechanism, progression details, diagram structure, and extension path.
7. **Treat timing below the whole-interview level as internal, non-scripted calibration.** Oxford gives a roughly 20–30 minute whole-interview anchor, not official per-stage expected times. Stage ranges are soft planning estimates only: individual families may deviate substantially, one core development may occupy most of an interview, and transitions should occur for mathematical reasons rather than because a nominal timer expired.
8. **Treat difficulty as a profile, not one number.** Entry, core, and ceiling should be calibrated separately.
9. **Adapt primarily between interviews.** Within an interview, prefer deeper exploration, prompts, reframing, and extensions within a coherent family. This is a product policy consistent with several official examples, not a claim that every real Oxford interview uses exactly one family.

---

## 1. Source hierarchy and provenance

### Tier A — first-party Oxford Mathematics / University of Oxford

| ID | Source | What it supports |
| --- | --- | --- |
| OX-INTERVIEWS | https://www.maths.ox.ac.uk/study-here/undergraduate-study/interviews | Current Maths-specific format: about 25 minutes; possible technique/curve sketching, problem solving, or a new definition and consequences; thinking aloud. |
| OX-UNIV-INTERVIEWS | https://www.ox.ac.uk/admissions/undergraduate/applying/guide-for-applicants/interviews | Interviews as tutorial-like academic conversations; response to new ideas; typical two tutors; simple opening questions; Tier 3 whiteboard/stylus use for Mathematics. |
| OX-SAMPLE | https://www.ox.ac.uk/admissions/undergraduate/applying/guide-for-applicants/interviews/sample_questions | Tutor-authored Mathematics examples with explicit commentary: ladder trace and 2-by-n tiling. |
| OX-PROSPECTUS | https://www.maths.ox.ac.uk/study-here/undergraduate-study/prospectus | Typical 20–30 minute interview; unseen problems; adaptation and helpful prompts rather than recall. |
| OX-CRITERIA | https://www.maths.ox.ac.uk/study-here/prospective-undergraduates/how-apply/admissions-criteria | Capacity to absorb/use new ideas, independent thinking, perseverance and enthusiasm, alongside aptitude/technical skill. |
| OX-TMUA | https://www.maths.ox.ac.uk/study-here/undergraduate-study/tmua | Current Oxford prerequisite/testing context: depth over breadth; AS/Higher GCSE plus limited full A-level content; TMUA used for shortlisting. |
| UAT-TMUA | https://esat-tmua.ac.uk/about-the-tests/tmua-test/ | Paper 1 applies mathematical knowledge in new situations; Paper 2 focuses mathematical reasoning and elementary logic. |
| OX-LIVE-2026 | https://www.maths.ox.ac.uk/study-here/undergraduate-study/tmua/mat-livestream | Current preparation programme explicitly wider than TMUA; Sept/Oct sessions center mathematical skills and include interview questions. |
| OX-VIS-2026 | https://www.maths.ox.ac.uk/study-here/undergraduate-study/tmua/mat-livestream/visualisation | Current official visualisation guidance and a problem explicitly adapted from a question James Munro used in Oxford Maths interviews. |
| OX-VIS-SOL-2026 | https://www.maths.ox.ac.uk/study-here/undergraduate-study/tmua/mat-livestream/visualisation-solutions | Progression of the adapted interview problem from sketching to iteration and proof. |
| OX-DEMO-2023 | https://www.youtube.com/watch?v=nietXNrjKD8 | Official Undergraduate Study at Oxford Mathematics demonstration interview with tutor prompting and post-interview commentary. |
| OX-LIVE-2025-INTERVIEW | https://youtube.com/live/PaD9Yr7_zKo | Official Oxford Mathematics Plus livestream devoted to sample/used interview questions and interviewer practice. |
| OX-OOMC | https://www.maths.ox.ac.uk/outreach/oxford-online-maths-club | First-party Mathematical Institute archive with several explicitly identified Oxford interview questions and admissions-oriented problem discussions. |
| OX-OOMC-RECTANGLES | https://www.maths.ox.ac.uk/outreach/oxford-online-maths-club/season-2-episode-9 | First-party page identifying a Tom Crawford question as used in interviews and recording related tiling/invariant material. |
| OX-OOMC-CUBICS | https://www.maths.ox.ac.uk/outreach/oxford-online-maths-club/episode-0 | First-party page describing an Oxford maths interview question about constructing cubics from endpoint conditions and its spline continuation. |

### Tier B — authoritative Oxford subject-adjacent evidence

| ID | Source | Caveat |
| --- | --- | --- |
| OX-MATHCS-KANADE | https://www.cs.ox.ac.uk/people/varun.kanade/website/post/2022/06/28/interview-questions.html | Oxford academic describing actual Maths/CS interviews. Useful for interaction structure and the fact that some interviews switch between questions; not evidence that pure Mathematics interviews always do so. |
| OX-MATHCS-Q1 | https://www.cs.ox.ac.uk/people/varun.kanade/website/post/2022/09/15/interview-question1-discussion.html | Actual Maths/CS interview question with detailed tutor commentary on small cases, connections, prompts, and extensions. |
| OX-MATHCS-Q2 | https://www.cs.ox.ac.uk/people/varun.kanade/website/post/2022/12/04/interview-question2-discussion.html | Actual Maths/CS question showing procedural experimentation, mathematical reformulation, subtle reasoning, and generalisation. |
| OX-CRAWFORD | https://tomrocksmaths.com/tag/oxford-interview-question/ | Oxford mathematician/interviewer Tom Crawford's public archive includes multiple questions he explicitly identifies as used in Oxford admissions. Treat interviewer self-report as authoritative for provenance of those specific families, but distinguish it from central departmental policy. |
| OX-SJC-INTERVIEW-RESOURCES | https://www.sjc.ox.ac.uk/discover/news/maths-study-day-2021/ | St John's College explains that interviews are discussions rather than tests and links Crawford's interview videos as remote-interview-style resources. |

### Tier C — secondary navigation/transcript aid only

The 2023 demonstration interview was cross-checked against a transcript mirror for navigation:

- https://sozai.app/transcript/mathematics-demonstration-interview/
- a third-party timestamped transcript of the 2025 Oxford Mathematics Plus interview livestream was used only to navigate the official recording when identifying stages of the confirmed-used addition-cost family.

Do **not** treat transcript providers as Oxford authority. Claims about Oxford practice should point back to the official video or first-party pages.

### Deep corpus vs broader reference inventory

Agent B now maintains two deliberately different source layers:

- [`official-benchmark-corpus.json`](./official-benchmark-corpus.json): **20 deeply annotated** benchmark families/examples. These are selected because the evidence is strong enough to support detailed structural analysis: prerequisites, opening, progression, reasoning, tutor intervention, transfer, and pedagogical role.
- [`reference-inventory.json`](./reference-inventory.json): **34 compact reference fingerprints** spanning confirmed-used questions, official samples/demonstrations, official interview-style continuations, and closely relevant first-party preparation material.

The broader inventory exists primarily as an **anti-collision aid**. It is intentionally compact so it does not become a copied question archive.

**Neither layer is exhaustive. Absence from either file is not evidence of originality.** Agent H must perform external mathematical nearest-neighbour retrieval for every proposed production family; local corpus checks alone can never approve originality.

### 2026 “Precision” evidence-date note

Oxford's current 2026 admissions-livestream schedule lists a session titled **Precision** for **17 September 2026**. As of **4 September 2026**, that session is still in the future and its substantive content is not available evidence for this foundation.

This reference may be used only to note that Oxford has scheduled a session under that title. The `precision-checking` recommendation is instead grounded in already-published material: official sample-question commentary requiring systematic completeness, published 2026 Visualisation material that explicitly warns about false assumptions and unproved graphical inferences, and other first-party examples where candidates must check cases/conditions. Revisit the Precision session only after Oxford publishes it.


---

## 2. Interview-format findings

### 2.1 Stable findings

| Finding | Evidence strength | Authoring consequence |
| --- | --- | --- |
| A Maths interview is roughly 25 minutes; the prospectus gives a typical 20–30 minute range. | Strong, current, first-party | Families should be usable inside a ~25-minute conversation, but may deliberately have more ceiling than can be completed. |
| Exact format varies by college. | Strong | Do not encode one rigid universal script as “the Oxford format.” |
| Tutors may inspect technique or curve sketching, ask an unseen problem, or introduce a definition and ask for consequences. | Strong | Bank must include technique/graph, problem-solving, and unfamiliar-definition formats. |
| Tutors care about thought process, response to new ideas, and response to prompts. | Strong | Evaluation must score process and adaptation, not just final correctness. |
| Whiteboards/handwriting/sketching are a normal part of the current remote setup. | Strong | Visual and diagrammatic families are first-class, not decorative variants. |
| Simple opening questions may precede subject work. | Strong University-wide; less Maths-specific | Support short warm-ups, but do not force every family to contain one. |
| Small cases and diagrams are legitimate starting strategies. | Strong from Mathematics examples and 2026 material | Encode small-case exploration and visualisation as independent reasoning skills. |
| Follow-ups frequently deepen the same idea or ask transfer/generalisation. | Strong examples | Author extensions that test whether the candidate learned a mechanism, not merely whether they can do a harder calculation. |
| Candidates may need hints, make mistakes, or fail to finish. | Strong | Number of prompts alone must not become a direct “bad score.” Track quality of response to prompts. |
| Low prerequisite content can still have a very high ceiling. | Strong tutor commentary in official 2-by-n example | Difficulty needs entry/core/ceiling, not a single label. |

### 2.2 One-family deep dives: supported, not universal

Several strong first-party exemplars are coherent deep dives:

- the ladder trace proceeds from intuition to modelling to a parameterised extension;
- the 2-by-n tiling example proceeds from small cases to recurrence to changed grids/tiles;
- the 2026 iterated-function example proceeds from sketching to composition to iteration to a quantitative proof;
- the official demonstration interview spends the mathematical portion on one tiling family.

However, Oxford states that format varies by college, and an Oxford Maths/CS tutor explicitly notes that they often switch questions to sample different types of thinking.

**Product decision:** keeping a simulated interview within one coherent problem family is a defensible fidelity choice and is especially compatible with between-interview adaptation. It must be documented as an Interview App policy, not as a universal Oxford fact.

### 2.3 Technical warm-ups

Official Maths guidance explicitly allows detailed points of technique and curve sketching. University-wide guidance says interviews may begin with a few simple questions.

Recommended usage:

- 1–4 minute technique check when it creates a natural on-ramp to the family;
- use familiar algebra, graph features, geometric facts, or notation;
- never spend a large share of the interview testing rote content;
- a warm-up should either establish shared notation/fluency or feed the core problem.

### 2.4 Tutor intervention ladder

The evidence supports **adaptive prompts**, but no official source specifies five hint levels. The repository’s existing five-stage hint mechanism is therefore an implementation convention, not an Oxford empirical finding.

Prefer this semantic order:

1. **Clarify / ask for narration** — “What are you trying to show?” “What have you noticed?”
2. **Change representation** — suggest a diagram, table, graph, equation, or labelled small case.
3. **Reduce** — ask for a small/symmetric/special case or isolate a subproblem.
4. **Local observation** — point to a relevant relation without giving the decisive mechanism.
5. **Structural direction** — surface the main connection only when earlier interventions have failed.
6. **Strong clue / recovery** — provide enough structure to keep the conversation moving, then test whether the candidate can use it.

The current five protected hint stages can approximate this ladder, but authors should not force every real interaction through all five.

---

## 3. What Oxford appears to assess

### 3.1 Reasoning-skill map

These are problem/evidence dimensions, not personality scores.

| Skill | Observable behavior | Evidence |
| --- | --- | --- |
| technique | Executes familiar algebra/calculus/geometry accurately enough to support reasoning. | OX-INTERVIEWS |
| visualization | Builds a useful diagram, graph, geometric picture, or table. | OX-INTERVIEWS; OX-VIS-2026 |
| graph sketching | Uses asymptotics, turning points, symmetries, transformations, or qualitative behavior. | OX-INTERVIEWS; OX-VIS-SOL-2026 |
| small-case exploration | Chooses informative examples systematically rather than randomly. | OX-SAMPLE; OX-VIS-2026; OX-MATHCS-Q1 |
| pattern recognition | Notices a recurrence, invariant, parity behavior, or structural regularity. | OX-SAMPLE; OX-DEMO-2023 |
| conjecture formation | Turns examples/visual evidence into a testable general claim. | OX-SAMPLE; OX-VIS-SOL-2026 |
| proof construction | Converts intuition into a logically sufficient argument. | OX-SAMPLE; OX-CRITERIA |
| counterexample construction | Tests boundaries and false converses/overgeneralizations. | Common consequence of definition work; weaker direct evidence |
| invariants | Finds a quantity/relation unchanged by a process. | Official interview materials and examples |
| abstraction | Removes irrelevant context and identifies the mathematical core. | OX-SAMPLE ladder commentary |
| modelling | Introduces variables/constraints that accurately represent a situation. | OX-SAMPLE ladder commentary |
| definition exploration | Uses a definition just introduced to derive examples/consequences. | OX-INTERVIEWS |
| generalization | Extends a result by parameter, dimension, or class. | OX-SAMPLE; OX-MATHCS-Q1 |
| transfer | Reuses a learned mechanism in a modified problem. | OX-SAMPLE 2-by-n progression |
| representation switching | Moves between picture, table, algebra, graph, recurrence, or verbal structure. | OX-SAMPLE; OX-VIS-2026 |
| error recovery | Notices/corrects a false start without losing the mathematical thread. | OX-DEMO-2023 |
| case analysis | Partitions possibilities systematically and checks coverage. | OX-SAMPLE 2-by-n |
| strategic simplification | Replaces a hard general problem with a revealing smaller/special case. | OX-SAMPLE; OX-MATHCS-Q1 |
| **guided adaptation** | After a tutor prompt, incorporates the new idea and advances rather than merely repeating it. | OX-PROSPECTUS; OX-SAMPLE; OX-DEMO-2023 |
| **precision/checking** | Checks assumptions, omitted cases, signs, edge cases, and whether a diagram/argument actually proves the claim. | OX-SAMPLE; published OX-VIS-2026 material (including explicit false-assumption/case-checking guidance) |

The last two are the only additions this research recommends to Agent A’s current reasoning-skill enum.

### 3.2 Candidate-level criteria that should not be confused with problem tags

Oxford’s admissions criteria also mention:

- capacity to absorb and use new ideas;
- ability to think/work independently;
- perseverance and enthusiasm.

These are useful **session evaluation dimensions**, but they should not be treated as mathematical domains. In particular, “perseverance” should not be inferred from how long the model lets a candidate struggle.

---

## 4. Prerequisite vs subject vs reasoning: three separate axes

### 4.1 Prerequisite toolkit

TMUA is useful for checking what can safely be treated as familiar school mathematics, because Oxford currently uses it for shortlisting and explicitly describes it as depth-over-breadth and approachable without Further Mathematics.

Typical toolkit buckets:

- arithmetic, fractions, powers, surds;
- algebraic manipulation, equations and inequalities;
- polynomials and factorisation;
- functions and graph basics;
- sequences/series and simple recurrences;
- exponentials/logarithms;
- trigonometry;
- coordinate and Euclidean geometry basics;
- differentiation and standard applications;
- integration at school level;
- elementary proof/logic;
- standard combinatorial notation where specified.

**Do not infer that every item in Agent A’s prerequisite enum is universally known by every applicant.** A prerequisite tag means “this family expects this concept without teaching it,” not “Oxford guarantees all applicants have studied it.”

### 4.2 Interview subject

Interview subject can be broader than TMUA when the problem is self-contained. Official Maths guidance explicitly allows tutors to give a mathematical definition and ask candidates to derive consequences.

Reasonable families therefore include:

- elementary number theory and divisibility;
- combinatorial structures/invariants;
- graph theory introduced from scratch;
- functional equations;
- iterated functions/dynamical behavior;
- unfamiliar operations/relations/definitions;
- geometric constructions and spatial reasoning;
- elementary probability if prerequisites are supplied or standard;
- modelling contexts;
- proof-oriented elementary analysis;
- graph transformations and qualitative calculus.

The governing constraint is **prerequisite burden**, not whether the topic has a school-subject label.

### 4.3 Reasoning skill

Two questions in the same subject can test very different skills. Likewise, small-case exploration, transfer, modelling, or definition exploration can occur across multiple domains.

The recommender should therefore select on all three axes rather than treating “weak at number theory” and “weak at conjecture formation” as equivalent.

---

## 5. Abstract Oxford-like family patterns

These are reusable **shapes**, not problem templates. Authors must change the mathematical kernel as required by the originality audit.

### F1 — Visual intuition → model → proof → parameter

- accessible visual situation;
- candidate predicts/sketches;
- tutor asks how to test the sketch;
- introduce variables/equations;
- prove the locus/property;
- move the marked point or parameter;
- ask what remains invariant and what changes.

Best for: modelling, representation switching, geometry, graphing.

### F2 — Small cases → pattern → structural recurrence → transfer

- compute/draw cases 1–4;
- require systematic enumeration;
- notice a sequence/pattern;
- derive why the recurrence appears;
- change dimension/object/allowed move;
- reuse the learned decomposition.

Best for: combinatorics, recurrences, learning from the interview.

### F3 — Sketch → transform/compose → iterate → prove behavior

- sketch a parameterised function qualitatively;
- identify asymptotics/turning points;
- reason about a composition without brute-force expansion;
- iterate and conjecture limiting behavior;
- prove a bound/contraction/monotonicity statement;
- interpret why convergence is fast/slow.

Best for: graph sketching, analysis, sequences, transfer between representations.

### F4 — New definition → examples → consequences → boundary cases

- tutor introduces a short unfamiliar definition;
- candidate creates examples/nonexamples;
- derive an immediate lemma;
- test a converse or closure property;
- find counterexample or necessary condition;
- generalize/compare with a modified definition.

Best for: abstraction, definition exploration, proof, counterexamples.

### F5 — Technique check → perturb condition → reveal structure

- short familiar calculation/graph/identity;
- alter one condition so routine technique becomes awkward;
- ask what the calculation suggests structurally;
- identify invariant/symmetry/representation;
- prove a broader statement or converse.

Best for: technique without turning interview into an exam.

### F6 — Construction/impossibility → local obstruction → generator

- try very small sizes;
- distinguish possible/impossible cases;
- identify a local structural obstruction;
- find a construction that grows solutions;
- determine coverage/exceptions;
- ask whether the obstruction is also sufficient.

Best for: geometry/tilings/combinatorics.

### F7 — Apparent optimization/search → hidden invariant

- candidate initially compares choices/orders;
- compute two or three examples;
- notice same quantity/result;
- formulate invariance;
- prove it without exhaustive enumeration;
- modify the cost/operation and ask when invariance survives.

Best for: algebra, combinatorics, modelling.

### F8 — Geometry → alternate representation → inequality/optimization

- draw a geometric configuration;
- express it using coordinates/vectors/lengths;
- reveal a second representation;
- use it to prove an extremal relation;
- transfer to a related algebraic inequality.

Best for: geometric visualization and representation change.

### F9 — Too-hard generality → special case → mechanism → restore generality

- pose an unfamiliar general question;
- if stalled, reduce to small/symmetric/single-parameter case;
- extract the mechanism from that case;
- return to the original statement;
- ask which assumptions were truly necessary.

Best for: strategic simplification and guided adaptation.

### F10 — Context → abstraction → sanity check → generalization

- simple physical/algorithmic/everyday context;
- strip context to variables/constraints;
- solve or characterize mathematically;
- compare result with initial intuition;
- vary a parameter or rule and rebuild the model.

Best for: modelling and abstraction.

---

## 6. Recommended 72-family bank coverage

**Semantics contract:** the numbers below are a **coverage-capacity allocation**, not observed Oxford question frequencies.

They MUST NOT be interpreted as:

- historical percentages of Oxford interview questions;
- empirical Oxford topic priors;
- default recommendation sampling weights;
- evidence that a domain with 7 slots should be selected more often than one with 3 slots.

The allocation answers a product-design question — “how much authored capacity should the bank contain so that it can cover the required mathematical/reasoning space?” — not a historical-frequency question.

A future recommendation engine should choose the next family primarily from **student need/evidence, uncertainty, appropriate difficulty, prerequisites, recent exposure, family/similarity repetition control, and portfolio availability**. These 72 target counts should constrain whether the bank has enough breadth; they should not directly control per-student sampling.

This is an **internal portfolio recommendation**, not a claim about Oxford’s empirical question frequencies. Counts are primary-domain assignments; individual families should carry multiple domain/skill tags.

| Agent A primary domain | Families |
| --- | ---: |
| algebra | 5 |
| functions | 5 |
| graph-sketching | 7 |
| sequences-recurrences | 5 |
| trigonometry | 2 |
| coordinate-geometry | 4 |
| euclidean-geometry | 6 |
| calculus | 6 |
| elementary-analysis | 4 |
| probability | 4 |
| combinatorics | 7 |
| number-theory | 6 |
| graph-theory | 3 |
| logic-proof | 2 |
| functional-equations | 3 |
| set-theory | 3 |
| **Total** | **72** |

### Cross-cutting portfolio targets

These overlap and therefore do not sum to 72.

| Feature | Recommended target |
| --- | ---: |
| Productive/accessible opening | >= 60 |
| High-ceiling optional extension | >= 45 |
| Explicit proof/explanation core | >= 40 |
| Transfer/generalisation stage | >= 35 |
| Representation switch required | >= 25 |
| Small-case exploration useful | >= 18 |
| Graph/curve-heavy families | 14–18 |
| Geometry/diagram-heavy families | 14–18 |
| New definition or mini-theory introduced | 10–14 |
| Technique/warm-up capable opening | 10–14 |
| Modelling/translation component | 8–12 |
| Counterexample/boundary-testing component | 8–12 |

### Why this is not an equal school-subject split

Oxford’s own examples reward movement between representations and the use of low-prerequisite material with substantial internal complexity. A bank balanced only as “algebra / geometry / number theory / combinatorics” would miss:

- graph sketching as an interview format;
- unfamiliar definitions;
- modelling;
- technical checks;
- transfer after learning;
- visual reasoning;
- deep extensions whose content is not a separate school topic.

---

## 7. Current Interview App bank audit

At the inspected `main` revision, the default Oxford bank contains 13 problems: 10 current curated Oxford entries plus 3 legacy Oxford entries. One additional curated Oxford problem is held in expert review.

### Category concentration

Among the 10 current curated Oxford entries:

- 4 are categorised as number theory;
- 2 are introductory-plus, 7 standard, and 1 stretch by the current single-label scheme;
- there is one geometry entry;
- there is no explicit graph-sketching family.

Including the 3 legacy Oxford entries, at least 9/13 default problems are categorised in number theory, combinatorics, graph theory, or set theory.

### Main gaps

1. **Curve/graph sketching:** effectively absent as a primary family despite being named in current official Maths interview guidance.
2. **Geometric visualisation:** one geometry category is too little for a whiteboard-native simulator.
3. **New-definition exploration:** no clear portfolio of self-contained mini-theory questions.
4. **Modelling:** underrepresented relative to the official ladder example.
5. **Technique warm-ups:** current bank is mostly complete proof/problem tasks rather than technical openings that deepen.
6. **Accessible-start/high-ceiling design:** several current items are known theorem/puzzle statements rather than deliberately staged interview families.
7. **Originality provenance:** the bank contains many classic, widely circulated problems/theorems. They may be useful fixtures, but they must be marked as `classic-problem` rather than treated as evidence that a new authored item is original.

### Priority correction order

1. graph/curve sketching;
2. geometry/visualisation;
3. unfamiliar-definition families;
4. modelling/representation-switching;
5. high-ceiling families with low prerequisite burden;
6. then fill ordinary domain gaps.

Do **not** solve the imbalance merely by writing more number-theory/combinatorics questions.

---

## 8. Difficulty calibration

### 8.1 Oxford does not publish a numerical interview difficulty scale

Use an internal ordinal vocabulary only:

1. `warm-up`
2. `introductory`
3. `introductory-plus`
4. `standard`
5. `strong`
6. `stretch`

The labels are app anchors, not official Oxford labels.

### 8.2 Always calibrate entry, core, and ceiling separately

This directly matches Agent A’s current `OxfordDifficultyProfile`.

| Band | Entry/core interpretation |
| --- | --- |
| warm-up | Direct familiar technique or representation check; little conceptual barrier. |
| introductory | Candidate can begin with obvious examples/diagram/standard manipulation; one mild idea. |
| introductory-plus | One nontrivial connection or organization step, but substantial scaffolding remains visible. |
| standard | A meaningful central insight plus a logically complete explanation; typically multi-stage. |
| strong | Several linked insights, a representation change, or transfer with substantial independence. |
| stretch | Deliberately high ceiling: unfamiliar abstraction, multiple structural jumps, or a deep extension; completion is not expected. |

A family can validly be:

- entry = introductory,
- core = standard,
- ceiling = stretch.

That shape is more Oxford-like than labelling the entire family “stretch.”

### 8.3 Difficulty dimensions to record during expert calibration

Rate each qualitatively (0–3 is sufficient for internal worksheets; do not expose as an Oxford score):

- prerequisite burden;
- initial insight barrier;
- number of conceptual jumps;
- abstraction level;
- proof/rigour burden;
- number/severity of representation changes;
- expected amount of **productive** prompting for a strong applicant;
- extension ceiling.

Do not mechanically sum these to produce the final band. Two problems can have the same total for very different reasons.

### 8.4 Prompting is not a penalty counter

Official material repeatedly treats prompting as part of the conversation. Calibration should distinguish:

- **prompt dependency**: how much guidance was needed;
- **guided adaptation**: how effectively the candidate used the guidance.

A candidate who needs one structural nudge and then transfers it powerfully may provide stronger evidence than a candidate who reaches an answer quickly but cannot explain/generalize.

---

## 9. Timing guidance

### Officially anchored

- Maths-specific current guidance: each interview is about 25 minutes.
- Current prospectus: interviews are typically 20–30 minutes.
- The official 2-by-n sample commentary describes the opening small cases as a relatively comfortable few minutes.

These are **whole-interview / broad conversational anchors**. Oxford does not publish a pacing script for individual stages.

### Not officially anchored

Oxford does **not** publish:

- expected first-insight time per family;
- expected independent completion time;
- expected prompted completion time;
- extension time;
- stage soft cutoffs;
- a time-to-grade conversion;
- a rule saying every warm-up/core/extension should consume a fixed share of 25 minutes.

Therefore Agent A's `OxfordTimingEstimate` is an internal product model.

### Initial product heuristics

Use only as low-confidence author estimates until pilot data exists:

| Phase | Soft planning range |
| --- | --- |
| setup / warm-up | 1–4 min |
| exploration / representation | 3–6 min |
| core reasoning | 7–12 min |
| extension / transfer | 4–8 min |

These ranges:

- may overlap;
- may be skipped;
- may be much shorter or much longer for a particular family;
- must **not** hard-stop the candidate or automatically trigger a hint/transition;
- must **not** be enforced as mandatory stage targets.

A realistic ~25-minute interview can spend most of its mathematical time on one core development if that conversation remains productive. Conversely, a candidate may move rapidly through an opening and reach several extensions.

**Stage changes should occur at mathematically natural transition points**: a useful conjecture has been formed, a proof has reached a coherent conclusion, a representation change is warranted, the current route is exhausted, or a transfer question becomes pedagogically useful. A nominal minute window expiring is not itself a mathematical reason to switch stages.

For new authored families:

- mark timing calibration `expert-estimate` only after an actual estimate has been made;
- normally use low confidence before repeated pilot evidence;
- retain more mathematical ceiling than the nominal interview length;
- permit the interview to stop at a mathematically natural point before “completion”;
- calibrate each family independently rather than fitting it to the generic table above.

Empirical calibration should later use distributions conditioned on candidate strength, assistance history, and stage reached, not a single average. Timing exists to support realism and operational planning, not to force scripted pacing.

---

## 10. Reconciliation with Agent A PR #126

Re-checked against **Agent A PR #126**, latest reviewed head `00824aebdc7392c9c83a2c1cd29bb02c93b73487`.

### Strong alignment

Agent A's current contract still cleanly supports the core research needs:

| Research need | Agent A contract |
| --- | --- |
| subject vs prerequisite vs reasoning | `domains`, `prerequisiteConcepts`, `skillEvidence` |
| accessible start + high ceiling | difficulty `entry/core/ceiling` |
| interview progression | stage DAG + `warm-up/technique-check/core/deep-dive/transfer/stretch` |
| visual/graph format | `visualization`, `graph-sketching` skills + graph-sketching domain |
| small cases/conjecture/proof | explicit reasoning-skill tags |
| new definition | `definition-exploration` + `introducesNewDefinition` |
| between-interview repetition control | `familyId`, `similarityClusterId` |
| provenance/originality | provenance + independent review status |
| uncertain calibration | estimate confidence + calibration status |

### Remaining synchronization requirement: two reasoning skills are still absent

At the latest #126 head, the canonical reasoning enum still has neither:

- `guided-adaptation`;
- `precision-checking`.

Agent B recommends adding both (or semantically equivalent bounded tags) **before Wave 2 authoring freezes metadata**, rather than forcing authors to misuse nearby tags.

#### Why `guided-adaptation` is distinct

The product needs two separate facts:

1. **Assistance/prompt dependency:** did the candidate need a tutor intervention to progress?
2. **Guided adaptation:** once an intervention supplied a new representation, observation, subproblem, or idea, did the candidate understand it, integrate it, and use it productively?

Those are not opposites and should not collapse into one score.

`guided-adaptation` is distinct from:

- **`error-recovery`** — recovering after the candidate's own unsuccessful/incorrect approach. A candidate can adapt superbly to a tutor's new idea without first making an error, or can correct an error without using any tutor-supplied idea.
- **hint responsiveness / assistance level** — assistance records *what help was supplied/how much was needed*. Guided adaptation records the *quality of mathematical use after that help*. A student can receive the same prompt as another student and respond very differently.
- **`transfer`** — applying an established mechanism to a modified problem, representation, or context. Guided adaptation may occur inside the original core problem immediately after a tutor prompt, before any transfer question exists.
- **independence** — unaided progress. Independence decreases when help is needed; guided adaptation can still be strong after help. Oxford's interview format is specifically useful because tutors can observe both.

Recommended evidence unit: milestone/stage evidence should record assistance through the existing evaluation seam and independently tag `guided-adaptation` when the post-prompt response itself is what the milestone tests.

#### Why `precision-checking` remains useful

This skill covers deliberate verification that:

- all cases have been considered;
- an assumption has not slipped in unnoticed;
- signs/endpoints/domain restrictions are correct;
- a graphical or numerical pattern actually proves the claim;
- a proposed converse/sufficiency statement is justified.

It overlaps with technique and error recovery but is observable even when no error has yet occurred. Published Oxford material repeatedly asks candidates to move from plausible picture/enumeration to a checked, sufficient argument.

### Coordination boundary

Agent B is not editing Agent A's branch. PR #127 remains docs/data-only and independent. The synchronization needed before Agents C–E bulk-author metadata is unambiguous: Agent A should either add these two bounded concepts or explicitly provide equivalent canonical representations so authoring agents do not improvise free-form tags.

### Timing warning for Agent A

The latest #126 contract requires problem/stage timing metadata. That remains compatible with this research **only if the values are treated as internal estimates rather than pacing obligations**.

New problem authors must not cite Oxford as the source of stage timing values. `timingCalibration = "expert-estimate"` should remain until enough observed sessions justify `empirically-calibrated`, and runtime/recommendation logic should not advance stages solely because a `softCutoffMinutes` value has elapsed.

---

## 11. Originality policy summary

Full procedure: [`originality-audit.md`](./originality-audit.md).

The audit now requires five comparison pools for **every** proposed family:

1. deep official benchmark corpus;
2. broader official/reference inventory;
3. current Interview App bank;
4. same-wave generated candidate families;
5. **mandatory external/classic mathematical nearest-neighbour retrieval** based on the mathematical fingerprint.

External retrieval must search mathematical structure, not only generated wording: normalized objects/constraints/target, central mechanism, progression signature, representation change, diagram topology, and extension/generalisation path.

The final originality record must retain the strongest plausible nearest matches and briefly explain mathematically why each is safe or too close.

**The local benchmark corpus is not an exhaustive whitelist of Oxford questions. Passing local similarity checks alone is insufficient for originality approval.**

A family is **not original enough** merely because:

- variables/numbers changed;
- people/objects/context changed;
- the diagram was relabelled/redrawn;
- prose was rewritten;
- a famous problem gained an extra extension;
- the same central invariant/trick is presented in the same reveal path.

Allowed inspiration is at the level of **reasoning shape**, e.g. “small cases → conjecture → proof → generalise,” while the mathematical kernel and progression specifics must be independent.

---

## 12. Wave 2 handoff: Agents C–H

All downstream agents should use Agent A's canonical schema plus this research layer. No Wave 2 agent should invent a parallel taxonomy.

### 12.1 Agent C — graphs/functions/algebra/calculus/sequences author

Primary remit:

- graph/curve sketching;
- functions and transformations;
- algebra;
- calculus;
- sequences/recurrences.

Requirements:

- prioritise the documented graph-sketching deficit;
- include families where school technique is only the opening and the core becomes structural;
- use the 20 deep benchmarks for pedagogical shape, not as mutation templates;
- check the 34-entry inventory before drafting and run external fingerprint search before originality approval;
- separate prerequisites from interview subject;
- author entry/core/ceiling and stage roles through Agent A's schema;
- keep new material in review until Agent H passes both fidelity and originality.

### 12.2 Agent D — combinatorics/number theory/graph theory/proof/invariants author

Primary remit:

- combinatorics;
- number theory;
- graph theory;
- proof structures/invariants.

Requirements:

- treat this as the highest collision-risk authoring area because the current bank and classic puzzle literature are already concentrated here;
- do **not** add familiar classics merely to increase count;
- external nearest-neighbour retrieval is mandatory even when wording is novel;
- diversify mechanisms beyond coloring, pigeonhole, parity, standard contradiction, and textbook recurrences;
- build accessible openings that reveal proof decisions rather than single-trick puzzle recognition;
- use `similarityClusterId` aggressively when distinct approved families still exercise closely related mechanisms.

### 12.3 Agent E — geometry/modelling/probability/unfamiliar-definition/abstraction author

Primary remit:

- Euclidean/coordinate geometry and visualisation;
- modelling;
- elementary probability where prerequisites are controlled;
- unfamiliar-definition / mini-theory families;
- abstraction and representation change.

Requirements:

- help correct the current visual-geometry and new-definition deficits;
- design whiteboard-native families where diagrams carry reasoning evidence;
- for unfamiliar definitions, teach the definition inside the family and test examples/consequences/converses rather than prior vocabulary;
- distinguish modelling skill from mere word-problem context;
- ensure diagram topology is included in the originality fingerprint and external search.

### 12.4 Agent F — recommendation/evidence tooling

Primary remit:

- connect Agent A metadata to grounded session evidence;
- distinguish milestone/process evidence;
- build between-interview recommendation/tooling rather than in-interview topic hopping.

Requirements from Agent B:

- **never convert the 72-family coverage counts into Oxford-frequency priors or automatic sampling weights**;
- select based on student need/strength/weakness, uncertainty, difficulty fit, prerequisites, recent exposure, family/similarity repetition control, and available calibrated content;
- distinguish “needed a prompt” from “used the prompt well” once Agent A resolves `guided-adaptation`;
- only grounded milestone evidence should update reasoning-skill estimates;
- keep uncertainty high when a skill/domain has little evidence;
- keep one live interview coherent within its selected family except for mathematically natural stages/extensions.

### 12.5 Agent G — difficulty/timing calibration

For every family:

- calibrate `entry`, `core`, and `ceiling` independently;
- record which difficulty dimensions drive the label;
- keep prerequisite burden separate from reasoning difficulty;
- keep prompt dependency separate from guided adaptation;
- mark initial timing as an internal expert estimate, normally low confidence;
- **do not fit stages to the generic timing table**;
- permit substantial family-specific timing deviation and mathematically natural stopping points;
- use pilot distributions before upgrading to `empirically-calibrated`;
- never describe the internal bands/minutes as official Oxford ratings or stage expectations.

### 12.6 Agent H — Oxford fidelity/originality auditor

Agent H must be independent of the authoring agent.

For every proposed family, H receives:

- generated family + Agent A metadata;
- mathematical fingerprint;
- nearest local benchmark/inventory/app-bank/same-wave matches;
- external-search results;
- no author self-assessment as authoritative evidence.

H must independently complete the five-pool retrieval in [`originality-audit.md`](./originality-audit.md), including external mathematical search. A clean local corpus check alone cannot produce `PASS`.

H returns separate decisions for:

- originality;
- Oxford fidelity.

A mathematically excellent problem can fail originality. An original problem can fail fidelity. Both gates must pass.

### 12.7 Shared Wave 2 authoring gate

Before a family is production-ready:

1. Agent A metadata is canonical and complete enough for review.
2. Mathematical correctness/solvability is independently checked.
3. Difficulty has at least a truthful expert estimate.
4. Timing is explicitly internal/non-scripted unless empirically calibrated.
5. Provenance is recorded.
6. All five originality retrieval pools have been searched.
7. Agent H approves originality.
8. Agent H approves Oxford fidelity.
9. The family does not create an unacceptable similarity/repetition cluster in the overall bank.

Agents C–E should not bulk-author ahead of unresolved taxonomy semantics for `guided-adaptation` / `precision-checking`; if Agent A has not synchronized those tags, record the evidence need without inventing replacement free-form strings.

---

## 13. Weak or ambiguous evidence

Do not overclaim these points:

1. **Number of problems per pure Maths interview:** no current first-party rule. Deep single-family examples are common in the benchmark evidence, but Maths/CS evidence confirms switching can occur.
2. **Official topic frequency:** not published. The 72-family distribution is a deliberate simulator portfolio, not a historical frequency estimate.
3. **Numerical difficulty:** not published.
4. **Stage timing:** not published.
5. **Exact hint count:** not published.
6. **How much prompting corresponds to a successful candidate:** no simple published mapping; official examples explicitly warn against inferring performance from help alone.
7. **Probability/statistics frequency in interviews:** insufficient evidence to assign an Oxford frequency. Keep some elementary probability for breadth, but do not over-weight it based on the degree syllabus.
8. **Advanced school material:** interviewers can introduce unfamiliar ideas or work with material the candidate has studied, so authoring should avoid assuming a uniform Further Mathematics background.
9. **One-family policy:** a product choice for coherence and between-interview adaptation, not a universal Oxford rule.
10. **Current bank semantics:** the concentration audit is based on catalog metadata and inspected authored entries; it is not a claim that every problem exercises only its primary category.
11. **2026 Precision session:** scheduled for 17 September 2026 and therefore unpublished as of this research cutoff (4 September 2026); its title is not substantive evidence.
12. **Reference inventory completeness:** 34 compact entries materially improve collision coverage, but Oxford does not publish an exhaustive historical question archive. External retrieval remains mandatory.

---

## 14. Acceptance checklist for this research foundation

A downstream authoring/calibration system is using this foundation correctly when:

- [ ] official source provenance is retained without copying full questions;
- [ ] benchmark records describe structure rather than reproduce problem text;
- [ ] prerequisite, subject, and reasoning are independent;
- [ ] graph/visual and unfamiliar-definition families are first-class;
- [ ] entry/core/ceiling are distinct;
- [ ] timing is labelled internal until empirical;
- [ ] prompt response is evaluated separately from prompt count;
- [ ] family selection happens primarily between interviews;
- [ ] in-interview adaptation normally deepens the coherent family;
- [ ] originality audit checks mathematical structure, not only text similarity;
- [ ] broader reference inventory is checked but never treated as exhaustive;
- [ ] external/classic nearest-neighbour retrieval is completed for every proposed family;
- [ ] classic problems are explicitly labelled as classic;
- [ ] 72-family domain counts are treated as coverage-only, never empirical Oxford frequencies or recommender priors;
- [ ] stage timing remains soft/internal and never forces a mathematically unnatural transition;
- [ ] Agent A vocabulary is used wherever available.
