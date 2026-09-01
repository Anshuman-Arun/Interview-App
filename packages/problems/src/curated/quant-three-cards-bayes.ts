import { authorCuratedProblem, type CuratedProblemSpec } from "../curated-authoring.js";

export const quantThreeCardsBayesSpec: CuratedProblemSpec = {
  "id":"quant-three-cards-bayes",
  "title":"Three Cards and a Revealed Side",
  "mode":"QUANT",
  "category":"Bayesian reasoning",
  "topics":["conditional probability","selection bias","symmetry","sample spaces"],
  "difficulty":"quant-standard",
  "prompt":"A box contains three cards: one is red on both sides (RR), one blue on both sides (BB), and one red on one side and blue on the other (RB). A card is chosen uniformly and placed on the table with a uniformly random side facing up. The visible side is red. What is the probability the hidden side is also red?",
  "givenInformation":["Each card is chosen with probability 1/3.","Conditional on the card, each side is equally likely to face up."],
  "approaches":[{"id":"exposed-sides","label":"Condition on equally likely exposed sides"},{"id":"bayes-cards","label":"Bayes over card identities"}],
  "milestones":[
    {"id":"define-observation","description":"Condition on the event that the visible side is red.","approachIds":["exposed-sides","bayes-cards"],"hintLevels":[1]},
    {"id":"count-red-faces","description":"Count the equally likely red-facing outcomes across the three cards.","approachIds":["exposed-sides"],"prerequisiteIds":["define-observation"],"hintLevels":[2]},
    {"id":"bayes-weights","description":"Alternatively compute P(red visible | RR), P(red visible | RB), and P(red visible | BB).","approachIds":["bayes-cards"],"prerequisiteIds":["define-observation"],"hintLevels":[3]},
    {"id":"posterior-card","description":"Find the posterior probability that the chosen card is RR given a red visible side.","approachIds":["exposed-sides","bayes-cards"],"prerequisiteIds":["count-red-faces","bayes-weights"],"hintLevels":[4]},
    {"id":"hidden-side","description":"Translate the posterior card identity into the probability the hidden side is red.","approachIds":["exposed-sides","bayes-cards"],"prerequisiteIds":["posterior-card"],"hintLevels":[5]}
  ],
  "edges":[{"from":"define-observation","to":"count-red-faces"},{"from":"define-observation","to":"bayes-weights"},{"from":"count-red-faces","to":"posterior-card"},{"from":"bayes-weights","to":"posterior-card"},{"from":"posterior-card","to":"hidden-side"}],
  "commonErrors":[{"id":"fifty-fifty-cards","description":"Says RR and RB are the two remaining possibilities and therefore equally likely, ignoring that RR has two red faces that could generate the observation."},{"id":"count-cards-not-faces","description":"Conditions on card identities without weighting by the probability of showing red."}],
  "followUps":["Solve the same problem by writing Bayes' theorem explicitly.","How does the answer change if card sides are not equally likely to face up?"],
  "extensions":[{"id":"general-double-single","prompt":"Generalize to a box with a double-red cards and b red-blue cards after observing red."},{"id":"biased-orientation","prompt":"Let the two sides of RB have unequal probabilities of facing up and recompute the posterior."}],
  "hints":[
    {"level":1,"text":"The observation 'red is visible' is more likely under some cards than others.","formulations":["condition on seeing red","observation has different likelihoods by card"]},
    {"level":2,"text":"There are three equally likely red-facing sides consistent with the observation: two belong to RR and one belongs to RB.","formulations":["two red faces on RR and one on RB","three red-facing outcomes"]},
    {"level":3,"text":"Bayes gives likelihoods 1 for RR, 1/2 for RB, and 0 for BB.","formulations":["likelihoods one one half zero","P(red|RR)=1 P(red|RB)=1/2"]},
    {"level":4,"text":"After weighting equal card priors, RR has posterior probability 2/3 and RB has 1/3.","formulations":["posterior RR two thirds","RR twice as likely as RB"]},
    {"level":5,"text":"The hidden side is red exactly when the card is RR, so the answer is 2/3.","formulations":["hidden side red probability two thirds","answer 2/3"]}
  ],
  "canonicalSolution":"Condition on the visible side being red. One can enumerate equally likely card-side outcomes: RR has two red sides that could be showing, RB has one, and BB has none. Thus among the three red-facing elementary outcomes, two come from RR and one from RB, so P(RR|red visible)=2/3. Equivalently, Bayes weights the equal card priors by likelihoods 1, 1/2, and 0, giving posterior weights 1/3 and 1/6, hence 2/3 for RR. The hidden side is red exactly for RR, so the desired probability is 2/3.",
  "verificationNotes":"The key is selection bias from observing a side, not merely eliminating BB and treating RR/RB equally."
};

export const quantThreeCardsBayesEntry = authorCuratedProblem(quantThreeCardsBayesSpec);
