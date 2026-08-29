import { z } from "zod";
import { DisclosureIdSchema } from "./ids.js";

const MilestoneSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  approachIds: z.array(z.string().min(1)).min(1),
  optionalPrerequisiteIds: z.array(z.string().min(1)).default([]),
  protectedDisclosureIds: z.array(DisclosureIdSchema).default([])
}).strict();

export const ReasoningGraphSchema = z.object({
  version: z.string().min(1),
  approaches: z.array(z.object({ id: z.string().min(1), label: z.string().min(1) }).strict()).min(1),
  milestones: z.array(MilestoneSchema).min(1),
  edges: z.array(z.object({ from: z.string().min(1), to: z.string().min(1) }).strict()),
  commonErrors: z.array(z.object({ id: z.string().min(1), description: z.string().min(1) }).strict()),
  extensions: z.array(z.object({ id: z.string().min(1), prompt: z.string().min(1) }).strict())
}).strict();
export type ReasoningGraph = z.infer<typeof ReasoningGraphSchema>;

export function assertReasoningGraphIntegrity(graph: ReasoningGraph): void {
  const milestoneIds = new Set(graph.milestones.map((item) => item.id));
  const approachIds = new Set(graph.approaches.map((item) => item.id));
  for (const milestone of graph.milestones) {
    for (const approachId of milestone.approachIds) {
      if (!approachIds.has(approachId)) throw new Error(`Unknown approach ${approachId}`);
    }
    for (const prerequisiteId of milestone.optionalPrerequisiteIds) {
      if (!milestoneIds.has(prerequisiteId)) throw new Error(`Unknown prerequisite ${prerequisiteId}`);
    }
  }
  for (const edge of graph.edges) {
    if (!milestoneIds.has(edge.from) || !milestoneIds.has(edge.to)) {
      throw new Error(`Invalid reasoning edge ${edge.from} -> ${edge.to}`);
    }
  }
}

