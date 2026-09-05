export * from "./support.js";
export * from "./batch-a.js";
export * from "./batch-b.js";
export * from "./batch-c.js";

import { dirichletBatchAEntries } from "./batch-a.js";
import { dirichletBatchBEntries } from "./batch-b.js";
import { dirichletBatchCEntries } from "./batch-c.js";

export const dirichletCandidateEntries = Object.freeze([
  ...dirichletBatchAEntries,
  ...dirichletBatchBEntries,
  ...dirichletBatchCEntries
] as const);

export const dirichletCandidateProblems = Object.freeze(
  dirichletCandidateEntries.map((entry) => entry.problem)
);

export const dirichletCandidateMetadata = Object.freeze(
  dirichletCandidateEntries.map((entry) => entry.metadata)
);
