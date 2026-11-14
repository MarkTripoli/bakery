import { assert, assertEquals, assertRejects } from "@std/assert";
import { mkdtemp, open as openFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readRecord,
  UnreadableRecord,
} from "../../packages/worker-bootstrap/src/index.ts";

// #18 (security): the install root is a directory anyone with write access to
// it could have changed. `status` and `doctor` read three things from it (the
// pairing record, the release record, the installed binary); a FIFO that never
// answers, a link to /dev/zero that never ends, a 300 MB file or a directory in
// any of those places must give a quick "cannot be read" and never hang the
// command or fill memory. Each case is built and measured in its own process,
// which is why the script is a fixture: it creates the `current` link and the
// FIFO that this lane's scoped permissions do not allow in-process.

const FIXTURE =
  new URL("../fixtures/worker-bootstrap-hostile-root.ts", import.meta.url)
    .pathname;
const MAX_MS = 3_000;
const MAX_RSS = 400 * 1024 * 1024;

type Result = {
  ms: number;
  installation: { state: string; intact?: boolean };
  pairing: string;
  checks: Record<string, string>;
  rss: number;
};

async function run(which: string, hostile: string): Promise<Result> {
  const root = await mkdtemp(join(tmpdir(), "bakery-hostile-root-"));
  try {
    const child = new Deno.Command(Deno.execPath(), {
      args: ["run", "--allow-all", FIXTURE, which, hostile, root],
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    // A command that hangs is killed here, which fails the case.
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }, 15_000);
    const output = await child.output();
    clearTimeout(timer);
    assert(
      output.success,
      `${which}/${hostile}: ${new TextDecoder().decode(output.stderr)}`,
    );
    return JSON.parse(new TextDecoder().decode(output.stdout));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

for (const hostile of ["fifo", "devzero", "sparse", "directory"]) {
  Deno.test(`a ${hostile} where the pairing record should be is "cannot be read", quickly and without filling memory`, async () => {
    const result = await run("pairing", hostile);
    assertEquals(result.pairing, "unreadable");
    assertEquals(result.checks.pairing, "failed");
    assertEquals(result.installation.state, "installed");
    assert(result.ms < MAX_MS, `took ${result.ms} ms`);
    assert(result.rss < MAX_RSS, `rss ${result.rss}`);
  });

  Deno.test(`a ${hostile} where the release record should be is "cannot be read", quickly and without filling memory`, async () => {
    const result = await run("release", hostile);
    assertEquals(result.installation.state, "unreadable");
    assertEquals(result.checks.install, "failed");
    assertEquals(result.pairing, "paired");
    assert(result.ms < MAX_MS, `took ${result.ms} ms`);
    assert(result.rss < MAX_RSS, `rss ${result.rss}`);
  });

  Deno.test(`a ${hostile} where the installed binary should be is "not intact", never read, quickly and without filling memory`, async () => {
    const result = await run("binary", hostile);
    assertEquals(result.installation.state, "installed");
    assertEquals(result.installation.intact, false);
    assertEquals(result.checks.install, "failed");
    assert(result.ms < MAX_MS, `took ${result.ms} ms`);
    assert(result.rss < MAX_RSS, `rss ${result.rss}`);
  });
}

Deno.test("a name swapped for a FIFO between the look and the open does not block the read: it is refused at once, not at the deadline", async () => {
  const root = await mkdtemp(join(tmpdir(), "bakery-swap-"));
  try {
    const path = join(root, "record");
    await writeFile(path, "{}");
    const started = Date.now();
    await assertRejects(
      () =>
        readRecord(path, 100, 10_000, async (opened, flags, mode) => {
          await rm(opened as string);
          const made = await new Deno.Command("mkfifo", {
            args: [opened as string],
          }).output();
          assert(made.success);
          return await openFile(opened, flags, mode);
        }),
      UnreadableRecord,
      "not a plain small file",
    );
    assert(
      Date.now() - started < 2_000,
      "refused long before the 10 s deadline",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
