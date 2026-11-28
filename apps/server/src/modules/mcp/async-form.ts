import { z } from "zod";

export const McpAsyncFormSchema = z.strictObject({
  kind: z.literal("submit_poll_v1").describe(
    "The one asynchronous form: submit under a Bakery-owned key, then poll by it.",
  ),
  effectKeyArgument: z.string().min(1).max(128).describe(
    "Argument of both the submit and the poll tool that carries the operation key.",
  ),
  pollTool: z.string().min(1).max(128).describe(
    "Read tool the binding grants for polling the operation.",
  ),
}).describe(
  "The asynchronous write form a workflow version froze into its step binding at publish.",
);
export type McpAsyncForm = z.infer<typeof McpAsyncFormSchema>;

export function parseMcpAsyncForm(raw: unknown): McpAsyncForm | null {
  if (raw === null || raw === undefined) return null;
  const parsed = McpAsyncFormSchema.safeParse(raw);
  return parsed.success ? Object.freeze(parsed.data) : null;
}
