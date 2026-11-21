/**
 * The probe's sandbox is the launcher's, and the launcher's is the server's
 * (#437 slice 2).
 *
 * Two lists describe one thing: `ARTIFACT_PROBE_UNIT_PROPERTIES` is what the
 * server says it asks for, and `infra/server-exec/artifact-probe.sh` is what
 * actually runs. A property added to one and not the other is a limit the
 * server believes it has, so this test compares them literally rather than
 * sampling the ones it remembers.
 *
 * The launcher also has to be unusable as anything but a probe: it takes one
 * UUID and nothing else, and it never runs an interpreter a caller names.
 */
import { assert, assertEquals } from "@std/assert";
import { ARTIFACT_PROBE_UNIT_PROPERTIES } from "../../apps/server/src/modules/knowledge/probe.ts";

const LAUNCHER =
  new URL("../../infra/server-exec/artifact-probe.sh", import.meta.url)
    .pathname;

function commandsOf(script: string): string {
  // The working directory is the one property whose value is a path the
  // launcher must compute rather than a constant: it is the repository root,
  // derived from the launcher's own location so a caller cannot point it
  // elsewhere. The server's list names that with a placeholder, so the two
  // lists are compared with the shell variable folded into it -- the check
  // stays exact about everything else, and still catches a launcher that
  // hard-coded a different directory.
  return script.split("\n").filter((line) => !line.trimStart().startsWith("#"))
    .join("\n").replaceAll("$repo_root", "@REPO_ROOT@")
    .replaceAll("$spool_dir", "@SPOOL_DIR@");
}

/** Every `--property=` value the launcher would pass, in the order written. */
function propertiesOf(script: string): string[] {
  const commands = commandsOf(script).replaceAll('"', "");
  return (commands.match(/--property=[^\s\\]+/g) ?? []).map((value) =>
    value.startsWith("--property=") ? value.slice("--property=".length) : value
  );
}

Deno.test("the probe launcher pins exactly the unit properties the server declares", async () => {
  const script = await Deno.readTextFile(LAUNCHER);
  // Quotes around a value are not a difference in what systemd is told, and
  // the working directory is quoted because a checkout may contain a space.
  // Compared as a set of values, not as formatted lines: the launcher
  // accumulates its arguments so the spool grant can be conditional, and a test
  // that matched trailing backslashes would be testing the layout.
  const declared = propertiesOf(script);
  for (const property of ARTIFACT_PROBE_UNIT_PROPERTIES) {
    assert(
      declared.some((value) => `--property=${value}` === property),
      `launcher is missing ${property}`,
    );
  }
  assertEquals(
    declared.length,
    ARTIFACT_PROBE_UNIT_PROPERTIES.length,
    "the launcher sets a property the server does not declare",
  );
});

Deno.test("the unit starts where the worker's imports resolve, from a path it computes", async () => {
  const script = await Deno.readTextFile(LAUNCHER);
  // A unit that starts in $HOME cannot resolve a bare specifier or find the
  // lockfile, so the worker dies with 226 before reading a byte. The root must
  // come from the launcher's own location, never from the caller's
  // environment: a sandbox whose working directory a caller chooses is a
  // sandbox a caller can point at a directory it has written to.
  assert(
    /repo_root=\$\(cd "\$here\/\.\.\/\.\." && pwd -P\)/.test(script),
    "the repository root is derived from the launcher's own path",
  );
  assert(
    script.includes('"--property=WorkingDirectory=$repo_root"'),
    "the unit is pinned to it",
  );
  assert(!/WorkingDirectory=\$[^r]/.test(script), "no caller-supplied path");
});

Deno.test("the probe sandbox has no network and no writable system", async () => {
  const script = await Deno.readTextFile(LAUNCHER);
  for (
    const required of [
      "--property=PrivateNetwork=yes",
      "--property=MemoryMax=",
      "--property=RuntimeMaxSec=",
      "--property=NoNewPrivileges=yes",
      "--property=ProtectSystem=strict",
    ]
  ) {
    assert(script.includes(required), required);
  }
  // The limits the launcher declares must be the ones the server's contract
  // states, not numbers chosen twice.
  const { ARTIFACT_PROBE_MEMORY_MAX_BYTES, ARTIFACT_PROBE_TIMEOUT_MS } =
    await import("@bakery/contracts/artifact-probe");
  assert(
    script.includes(`--property=MemoryMax=${ARTIFACT_PROBE_MEMORY_MAX_BYTES}`),
  );
  assert(
    script.includes(
      `--property=RuntimeMaxSec=${ARTIFACT_PROBE_TIMEOUT_MS / 1000}s`,
    ),
  );
});

