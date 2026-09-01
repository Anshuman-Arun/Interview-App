import { authorCuratedProblem, type CuratedProblemSpec } from "../curated-authoring.js";

export const quantHiddenCoinBayesSpec: CuratedProblemSpec = {
  "id":"quant-hidden-coin-bayes",
  "title":"Which Coin Was Chosen?",
  "mode":"QUANT",
  "category":"Bayesian reasoning",
  "topics":["conditional probability","Bayes theorem","likelihood ratios","Bernoulli trials"],
  "difficulty":"quant-standard",
  "prompt":"A box contains two coins. Coin A lands Heads with probability 1/2; Coin B lands Heads with probability 3/4. One coin is chosen uniformly at random and flipped three times, producing HHH. What is the posterior probability that Coin B was chosen?",
  "givenInformation":["Conditional on the chosen coin, flips are independent.","Each coin is selected with prior probability 1/2."],
  "approaches":[{"id":"bayes-formula","label":"Direct Bayes calculation"},{"id":"odds-update","label":"Posterior odds from likelihood ratio"}],
  "milestones":[
    {"id":"priors","description":"State the equal prior odds for A and B.","approachIds":["bayes-formula","odds-update"],"hintLevels":[1]},
    {"id":"likelihoods","description":"Compute the likelihood of HHH under each coin.","approachIds":["bayes-formula","odds-update"],"prerequisiteIds":["priors"],"hintLevels":[2]},
    {"id":"likelihood-ratio","description":"Compare the likelihoods or multiply priors by them.","approachIds":["bayes-formula","odds-update"],"prerequisiteIds":["likelihoods"],"hintLevels":[3]},
    {"id":"normalize-posterior","description":"Normalize the two posterior weights.","approachIds":["bayes-formula"],"prerequisiteIds":["likelihood-ratio"],"hintLevels":[4]},
    {"id":"posterior-answer","description":"State and interpret the posterior probability for Coin B.","approachIds":["bayes-formula","odds-update"],"prerequisiteIds":["normalize-posterior"],"hintLevels":[5]}
  ],
  "edges":[{"from":"priors","to":"likelihoods"},{"from":"likelihoods","to":"likelihood-ratio"},{"from":"likelihood-ratio","to":"normalize-posterior"},{"from":"normalize-posterior","to":"posterior-answer"}],
  "commonErrors":[{"id":"compare-probabilities-not-cubes","description":"Uses 3/4 versus 1/2 instead of cubing because three independent heads were observed."},{"id":"forget-normalization","description":"Reports the likelihood ratio 27/8 as if it were a probability."}],
  "followUps":["How many consecutive Heads would be needed for the posterior on B to exceed 99%?","How does the answer change after observing HHT instead?"],
  "extensions":[{"id":"general-sequence","prompt":"Derive the posterior after h Heads and t Tails."},{"id":"decision-threshold","prompt":"Solve for the number of Heads needed to cross an arbitrary posterior threshold."}],
  "hints":[
    {"level":1,"text":"Treat the chosen coin as a hidden hypothesis with equal prior probability.","formulations":["two hypotheses with equal priors","start with prior odds one to one"]},
    {"level":2,"text":"P(HHH|A)=(1/2)^3 and P(HHH|B)=(3/4)^3.","formulations":["likelihoods are one eighth and twenty seven sixty fourths","cube the head probabilities"]},
    {"level":3,"text":"With equal priors, posterior odds equal the likelihood ratio: (27/64)/(1/8)=27/8.","formulations":["posterior odds 27 to 8","likelihood ratio twenty seven over eight"]},
    {"level":4,"text":"Normalize the weights 1/16 and 27/128, or equivalently normalize odds 27:8.","formulations":["normalize 27 to 8","posterior is 27 over 35"]},
    {"level":5,"text":"The posterior probability of Coin B is 27/(27+8)=27/35.","formulations":["Coin B probability 27/35","answer twenty seven thirty fifths"]}
  ],
  "canonicalSolution":"Let B denote choosing Coin B and A choosing Coin A. The priors are P(A)=P(B)=1/2. The likelihoods are P(HHH|A)=1/8 and P(HHH|B)=27/64. Bayes gives posterior weights (1/2)(1/8)=1/16=8/128 for A and (1/2)(27/64)=27/128 for B. Normalizing, P(B|HHH)=27/(27+8)=27/35. In odds form, prior odds are 1 and the likelihood ratio is 27/8, so posterior odds are 27:8.",
  "verificationNotes":"Check the independence exponent and distinguish posterior odds from posterior probability."
};

export const quantHiddenCoinBayesEntry = authorCuratedProblem(quantHiddenCoinBayesSpec);
