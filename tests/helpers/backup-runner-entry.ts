import { runRunner } from "../../scripts/deploy/backup-runner.ts";
import { readArtifact } from "../../scripts/deploy/backup-runner/backup-step.ts";

/**
 * Test entry for the process-level permission test: the real runner entry with
 * a stand-in for backup.sh (pg_dump and age live on the real host). It is run
 * by `deno run` with the permission flags taken from scripts/deploy/runtime.sh,
 * so a permission the production unit would lack fails here.
 */
const root = Deno.env.get("STUB_BACKUPS_ROOT") ?? "";
const name = "20261120T030000Z-00000000-0000-4000-8000-000000000001";

Deno.exit(
  await runRunner({
    env: Deno.env.toObject(),
    backupsRoot: root,
    backup: async () => {
      await Deno.mkdir(`${root}/${name}`, { recursive: true });
      for (
        const [file, text] of Object.entries({
          "bakery.dump.age": "dump-bytes".repeat(30),
          "release.json": "{}",
          SHA256SUMS: "sums\n",
        })
      ) await Deno.writeTextFile(`${root}/${name}/${file}`, text);
      return await readArtifact(root, name);
    },
  }),
);
