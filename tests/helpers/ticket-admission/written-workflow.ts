import { assertEquals } from "@std/assert";
import { read, ticketCall } from "./operations-http.ts";
import type { TicketFixture } from "./fixtures.ts";

export type WrittenWorkflow = Readonly<{
  workflowId: string;
  versionId: string;
  name: string;
}>;

export function writtenDefinition(options: WrittenOptions = {}) {
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

export type WrittenOptions = { requiredInput?: boolean; startsOn?: string[] };

export function eventStarts(actions: readonly string[]) {
  return actions.map((action) => ({
    id: `on-${action}`,
    budgetUsd: 5,
    inputs: {},
    on: { kind: "event", eventKind: `work_item.${action}`, filter: {} },
  }));
}

export async function publishVersion(
  fx: Pick<TicketFixture, "f" | "organizationId" | "owner">,
  workflowId: string,
  options: WrittenOptions = {},
): Promise<string> {
  const draft = await read<{ id: string; version: number }>(
    await ticketCall(fx, "POST", `/v1/workflows/${workflowId}/versions`, {
      body: { definition: writtenDefinition(options) },
    }),
    201,
  );
  await fx.owner.query(
    `update bakery.workflow_drafts set starts = $3::jsonb
      where organization_id = $1 and id = $2`,
    [
      fx.organizationId,
      draft.id,
      JSON.stringify(eventStarts(options.startsOn ?? [])),
    ],
  );
  await read(
    await ticketCall(
      fx,
      "POST",
      `/v1/workflows/${workflowId}/versions/${draft.id}/publish`,
      { body: {}, ifMatch: draft.version ?? 1 },
    ),
    200,
  );
  return draft.id;
}

export async function activateVersion(
  fx: Pick<TicketFixture, "f" | "organizationId" | "owner">,
  workflowId: string,
  versionId: string,
): Promise<Response> {
  const current = await read<{ version: number }>(
    await ticketCall(fx, "GET", `/v1/workflows/${workflowId}`),
    200,
  );
  return await ticketCall(
    fx,
    "POST",
    `/v1/workflows/${workflowId}/activations`,
    {
      body: { versionId },
      ifMatch: current.version,
    },
  );
}

export async function publishWrittenWorkflow(
  fx: Pick<TicketFixture, "f" | "organizationId" | "owner">,
  slug: string,
  options: WrittenOptions = {},
): Promise<WrittenWorkflow> {
  const name = `Written ${slug}`;
  const created = await read<{ id: string }>(
    await ticketCall(fx, "POST", "/v1/workflows", {
      body: { slug, name, description: "" },
    }),
    201,
  );
  const versionId = await publishVersion(fx, created.id, options);
  const active = await read<{ activeVersionId: string }>(
    await activateVersion(fx, created.id, versionId),
    200,
  );
  assertEquals(active.activeVersionId, versionId);
  return { workflowId: created.id, versionId, name };
}
