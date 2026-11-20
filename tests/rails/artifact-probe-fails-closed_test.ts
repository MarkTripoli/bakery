/**
 * The sandbox must prove it is sealed before the server hands it a file
 * (#437 slice 2).
 *
 * `PrivateNetwork=yes` is a request. A user manager that cannot create a network
 * namespace accepts it and logs "proceeding without", and the unit then runs on
 * the host's own network — so the unit's own configuration cannot answer
 * whether the sandbox exists. Only a connect made *inside* the unit can, which
 * is what the self-test asks.
 *
 * The rule these tests hold is that every uncertain answer is "no": an unsealed
 * sandbox, a sandbox that could not be asked, one that hung, one that answered
 * nonsense, and a host that could not build the unit at all. The cost of being
 * wrong in that direction is a missing preview. The cost of being wrong the
 * other way is a stranger's file running with the server's network.
 */
import { assert, assertEquals } from "@std/assert";
import {
  forgetSandboxPreflight,
  probeArtifactBytes,
  probeBlob,
  sandboxHoldsNetwork,
} from "../../apps/server/src/modules/knowledge/probe.ts";
import {
  PNG_FRAME,
  SEALED,
  UNSEALED,
  writeStub,
} from "../helpers/probe-stub-launcher.ts";

const dir = await Deno.makeTempDir({ prefix: "bakery-probe-preflight-" });
const input = { path: "/tmp/whatever", sizeBytes: 16 };

/** A lock so each test starts from "the host has not been asked yet". */
function fresh(): void {
  forgetSandboxPreflight();
}

Deno.test("a sealed sandbox says yes, and the probe runs", async () => {
  fresh();
  const launcher = await writeStub(dir, "sealed", {
    probe: `printf '%s' '${PNG_FRAME}'`,
  });
  assertEquals(await sandboxHoldsNetwork({ launcherPath: launcher }), true);
  assertEquals(
    (await probeArtifactBytes(input, { launcherPath: launcher }))
      .status,
    "described",
  );
});

Deno.test("a connect that succeeds inside the unit means there is no sandbox", async () => {
  fresh();
  const launcher = await writeStub(dir, "unsealed", {
    selfTest: UNSEALED,
    probe: `printf '%s' '${PNG_FRAME}'`,
  });
  assertEquals(await sandboxHoldsNetwork({ launcherPath: launcher }), false);
  // And the file is never described by a process that could reach the network:
  // the probe stub above would happily answer, and the answer must not be taken.
  assertEquals(
    await probeArtifactBytes(input, { launcherPath: launcher }),
    { status: "refused", code: "sandbox-unavailable" },
  );
});

Deno.test("a self-test that namespaces could not be built fails closed", async () => {
  fresh();
  // 218 and 226 are what systemd returns when the unit's namespaces cannot be
  // set up: the sandbox was not built, so it is not a sandbox.
  for (const code of [218, 226, 69]) {
    const launcher = await writeStub(dir, `ns-${code}`, {
      selfTest: `exit:${code}`,
      probe: `printf '%s' '${PNG_FRAME}'`,
    });
    forgetSandboxPreflight();
    assertEquals(
      await probeArtifactBytes(input, { launcherPath: launcher }),
      { status: "refused", code: "sandbox-unavailable" },
      `exit ${code} must not be read as a described file`,
    );
  }
});

Deno.test("a unit that dies setting up its namespaces is the host, not the file", async () => {
  fresh();
  // The self-test answered "sealed" and then systemd failed to build the unit
  // for the real probe. Called "unreadable" this would be stored as a property
  // of a perfectly good file; it is a host that could not run the sandbox.
  for (const code of [218, 226]) {
    const launcher = await writeStub(dir, `probe-ns-${code}`, {
      selfTest: SEALED,
      probe: `exit ${code}`,
    });
    forgetSandboxPreflight();
    assertEquals(
      await probeArtifactBytes(input, { launcherPath: launcher }),
      { status: "refused", code: "sandbox-unavailable" },
      `exit ${code} on the probe is not an unreadable file`,
    );
  }
});

