import { z } from "zod";

export const attachOptionsSchema = z.object({
  channel: z.enum(["stable", "beta", "dev", "canary"]).default("stable"),
  timeoutMs: z.coerce.number().int().min(1000).max(120000).default(30000),
});
export type AttachOptions = z.infer<typeof attachOptionsSchema>;
