import { assert, assertEquals, assertStringIncludes } from "@std/assert";

const root = Deno.cwd();
const serverRoot = `${root}/apps/server`;
const launcher = "scripts/run-main.sh";
const decoder = new TextDecoder();

async function writeCaptureDeno(directory: string): Promise<{
  argsPath: string;
  rootPath: string;
  unrelatedPath: string;
}> {
  const argsPath = `${directory}/args`;
  const rootPath = `${directory}/root`;
  const unrelatedPath = `${directory}/unrelated`;
  const executable = `${directory}/deno`;
  await Deno.writeTextFile(
    executable,
    `#!/usr/bin/env bash\nset -euo pipefail\nprintf '%s\\0' "$@" > '${argsPath}'\nprintf '%s' "\${BAKERY_SKILL_FILE_ROOT-}" > '${rootPath}'\nif [[ -v BAKERY_LAUNCHER_UNRELATED_SECRET ]]; then printf present > '${unrelatedPath}'; else printf absent > '${unrelatedPath}'; fi\n`,
    { mode: 0o700 },
  );
  return { argsPath, rootPath, unrelatedPath };
}

async function launch(
  path: string,
  environment: Record<string, string>,
): Promise<Deno.CommandOutput> {
  return await new Deno.Command("/usr/bin/bash", {
    args: [launcher],
    cwd: serverRoot,
    clearEnv: true,
    env: {
      PATH: `${path}:/usr/bin:/bin`,
      ...environment,
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
}

async function capturedArgs(path: string): Promise<string[]> {
  return (await Deno.readTextFile(path)).split("\0").filter(Boolean);
}

Deno.test("production launcher preserves only validated scoped skill storage", async () => {
  const fixture = await Deno.makeTempDir({
    prefix: "bakery-skill-launcher-",
  });
  try {
    const fakeBin = `${fixture}/bin`;
    const skillRoot = `${fixture}/skill-store`;
    const secretsKeyFile = `${fixture}/secrets.key`;
    const providerFixtureFile = `${fixture}/provider.json`;
    const unrelatedReadPath = `${fixture}/unrelated-read`;
    const unrelatedWritePath = `${fixture}/unrelated-write`;
    await Deno.mkdir(fakeBin, { mode: 0o700 });
    await Deno.mkdir(skillRoot, { mode: 0o700 });
    await Deno.writeTextFile(secretsKeyFile, "private-key", { mode: 0o600 });
    await Deno.writeTextFile(providerFixtureFile, "{}", { mode: 0o600 });
    await Deno.writeTextFile(unrelatedReadPath, "private");
    const capture = await writeCaptureDeno(fakeBin);

    const configured = await launch(fakeBin, {
      BAKERY_ENV: "test",
      BAKERY_SECRETS_KEY_FILE: secretsKeyFile,
      BAKERY_SECRET_IDENTITY_PROVIDER_FIXTURE_FILE: providerFixtureFile,
      BAKERY_SKILL_FILE_ROOT: skillRoot,
      BAKERY_LAUNCHER_UNRELATED_SECRET: "must-not-cross",
    });
    assertEquals(configured.code, 0, decoder.decode(configured.stderr));
    const args = await capturedArgs(capture.argsPath);
    assertEquals(await Deno.readTextFile(capture.rootPath), skillRoot);
    assertEquals(await Deno.readTextFile(capture.unrelatedPath), "absent");
    assert(args.includes(`--allow-read=${skillRoot}`));
    assert(args.includes(`--allow-write=${skillRoot}`));
    assert(args.includes(`--allow-read=${secretsKeyFile}`));
    assert(args.includes(`--allow-read=${providerFixtureFile}`));
    assert(!args.includes(`--allow-write=${secretsKeyFile}`));
    assert(!args.includes(`--allow-write=${providerFixtureFile}`));
    assert(!args.includes("--allow-all"));
    assertEquals(args.at(-1), "src/main.ts");

    const probeArgs = [
      ...args.slice(0, -1),
      "../../tests/fixtures/skill-launcher-permission-probe.ts",
      unrelatedReadPath,
      unrelatedWritePath,
    ];
    const probe = await new Deno.Command(Deno.execPath(), {
      args: probeArgs,
      cwd: serverRoot,
      clearEnv: true,
      env: {
        PATH: "/usr/bin:/bin",
        FORCE_COLOR: "0",
        BAKERY_ENV: "test",
        BAKERY_SKILL_FILE_ROOT: skillRoot,
      },
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(probe.code, 0, decoder.decode(probe.stderr));
    await assertRejectsNotFound(unrelatedWritePath);

    await Deno.remove(capture.argsPath);
    const absent = await launch(fakeBin, {
      BAKERY_ENV: "test",
      BAKERY_LAUNCHER_UNRELATED_SECRET: "must-not-cross",
    });
    assertEquals(absent.code, 0, decoder.decode(absent.stderr));
    const absentArgs = await capturedArgs(capture.argsPath);
    assertEquals(await Deno.readTextFile(capture.rootPath), "");
    assertEquals(await Deno.readTextFile(capture.unrelatedPath), "absent");
    // Without a skill root there is no read grant: never a skill, storage or
    // unrelated path.
    assertEquals(
      absentArgs.filter((argument) => argument.startsWith("--allow-read=")),
      [],
    );
    assert(
      !absentArgs.some((argument) => argument.startsWith("--allow-write=")),
    );
    assertEquals(absentArgs.at(-1), "src/main.ts");
  } finally {
    await Deno.remove(fixture, { recursive: true });
  }
});

async function assertRejectsNotFound(path: string): Promise<void> {
  try {
    await Deno.lstat(path);
    throw new Error(`unexpected file: ${path}`);
  } catch (error) {
    assert(error instanceof Deno.errors.NotFound);
  }
}

Deno.test("production launcher rejects unsafe skill roots before Deno", async () => {
  const fixture = await Deno.makeTempDir({
    prefix: "bakery-skill-launcher-invalid-",
  });
  try {
    const fakeBin = `${fixture}/bin`;
    await Deno.mkdir(fakeBin, { mode: 0o700 });
    const capture = await writeCaptureDeno(fakeBin);
    for (
      const invalid of [
        "relative/root",
        "--allow-all",
        "/tmp/root, --allow-all",
        "/tmp/root\nnext",
        "/tmp/root/../outside",
      ]
    ) {
      await Deno.remove(capture.argsPath).catch(() => undefined);
      const result = await launch(fakeBin, {
        BAKERY_ENV: "test",
        BAKERY_SKILL_FILE_ROOT: invalid,
      });
      assertEquals(result.code, 1);
      assertStringIncludes(
        decoder.decode(result.stderr),
        "SKILL_FILE_ROOT_INVALID",
      );
      await assertRejectsNotFound(capture.argsPath);
    }
  } finally {
    await Deno.remove(fixture, { recursive: true });
  }
});
