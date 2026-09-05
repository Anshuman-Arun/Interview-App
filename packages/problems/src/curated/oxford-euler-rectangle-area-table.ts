import { authorCuratedProblem } from "../curated-authoring.js";
import { makeEulerSpec, type EulerFamilyDefinition } from "./oxford-euler-authoring.js";

const DEFINITION: EulerFamilyDefinition = {
  "id": "oxford-euler-rectangle-area-table",
  "title": "Four Areas Around a Point",
  "category": "geometry",
  "topics": ["rectangle decomposition","area constraints","ratio structure","converse construction"],
  "prompt": "A point P lies strictly inside a rectangle. Through P draw one line parallel to each pair of sides, splitting the rectangle into four smaller rectangles. Label their areas a,b,c,d in cyclic order. What relationships among a,b,c,d must always hold? Conversely, which four positive numbers can arise in this way?",
  "givenInformation": [
    "The four labels go around P cyclically; opposite small rectangles therefore have areas a and c, and b and d if you choose that convention consistently.",
    "You may choose your own symbols for the two horizontal and two vertical side lengths."
  ],
  "domains": ["euclidean-geometry","algebra"],
  "contentConcepts": ["spatial-configuration","algebraic-identities","equations-inequalities"],
  "prerequisiteConcepts": ["arithmetic","algebraic-manipulation","euclidean-geometry-basics"],
  "skills": ["visualization","modelling","representation-switching","proof-construction","generalization","precision-checking","strategic-simplification","case-analysis","abstraction","transfer"],
  "difficulty": {"entry":"warm-up","core":"introductory-plus","ceiling":"strong"},
  "novelty":"moderate",
  "abstraction":"moderate",
  "introducesNewDefinition":false,
  "stages":[
    {"id":"opening","description":"Choose useful side-length variables from the picture and express the four areas as products.","contentConcepts":["spatial-configuration"],"skills":["visualization","modelling"],"difficulty":"warm-up","novelty":"low","abstraction":"low"},
    {"id":"structure","description":"Eliminate the side-length variables to find the multiplicative relation among the four areas.","contentConcepts":["algebraic-identities"],"skills":["representation-switching","proof-construction"],"difficulty":"introductory-plus","novelty":"moderate","abstraction":"moderate"},
    {"id":"converse","description":"Starting only from positive a,b,c,d satisfying the relation, construct side lengths that realize them.","contentConcepts":["equations-inequalities","algebraic-identities"],"skills":["proof-construction","strategic-simplification"],"difficulty":"standard","novelty":"moderate","abstraction":"moderate"},
    {"id":"boundary","description":"Identify exactly what positivity contributes and what happens if zero areas or a boundary point are allowed.","contentConcepts":["equations-inequalities"],"skills":["precision-checking","case-analysis"],"difficulty":"standard","novelty":"moderate","abstraction":"moderate"},
    {"id":"transfer","description":"Generalize the multiplicative consistency idea to a rectangular grid cut by several horizontal and vertical lines.","contentConcepts":["algebraic-identities","spatial-configuration"],"skills":["abstraction","generalization","transfer"],"difficulty":"strong","novelty":"high","abstraction":"high"}
  ],
  "commonErrors":[
    {"id":"sum-only","description":"Notices only that the four areas add to the total rectangle area and misses the cross-product constraint."},
    {"id":"converse-uniqueness","description":"Assumes the four areas determine unique physical side lengths, ignoring a horizontal/vertical scaling degree of freedom."}
  ],
  "followUps":[
    "What ratios of horizontal and vertical segment lengths can you recover from the four areas?",
    "If the outer rectangle area is fixed, does that remove the non-uniqueness of the side lengths?"
  ],
  "extensions":[
    {"id":"grid-rank-one","prompt":"For an m by n grid of smaller rectangles, characterize area tables that can arise from horizontal strip heights and vertical strip widths."},
    {"id":"boundary-zero","prompt":"Allow P on the boundary and classify the nonnegative area quadruples that can occur."}
  ],
  "hints":[
    {"text":"Call the left/right widths x,y and the upper/lower heights u,v.","formulations":["use two width variables and two height variables","write each small area as width times height"]},
    {"text":"With a=xu, b=yu, c=yv, d=xv in cyclic order, compare products of opposite areas.","formulations":["multiply opposite areas","cross products cancel the side lengths"]},
    {"text":"For the converse, fix one width arbitrarily, then solve for the remaining height, width, and height.","formulations":["choose one scale freely","construct dimensions from three of the areas"]},
    {"text":"Strictly interior P means every width and height factor is positive, so division by them is legitimate.","formulations":["positivity rules out zero factors","boundary cases require separate treatment"]},
    {"text":"In a larger grid every area has the form row-height times column-width, so every 2 by 2 multiplicative cross-product must agree.","formulations":["look for the same cross-product rule in every 2 by 2 block","area tables factor into one row quantity times one column quantity"]}
  ],
  "canonicalSolution":"Let the left and right widths be x,y>0 and the upper and lower heights be u,v>0. In cyclic order the four areas can be written a=xu, b=yu, c=yv, d=xv. With this cyclic convention, opposite products are a*c=(xu)(yv)=xyuv and b*d=(yu)(xv)=xyuv, so ac=bd. Conversely, suppose a,b,c,d>0 and ac=bd. Choose x=1, set u=a, y=b/a, and v=d. Then the four areas are xu=a, yu=b, yv=(b/a)d=c by bd=ac, and xv=d. Thus the relation is sufficient. The dimensions are not unique: multiplying both widths by λ>0 and dividing both heights by λ preserves all four areas. Ratios such as x:y=a:b=d:c and u:v=a:d=b:c are determined. In an m by n grid, an area table arises from strip widths/heights exactly when it factors as r_i c_j with positive factors; equivalently, all 2 by 2 cross-products agree.",
  "verificationNotes":"The cyclic labeling convention must be kept fixed: for a=xu,b=yu,c=yv,d=xv, the invariant is ac=bd. If the user chooses a different cyclic starting corner the statement remains 'product of one opposite pair equals product of the other opposite pair.' The converse construction uses positivity; zero entries require a separate degenerate classification. Outer area is a+b+c+d and does not remove the λ scaling freedom."
};

export const oxfordEulerRectangleAreaTableSpec = makeEulerSpec(DEFINITION);
export const oxfordEulerRectangleAreaTableEntry = authorCuratedProblem(oxfordEulerRectangleAreaTableSpec);
