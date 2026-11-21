import { assertEquals } from "@std/assert";
import {
  nextRestoreStep,
  RESTORE_STEPS,
} from "../../apps/server/src/modules/backups/restore-release.ts";

/**
 * #64 slice E3: which door each guarded entry point asks for. A restore hold
 * opens intake first, dispatch second and workers last, so a worker claim that
 * asked for the intake door would run before an administrator opened workers.
 * Each case reads the entry point's own source: it is the call that must name
 * its door.
 */

const root = new URL("../../apps/server/src/", import.meta.url);
const read = (path: string) => Deno.readTextFileSync(new URL(path, root));

Deno.test("a worker claim asks for the workers door", () => {
  assertEquals(
    /assertNotQuiesced\(transaction, "workers"\)/.test(
      read("modules/execution/claim.ts"),
    ),
    true,
  );
});

Deno.test("the retention collector and the storage purge ask for the dispatch door", () => {
  assertEquals(
    /assertNotQuiesced\(transaction, "dispatch"\)/.test(
      read("modules/knowledge/retention/collector.ts"),
    ),
    true,
  );
  const purge = read("modules/knowledge/storage-record-purge.ts");
  assertEquals(purge.match(/assertNotQuiesced\(tx, "dispatch"\)/g)?.length, 2);
});

Deno.test("run creation, imports, catalog changes and intake ask for the intake door", () => {
  for (
    const path of [
      "modules/work/run-command.ts",
      "modules/knowledge/import.ts",
      "modules/catalog/persistence.ts",
    ]
  ) {
    assertEquals(
      /assertNotQuiesced\(transaction, "intake"\)/.test(read(path)),
      true,
      path,
    );
  }
  for (
    const path of [
      "modules/integrations/intake-workflow.ts",
      "modules/workflows/automations/event-intake.ts",
    ]
  ) {
    assertEquals(
      /isQuiesced\(transaction, "intake"\)/.test(read(path)),
      true,
      path,
    );
  }
});

Deno.test("the steps are intake, dispatch, workers, and the next one is the first not taken", () => {
  assertEquals([...RESTORE_STEPS], ["intake", "dispatch", "workers"]);
  const none = { intake: false, dispatch: false, workers: false };
  assertEquals(nextRestoreStep(none), "intake");
  assertEquals(nextRestoreStep({ ...none, intake: true }), "dispatch");
  assertEquals(
    nextRestoreStep({ intake: true, dispatch: true, workers: false }),
    "workers",
  );
  assertEquals(
    nextRestoreStep({ intake: true, dispatch: true, workers: true }),
    null,
  );
});
