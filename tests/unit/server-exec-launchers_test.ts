import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  SYSTEMD_UNIT_PROPERTIES,
} from "../../apps/server/src/modules/knowledge/draft-isolation.ts";
import {
  SERVER_DRAFT_SYSTEMD_LAUNCHER,
  SERVER_GIT_LAUNCHER,
  systemdLauncherArgs,
  UnsupportedSystemdInvocationError,
} from "../../apps/server/src/platform/server-exec.ts";

const uuid = "0f1e2d3c-4b5a-4968-8776-655443322110";
const unit = `bakery-draft-${uuid}.service`;

function commandsOf(script: string): string {
  return script.split("\n").filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
}

Deno.test("the systemd draft launcher pins the server's unit properties", async () => {
  const script = await Deno.readTextFile(SERVER_DRAFT_SYSTEMD_LAUNCHER);
  const commands = commandsOf(script);
  const fixed = SYSTEMD_UNIT_PROPERTIES.filter((property) =>
    !property.startsWith("--property=RuntimeMaxSec=")
  );
  for (const property of fixed) {
    assert(commands.includes(` ${property} \\`), property);
  }
  assert(commands.includes('"--property=RuntimeMaxSec=${runtime_seconds}s"'));
  // Only the `run` operation sets unit properties.
  const run = commands.slice(
    commands.indexOf("  run)"),
    commands.indexOf("\n    ;;", commands.indexOf("  run)")),
  );
  // The fixed list plus RuntimeMaxSec, which the server passes per call.
  assertEquals(
    run.match(/--property=/g)?.length,
    SYSTEMD_UNIT_PROPERTIES.length + 1,
    "the launcher sets a property the server does not",
  );
  assertEquals(
    SYSTEMD_UNIT_PROPERTIES.some((property) =>
      property.startsWith("--property=RuntimeMaxSec=")
    ),
    false,
  );
  // The worker gets the same flags as the server's own systemd arguments.
  assert(
    commands.includes(
      '"$deno" run --cached-only --no-prompt --deny-import --frozen "$worker"',
    ),
  );
  // Caller argv never reaches a tool: "$@" appears only in user_exec, whose
  // arguments are this script's own fixed command lines.
  assert(!/--allow-|eval|\$\*/.test(commands), "a permission or eval");
  assertEquals(
    commands.split("\n").filter((line) => line.includes('"$@"')),
    ['    DBUS_SESSION_BUS_ADDRESS="$bus" LC_ALL=C "$@"'],
  );
  for (const path of [SERVER_DRAFT_SYSTEMD_LAUNCHER, SERVER_GIT_LAUNCHER]) {
    assert(((await Deno.stat(path)).mode! & 0o111) !== 0, path);
  }
});

Deno.test("the git launcher bounds every local read with a 256 MiB address-space limit", async () => {
  // This limit is what stops a hostile repository from making git allocate
  // without bound; it moved here from repository-inspect.ts.
  const commands = commandsOf(await Deno.readTextFile(SERVER_GIT_LAUNCHER));
  const local = commands.slice(
    commands.indexOf("local_git() {"),
    commands.indexOf("\n}", commands.indexOf("local_git() {")),
  );
  assert(
    local.includes("/usr/bin/prlimit --as=268435456:268435456 -- \\"),
    "local_git lost its address-space limit",
  );
  assert(
    local.indexOf("/usr/bin/prlimit") < local.indexOf("/usr/bin/git "),
    "the limit must wrap git",
  );
  // Every local operation goes through local_git; only fetch runs git
  // directly (network reads are bounded by depth=1 and blob:none).
  assertEquals(
    commands.split("\n").filter((line) => /^\s+\/usr\/bin\/git /.test(line))
      .length,
    2,
  );
});

Deno.test("every systemctl and journalctl call maps onto a launcher operation", () => {
  const cases: [string[], string[]][] = [
    [["--user", "show", "--property=Version", "--value"], ["manager-version"]],
    [["--user", "kill", "--kill-who=all", "--signal=KILL", unit], [
      "kill",
      uuid,
    ]],
    [["--user", "stop", unit], ["stop", uuid]],
    [["--user", "reset-failed", unit], ["reset-failed", uuid]],
    [[
      "--user",
      "show",
      unit,
      "--property=LoadState",
      "--property=ActiveState",
      "--property=ControlGroup",
      "--property=MainPID",
    ], ["show-boundary", uuid]],
    [["--user", "show", unit, "--property=PrivateUsers", "--value"], [
      "show-private-users",
      uuid,
    ]],
    [[
      "--user",
      "status",
      unit,
      "--no-pager",
      "--lines=8",
      "--output=short",
      "--full",
    ], ["status", uuid]],
    [[
      "--user",
      "--unit",
      unit,
      "--no-pager",
      "--lines",
      "20",
      "--output=cat",
    ], ["journal", uuid]],
  ];
  for (const [args, expected] of cases) {
    assertEquals(systemdLauncherArgs(args), expected, args.join(" "));
  }
  for (
    const args of [
      ["--user", "stop", "other.service"],
      ["--user", "stop", `bakery-draft-${uuid.toUpperCase()}.service`],
      ["--user", "link", "/tmp/evil.service"],
      ["--user", "start", unit],
      ["--user", "edit", unit],
      ["--user", "kill", "--signal=KILL", unit],
      ["--user", "show", unit],
    ]
  ) {
    assertThrows(
      () => systemdLauncherArgs(args),
      UnsupportedSystemdInvocationError,
      undefined,
      args.join(" "),
    );
  }
});

Deno.test("the systemd draft launcher refuses everything it does not define", async () => {
  for (
    const args of [
      [],
      ["link", "/tmp/x.service"],
      ["run"],
      ["run", uuid],
      ["run", uuid, "0"],
      ["run", uuid, "31"],
      ["run", uuid, "1", "extra"],
      ["run", "not-a-uuid", "1"],
      ["stop", uuid.toUpperCase()],
      ["stop", uuid, "extra"],
      ["journal", "../x"],
      ["manager-version", "extra"],
      ["exec", "/bin/sh"],
    ]
  ) {
    const { code } = await new Deno.Command(SERVER_DRAFT_SYSTEMD_LAUNCHER, {
      args,
      clearEnv: true,
      stdout: "null",
      stderr: "null",
    }).output();
    assertEquals(code, 64, JSON.stringify(args));
  }
});
