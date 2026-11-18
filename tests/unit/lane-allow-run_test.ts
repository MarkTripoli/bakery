import { assert, assertEquals } from "@std/assert";
import {
  allowRunFlags,
  allowRunFor,
  REFUSED_BASENAMES,
} from "../../scripts/ci/lane-allow-run.ts";

// #259: Deno checks a run grant against the spawned path only, so a lane that
// is granted a shell can run anything on the rig host, which shares the owner's
// account. These pin each lane's exact grant, so any addition is a reviewed
// change here, and refuse the programs that run arbitrary commands.

const EXEC = "/opt/deno/bin/deno";
const launcher = (name: string) => `/repo/infra/server-exec/${name}`;
const context = { execPath: EXEC, serverLauncher: launcher };
// Written out, not read from the module: dropping or adding a bare-grant lane
// there must fail here.
const BARE_LANES = [
  "rails",
  "integration",
  "recovery",
  "security",
  "e2e",
  "connected",
  "native",
];
const LANES = [
  "rails",
  "unit",
  "provider",
  "contract",
  "integration",
  "recovery",
  "security",
  "e2e",
  "connected",
  "native",
  "r2",
];

const grant = (lane: string, providerRealCli = false) =>
  allowRunFor(lane, { ...context, providerRealCli });

Deno.test("each lane's --allow-run is pinned exactly", () => {
  assertEquals(grant("unit"), {
    kind: "list",
    entries: [
      "zip",
      "unzip",
      "node",
      "git",
      "/usr/bin/git",
      "/usr/bin/stat",
      "/usr/bin/prlimit",
      "/usr/bin/setsid",
      "/usr/bin/kill",
      "/repo/infra/server-exec/git.sh",
      "/repo/infra/server-exec/draft-systemd.sh",
      EXEC,
    ],
  });
  assertEquals(grant("provider"), {
    kind: "list",
    entries: ["git", "/usr/bin/git", "/usr/bin/setsid", "/usr/bin/kill"],
  });
  assertEquals(grant("contract"), { kind: "list", entries: [EXEC] });
  assertEquals(grant("r2"), { kind: "none" });
  for (const lane of BARE_LANES) {
    assertEquals(grant(lane), { kind: "any" }, lane);
  }
  // The owner's opt-in for a real harness CLI widens the provider lane, and
  // nothing else.
  assertEquals(grant("provider", true), { kind: "any" });
  assertEquals(grant("unit", true), grant("unit"));
  assertEquals(grant("contract", true), grant("contract"));
});

Deno.test("every known lane has a decision, and the bare-grant lanes are the ones that run a real stack", () => {
  for (const lane of LANES) assert(grant(lane) !== undefined, lane);
  assertEquals(
    LANES.filter((lane) => grant(lane).kind === "any").sort(),
    [...BARE_LANES].sort(),
  );
});

Deno.test("no lane's list names a shell, env, deno or systemd-run", () => {
  for (const lane of LANES) {
    const result = grant(lane);
    if (result.kind !== "list") continue;
    for (const entry of result.entries) {
      // The lane's own Deno binary is pinned by the test above, not by name.
      if (entry === EXEC) continue;
      const base = entry.split("/").at(-1) ?? entry;
      assert(
        !(REFUSED_BASENAMES as readonly string[]).includes(base),
        `${lane} grants ${entry}, which runs an arbitrary command`,
      );
    }
  }
});

Deno.test("the refused names include the programs the issue lists", () => {
  for (const name of ["sh", "bash", "env", "deno", "systemd-run"]) {
    assert((REFUSED_BASENAMES as readonly string[]).includes(name), name);
  }
});

Deno.test("the flag is a bare grant, a pinned list, or none", () => {
  const flags = (lane: string) =>
    allowRunFlags(lane, { ...context, providerRealCli: false });
  assertEquals(flags("rails"), ["--allow-run"]);
  assertEquals(flags("r2"), []);
  assertEquals(flags("contract"), [`--allow-run=${EXEC}`]);
  assertEquals(
    flags("provider"),
    ["--allow-run=git,/usr/bin/git,/usr/bin/setsid,/usr/bin/kill"],
  );
});
