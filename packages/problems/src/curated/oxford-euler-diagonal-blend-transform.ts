import { authorCuratedProblem } from "../curated-authoring.js";
import { makeEulerCandidateSpec } from "./oxford-euler-authoring.js";

export const oxfordEulerDiagonalBlendTransformSpec = makeEulerCandidateSpec({
  "id":"oxford-euler-diagonal-blend-transform","title":"The Diagonal Blend Transform","category":"definitions","topics":["coordinate transformations","iteration","distance scaling","invariant lines"],
  "prompt":"Define a coordinate rule T by T(x,y)=(x+2y, 2x-y). Without using matrix or eigenvalue vocabulary, explore what T does to points and shapes. What happens if you apply T twice? How does T change distances? Which lines through the origin are mapped onto themselves? Then investigate T_a(x,y)=(x+a y, a x-y).",
  "givenInformation":["You may use the distance formula and ordinary coordinate algebra.","A line through the origin may be represented by y=mx, but remember that this misses the vertical line."],
  "domains":["coordinate-geometry","functions","algebra"],"contentConcepts":["function-transformations","composition-iteration","analytic-curve-geometry","algebraic-identities","equations-inequalities","parameter-dependent-algebra"],"prerequisiteConcepts":["coordinate-geometry-basics","algebraic-manipulation","functions-graphs"],
  "skills":["definition-exploration","visualization","representation-switching","proof-construction","generalization","precision-checking","case-analysis","transfer","abstraction"],"difficulty":{"entry":"warm-up","core":"standard","ceiling":"strong"},"novelty":"high","abstraction":"moderate","introducesNewDefinition":true,
  "stages":[
    {"id":"opening","description":"Plot a few points and the image of a simple square to conjecture the geometric effect of T.","contentConcepts":["function-transformations","analytic-curve-geometry"],"skills":["definition-exploration","visualization"],"difficulty":"warm-up","novelty":"high","abstraction":"moderate"},
    {"id":"structure","description":"Compute T(T(x,y)) and discover that the second application is pure scaling by 5.","contentConcepts":["composition-iteration","algebraic-identities"],"skills":["representation-switching","proof-construction"],"difficulty":"standard","novelty":"high","abstraction":"moderate"},
    {"id":"metric","description":"Compare squared distances before and after T and prove that every distance is multiplied by sqrt(5).","contentConcepts":["algebraic-identities","analytic-curve-geometry"],"skills":["proof-construction","visualization"],"difficulty":"standard","novelty":"high","abstraction":"moderate"},
    {"id":"invariant-lines","description":"Solve for all slopes m for which a point on y=mx is sent to the same line, checking the vertical line separately.","contentConcepts":["function-transformations","equations-inequalities"],"skills":["case-analysis","precision-checking","proof-construction"],"difficulty":"strong","novelty":"high","abstraction":"high"},
    {"id":"transfer","description":"Replace 2 by a parameter a and determine which parts of the structure survive.","contentConcepts":["composition-iteration","parameter-dependent-algebra"],"skills":["generalization","transfer","abstraction"],"difficulty":"strong","novelty":"high","abstraction":"high"}
  ],
  "commonErrors":[{"id":"calls-rotation","description":"Sees uniform distance scaling and assumes the transformation is a rotation without checking orientation or fixed directions."},{"id":"misses-vertical","description":"Solves only with slopes y=mx and never checks the vertical line."}],
  "followUps":["What is the image of the unit circle?","Can you reconstruct (x,y) from T(x,y) without solving two unrelated equations?"],
  "extensions":[{"id":"parameter-blend","prompt":"For T_a(x,y)=(x+ay, ax-y), compute T_a^2 and interpret the result."},{"id":"shape-area","prompt":"Determine how T changes the area of a triangle or rectangle and reconcile that with the distance scale."}],
  "hints":[
    {"text":"Try applying the rule twice before trying to name the transformation.","formulations":["compose T with itself","calculate T(T(x,y))"]},
    {"text":"The cross-terms cancel in the second iterate.","formulations":["look for cancellation after composition","T squared becomes a scalar rule"]},
    {"text":"For two points, apply T to their difference vector (u,v) and expand (u+2v)^2+(2u-v)^2.","formulations":["compare squared lengths","the transformed difference has coordinates u+2v and 2u-v"]},
    {"text":"For an invariant nonvertical line, require the image of (1,m) to have slope m.","formulations":["use a representative direction (1,m)","set (2-m)/(1+2m)=m"]},
    {"text":"For T_a, the same cancellation gives T_a^2=(1+a^2) times the identity.","formulations":["keep a symbolic","the parameterized second iterate is scalar"]}
  ],
  "canonicalSolution":"A direct calculation gives T(T(x,y))=T(x+2y,2x-y)=(5x,5y), so T^2 is scaling by 5. For a difference vector (u,v), its image is (u+2v,2u-v), whose squared length is (u+2v)^2+(2u-v)^2=5(u^2+v^2). Thus all distances scale by sqrt(5), so angles are preserved as well. For a nonvertical invariant line y=mx, the image of (1,m) is (1+2m,2-m), and requiring the same slope gives 2-m=m(1+2m), or m^2+m-1=0. Hence the invariant slopes are (-1±sqrt(5))/2; the vertical line maps to direction (2,-1) and is not invariant. For T_a(x,y)=(x+a y,a x-y), direct composition gives T_a^2=(1+a^2)(x,y), and the same squared-distance expansion shows uniform scaling by sqrt(1+a^2).",
  "verificationNotes":"T^2=5I and the metric identity have been expanded directly, so no linear-algebra theorem is assumed. The invariant-line equation must check the case 1+2m=0 without division: it does not satisfy invariance, and the vertical line is separately noninvariant. For T_a, a=0 is allowed: the rule is reflection across the x-axis and T_a^2=I."
} as const);

export const oxfordEulerDiagonalBlendTransformEntry = authorCuratedProblem(oxfordEulerDiagonalBlendTransformSpec);
