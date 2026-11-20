/**
 * The filesystem preflight (#437 slice 2, PM's decision 03:51Z).
 *
 * A user manager that cannot set up read-only mounts accepts
 * `ProtectSystem=strict` and `ReadOnlyPaths=` and runs the unit with a writable
 * filesystem, saying so only in the journal. Measured on the host this was
 * written on: a unit with `ProtectSystem=strict` alone, `ReadOnlyPaths=` alone,
 * and both together all created a file under `/run/user/<uid>`.
 *
 * So the server asks the one question with an answer, before it names a file: can
 * a canary be created? These tests pin the fail-closed reading of every answer.
 */
import { assertEquals } from "@std/assert";
import {
  forgetSandboxPreflight,
  probeArtifactBytes,
} from "../../apps/server/src/modules/knowledge/probe.ts";
import {
  PNG_FRAME,
  READ_ONLY,
  SEALED,
  UNSEALED,
  WRITABLE,
  writeStub,
} from "../helpers/probe-stub-launcher.ts";

const dir = Deno.makeTempDirSync({ prefix: "bakery-fs-preflight-" });
const input = { path: `${dir}/blob.bin`, sizeBytes: 16 };

function fresh(): void {
  forgetSandboxPreflight();
}

Deno.test("a writable sandbox refuses before a file is named", async () => {
  fresh();
  let probed = false;
  const launcher = await writeStub(dir, "writable", {
    selfTest: SEALED,
    filesystem: WRITABLE,
    probe: `printf 'probed' >> '${dir}/probe-ran'; printf '%s' '${PNG_FRAME}'`,
  });
  const result = await probeArtifactBytes(input, { launcherPath: launcher });
  probed = await Deno.readTextFile(`${dir}/probe-ran`).then(() => true).catch(
    () => false,
  );
  assertEquals(result.status, "refused");
  assertEquals(
    result.status === "refused" && result.code,
    "sandbox-unavailable",
  );
  assertEquals(probed, false, "the probe branch must never have run");
});

Deno.test("a read-only sandbox describes the bytes", async () => {
  fresh();
  const launcher = await writeStub(dir, "readonly", {
    selfTest: SEALED,
    filesystem: READ_ONLY,
    probe: `printf '%s' '${PNG_FRAME}'`,
  });
  const result = await probeArtifactBytes(input, { launcherPath: launcher });
  assertEquals(result.status, "described");
});

Deno.test("an unanswerable filesystem question refuses, six ways", async () => {
  // Every uncertain answer is a "no". The cost of being wrong is a missing
  // preview; the cost of the other mistake is a parser that can write to the
  // repository while it reads a stranger's file.
  for (
    const filesystem of [
      "exit:69", // no systemd on the host
      "exit:218", // namespaces could not be set up
      "exit:226",
      "", // an empty frame
      '{"selfTest":"network","reachable":false}', // the wrong question answered
      '{"selfTest":"filesystem","writable":"no"}', // not even a boolean
    ]
  ) {
    fresh();
    const launcher = await writeStub(dir, "unsealed", {
      filesystem,
      probe: `printf '%s' '${PNG_FRAME}'`,
    });
    const result = await probeArtifactBytes(input, { launcherPath: launcher });
    assertEquals(
      result.status === "refused" && result.code,
      "sandbox-unavailable",
      `filesystem answer: ${filesystem}`,
    );
  }
});

Deno.test("the network refusal is still checked first, and named the same", async () => {
  // Two seals, one answer: the caller must not be able to tell which one refused,
  // because the remedy is the same and naming it would describe the host.
  fresh();
  const launcher = await writeStub(dir, "open-network", {
    selfTest: UNSEALED,
    filesystem: READ_ONLY,
    probe: `printf '%s' '${PNG_FRAME}'`,
  });
  const result = await probeArtifactBytes(input, { launcherPath: launcher });
  assertEquals(
    result.status === "refused" && result.code,
    "sandbox-unavailable",
  );
});
