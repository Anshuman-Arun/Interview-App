import { authorCuratedProblem, type CuratedProblemSpec } from "../curated-authoring.js";

export const quantBirthdayCollisionSpec: CuratedProblemSpec = {
  "id":"quant-birthday-collision",
  "title":"Birthday Collision Threshold",
  "mode":"QUANT",
  "category":"probability",
  "topics":["complements","approximation","occupancy","expected collisions"],
  "difficulty":"quant-standard",
  "prompt":"Assume 365 equally likely birthdays and ignore leap years. For n people, derive the probability that at least two share a birthday. Then estimate the smallest n for which this probability exceeds 1/2.",
  "givenInformation":["Birthdays are independent and uniformly distributed over 365 days."],
  "approaches":[{"id":"complement-product","label":"Compute probability of all distinct birthdays"},{"id":"log-approximation","label":"Approximate the product using logarithms"}],
  "milestones":[
    {"id":"use-complement","description":"Replace the collision event by the easier event that all birthdays are distinct.","approachIds":["complement-product","log-approximation"],"hintLevels":[1]},
    {"id":"product","description":"Derive P(no collision)=∏_{k=0}^{n-1}(365-k)/365.","approachIds":["complement-product","log-approximation"],"prerequisiteIds":["use-complement"],"hintLevels":[2]},
    {"id":"collision-formula","description":"Take one minus the product for the exact answer.","approachIds":["complement-product"],"prerequisiteIds":["product"],"hintLevels":[3]},
    {"id":"approximate-log","description":"Use log(1-x)≈-x to obtain P(no collision)≈exp(-n(n-1)/(2·365)).","approachIds":["log-approximation"],"prerequisiteIds":["product"],"hintLevels":[4]},
    {"id":"threshold","description":"Solve the approximation and verify the exact threshold n=23.","approachIds":["complement-product","log-approximation"],"prerequisiteIds":["collision-formula","approximate-log"],"hintLevels":[5]}
  ],
  "edges":[{"from":"use-complement","to":"product"},{"from":"product","to":"collision-formula"},{"from":"product","to":"approximate-log"},{"from":"collision-formula","to":"threshold"},{"from":"approximate-log","to":"threshold"}],
  "commonErrors":[{"id":"pair-independence","description":"Treats pairwise collision events as independent and multiplies or sums them exactly."},{"id":"forget-complement","description":"Computes the no-collision probability but reports it as the collision probability."}],
  "followUps":["Why is the threshold on the order of √365 rather than 365?","What is the expected number of colliding pairs at n=23?"],
  "extensions":[{"id":"d-days","prompt":"Replace 365 by d and derive the √d threshold scale."},{"id":"nonuniform","prompt":"Discuss qualitatively how nonuniform birthday probabilities affect collision likelihood."}],
  "hints":[
    {"level":1,"text":"It is easier to compute the probability that every birthday is different.","formulations":["use the complement","compute no shared birthdays first"]},
    {"level":2,"text":"The first birthday is unrestricted, the second must avoid one day, the third must avoid two, and so on.","formulations":["product 365 over 365 times 364 over 365","multiply distinct birthday probabilities"]},
    {"level":3,"text":"So P(collision)=1-∏_{k=0}^{n-1}(1-k/365).","formulations":["one minus product","exact collision probability"]},
    {"level":4,"text":"For moderate n, log P(no collision)≈-∑k/365=-n(n-1)/(730).","formulations":["log approximation","exp minus n n minus one over 730"]},
    {"level":5,"text":"Setting the approximation near 1/2 gives n around 23; direct evaluation shows n=22 is below 1/2 and n=23 is above.","formulations":["threshold 23 people","smallest n is 23"]}
  ],
  "canonicalSolution":"The probability of no shared birthday is 1·(364/365)·(363/365)⋯((365-n+1)/365)=∏_{k=0}^{n-1}(1-k/365), for n≤365. Hence P(at least one collision)=1 minus that product. For an estimate, log P(no collision)=∑_{k=0}^{n-1}log(1-k/365)≈-∑k/365=-n(n-1)/(2·365). Thus P(no collision)≈exp(-n(n-1)/730). Setting this equal to 1/2 gives n(n-1)≈730 ln2≈506, suggesting n≈23. Exact evaluation confirms P(collision)≈0.476 at n=22 and ≈0.507 at n=23, so the smallest n is 23.",
  "verificationNotes":"The exact formula is a complement product, not a product of pairwise-independent events. The 22/23 numerical values are standard approximations and should be rechecked in any later numerical-content audit."
};

export const quantBirthdayCollisionEntry = authorCuratedProblem(quantBirthdayCollisionSpec);
