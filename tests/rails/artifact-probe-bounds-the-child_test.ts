/**
 * The server's side of the probe wall (#437 slice 2).
 *
 * The unit is the real sandbox. This test is about what the *server* does when
 * the child misbehaves anyway: a child that writes nothing, one that writes for
 * ever, one that outlives its budget, and one that dies of its memory limit.
 * Each is a named refusal rather than a hang or a crash, because a page that
 * asks a dead probe for a thumbnail must get an answer.
 *
 * The stub launchers below are shell scripts, so they are the same kind of
 * thing the real launcher is (a process that writes to stdout and exits) rather
 * than a mock of one.
 */
import { assert, assertEquals } from "@std/assert";
import { probeArtifactBytes } from "../../apps/server/src/modules/knowledge/probe.ts";
import { PNG_FRAME, writeStub } from "../helpers/probe-stub-launcher.ts";

const dir = await Deno.makeTempDir({ prefix: "bakery-probe-test-" });

/** A stub whose probe branch is the shell given here. */
async function stub(name: string, body: string): Promise<string> {
  // Self-test frames are answered by the helper's sealed branch. The stubs below
  // are about what happens once the sandbox says yes, so the sealed answer is
  // the precondition for all of them.
  return await writeStub(dir, name, { probe: body });
}

const input = { path: "/tmp/whatever", sizeBytes: 16 };

Deno.test("a probe that answers is read back as its result", async () => {
  const launcher = await stub("ok", `printf '%s' '${PNG_FRAME}'`);
  assertEquals(await probeArtifactBytes(input, { launcherPath: launcher }), {
    status: "described",
    kind: "image",
    mediaType: "image/png",
    byteLength: 16,
    width: 2,
    height: 2,
  });
});

Deno.test("a probe that writes nothing is unreadable, not an empty file", async () => {
  const launcher = await stub("silent", ":");
  assertEquals(
    await probeArtifactBytes(input, { launcherPath: launcher }),
    { status: "refused", code: "unreadable" },
  );
});

Deno.test("a probe that outlives its budget is killed and reported as a timeout", async () => {
  const launcher = await stub("slow", "sleep 30");
  const started = Date.now();
  const result = await probeArtifactBytes(input, {
    launcherPath: launcher,
    timeoutMs: 300,
  });
  assertEquals(result, { status: "refused", code: "timeout", limit: 300 });
  // It was killed, not waited out.
  assert(Date.now() - started < 5_000, "the timeout did not stop the child");
});

Deno.test("a probe that writes for ever is cut off rather than buffered", async () => {
  const launcher = await stub(
    "flood",
    `while : ; do printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; done`,
  );
  assertEquals(
    await probeArtifactBytes(input, {
      launcherPath: launcher,
      timeoutMs: 5_000,
    }),
    { status: "refused", code: "malformed" },
  );
});

Deno.test("a probe killed by its memory limit says so", async () => {
  // 137 is SIGKILL, which is what the unit's OOMPolicy delivers.
  const launcher = await stub("oom", "exit 137");
  assertEquals(
    await probeArtifactBytes(input, { launcherPath: launcher }),
    { status: "refused", code: "memory", limit: 536870912 },
  );
});

Deno.test("a launcher that exits 69 is the host, not the file", async () => {
  const launcher = await stub("unavailable", "exit 69");
  assertEquals(
    await probeArtifactBytes(input, { launcherPath: launcher }),
    { status: "refused", code: "sandbox-unavailable" },
  );
});

Deno.test("a launcher that cannot be started at all is unavailable", async () => {
  assertEquals(
    await probeArtifactBytes(input, {
      launcherPath: `${dir}/does-not-exist`,
    }),
    { status: "refused", code: "sandbox-unavailable" },
  );
});

Deno.test("a frame that is not the schema is malformed, never a confident guess", async () => {
  const launcher = await stub(
    "liar",
    `printf '%s' '{"result":{"status":"described","kind":"image","mediaType":"image/png","byteLength":16,"width":-2}}'`,
  );
  assertEquals(
    await probeArtifactBytes(input, { launcherPath: launcher }),
    { status: "refused", code: "malformed" },
  );
});

Deno.test("the child is told the path and size and nothing else", async () => {
  // A stub that echoes its input back through the frame: whatever the server
  // sends is visible here, so a future field cannot be added unnoticed.
  const launcher = await stub(
    "echo",
    `case "$request" in
       '{"path":"/tmp/whatever","sizeBytes":16}') ;;
       *) printf '%s' '{"result":{"status":"refused","code":"malformed"}}'; exit 0 ;;
     esac
     printf '%s' '{"result":{"status":"described","kind":"text","mediaType":"text/plain","byteLength":16,"lineCount":1,"utf8":true}}'`,
  );
  assertEquals(
    await probeArtifactBytes(input, { launcherPath: launcher }),
    {
      status: "described",
      kind: "text",
      mediaType: "text/plain",
      byteLength: 16,
      lineCount: 1,
      utf8: true,
    },
  );
});
