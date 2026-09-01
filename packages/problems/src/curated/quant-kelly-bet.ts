import { authorCuratedProblem, type CuratedProblemSpec } from "../curated-authoring.js";

export const quantKellyBetSpec: CuratedProblemSpec = {
  "id":"quant-kelly-bet",
  "title":"Kelly Fraction for a Favorable Even-Money Bet",
  "mode":"QUANT",
  "category":"expected value",
  "topics":["log utility","optimization","bet sizing","growth rate"],
  "difficulty":"quant-stretch",
  "prompt":"You repeatedly face an independent even-money bet: with probability 1/2<p<1 your stake wins and with probability 1-p it loses. If you bet a fixed fraction f of current wealth each round, with 0≤f<1, what f maximizes expected log-wealth growth per round?",
  "givenInformation":["On a win wealth is multiplied by 1+f; on a loss by 1-f.","Maximize expected log growth, not expected dollar wealth."],
  "approaches":[{"id":"calculus-log-growth","label":"Differentiate expected log growth"}],
  "milestones":[
    {"id":"growth-objective","description":"Write the one-round expected log-growth objective g(f).","approachIds":["calculus-log-growth"],"hintLevels":[1]},
    {"id":"differentiate","description":"Differentiate g(f) on 0≤f<1.","approachIds":["calculus-log-growth"],"prerequisiteIds":["growth-objective"],"hintLevels":[2]},
    {"id":"stationary-point","description":"Set g'(f)=0 and solve for f.","approachIds":["calculus-log-growth"],"prerequisiteIds":["differentiate"],"hintLevels":[3]},
    {"id":"check-maximum","description":"Use g''(f)<0 and the domain to verify the stationary point is the maximizer.","approachIds":["calculus-log-growth"],"prerequisiteIds":["stationary-point"],"hintLevels":[4]},
    {"id":"interpret-kelly","description":"State f*=2p-1 and explain its dependence on the edge.","approachIds":["calculus-log-growth"],"prerequisiteIds":["check-maximum"],"hintLevels":[5]}
  ],
  "edges":[{"from":"growth-objective","to":"differentiate"},{"from":"differentiate","to":"stationary-point"},{"from":"stationary-point","to":"check-maximum"},{"from":"check-maximum","to":"interpret-kelly"}],
  "commonErrors":[{"id":"maximize-expected-wealth","description":"Maximizes E[wealth multiplier], which is linear in f and would incorrectly push to the boundary."},{"id":"forget-loss-log","description":"Uses log(1+f) for both outcomes or omits the loss term log(1-f)."}],
  "followUps":["How does the formula change for decimal odds b:1?","Why can maximizing expected wealth recommend pathological leverage compared with expected log growth?"],
  "extensions":[{"id":"general-odds","prompt":"Derive the Kelly fraction for net odds b on a win and loss of the stake otherwise."},{"id":"fractional-kelly","prompt":"Discuss the effect of betting a fraction of the Kelly-optimal stake when p is estimated with error."}],
  "hints":[
    {"level":1,"text":"The relevant objective per round is p log(1+f)+(1-p)log(1-f).","formulations":["expected log growth","g(f)=p log(1+f)+(1-p) log(1-f)"]},
    {"level":2,"text":"Differentiate: g'(f)=p/(1+f)-(1-p)/(1-f).","formulations":["derivative of expected log growth","p over one plus f minus q over one minus f"]},
    {"level":3,"text":"Setting the derivative to zero gives p(1-f)=(1-p)(1+f).","formulations":["first order condition","p times one minus f equals q times one plus f"]},
    {"level":4,"text":"Solving gives f=2p-1, and g''(f) is strictly negative throughout the domain.","formulations":["f equals two p minus one","second derivative negative"]},
    {"level":5,"text":"Thus the log-optimal fixed fraction is f*=2p-1; as p↓1/2 the optimal stake shrinks to zero.","formulations":["Kelly fraction 2p-1","optimal stake equals twice the edge over one half"]}
  ],
  "canonicalSolution":"The expected log-growth increment is g(f)=p log(1+f)+(1-p)log(1-f). Its derivative is g'(f)=p/(1+f)-(1-p)/(1-f). Setting g'(f)=0 gives p(1-f)=(1-p)(1+f), hence p-pf=1-p+(1-p)f and f=2p-1. Also g''(f)=-p/(1+f)^2-(1-p)/(1-f)^2<0, so the objective is strictly concave and this stationary point is the unique maximizer. Since 1/2<p<1, we have 0<f*=2p-1<1, so the stationary point lies in the stated domain.",
  "verificationNotes":"The problem is explicitly about expected log growth. Under 1/2<p<1 the optimizer f*=2p-1 is an interior point of 0≤f<1 and strict concavity makes it unique."
};

export const quantKellyBetEntry = authorCuratedProblem(quantKellyBetSpec);
