import type { ProtectedDisclosure } from "./disclosure.js";
import type { ReasoningGraph } from "./reasoning.js";

export interface InterviewProblem {
  readonly id: string;
  readonly version: string;
  readonly public: { readonly prompt: string; readonly givenInformation: readonly string[] };
  readonly interviewer: {
    readonly topics: readonly string[];
    readonly difficulty: string;
    readonly reasoningGraph: ReasoningGraph;
    readonly protectedDisclosures: readonly ProtectedDisclosure[];
  };
  readonly private: {
    readonly canonicalSolution: string;
    readonly verificationNotes: string;
  };
}

