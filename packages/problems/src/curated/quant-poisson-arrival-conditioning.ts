import { authorCuratedProblem, type CuratedProblemSpec } from "../curated-authoring.js";

export const quantPoissonArrivalConditioningSpec: CuratedProblemSpec = {
  "id":"quant-poisson-arrival-conditioning",
  "title":"Arrival Time Given One Poisson Event",
  "mode":"QUANT",
  "category":"stochastic processes",
  "topics":["Poisson process","conditional distributions","memoryless increments","uniform distribution"],
  "difficulty":"quant-stretch",
  "prompt":"Events follow a homogeneous Poisson process of rate λ>0. Conditional on exactly one event occurring in the interval [0,T], what is the distribution of that event's arrival time? Derive the conditional distribution.",
  "givenInformation":["Counts on disjoint intervals are independent.","The number of events in an interval of length t is Poisson(λt)."],
  "approaches":[{"id":"split-interval","label":"Condition using independent counts before and after t"}],
  "milestones":[
    {"id":"cdf-target","description":"Express P(S≤t | N(T)=1) using counts in [0,t] and (t,T].","approachIds":["split-interval"],"hintLevels":[1]},
    {"id":"joint-event","description":"Identify {S≤t,N(T)=1} as one event in [0,t] and zero in (t,T].","approachIds":["split-interval"],"prerequisiteIds":["cdf-target"],"hintLevels":[2]},
    {"id":"independent-counts","description":"Use Poisson probabilities and independent increments for the numerator.","approachIds":["split-interval"],"prerequisiteIds":["joint-event"],"hintLevels":[3]},
    {"id":"divide-condition","description":"Divide by P(N(T)=1) and simplify λ and exponential factors.","approachIds":["split-interval"],"prerequisiteIds":["independent-counts"],"hintLevels":[4]},
    {"id":"identify-uniform","description":"Recognize the conditional CDF t/T on 0≤t≤T as Uniform(0,T).","approachIds":["split-interval"],"prerequisiteIds":["divide-condition"],"hintLevels":[5]}
  ],
  "edges":[{"from":"cdf-target","to":"joint-event"},{"from":"joint-event","to":"independent-counts"},{"from":"independent-counts","to":"divide-condition"},{"from":"divide-condition","to":"identify-uniform"}],
  "commonErrors":[{"id":"use-exponential-unconditionally","description":"Answers exponential because the first arrival is exponential without conditioning on exactly one event by T."},{"id":"forget-zero-after","description":"Counts an event before t but does not require zero additional events in (t,T]."}],
  "followUps":["Conditional on N(T)=n, what is the joint distribution of the n ordered arrival times?","Does the conditional answer depend on λ? Why not?"],
  "extensions":[{"id":"n-arrivals","prompt":"Show that conditional on N(T)=n, the ordered arrival times are the order statistics of n iid Uniform(0,T) variables."},{"id":"nonhomogeneous","prompt":"How would the one-arrival conditional density change for a nonhomogeneous Poisson process with intensity λ(t)?"}],
  "hints":[
    {"level":1,"text":"Compute the conditional CDF P(S≤t | N(T)=1) for 0≤t≤T.","formulations":["compute a conditional cdf","condition on exactly one event"]},
    {"level":2,"text":"For the event to occur by t and be the only event by T, there must be exactly one count in [0,t] and zero in (t,T].","formulations":["one before t and zero after","N(t)=1 and N(T)-N(t)=0"]},
    {"level":3,"text":"Independence gives (λt)e^{-λt}·e^{-λ(T-t)}=λt e^{-λT} for the numerator.","formulations":["numerator lambda t e minus lambda T","multiply independent Poisson probabilities"]},
    {"level":4,"text":"P(N(T)=1)=λT e^{-λT}, so the conditional CDF is t/T.","formulations":["divide by lambda T e minus lambda T","conditional cdf t over T"]},
    {"level":5,"text":"A CDF equal to t/T on [0,T] is Uniform(0,T).","formulations":["arrival is uniform on zero to T","Uniform(0,T)"]}
  ],
  "canonicalSolution":"Let S be the unique arrival time given N(T)=1. For 0≤t≤T, {S≤t,N(T)=1} is the event that N(t)=1 and N(T)-N(t)=0. By independent increments, its probability is [(λt)e^{-λt}]·[e^{-λ(T-t)}]=λt e^{-λT}. Also P(N(T)=1)=λT e^{-λT}. Therefore P(S≤t|N(T)=1)=t/T. This is the CDF of Uniform(0,T), so the conditional arrival time is uniform and independent of λ after conditioning on exactly one event.",
  "verificationNotes":"The conditioning changes the distribution from exponential to uniform. Check both the independent-increment factorization and the normalization."
};

export const quantPoissonArrivalConditioningEntry = authorCuratedProblem(quantPoissonArrivalConditioningSpec);