Deno.test("the probe launcher refuses anything but one UUID", async () => {
  const script = await Deno.readTextFile(LAUNCHER);
  const commands = commandsOf(script);
  // One argument, validated as a lower-case UUID, and an optional second that
  // may only be a spool directory. Anything else is refused before any tool runs.
  assert(
    commands.includes('[ "$#" -eq 1 ] || [ "$#" -eq 2 ] || exit 64'),
    "one UUID, plus at most a spool",
  );
  // The caller's second argument is parsed, never forwarded. The one place the
  // argument list is expanded is the fixed `systemd-run` invocation, and that
  // list is the launcher's own: every `set --` there names a property it chose.
  const expanded = commands.split("\n").filter((line) => line.includes('"$@"'));
  // Two lines mention it: the conditional append that adds the spool grant, and
  // the fixed invocation. Nothing expands the caller's argv.
  assertEquals(
    expanded.filter((line) => line.includes("systemd-run")).length,
    1,
    "the list reaches systemd-run once",
  );
  for (const line of expanded) {
    assert(
      line.includes("systemd-run") || line.trimStart().startsWith("set --"),
      `a line forwards the caller's argv: ${line.trim()}`,
    );
  }
  // `--collect` retires a unit when it exits, and nothing else does. Without it
  // a probe killed for its wall clock or its memory leaves a failed unit behind
  // for ever -- one per hostile upload -- until someone runs `reset-failed`. It
  // is one word in the invocation and its absence passes every other test here,
  // because the harness resets its own units, so it is pinned explicitly.
  assert(
    commands.includes('systemd-run --collect "$@"'),
    "the units are collected when they exit",
  );
  // The worker is pinned by path; no caller chooses what runs.
  assert(commands.includes('"$deno" run --cached-only --no-prompt'));
  assert(commands.includes('"$worker"'));
  // Exactly one permission, chosen by the question in the frame, and never a
  // blanket one. Two shipped defects came from the other two answers: no
  // `--allow-read` made the probe answer "unreadable" for a healthy file, and no
  // `--allow-net`/`--allow-write` made both preflights answer "sealed" on every
  // host. A permission the worker lacks is not a sandbox, and a permission it
  // has for everything is not one either.
  assert(
    !/--allow-all|\s-A\s|eval|\$\*/.test(commands),
    "no blanket permission",
  );
  assertEquals(
    commands.split("\n").filter((line) => line.includes("--allow-")).length,
    3,
    "one permission per question: read a path, net to the self-test, write the canary",
  );
  assert(commands.includes('"--allow-net=$self_test_host:$self_test_port"'));
  assert(commands.includes('"--allow-write=$2/$self_test_canary"'));
  assert(commands.includes('"--allow-read=$path"'));
  // The frame is read by the launcher, because the permission depends on it, and
  // handed to the unit unchanged.
  assert(commands.includes("frame=$(cat)"));
  assert(commands.includes("printf '%s' \"$frame\" |"));
});

Deno.test("the launcher refuses a spool it cannot honestly grant", async () => {
  // The guard runs before the parent check, so a shell can ask it and get an
  // answer: this is the argument parsing, not the sandbox. `InaccessiblePaths`
  // wins over `ReadOnlyPaths`, so a grant under /tmp, /var/tmp or $HOME is a
  // property systemd would accept and still leave unreadable -- exactly the
  // "unreadable" answer a healthy file must never get.
  const uid = "0f1e2d3c-4b5a-4968-8776-655443322110";
  const run = async (arg: string) => {
    const result = await new Deno.Command("/bin/sh", {
      args: [LAUNCHER, uid, arg],
      stdout: "null",
      stderr: "null",
    }).output();
    return result.code;
  };
  assertEquals(await run("--spool-dir=/tmp/spool"), 64, "under /tmp");
  assertEquals(await run("--spool-dir=/var/tmp/spool"), 64, "under /var/tmp");
  assertEquals(await run(`--spool-dir=${Deno.env.get("HOME")}/spool`), 64);
  assertEquals(await run(`--spool-dir=${Deno.cwd()}/absent`), 64, "absent");
  // A relative path is not a directory this launcher can name at all.
  assertEquals(await run("--spool-dir=relative/spool"), 64);
  // And an argument that is not the spool option is still refused.
  assertEquals(await run("--allow-all"), 64);
});

Deno.test("the launcher names the spool directory in the unit", async () => {
  const script = await Deno.readTextFile(LAUNCHER);
  assert(
    script.includes('set -- "$@" "--property=ReadOnlyPaths=$spool_dir"'),
    "the grant names the directory the server configured",
  );
  // Conditional: a deployment that hands over a path in place has no spool, and
  // an unconditional grant of a directory that does not exist is a unit
  // systemd refuses to start.
  assert(
    /if \[ -n "\$spool_dir" \]; then[\s\S]{0,200}ReadOnlyPaths/.test(script),
    "the grant is only made when there is a spool",
  );
});

Deno.test("a host without a user bus reports the sandbox as unavailable", async () => {
  // 69 is EX_UNAVAILABLE: the host cannot start the unit, so nothing ran and
  // nothing was measured. The server turns this into `sandbox-unavailable` and
  // does not fall back to parsing in-process, which is the whole point of the
  // launcher.
  const bus = Deno.build.os === "linux" &&
    await Deno.stat(`/run/user/${Deno.uid()}/bus`).then(() => true).catch(
      () => false,
    );
  if (bus) return; // a host that has one exercises the sandbox itself
  const result = await new Deno.Command(LAUNCHER, {
    args: ["0f1e2d3c-4b5a-4968-8776-655443322110"],
    stdout: "null",
    stderr: "null",
  }).output();
  assertEquals(result.code, 69);
});
