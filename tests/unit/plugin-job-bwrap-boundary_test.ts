import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  boundaryArgs,
  BWRAP_CODE_MOUNT,
  HIDDEN_DIRS,
  refusalReason,
} from "../../apps/worker/src/plugin-job-bwrap.ts";
import { jobCommand } from "../../apps/worker/src/plugin-job-select.ts";

// #29 (QA of #932): the bubblewrap boundary is built from what the host has,
// starts a job with no inherited environment, hides the worker's own state,
// and says why it could not start. None of this needs user namespaces.

const tmpfsDirs = (args: readonly string[]) =>
  args.flatMap((arg, i) => args[i - 1] === "--tmpfs" ? [arg] : []);

Deno.test("only directories the host has are hidden: a host without /media still starts", () => {
  const present = new Set(["/run", "/home", "/root", "/mnt", "/var/tmp"]);
  const dirs = tmpfsDirs(boundaryArgs({ exists: (p) => present.has(p) }));
  assertEquals(dirs.includes("/media"), false);
  for (const dir of present) assertEquals(dirs.includes(dir), true, dir);
});

Deno.test("every default directory is hidden when it exists, and /tmp always", () => {
  const dirs = tmpfsDirs(boundaryArgs({ exists: () => true }));
  assertEquals(dirs.includes("/tmp"), true);
  for (const dir of HIDDEN_DIRS) assertEquals(dirs.includes(dir), true, dir);
});

Deno.test("the worker's state directory is hidden too, when it exists", () => {
  const args = boundaryArgs({
    hide: ["/var/lib/bakery-worker"],
    exists: () => true,
  });
  assertEquals(tmpfsDirs(args).includes("/var/lib/bakery-worker"), true);
  const gone = boundaryArgs({
    hide: ["/var/lib/bakery-worker"],
    exists: (p) => p !== "/var/lib/bakery-worker",
  });
  assertEquals(tmpfsDirs(gone).includes("/var/lib/bakery-worker"), false);
});

Deno.test("a job inherits no environment: it is cleared and only PATH and HOME are set", () => {
  const args = boundaryArgs({ exists: () => false });
  assertEquals(args.includes("--clearenv"), true);
  const set = args.flatMap((arg, i) => args[i - 1] === "--setenv" ? [arg] : []);
  assertEquals(set, ["PATH", "HOME"]);
  // The environment is cleared before the root is bound, in the one argument list.
  assertEquals(args.indexOf("--clearenv") < args.indexOf("--ro-bind"), true);
});

Deno.test("the code is mounted under /tmp, which the boundary creates itself", () => {
  assertEquals(BWRAP_CODE_MOUNT.startsWith("/tmp/"), true);
  const args = boundaryArgs({ exists: () => false });
  assertEquals(args.includes("/tmp"), true);
  assertEquals(
    jobCommand({}, "main.ts", BWRAP_CODE_MOUNT).at(-1),
    `${BWRAP_CODE_MOUNT}/main.ts`,
  );
  assertEquals(jobCommand({}, "main.ts").at(-1), "/code/main.ts");
});

Deno.test("a failure that is not a namespace refusal is not reported as one", () => {
  assertStringIncludes(
    refusalReason("bwrap: Can't mkdir /media: Read-only file system"),
    "Read-only file system",
  );
  assertStringIncludes(
    refusalReason("bwrap: setting up uid map: Permission denied"),
    "user namespaces",
  );
  assertStringIncludes(
    refusalReason(
      "bwrap: No permissions to create new namespace, Operation not permitted",
    ),
    "user namespaces",
  );
  assertStringIncludes(refusalReason(""), "said nothing");
});
