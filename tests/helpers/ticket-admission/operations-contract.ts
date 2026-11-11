import { assert, assertEquals } from "@std/assert";
import type { z } from "zod";
import {
  assertDescribedJsonSchema,
  catalogActions,
  contractSchemas,
  generateContracts,
  toJsonSchema,
} from "../../../packages/contracts/src/contracts.ts";
import {
  implementedActions,
  TicketImplementedAction,
  ticketImplementedActions,
} from "../../../packages/contracts/src/implemented-actions.ts";
import type { PgDatabase } from "../../../apps/server/src/platform/database.ts";
import { createTicketActionRegistry } from "../../../apps/server/src/modules/work/ticket-actions.ts";
import { TICKET_DEADLINE_MS } from "../../../apps/server/src/modules/work/ticket-routes.ts";
import type {
  TicketFactIndex,
  TicketSourceReader,
} from "../../../apps/server/src/modules/work/ticket-source-reader.ts";

/*
 * Issue 82 operation contract: the implemented flags, the runtime registry,
 * the described schemas, the declared errors and the receipt shape of the
 * eleven ticket operations. Remote ticket creation stays unimplemented.
 */

const schemas = contractSchemas as unknown as Record<string, z.ZodType>;

function registry() {
  return createTicketActionRegistry({} as PgDatabase, {
    reader: {} as TicketSourceReader,
    factIndex: {} as TicketFactIndex,
    budget: undefined,
    cursorSecret: "operations-contract-cursor-secret",
  });
}

Deno.test("issue 82 ops contract: all eleven operations are implemented, registered and described", async () => {
  assertEquals(ticketImplementedActions.length, 11);
  assertEquals(
    [...ticketImplementedActions].sort(),
    Object.values(TicketImplementedAction).sort(),
  );
  const registered = registry().list();
  assertEquals(
    registered.map(({ name }) => name).sort(),
    [...ticketImplementedActions].sort(),
  );
  const generated = generateContracts();
  const checkedIn = JSON.parse(
    await Deno.readTextFile(
      new URL(
        "../../../packages/contracts/generated/contracts.json",
        import.meta.url,
      ),
    ),
  ) as { actions: { action: string; implemented: boolean }[] };
  for (const name of ticketImplementedActions) {
    assert(implementedActions.includes(name), name);
    assertEquals(
      generated.actions.find((entry) => entry.action === name)?.implemented,
      true,
      name,
    );
    assertEquals(
      checkedIn.actions.find((entry) => entry.action === name)?.implemented,
      true,
      `${name} in contracts.json`,
    );
    const catalog = catalogActions.find((entry) => entry.action === name)!;
    for (const schema of [catalog.input, catalog.output]) {
      assertDescribedJsonSchema(
        toJsonSchema(schemas[schema]),
        `${name}.${schema}`,
      );
    }
  }
  // Remote ticket creation is not part of this series.
  assertEquals(
    checkedIn.actions.find((entry) => entry.action === "externalTickets.create")
      ?.implemented,
    false,
  );
});

Deno.test("issue 82 ops contract: reading operations declare the errors a client must handle", () => {
  const errors = (name: string) =>
    catalogActions.find((entry) => entry.action === name)!.errors;
  for (const name of ["ticketSources.preview", "ticketSources.sync"]) {
    for (
      const code of [
        "DEPENDENCY_UNAVAILABLE",
        "STATE_CONFLICT",
        "UNPROCESSABLE",
        "IDEMPOTENCY_PAYLOAD_MISMATCH",
      ]
    ) assert(errors(name).includes(code as never), `${name} ${code}`);
  }
  for (const code of ["PRECONDITION_FAILED", "STATE_CONFLICT"]) {
    assert(
      errors("ticketSources.update").includes(code as never),
      `update ${code}`,
    );
  }
  assert(errors("ticketSources.list").includes("INVALID_CURSOR" as never));
  for (const name of ["ticketReadiness.create", "ticketRequests.create"]) {
    for (
      const code of [
        "DEPENDENCY_UNAVAILABLE",
        "PRECONDITION_FAILED",
        "STATE_CONFLICT",
        "UNPROCESSABLE",
        "IDEMPOTENCY_PAYLOAD_MISMATCH",
      ]
    ) assert(errors(name).includes(code as never), `${name} ${code}`);
  }
  for (
    const code of ["STATE_CONFLICT", "UNPROCESSABLE", "RESOURCE_NOT_FOUND"]
  ) {
    assert(
      errors("ticketTaskLinks.create").includes(code as never),
      `link ${code}`,
    );
  }
});

Deno.test("issue 82 ops contract: ticketRequests.create alone carries the admission guard", () => {
  const guarded = registry().list().filter((action) =>
    action.policy.authorize !== undefined
  );
  assertEquals(guarded.map(({ name }) => name), ["ticketRequests.create"]);
  assertEquals(guarded[0].policy.access, "Developer+admission authority");
});

Deno.test("issue 82 ops contract: a receipt names an operation by a UUID and a lifecycle status", () => {
  const receipt = contractSchemas.TicketOperationReceipt;
  assert(
    receipt.safeParse({
      operationId: crypto.randomUUID(),
      status: "completed",
    }).success,
  );
  for (
    const bad of [
      { status: "completed" },
      { operationId: "not-a-uuid", status: "completed" },
      { operationId: crypto.randomUUID(), status: "done" },
    ]
  ) assertEquals(receipt.safeParse(bad).success, false, JSON.stringify(bad));
  // Ticket requests may run longer than the router default, for the 25-issue preview.
  assertEquals(TICKET_DEADLINE_MS, 30_000);
});