Deno.test("a self-test that answers nonsense, or nothing, fails closed", async () => {
  fresh();
  for (
    const [name, frame] of [
      ["garbage", "not json"],
      ["wrong-shape", '{"selfTest":"network"}'],
      ["probe-frame", PNG_FRAME],
      ["empty", ""],
    ] as const
  ) {
    const launcher = await writeStub(dir, `bad-${name}`, {
      selfTest: frame,
      probe: `printf '%s' '${PNG_FRAME}'`,
    });
    forgetSandboxPreflight();
    assertEquals(
      await sandboxHoldsNetwork({ launcherPath: launcher }),
      false,
      `${name} is not a sealed sandbox`,
    );
  }
});

Deno.test("a self-test that hangs does not hold the server open", async () => {
  fresh();
  const launcher = await writeStub(dir, "hang", {
    selfTest: "sleep",
    probe: `printf '%s' '${PNG_FRAME}'`,
  });
  const started = Date.now();
  assertEquals(
    await probeArtifactBytes(input, {
      launcherPath: launcher,
      timeoutMs: 300,
    }),
    { status: "refused", code: "sandbox-unavailable" },
  );
  assert(Date.now() - started < 8_000, "the preflight was bounded");
});

Deno.test("an unsealed sandbox writes no probe row", async () => {
  fresh();
  const launcher = await writeStub(dir, "no-row", {
    selfTest: UNSEALED,
    probe: `printf '%s' '${PNG_FRAME}'`,
  });
  const statements: string[] = [];
  const database = {
    query: (text: string) => {
      statements.push(text);
      return Promise.resolve({ rows: [] as unknown[] });
    },
  };
  const result = await probeBlob(
    database as never,
    { organizationId: "org", blobId: "blob", ...input },
    { launcherPath: launcher },
  );
  assertEquals(result, { status: "refused", code: "sandbox-unavailable" });
  // The rule from the persistence half, kept here as well: a refusal about the
  // host is never recorded against the file. The only statement that may run is
  // the read that looks for an existing row.
  assertEquals(
    statements.filter((text) => /insert into bakery\.blob_probes/.test(text)),
    [],
    "a host's failure must never become the file's record",
  );
});

Deno.test("the answer is cached per process, and only the asking is cached", async () => {
  fresh();
  // A stub that counts: the self-test branch appends to a file each time it is
  // asked, so the count is the number of times the host was interrogated.
  const counter = `${dir}/ask-count`;
  await Deno.writeTextFile(counter, "");
  const launcher = await writeStub(dir, "counted", {
    selfTest: SEALED,
    probe: `printf '%s' '${PNG_FRAME}'`,
  });
  // Wrap the stub in a counter without changing what it answers.
  const counting = `${dir}/counting`;
  await Deno.writeTextFile(
    counting,
    `#!/bin/sh
request=$(cat) || request=
case "$request" in
  *filesystem*) echo filesystem >> '${counter}' ;;
  *selfTest*) echo network >> '${counter}' ;;
esac
printf '%s' "$request" | '${launcher}'
`,
  );
  await Deno.chmod(counting, 0o755);

  for (let index = 0; index < 3; index += 1) {
    assertEquals(
      (await probeArtifactBytes(input, { launcherPath: counting })).status,
      "described",
    );
  }
  const asks = (await Deno.readTextFile(counter)).trim().split("\n").filter(
    (line) => line !== "",
  );
  // One ask per seal, for three probes: the network and the filesystem are
  // separate properties of the machine, so each is cached separately, and
  // neither is re-asked after the first answer.
  assertEquals(
    asks.sort(),
    ["filesystem", "network"],
    `the host was asked ${asks.length} times: ${asks.join(",")}`,
  );
});
