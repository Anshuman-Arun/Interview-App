import { authorCuratedProblem, type CuratedProblemSpec } from "../curated-authoring.js";

export const quantUniformEndpointEstimationSpec: CuratedProblemSpec = {
  "id":"quant-uniform-endpoint-estimation",
  "title":"Estimating the Endpoint of a Uniform Distribution",
  "mode":"QUANT",
  "category":"estimation",
  "topics":["estimators","bias","variance","order statistics","mean squared error"],
  "difficulty":"quant-stretch",
  "prompt":"Let X_1,…,X_n be iid Uniform(0,θ), where θ>0 is unknown. (a) Find an unbiased estimator of θ based on the sample maximum M=max_i X_i. (b) Compare its variance with the unbiased estimator 2 times the sample mean.",
  "givenInformation":["You may derive the distribution of M from P(M≤m)=P(X_1≤m,…,X_n≤m)."],
  "approaches":[{"id":"order-statistic","label":"Distribution and moments of sample maximum"},{"id":"scaled-beta","label":"Recognize M/θ as Beta(n,1)"}],
  "milestones":[
    {"id":"max-cdf","description":"Derive the CDF of M for 0≤m≤θ.","approachIds":["order-statistic","scaled-beta"],"hintLevels":[1]},
    {"id":"max-density","description":"Differentiate to get the density and compute E[M].","approachIds":["order-statistic","scaled-beta"],"prerequisiteIds":["max-cdf"],"hintLevels":[2]},
    {"id":"unbias-max","description":"Scale M to remove its bias.","approachIds":["order-statistic","scaled-beta"],"prerequisiteIds":["max-density"],"hintLevels":[3]},
    {"id":"variances","description":"Compute Var(M) and Var(2 times the sample mean).","approachIds":["order-statistic","scaled-beta"],"prerequisiteIds":["unbias-max"],"hintLevels":[4]},
    {"id":"compare","description":"Compare the two unbiased variances as functions of n.","approachIds":["order-statistic","scaled-beta"],"prerequisiteIds":["variances"],"hintLevels":[5]}
  ],
  "edges":[{"from":"max-cdf","to":"max-density"},{"from":"max-density","to":"unbias-max"},{"from":"unbias-max","to":"variances"},{"from":"variances","to":"compare"}],
  "commonErrors":[{"id":"max-is-unbiased","description":"Uses M directly as an unbiased estimator despite E[M]=nθ/(n+1)."},{"id":"forget-squared-scale","description":"Scales variance linearly rather than quadratically when multiplying M by (n+1)/n."}],
  "followUps":["Which estimator has smaller MSE if you use M without bias correction?","How quickly do the two variances decay with n?"],
  "extensions":[{"id":"mse-max","prompt":"Compare the MSE of the biased estimator M with the unbiased scaled maximum."},{"id":"sufficiency","prompt":"Discuss why the sample maximum carries special information about θ in this nonregular model."}],
  "hints":[
    {"level":1,"text":"For 0≤m≤θ, M≤m exactly when every X_i≤m, so F_M(m)=(m/θ)^n.","formulations":["maximum cdf is (m/theta)^n","all observations below m"]},
    {"level":2,"text":"Thus f_M(m)=n m^{n-1}/θ^n and E[M]=nθ/(n+1).","formulations":["expected max n theta over n plus one","density of maximum"]},
    {"level":3,"text":"Multiply M by (n+1)/n to get an unbiased estimator.","formulations":["unbiased maximum estimator (n+1)M/n","scale the maximum"]},
    {"level":4,"text":"Use E[M²]=nθ²/(n+2), so Var((n+1)M/n)=θ²/[n(n+2)], while Var(2 times the sample mean)=θ²/(3n).","formulations":["variance theta squared over n n plus 2","variance of twice sample mean theta squared over 3n"]},
    {"level":5,"text":"Since 1/[n(n+2)]<1/(3n) for n>1 (equal at n=1), the scaled maximum is more efficient for n>1.","formulations":["scaled maximum has lower variance for n greater than one","compare n plus 2 with 3"]}
  ],
  "canonicalSolution":"For 0≤m≤θ, P(M≤m)=(m/θ)^n, so f_M(m)=n m^{n-1}/θ^n. Hence E[M]=∫_0^θ m f_M(m)dm=nθ/(n+1), making theta-hat_M=((n+1)/n)M unbiased. Also E[M²]=nθ²/(n+2), so Var(M)=nθ²/(n+2)-n²θ²/(n+1)² = nθ²/[(n+2)(n+1)²]. Scaling gives Var(theta-hat_M)=θ²/[n(n+2)]. Since Var(X_i)=θ²/12, Var(2 times the sample mean)=4·θ²/(12n)=θ²/(3n). For n>1, θ²/[n(n+2)]<θ²/(3n); at n=1 they are equal.",
  "verificationNotes":"Check the second moment algebra and squared scaling factor. The comparison is variance-to-variance because both estimators under comparison are unbiased."
};

export const quantUniformEndpointEstimationEntry = authorCuratedProblem(quantUniformEndpointEstimationSpec);
