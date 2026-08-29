import { z } from "zod";

export const LocalClientIdentitySchema = z.object({
  protocolVersion: z.literal(1),
  clientToken: z.string().min(32),
  origin: z.url()
}).strict();
