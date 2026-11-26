import { assertEquals } from "@std/assert";
import { read, ticketCall } from "./operations-http.ts";
import type { TicketFixture } from "./fixtures.ts";

export type WrittenWorkflow = Readonly<{
  workflowId: string;
  versionId: string;
  name: string;
}>;

export function writtenDefinition(options: { requiredInput?: boolean } = {}) {
  return {
    apiVersion: "bakery.dev/v1",
    kind: "workflow",
    name: "written",
    description: "A workflow written in the organization.",
    inputs: {
      note: { type: "string", required: options.requiredInput === true },
    },
    steps: [{ id: "flow", steps: [{ id: "pause", wait: { duration: "1m" } }] }],
  };
}

export async function publishWrittenWorkflow(
  fx: Pick<TicketFixture, "f" | "organizationId">,
  slug: string,
  options: { requiredInput?: boolean } = {},
): Promise<WrittenWorkflow> {
  const name = `Written ${slug}`;
  const created = await read<{ id: string }>(
    await ticketCall(fx, "POST", "/v1/workflows", {
      body: { slug, name, description: "" },
    }),
    201,
  );
  const draft = await read<{ id: string }>(
    await ticketCall(fx, "POST", `/v1/workflows/${created.id}/versions`, {
      body: { definition: writtenDefinition(options) },
    }),
    201,
  );
  await read(
    await ticketCall(
      fx,
      "POST",
      `/v1/workflows/${created.id}/versions/${draft.id}/publish`,
      { body: {}, ifMatch: 1 },
    ),
    200,
  );
  const active = await read<{ activeVersionId: string }>(
    await ticketCall(fx, "POST", `/v1/workflows/${created.id}/activations`, {
      body: { versionId: draft.id },
      ifMatch: 1,
    }),
    200,
  );
  assertEquals(active.activeVersionId, draft.id);
  return { workflowId: created.id, versionId: draft.id, name };
}
