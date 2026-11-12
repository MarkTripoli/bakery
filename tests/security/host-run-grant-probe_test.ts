// #225 AC1: a process started with exactly the run grant of
// apps/server/scripts/run-main.sh cannot execute a shell or any general exec
// wrapper, and the launchers it may run refuse to be repurposed, while the
// server's real git and draft work still runs through them.
import { assert, assertEquals } from "@std/assert";
import {
  createDraftIsolation,
  DraftIsolationError,
} from "../../apps/server/src/modules/knowledge/draft-isolation.ts";
import { DRAFT_LIMITS } from "../../apps/server/src/modules/knowledge/drafts.ts";
import {
  SERVER_DRAFT_SYSTEMD_LAUNCHER,
} from "../../apps/server/src/platform/server-exec.ts";

const root = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");

/** The --allow-run value run-main.sh builds, with its repo_root resolved. */
async function runMainGrant(): Promise<string> {
  const script = await Deno.readTextFile(
    `${root}/apps/server/scripts/run-main.sh`,
  );
  const value = /^run_grant="([^"]+)"$/m.exec(script)?.[1];
  assert(value, "run-main.sh defines run_grant");
  assert(/"--allow-run=\$run_grant"/.test(script), "run-main.sh uses it");
  return value.replaceAll("$repo_root", root);
}

const PROBE = `
const attempt = async (command, args) => {
  try {
    const out = await new Deno.Command(command, {
      args, clearEnv: true, stdout: "piped", stderr: "null",
    }).output();
    return "exit:" + out.code;
  } catch (error) {
    return error instanceof Deno.errors.NotCapable ? "denied" : "error:" + error.name;
  }
};
const [git, systemd, dir] = Deno.args;
console.log(JSON.stringify({
  sh: await attempt("/bin/sh", ["-c", "exit 7"]),
  bash: await attempt("/usr/bin/bash", ["-c", "exit 7"]),
  git: await attempt("/usr/bin/git", ["-c", "alias.x=!true", "x"]),
  deno: await attempt(Deno.execPath(), ["eval", "Deno.exit(7)"]),
  prlimit: await attempt("/usr/bin/prlimit", ["--", "/bin/true"]),
  systemdRun: await attempt("/usr/bin/systemd-run", ["--user", "/bin/true"]),
  systemctl: await attempt("/usr/bin/systemctl", ["--user", "--version"]),
  env: await attempt("/usr/bin/env", ["true"]),
  gitAlias: await attempt(git, ["-c", "alias.x=!true", "x"]),
  gitUploadPack: await attempt(git, ["fetch", dir, "https://example.test/r.git", "--upload-pack=sh"]),
  gitExt: await attempt(git, ["fetch", dir, "ext::sh -c true", "main"]),
  gitBare: await attempt(git, ["is-bare", dir]),
  systemdLink: await attempt(systemd, ["link", "/tmp/x.service"]),
  systemdRunAnything: await attempt(systemd, ["run", "not-a-uuid", "1"]),
}));
`;

Deno.test("the host server's run grant cannot execute a shell or repurpose a launcher", async () => {
  const grant = await runMainGrant();
  const scratch = await Deno.makeTempDir({ prefix: "bakery-run-grant-" });
  try {
    const repo = `${scratch}/r.git`;
    const init = await new Deno.Command("/usr/bin/git", {
      args: ["init", "-q", "--bare", repo],
    }).output();
    assertEquals(init.code, 0);
    const probe = `${scratch}/probe.mjs`;
    await Deno.writeTextFile(probe, PROBE);
    const [git, systemd] = grant.split(",");
    const output = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--no-prompt",
        "--no-config",
        `--allow-read=${scratch}`,
        `--allow-run=${grant}`,
        probe,
        git!,
        systemd!,
        repo,
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    const text = new TextDecoder().decode(output.stdout);
    assertEquals(output.code, 0, new TextDecoder().decode(output.stderr));
    assertEquals(JSON.parse(text.trim().split("\n").at(-1)!), {
      sh: "denied",
      bash: "denied",
      git: "denied",
      deno: "denied",
      prlimit: "denied",
      systemdRun: "denied",
      systemctl: "denied",
      env: "denied",
      gitAlias: "exit:64",
      gitUploadPack: "exit:64",
      gitExt: "exit:64",
      gitBare: "exit:0",
      systemdLink: "exit:64",
      systemdRunAnything: "exit:64",
    });
  } finally {
    await Deno.remove(scratch, { recursive: true });
  }
});

