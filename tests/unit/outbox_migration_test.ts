import { assertEquals } from "@std/assert";

Deno.test("outbox constraints validate in a later transaction", async () => {
  const migrationRoot = new URL(
    "../../apps/server/src/modules/work/migrations/bakery/",
    import.meta.url,
  );
  const installation = await Deno.readTextFile(
    new URL("0016_outbox_dispatch_constraints.sql", migrationRoot),
  );
  const validation = await Deno.readTextFile(
    new URL("0017_outbox_dispatch_constraint_validation.sql", migrationRoot),
  );

  assertEquals(installation.includes("validate constraint"), false);
  assertEquals(
    validation.trim(),
    "alter table bakery.outbox\n  validate constraint outbox_organization_event_fk;",
  );
});
