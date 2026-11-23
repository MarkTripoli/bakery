/**
 * The session credential is a secret in the harness, exactly as the lease token.
 *
 * The credential reaches the child through an attempt-private file it can read,
 * which is the point of handing it over as a file. The consequence is that any
 * command the child runs can `cat` that file, so its bytes must be treated the
 * way the lease token is: withheld from published patches and replaced in
 * anything the harness reports.
 *
 * `secretNeedleVariants` is the single list every redaction and patch scan reads,
 * so this proves two things at once — that a value placed in that list is
 * actually matched, including inside a larger line — and that each harness puts
 * the session credential in its list at each of its publication sites.
 */

import { assert, assertEquals } from "@std/assert";
import { join } from "node:path";
import { secretNeedleVariants } from "../../apps/worker/src/native-output.ts";

const SOURCE_DIR = join(
  new URL(".", import.meta.url).pathname,
  "../../apps/worker/src",
);

const HARNESSES = ["claude-harness.ts", "codex-harness.ts", "pi-harness.ts"];

const SESSION_CREDENTIAL = "session-credential-6f1c9a2b4d8e0f37";

Deno.test("a secret in the list is found inside a line of output", () => {
  const needles = secretNeedleVariants([SESSION_CREDENTIAL]);
  assert(needles.length > 0, "the list produced no needle");
  // What `cat` of the credential file prints, surrounded by the rest of the
  // output a talkative tool would produce.
  const output =
    `$ cat $BAKERY_SESSION_CREDENTIAL_FILE\n${SESSION_CREDENTIAL}\n`;
  assert(
    needles.some((needle) => output.includes(needle)),
    "the credential was not matched inside the output",
  );
});

Deno.test("every harness redacts the session credential at every publication site", async () => {
  for (const harness of HARNESSES) {
    const source = await Deno.readTextFile(join(SOURCE_DIR, harness));
    const sites = source.match(/assignment\.leaseToken,/g) ?? [];
    const credentials = source.match(
      /assignment\.sessionCredential === undefined/g,
    ) ?? [];
    assert(sites.length > 0, `${harness} has no publication site`);
    assertEquals(
      credentials.length,
      sites.length,
      `${harness} redacts the session credential at ${credentials.length} of ${sites.length} sites`,
    );
  }
});

Deno.test("the credential is written as a file and never put in a child environment", async () => {
  const source = await Deno.readTextFile(
    join(SOURCE_DIR, "session-credential-file.ts"),
  );
  // The environment the child receives names the file, and the file's path is
  // derived from the attempt. A value in the environment would be readable from
  // `/proc/<pid>/environ` and would survive in a crash dump.
  assert(
    source.includes("BAKERY_SESSION_CREDENTIAL_FILE"),
    "the child environment does not name the credential file",
  );
  assertEquals(
    /BAKERY_SESSION_CREDENTIAL\s*:/.test(source),
    false,
    "the credential itself is assigned into the child environment",
  );
});
