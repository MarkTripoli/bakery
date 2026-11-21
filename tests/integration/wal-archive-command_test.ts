import { assert, assertEquals } from "@std/assert";
import { join } from "node:path";
import { listSpool } from "../../scripts/deploy/backup-runner/wal.ts";

/**
 * #80 P1b: the archive_command shipped in infra/production/compose.yaml must
 * never leave a partly written segment under its final name, or a runner pass
 * can upload half a segment and delete it. The command is read from the
 * compose file and run as Postgres runs it, with a slow `cp` stand-in, while
 * the spool is listed the way the runner lists it.
 */

const REPO = new URL("../../", import.meta.url).pathname;
const SEGMENT = "000000010000000000000041";

async function shippedArchiveCommand(): Promise<string> {
  const compose = await Deno.readTextFile(
    join(REPO, "infra/production/compose.yaml"),
  );
  const match = compose.match(/^\s*- archive_command=(.+)$/m);
  assert(match, "compose.yaml sets no archive_command");
  return match[1].trim();
}

Deno.test("the shipped archive_command never shows a half-copied segment to the runner", async () => {
  const dir = await Deno.makeTempDir({ prefix: "bakery-archive-command-" });
  try {
    const spool = join(dir, "wal-spool");
    const bin = join(dir, "bin");
    await Deno.mkdir(spool);
    await Deno.mkdir(bin);
    const source = join(dir, "pg_wal-" + SEGMENT);
    const bytes = new Uint8Array(256 * 1024).map((_, i) => i % 251);
    await Deno.writeFile(source, bytes);
    // A cp that writes its destination in 16 slow chunks, as a real copy of a
    // 16 MiB segment does over time.
    await Deno.writeTextFile(
      join(bin, "cp"),
      [
        "#!/bin/sh",
        'src="$1"; dst="$2"',
        ': > "$dst"',
        "i=0",
        'while [ "$i" -lt 16 ]; do',
        '  dd if="$src" bs=16384 skip="$i" count=1 2>/dev/null >> "$dst"',
        "  sleep 0.05",
        "  i=$((i + 1))",
        "done",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const command = (await shippedArchiveCommand())
      .replaceAll("/wal-spool", spool)
      .replaceAll("%p", source)
      .replaceAll("%f", SEGMENT);
    const child = new Deno.Command("sh", {
      args: ["-c", command],
      env: { PATH: `${bin}:/usr/bin:/bin` },
      stdout: "null",
      stderr: "piped",
    }).spawn();
    let running = true;
    const status = child.status.then((s) => {
      running = false;
      return s;
    });
    let sawPartial = false;
    let polls = 0;
    while (running) {
      const listed = await listSpool(spool);
      polls += 1;
      for (const file of listed) {
        const size = (await Deno.stat(join(spool, file.name))).size;
        if (file.name === SEGMENT && size < bytes.length) sawPartial = true;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const exit = await status;
    assertEquals(exit.code, 0);
    assert(polls > 5, `the copy was too quick to observe (${polls} polls)`);
    assertEquals(
      sawPartial,
      false,
      "the runner could list a segment that was still being copied",
    );
    assertEquals(await Deno.readFile(join(spool, SEGMENT)), bytes);
    const left = [];
    for await (const entry of Deno.readDir(spool)) left.push(entry.name);
    assertEquals(left, [SEGMENT]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
