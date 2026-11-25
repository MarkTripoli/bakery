import { assertEquals, assertThrows } from "@std/assert";
import { StandardError } from "../../packages/contracts/src/http.ts";
import {
  defaultTicketSourcePolicy,
  type TicketSourcePolicy,
} from "../../packages/contracts/src/ticket-admission.ts";
import {
  assertPolicyTriggersDeclared,
  ticketTriggersOf,
} from "../../apps/server/src/modules/work/ticket-triggers.ts";

const withStatuses: TicketSourcePolicy = {
  ...defaultTicketSourcePolicy(),
  readiness: { requireAcceptanceCriteria: true, statuses: ["open"] },
};

Deno.test("a source may name statuses only on a provider that declares the status trigger (#407)", () => {
  assertEquals(ticketTriggersOf("github"), ["label", "status"]);
  assertEquals(ticketTriggersOf("linear"), ["label", "status"]);
  assertEquals(ticketTriggersOf("unknown-tracker"), ["label"]);
  assertPolicyTriggersDeclared("github", withStatuses);
  assertPolicyTriggersDeclared("linear", withStatuses);
  assertPolicyTriggersDeclared("unknown-tracker", defaultTicketSourcePolicy());
  const refused = assertThrows(
    () => assertPolicyTriggersDeclared("unknown-tracker", withStatuses),
    StandardError,
  );
  assertEquals(refused.code, "UNPROCESSABLE");
  assertEquals(
    (refused.params as { issues: { code: string }[] }).issues[0].code,
    "status_trigger_unsupported",
  );
});
