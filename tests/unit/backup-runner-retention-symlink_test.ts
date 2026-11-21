import { assertEquals } from "@std/assert";
import { pruneLocal } from "../../scripts/deploy/backup-runner/offsite.ts";

/**
 * Local retention against a real directory. It lives in the unit lane on
 * purpose: it needs a real symlink, and `Deno.symlink` needs unrestricted write
 * permission, which the integration lane (scoped to the temporary directory)
 * does not give. It spawns nothing and opens no socket.
 */

const set = (stamp: string, n = 1) =>
  `${stamp}-00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const N1 = set("20260101T030000Z", 1);
const N2 = set("20260201T030000Z", 2);
const N3 = set("20261119T030000Z", 3);

async function withTemp<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "bakery-runner-offsite-" });
  try {
    return await run(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("local retention removes expired set directories only", async () => {
  await withTemp(async (root) => {
    const backups = `${root}/backups`;
    await Deno.mkdir(backups);
    for (const name of [N1, N2, N3]) {
      await Deno.mkdir(`${backups}/${name}`);
      await Deno.writeTextFile(`${backups}/${name}/SHA256SUMS`, "x");
    }
    await Deno.writeTextFile(`${backups}/latest`, `${backups}/${N3}\n`);
    await Deno.mkdir(`${backups}/.pending-AbCd1234`);
    // A symlink that is named like an old set must not be followed or removed.
    const elsewhere = `${root}/elsewhere`;
    await Deno.mkdir(elsewhere);
    await Deno.writeTextFile(`${elsewhere}/precious`, "keep");
    const linked = set("20250101T030000Z", 9);
    await Deno.symlink(elsewhere, `${backups}/${linked}`);
    const removed = await pruneLocal({
      root: backups,
      artifactName: N3,
      daysToKeep: 30,
      now: new Date("2026-11-20T12:00:00Z"),
    });
    assertEquals(removed, [N1, N2]);
    const left = [];
    for await (const entry of Deno.readDir(backups)) left.push(entry.name);
    assertEquals(
      left.sort(),
      [".pending-AbCd1234", linked, "latest", N3].sort(),
    );
    assertEquals(await Deno.readTextFile(`${elsewhere}/precious`), "keep");
  });
});
