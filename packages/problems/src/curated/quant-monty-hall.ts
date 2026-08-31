import { authorCuratedProblem, type CuratedProblemSpec } from "../curated-authoring.js";

export const quantMontyHallSpec: CuratedProblemSpec = {
  "id": "quant-monty-hall",
  "title": "Monty Hall with a Specified Host Policy",
  "mode": "QUANT",
  "category": "conditional probability",
  "topics": ["Bayesian reasoning","conditioning","information"],
  "difficulty": "quant-standard",
  "prompt": "There are three doors: one hides a prize and two hide goats. You choose Door 1. The host knows where the prize is, always opens one of Doors 2 or 3 that has a goat, and if both are goats chooses uniformly at random between them. The host opens Door 3. What is the probability the prize is behind Door 2? Should you switch?",
  "givenInformation": ["The prize is initially equally likely to be behind each door.","The host always opens a goat door and never opens your chosen door.","If the host has two eligible goat doors, the host chooses uniformly."],
  "approaches": [{"id":"bayes-cases","label":"Bayes over prize locations"},{"id":"survival-mass","label":"Track prior probability mass through host action"}],
  "milestones": [
    {"id":"state-hypotheses","description":"List prize-location hypotheses and their prior probabilities.","approachIds":["bayes-cases","survival-mass"],"hintLevels":[1]},
    {"id":"host-likelihoods","description":"Compute P(host opens Door 3 | each prize location).","approachIds":["bayes-cases"],"prerequisiteIds":["state-hypotheses"],"hintLevels":[2]},
    {"id":"bayes-weight","description":"Weight each prior by the corresponding host likelihood.","approachIds":["bayes-cases","survival-mass"],"prerequisiteIds":["host-likelihoods"],"hintLevels":[3]},
    {"id":"normalize","description":"Normalize the surviving weights after observing Door 3 opened.","approachIds":["bayes-cases","survival-mass"],"prerequisiteIds":["bayes-weight"],"hintLevels":[4]},
    {"id":"decision","description":"Compare the posterior probabilities of staying and switching.","approachIds":["bayes-cases","survival-mass"],"prerequisiteIds":["normalize"],"hintLevels":[5]}
  ],
  "edges": [{"from":"state-hypotheses","to":"host-likelihoods"},{"from":"host-likelihoods","to":"bayes-weight"},{"from":"bayes-weight","to":"normalize"},{"from":"normalize","to":"decision"}],
  "commonErrors": [{"id":"fifty-fifty","description":"Treats the two unopened doors as automatically equally likely after conditioning."},{"id":"ignore-host-policy","description":"Computes a posterior without using the stated randomization policy when the host has a choice."}],
  "followUps": ["How would the answer change if the host preferred Door 3 whenever possible?","What if there were 100 doors and the host opened 98 goats?"],
  "extensions": [{"id":"biased-host","prompt":"Replace the uniform tie-break with a parameter r and derive the posterior as a function of r."},{"id":"many-doors","prompt":"Generalize the switching advantage to n doors under the analogous host policy."}],
  "hints": [
    {"level":1,"text":"Condition on the three possible prize locations rather than reasoning from the two doors that remain.","formulations":["consider each prize location","set up hypotheses for doors 1 2 3"]},
    {"level":2,"text":"If the prize is behind Door 1, the host opens Door 3 only half the time; if behind Door 2, the host must open Door 3; if behind Door 3, the observation is impossible.","formulations":["host likelihoods are one half one zero","compute P(open 3 | prize location)"]},
    {"level":3,"text":"Multiply the 1/3 priors by those likelihoods: the unnormalized weights are 1/6 for Door 1 and 1/3 for Door 2.","formulations":["weights one sixth and one third","Bayes prior times likelihood"]},
    {"level":4,"text":"Normalize 1/6 and 1/3 to probabilities 1/3 and 2/3.","formulations":["normalize to one third and two thirds","posterior Door 2 is two thirds"]},
    {"level":5,"text":"Door 2 has posterior probability 2/3, so switching from Door 1 doubles the winning probability.","formulations":["switch with probability two thirds","switching is better"]}
  ],
  "canonicalSolution": "Let H_i be the event that the prize is behind Door i, each with prior probability 1/3, and let O_3 be the event the host opens Door 3. The likelihoods are P(O_3|H_1)=1/2, P(O_3|H_2)=1, and P(O_3|H_3)=0. Thus the posterior weights are 1/6, 1/3, and 0, totaling 1/2. Therefore P(H_2|O_3)=(1/3)/(1/2)=2/3 and P(H_1|O_3)=1/3. Switching to Door 2 is optimal.",
  "verificationNotes": "The explicit host policy matters. The 2/3 answer follows under the stated uniform tie-break and must be derived by conditioning, not by symmetry of the two unopened doors."
};

export const quantMontyHallEntry = authorCuratedProblem(quantMontyHallSpec);
