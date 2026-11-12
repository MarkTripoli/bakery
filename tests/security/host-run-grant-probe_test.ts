// #225 AC1: a process started with exactly the run grant of
// apps/server/scripts/run-main.sh cannot execute a shell or any general exec
// wrapper, and the launchers it may run refuse to be repurposed, while the
// server's real git and draft work still runs through them.
import { assert, assertEquals } from "@std/assert";
import {
  createDraftIsolation,
  DraftIsolationError,
} from "../../apps/server/src/modules/knowledge/draft-isolation.ts";
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