Deno.test("a draft runs through the systemd launcher, and a host without systemd reports isolation unavailable", async () => {
  const candidate = await createDraftIsolation({ launcher: "systemd" })
    .initialize("through the launcher");
  assertEquals(candidate.text, "through the launcher");

  const directory = await Deno.makeTempDir({ prefix: "bakery-no-systemd-" });
  try {
    const copy = `${directory}/draft-systemd.sh`;
    const script = (await Deno.readTextFile(SERVER_DRAFT_SYSTEMD_LAUNCHER))
      .replaceAll("/usr/bin/systemd-run", "/nonexistent/systemd-run");
    await Deno.writeTextFile(copy, script);
    await Deno.chmod(copy, 0o700);
    const isolation = createDraftIsolation({
      launcher: "systemd",
      systemdLauncherPath: copy,
    });
    let error: unknown;
    try {
      await isolation.initialize("x");
    } catch (caught) {
      error = caught;
    }
    assert(error instanceof DraftIsolationError, String(error));
    assertEquals(error.kind, "unavailable");
    assertEquals(error.message, "HOST_ISOLATION_UNAVAILABLE");
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("on a host without systemd, bad input is still 64 and only valid calls are 69", async () => {
  const directory = await Deno.makeTempDir({ prefix: "bakery-no-systemd-" });
  try {
    const copy = `${directory}/draft-systemd.sh`;
    await Deno.writeTextFile(
      copy,
      (await Deno.readTextFile(SERVER_DRAFT_SYSTEMD_LAUNCHER)).replaceAll(
        "/usr/bin/systemd-run",
        "/nonexistent/systemd-run",
      ),
    );
    await Deno.chmod(copy, 0o700);
    const code = async (args: string[]) =>
      (await new Deno.Command(copy, {
        args,
        clearEnv: true,
        stdout: "null",
        stderr: "null",
      }).output()).code;
    assertEquals(await code(["link", "/tmp/x.service"]), 64);
    assertEquals(await code(["run", "not-a-uuid", "1"]), 64);
    assertEquals(await code(["stop", crypto.randomUUID()]), 69);
    assertEquals(await code(["run", crypto.randomUUID(), "1"]), 69);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("dispatch.sh takes no arguments and the systemd launcher only runs under Deno", async () => {
  const dispatch = SERVER_DRAFT_SYSTEMD_LAUNCHER.replace(
    "draft-systemd.sh",
    "dispatch.sh",
  );
  for (const args of [["x"], ["eval", "Deno.exit(7)"], ["--allow-all"]]) {
    const { code } = await new Deno.Command(dispatch, {
      args,
      clearEnv: true,
      stdout: "null",
      stderr: "null",
    }).output();
    assertEquals(code, 64, JSON.stringify(args));
  }
  // Started from a shell (not the server's Deno), `run` must refuse rather
  // than exec whatever its parent is. `; exit $?` keeps the shell resident,
  // so the shell, not Deno, is the launcher's parent.
  const { code } = await new Deno.Command("/bin/sh", {
    args: [
      "-c",
      `'${SERVER_DRAFT_SYSTEMD_LAUNCHER}' run ${crypto.randomUUID()} 1; exit $?`,
    ],
    clearEnv: true,
    stdout: "null",
    stderr: "null",
  }).output();
  assertEquals(code, 70);
});

Deno.test("the server hands the launcher the per-isolation backstop as its run operand", async () => {
  // The slow-start tests use the raw systemd-run path (they inject a worker);
  // production goes through the launcher, whose own 1-30 check cannot tell 7
  // from 1. A recording stub shows exactly what the server passes.
  const directory = await Deno.makeTempDir({ prefix: "bakery-operand-" });
  try {
    const log = `${directory}/calls`;
    const stub = `${directory}/draft-systemd.sh`;
    await Deno.writeTextFile(
      stub,
      `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexit 69\n`,
    );
    await Deno.chmod(stub, 0o700);
    await createDraftIsolation({
      launcher: "systemd",
      systemdLauncherPath: stub,
    })
      .initialize("x").catch(() => undefined);
    const runs = (await Deno.readTextFile(log)).split("\n").filter((line) =>
      line.startsWith("run ")
    );
    assertEquals(runs.length, 1, runs.join("|"));
    const match =
      /^run [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12} (\d+)$/
        .exec(runs[0]);
    assert(match !== null, `launcher got: ${runs[0]}`);
    const expected = Math.ceil(
      (DRAFT_LIMITS.workerStartupMs + DRAFT_LIMITS.workerRuntimeMs) / 1_000,
    ) + 1;
    assertEquals(Number(match[1]), expected);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
