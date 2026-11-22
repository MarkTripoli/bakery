import { assert, assertEquals } from "@std/assert";
import {
  CHILD_ENV_NAMES,
  defaultExec,
} from "../../scripts/deploy/backup-runner/drill.ts";

/**
 * #64 slice D: the drill's real process runner, with a real `bash`. It is in
 * the integration lane because it spawns a process; the unit lane may not.
 */

Deno.test("the real exec reports exit codes, output and stdin, and hands a child only the allow-listed environment", async () => {
  const exec = defaultExec();
  assertEquals(await exec(["bash", "-c", "echo out; echo err >&2; exit 3"]), {
    code: 3,
    stdout: "out\n",
    stderr: "err\n",
  });
  assertEquals(
    (await exec(["bash", "-c", "cat"], { stdin: "piped in" })).stdout,
    "piped in",
  );
  // The runner's credential is in this process's environment but never reaches a child.
  Deno.env.set("BAKERY_BACKUP_RUNNER_TOKEN", "must-not-reach-a-child");
  try {
    const seen = await exec([
      "bash",
      "-c",
      'echo "${BAKERY_BACKUP_RUNNER_TOKEN:-absent}"',
    ]);
    assertEquals(seen.stdout.trim(), "absent");
  } finally {
    Deno.env.delete("BAKERY_BACKUP_RUNNER_TOKEN");
  }
  assert(CHILD_ENV_NAMES.includes("PATH"));
  assert(
    !(CHILD_ENV_NAMES as readonly string[]).some((name) =>
      name.includes("TOKEN")
    ),
  );
});
