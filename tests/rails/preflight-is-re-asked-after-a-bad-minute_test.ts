/**
 * A "not sealed" preflight answer is not a life sentence (#437 slice 2 review).
 *
 * The reviewer's finding: a false answer was cached for the process lifetime, so
 * one transient failure -- a bus restarting, a unit losing a race -- disabled
 * probing until the server restarted. A sealed answer is a property of the
 * machine and is kept; an unsealed one is re-asked after a bounded window, and
 * every probe inside that window is still refused.
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
  writeStub,
} from "../helpers/probe-stub-launcher.ts";

const dir = Deno.makeTempDirSync({ prefix: "bakery-preflight-retry-" });
const input = { path: `${dir}/blob.bin`, sizeBytes: 16 };

Deno.test("an unsealed answer is re-asked after the window, and sealed is kept", async () => {
  forgetSandboxPreflight();
  // A launcher that answers "unsealed" the first time and "sealed" afterwards,
  // counting how often it was asked.
  const counter = `${dir}/asks`;
  await Deno.writeTextFile(counter, "");
  const launcher = await writeStub(dir, "flaky", {
    selfTest: SEALED,
    filesystem: READ_ONLY,
    probe: `printf '%s' '${PNG_FRAME}'`,
  });
  const flaky = `${dir}/flaky-wrapper`;
  await Deno.writeTextFile(
    flaky,
    `#!/bin/sh
request=$(cat) || request=
case "$request" in
  *selfTest*)
    echo x >> '${counter}'
    if [ "$(wc -l < '${counter}')" -le 1 ]; then
      printf '%s' '${UNSEALED}'
      exit 0
    fi
    ;;
esac
printf '%s' "$request" | '${launcher}'
`,
  );
  await Deno.chmod(flaky, 0o755);

  // First probe: the network answer is "unsealed", so nothing is described.
  assertEquals(
    await probeArtifactBytes(input, {
      launcherPath: flaky,
      preflightRetryMs: 0,
    }),
    { status: "refused", code: "sandbox-unavailable" },
  );
  // Second probe, window elapsed: the host is asked again, answers sealed, and
  // the file is described. Without the retry this stays refused for ever.
  assertEquals(
    (await probeArtifactBytes(input, {
      launcherPath: flaky,
      preflightRetryMs: 0,
    })).status,
    "described",
  );
  // A sealed answer is not re-asked: the count stops growing.
  const before = (await Deno.readTextFile(counter)).trim().split("\n").length;
  await probeArtifactBytes(input, { launcherPath: flaky, preflightRetryMs: 0 });
  const after = (await Deno.readTextFile(counter)).trim().split("\n").length;
  assertEquals(after, before, "a sealed answer was asked again");
});

Deno.test("inside the window the answer stays fail-closed and is not re-asked", async () => {
  forgetSandboxPreflight();
  const counter = `${dir}/asks-window`;
  await Deno.writeTextFile(counter, "");
  const launcher = await writeStub(dir, "unsealed", {
    selfTest: UNSEALED,
    filesystem: READ_ONLY,
    probe: `printf '%s' '${PNG_FRAME}'`,
  });
  const counting = `${dir}/counting-window`;
  await Deno.writeTextFile(
    counting,
    `#!/bin/sh
request=$(cat) || request=
case "$request" in
  *selfTest*) echo x >> '${counter}' ;;
esac
printf '%s' "$request" | '${launcher}'
`,
  );
  await Deno.chmod(counting, 0o755);
  for (let index = 0; index < 3; index += 1) {
    assertEquals(
      await probeArtifactBytes(input, {
        launcherPath: counting,
        preflightRetryMs: 60_000,
      }),
      { status: "refused", code: "sandbox-unavailable" },
    );
  }
  const asks = (await Deno.readTextFile(counter)).trim().split("\n").length;
  assertEquals(asks, 1, `the host was asked ${asks} times inside the window`);
});
