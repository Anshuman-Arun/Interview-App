import { authorCuratedProblem } from "../curated-authoring.js";
import { makeEulerCandidateSpec } from "./oxford-euler-authoring.js";

export const oxfordEulerCornerBalancedTablesSpec = makeEulerCandidateSpec({
  "id":"oxford-euler-corner-balanced-tables","title":"Corner-Balanced Tables","category":"definitions","topics":["arrays","local constraints","row-column decomposition","degrees of freedom"],
  "prompt":"A rectangular table of real numbers is called corner-balanced if every adjacent 2 by 2 block has equal diagonal sums: top-left + bottom-right = top-right + bottom-left. Explore small examples. Characterize every corner-balanced m by n table, and decide how much information is needed to determine the whole table.",
  "givenInformation":["m and n are positive integers; the cases m=1 or n=1 are allowed.","Only adjacent 2 by 2 blocks are assumed in the definition.","Rows and columns are labeled, but no ordering of the numerical entries is assumed."],
  "domains":["algebra","combinatorics"],"contentConcepts":["algebraic-identities","counting-structure"],"prerequisiteConcepts":["arithmetic","algebraic-manipulation","counting-principles"],
  "skills":["definition-exploration","small-case-exploration","pattern-recognition","proof-construction","abstraction","generalization","representation-switching","precision-checking","transfer"],
  "difficulty":{"entry":"warm-up","core":"standard","ceiling":"strong"},"novelty":"moderate","abstraction":"high","introducesNewDefinition":true,
  "stages":[
    {"id":"opening","description":"Fill small 2 by 3 and 3 by 3 examples and look for a rule in row-to-row or column-to-column differences.","contentConcepts":["algebraic-identities"],"skills":["definition-exploration","small-case-exploration"],"difficulty":"warm-up","novelty":"moderate","abstraction":"moderate"},
    {"id":"structure","description":"Rearrange the 2 by 2 condition to show horizontal differences are copied from one row to the next.","contentConcepts":["algebraic-identities"],"skills":["representation-switching","pattern-recognition"],"difficulty":"standard","novelty":"moderate","abstraction":"high"},
    {"id":"classification","description":"Prove every entry has the form r_i+c_j after choosing a reference row and column.","contentConcepts":["algebraic-identities"],"skills":["proof-construction","abstraction"],"difficulty":"standard","novelty":"high","abstraction":"high"},
    {"id":"converse","description":"Prove every table of the form r_i+c_j is corner-balanced and identify the one-parameter redundancy in r_i,c_j.","contentConcepts":["algebraic-identities"],"skills":["proof-construction","precision-checking"],"difficulty":"strong","novelty":"high","abstraction":"high"},
    {"id":"transfer","description":"Count degrees of freedom and determine whether adjacent 2 by 2 balance automatically implies the same diagonal-sum relation for every larger rectangular corner choice.","contentConcepts":["counting-structure","algebraic-identities"],"skills":["generalization","transfer","abstraction"],"difficulty":"strong","novelty":"high","abstraction":"high"}
  ],
  "commonErrors":[{"id":"checks-only-local","description":"Verifies several adjacent blocks but never extracts a global representation."},{"id":"claims-m-plus-n","description":"Counts m+n free row/column parameters without subtracting the shared additive redundancy."}],
  "followUps":["If you know the first row and first column, can you fill the rest uniquely?","Does the balancing identity then hold for the four corners of any non-adjacent subrectangle?"],
  "extensions":[{"id":"modular-table","prompt":"Replace real entries by integers modulo q. Which parts of the classification still work?"},{"id":"multiplicative-analogue","prompt":"For positive entries replace equal diagonal sums by equal diagonal products. What factorized form should you expect?"}],
  "hints":[
    {"text":"Rewrite a_ij+a_{i+1,j+1}=a_{i,j+1}+a_{i+1,j} as a_{i,j+1}-a_ij=a_{i+1,j+1}-a_{i+1,j}.","formulations":["compare horizontal differences","the same column-to-column difference repeats down rows"]},
    {"text":"Therefore each row differs from the first row by an additive constant.","formulations":["row shapes are parallel up to shifts","horizontal increments are identical in every row"]},
    {"text":"Set c_j=a_{1j} and r_i=a_{i1}-a_{11}; then test a_ij=r_i+c_j.","formulations":["use first row and first column as coordinates","write each entry as row offset plus column baseline"]},
    {"text":"The representation is unchanged if you add t to every r_i and subtract t from every c_j.","formulations":["row column decomposition is not unique","there is one additive gauge freedom"]},
    {"text":"There are m+n-1 degrees of freedom, matching first row plus first column with the shared corner counted once.","formulations":["count independent boundary data","first row and first column determine all entries"]}
  ],
  "canonicalSolution":"The adjacent condition rearranges to a_{i,j+1}-a_{ij}=a_{i+1,j+1}-a_{i+1,j}. Thus for each adjacent pair of columns, the horizontal difference is independent of the row. Consequently row i differs from row 1 by a constant. Define c_j=a_{1j} and r_i=a_{i1}-a_{11}; then telescoping horizontal differences gives a_{ij}=r_i+c_j. Conversely, any table r_i+c_j satisfies (r_i+c_j)+(r_{i+1}+c_{j+1})=(r_i+c_{j+1})+(r_{i+1}+c_j). The decomposition has one redundancy: r_i+t and c_j-t give the same table, so the space has m+n-1 free parameters. The same representation also proves equal diagonal sums for the four corners of any larger axis-aligned subrectangle.",
  "verificationNotes":"The adjacent condition suffices globally by propagating horizontal differences across connected rows and columns. For m=1 or n=1 there are no 2 by 2 constraints; the representation still exists and gives m+n-1 entries/degrees of freedom. The modular extension works over any abelian group for the additive version, though the main family is over reals."
} as const);

export const oxfordEulerCornerBalancedTablesEntry = authorCuratedProblem(oxfordEulerCornerBalancedTablesSpec);
