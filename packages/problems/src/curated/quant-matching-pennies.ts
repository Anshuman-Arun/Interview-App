import { authorCuratedProblem, type CuratedProblemSpec } from "../curated-authoring.js";

export const quantMatchingPenniesSpec: CuratedProblemSpec = {
  "id":"quant-matching-pennies",
  "title":"Matching Pennies Minimax",
  "mode":"QUANT",
  "category":"games",
  "topics":["zero-sum games","mixed strategies","indifference","minimax"],
  "difficulty":"quant-standard",
  "prompt":"Two players simultaneously choose Heads or Tails. Player 1 wins $1 from Player 2 if the choices match and loses $1 if they differ. Find the Nash equilibrium and the value of the game. Explain why no pure-strategy equilibrium exists.",
  "givenInformation":["Payoffs are zero-sum.","Mixed strategies are allowed."],
  "approaches":[{"id":"indifference","label":"Make the opponent indifferent"},{"id":"minimax","label":"Equalize worst-case payoff"}],
  "milestones":[
    {"id":"pure-cycle","description":"Check each pure action profile and show one player always has a profitable deviation.","approachIds":["indifference","minimax"],"hintLevels":[1]},
    {"id":"parameterize","description":"Let Player 1 choose Heads with p and Player 2 choose Heads with q.","approachIds":["indifference","minimax"],"prerequisiteIds":["pure-cycle"],"hintLevels":[2]},
    {"id":"indifference-p2","description":"Choose p so Player 2 is indifferent between Heads and Tails, or equivalently equalize Player 1's payoff against Player 2's pure responses.","approachIds":["indifference","minimax"],"prerequisiteIds":["parameterize"],"hintLevels":[3]},
    {"id":"indifference-p1","description":"Symmetrically solve for q.","approachIds":["indifference","minimax"],"prerequisiteIds":["indifference-p2"],"hintLevels":[4]},
    {"id":"value","description":"Compute the expected payoff at p=q=1/2 and state the equilibrium/value.","approachIds":["indifference","minimax"],"prerequisiteIds":["indifference-p1"],"hintLevels":[5]}
  ],
  "edges":[{"from":"pure-cycle","to":"parameterize"},{"from":"parameterize","to":"indifference-p2"},{"from":"indifference-p2","to":"indifference-p1"},{"from":"indifference-p1","to":"value"}],
  "commonErrors":[{"id":"both-best-respond-pure","description":"Looks for a pure fixed point even though best responses cycle."},{"id":"same-indifference-equation","description":"Uses Player 1's mixing probability to make Player 1 rather than Player 2 indifferent."}],
  "followUps":["What happens if matching Heads pays 2 while matching Tails pays 1?","How do equilibrium probabilities change in an asymmetric 2×2 zero-sum game?"],
  "extensions":[{"id":"asymmetric-payoff","prompt":"Replace the ±1 matrix by a general 2×2 zero-sum matrix and derive the mixed equilibrium when it is interior."},{"id":"exploit-bias","prompt":"If Player 2 uses q=0.6, what pure response maximizes Player 1's expected payoff?"}],
  "hints":[
    {"level":1,"text":"In every pure profile, one player wants to switch, so look for a mixed equilibrium.","formulations":["no pure equilibrium","best responses cycle"]},
    {"level":2,"text":"Write p=P1(H) and q=P2(H).","formulations":["parameterize mixed strategies","let p and q be head probabilities"]},
    {"level":3,"text":"Player 2 must be indifferent between H and T; that happens only when p=1/2.","formulations":["make player two indifferent","p equals one half"]},
    {"level":4,"text":"By the same argument, Player 1 is indifferent only when q=1/2.","formulations":["q equals one half","make player one indifferent"]},
    {"level":5,"text":"At p=q=1/2, match and mismatch each occur with probability 1/2, so the game's value to Player 1 is 0.","formulations":["equilibrium both mix one half","game value zero"]}
  ],
  "canonicalSolution":"There is no pure equilibrium: at a match, Player 2 prefers to switch; at a mismatch, Player 1 prefers to switch. Let Player 1 play H with probability p. If Player 2 plays H, Player 1's expected payoff is 2p-1; if Player 2 plays T, it is 1-2p. Player 1 maximizes the minimum of these by setting them equal, giving p=1/2 and guaranteed payoff 0. Symmetrically Player 2 chooses q=1/2. Thus the unique mixed Nash equilibrium has each player randomize H/T equally, and the value to Player 1 is 0.",
  "verificationNotes":"The indifference condition should be applied to the opponent's pure actions. In a zero-sum presentation, minimax equalization is an equivalent derivation."
};

export const quantMatchingPenniesEntry = authorCuratedProblem(quantMatchingPenniesSpec);
