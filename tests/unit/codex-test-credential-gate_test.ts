import { assert, assertEquals, assertThrows } from "@std/assert";
import { join } from "node:path";
import {
  CODEX_TEST_AUTH_DIR_ENV,
  codexTestCredentialGate as gateWithAccount,
  dedicatedCodexTestAuthSource as sourceWithAccount,
} from "../helpers/codex-harness.ts";

// These cases must never consult the real account: a gate that finds the real
// home would look at the real ~/.codex path. They use a neutral fake home unless
// a case passes its own. The real lookup is tested under the lane's exact
// permissions in tests/rails/codex-test-credentials_test.ts.
const NEUTRAL_HOME = () => "/nonexistent-account-home";
const codexTestCredentialGate = (
  env: Parameters<typeof gateWithAccount>[0],
  probe: Parameters<typeof gateWithAccount>[1],
  executable: string,
  accountHome: Parameters<typeof gateWithAccount>[3] = NEUTRAL_HOME,
  fileInfo?: Parameters<typeof gateWithAccount>[4],
) => gateWithAccount(env, probe, executable, accountHome, fileInfo);
const dedicatedCodexTestAuthSource = (
  env: Parameters<typeof sourceWithAccount>[0],
  accountHome: Parameters<typeof sourceWithAccount>[1] = NEUTRAL_HOME,
  fileInfo?: Parameters<typeof sourceWithAccount>[2],
) => sourceWithAccount(env, accountHome, fileInfo);

// #207: the real-Codex cases used to run whenever a `codex` executable
// resolved, against the operator's own login ($HOME/.codex by default), so a
// local `pnpm test:security` or full lane could spend the owner's personal
// account. They now run only when BAKERY_TEST_CODEX_AUTH_DIR names a dedicated
// test credential directory. These cases use only temporary directories and an
// injected environment and probe: none of them reads or runs anything of the
// operator's. The rail in tests/rails/codex-test-credentials_test.ts holds the
// rest of the line (no other test reaches the login; the real gate touches
// nothing it may not).

type Env = Record<string, string | undefined>;
const reader = (env: Env) => (name: string) => env[name];

/** A pretend operator: HOME with a login, and every variable that could point at it. */
async function sentinelOperator() {
  const home = await Deno.makeTempDir({ prefix: "bakery-sentinel-home-" });
  const login = join(home, ".codex");
  await Deno.mkdir(login);
  await Deno.writeTextFile(join(login, "auth.json"), "SENTINEL-DO-NOT-READ");
  const env: Env = {
    HOME: home,
    CODEX_HOME: login,
    BAKERY_CODEX_AUTH_SOURCE_DIR: login,
  };
  return { home, login, env };
}

/** A dedicated test credential directory: absolute, existing, holding auth.json. */
async function dedicatedDirectory() {
  const dir = await Deno.makeTempDir({ prefix: "bakery-dedicated-codex-" });
  await Deno.writeTextFile(join(dir, "auth.json"), "{}");
  return dir;
}

function spyProbe(result: string | true = true) {
  const calls: { executable: string; env: Record<string, string> }[] = [];
  return {
    calls,
    probe: (executable: string, env: Record<string, string>) => {
      calls.push({ executable, env });
      return Promise.resolve(result);
    },
  };
}

const EXECUTABLE = "codex";

Deno.test("without the opt-in nothing resolves the operator's login: the gate skips and probes nothing", async () => {
  const operator = await sentinelOperator();
  try {
    // Every variable that points at the login is set, and none is an opt-in.
    const spy = spyProbe();
    const result = await codexTestCredentialGate(
      reader(operator.env),
      spy.probe,
      EXECUTABLE,
    );
    assert(typeof result === "string", "the gate must skip, not pass");
    assert(result.includes(CODEX_TEST_AUTH_DIR_ENV), result);
    assert(
      result.includes("is not set"),
      `skipped for the wrong reason: ${result}`,
    );
    assertEquals(spy.calls.length, 0, "the CLI was probed without the opt-in");
    assert(!result.includes(operator.home), "the skip reason names the login");

    const error = assertThrows(() =>
      dedicatedCodexTestAuthSource(reader(operator.env))
    );
    assert(error instanceof Error);
    assert(error.message.includes(CODEX_TEST_AUTH_DIR_ENV));
    assert(!error.message.includes(operator.home), error.message);
    // A blank opt-in is no opt-in.
    for (const blank of ["", "   "]) {
      const again = await codexTestCredentialGate(
        reader({ ...operator.env, [CODEX_TEST_AUTH_DIR_ENV]: blank }),
        spy.probe,
        EXECUTABLE,
      );
      assert(typeof again === "string");
    }
    assertEquals(spy.calls.length, 0);
    assertEquals(
      await Deno.readTextFile(join(operator.login, "auth.json")),
      "SENTINEL-DO-NOT-READ",
    );
  } finally {
    await Deno.remove(operator.home, { recursive: true });
  }
});

Deno.test("the old variables are no opt-in, even when they name a perfectly good dedicated directory", async () => {
  // This is the case where a fallback would actually run the cases: the
  // directory is not the operator's login, so only the missing opt-in stops it.
  const other = await dedicatedDirectory();
  try {
    for (const name of ["CODEX_HOME", "BAKERY_CODEX_AUTH_SOURCE_DIR"]) {
      const spy = spyProbe();
      const env = { HOME: "/nonexistent-home", [name]: other };
      const result = await codexTestCredentialGate(
        reader(env),
        spy.probe,
        EXECUTABLE,
      );
      assert(
        typeof result === "string" && result.includes("is not set"),
        `${name} counted as an opt-in: ${result}`,
      );
      assertEquals(spy.calls.length, 0, `${name} was probed`);
      assertThrows(
        () => dedicatedCodexTestAuthSource(reader(env)),
        Error,
        "is not set",
      );
    }
  } finally {
    await Deno.remove(other, { recursive: true });
  }
});

Deno.test("an opt-in that is the operator's own login, or inside it, is refused", async () => {
  const operator = await sentinelOperator();
  const inside = join(operator.login, "profiles");
  await Deno.mkdir(inside);
  await Deno.writeTextFile(join(inside, "auth.json"), "{}");
  const viaLink = join(operator.home, "innocent-looking");
  await Deno.symlink(operator.login, viaLink);
  try {
    // Each way the operator's login can be named, taken as the opt-in.
    const refused: { name: string; env: Env; optIn: string }[] = [
      { name: "HOME/.codex", env: operator.env, optIn: operator.login },
      { name: "a subdirectory of it", env: operator.env, optIn: inside },
      { name: "a symlink to it", env: operator.env, optIn: viaLink },
      {
        name: "CODEX_HOME",
        env: { HOME: "/nonexistent-home", CODEX_HOME: operator.login },
        optIn: operator.login,
      },
      {
        name: "BAKERY_CODEX_AUTH_SOURCE_DIR",
        env: {
          HOME: "/nonexistent-home",
          BAKERY_CODEX_AUTH_SOURCE_DIR: operator.login,
        },
        optIn: operator.login,
      },
    ];
    for (const { name, env: base, optIn } of refused) {
      const spy = spyProbe();
      const env = { ...base, [CODEX_TEST_AUTH_DIR_ENV]: optIn };
      const result = await codexTestCredentialGate(
        reader(env),
        spy.probe,
        EXECUTABLE,
      );
      assert(typeof result === "string", `${name} was accepted`);
      assertEquals(spy.calls.length, 0, `${name} was probed`);
      assertThrows(() => dedicatedCodexTestAuthSource(reader(env)), Error);
    }
  } finally {
    await Deno.remove(operator.home, { recursive: true });
  }
});

Deno.test("an opt-in must be an absolute existing directory that holds auth.json", async () => {
  const empty = await Deno.makeTempDir({ prefix: "bakery-empty-codex-" });
  const file = await Deno.makeTempFile({ prefix: "bakery-not-a-dir-" });
  const here = await dedicatedDirectory();
  const cwd = Deno.cwd();
  try {
    // A relative path that does exist from the working directory, and holds an
    // auth.json, is still not an absolute path.
    Deno.chdir(here);
    for (const relative of [".", "./"]) {
      const spy = spyProbe();
      const env = {
        HOME: "/nonexistent-home",
        [CODEX_TEST_AUTH_DIR_ENV]: relative,
      };
      const result = await codexTestCredentialGate(
        reader(env),
        spy.probe,
        EXECUTABLE,
      );
      assert(
        typeof result === "string" && result.includes("absolute"),
        `${relative} was accepted: ${result}`,
      );
      assertEquals(spy.calls.length, 0);
    }
    Deno.chdir(cwd);
    for (
      const value of [
        "relative/path",
        "./auth",
        `${empty}-does-not-exist`,
        file,
        empty,
      ]
    ) {
      const spy = spyProbe();
      const env = {
        HOME: "/nonexistent-home",
        [CODEX_TEST_AUTH_DIR_ENV]: value,
      };
      const result = await codexTestCredentialGate(
        reader(env),
        spy.probe,
        EXECUTABLE,
      );
      assert(typeof result === "string", `${value} was accepted`);
      assertEquals(spy.calls.length, 0, `${value} was probed`);
      assertThrows(() => dedicatedCodexTestAuthSource(reader(env)), Error);
    }
  } finally {
    Deno.chdir(cwd);
    await Deno.remove(empty, { recursive: true });
    await Deno.remove(here, { recursive: true });
    await Deno.remove(file);
  }
});

Deno.test("a dedicated directory is probed with HOME and CODEX_HOME pointed at it, and is the only source used", async () => {
  const operator = await sentinelOperator();
  const dedicated = await dedicatedDirectory();
  try {
    const env = { ...operator.env, [CODEX_TEST_AUTH_DIR_ENV]: dedicated };
    const spy = spyProbe(true);
    assertEquals(
      await codexTestCredentialGate(reader(env), spy.probe, EXECUTABLE),
      true,
    );
    assertEquals(spy.calls.length, 1);
    assertEquals(spy.calls[0]!.executable, EXECUTABLE);
    // The probe must not see the operator's HOME or login either.
    assertEquals(spy.calls[0]!.env, { HOME: dedicated, CODEX_HOME: dedicated });
    assertEquals(dedicatedCodexTestAuthSource(reader(env)), dedicated);

    // What the probe says is passed on: a CLI that will not run is a skip.
    const failing = spyProbe("the pinned codex CLI is not runnable");
    assertEquals(
      await codexTestCredentialGate(reader(env), failing.probe, EXECUTABLE),
      "the pinned codex CLI is not runnable",
    );
  } finally {
    await Deno.remove(operator.home, { recursive: true });
    await Deno.remove(dedicated, { recursive: true });
  }
});

// --- QA round 1: a link to the operator's login file is the operator's login

Deno.test("an auth.json that links to the operator's own login file is refused, however it is linked", async () => {
  const operator = await sentinelOperator();
  // A second login the operator could have named through CODEX_HOME or
  // BAKERY_CODEX_AUTH_SOURCE_DIR instead of HOME.
  const elsewhere = await Deno.makeTempDir({ prefix: "bakery-other-login-" });
  await Deno.writeTextFile(join(elsewhere, "auth.json"), "OTHER-LOGIN");
  const made: string[] = [];
  try {
    const targets: { name: string; env: Env; file: string }[] = [
      {
        name: "HOME/.codex",
        env: operator.env,
        file: join(operator.login, "auth.json"),
      },
      {
        name: "CODEX_HOME",
        env: { HOME: "/nonexistent-home", CODEX_HOME: elsewhere },
        file: join(elsewhere, "auth.json"),
      },
      {
        name: "BAKERY_CODEX_AUTH_SOURCE_DIR",
        env: {
          HOME: "/nonexistent-home",
          BAKERY_CODEX_AUTH_SOURCE_DIR: elsewhere,
        },
        file: join(elsewhere, "auth.json"),
      },
    ];
    const linkers: [string, (to: string, at: string) => Promise<void>][] = [
      ["a symbolic link", (to, at) => Deno.symlink(to, at)],
      ["a hard link", (to, at) => Deno.link(to, at)],
    ];
    for (const target of targets) {
      for (const [how, link] of linkers) {
        const dir = await Deno.makeTempDir({ prefix: "bakery-linked-codex-" });
        made.push(dir);
        await link(target.file, join(dir, "auth.json"));
        const spy = spyProbe();
        const env = { ...target.env, [CODEX_TEST_AUTH_DIR_ENV]: dir };
        const result = await codexTestCredentialGate(
          reader(env),
          spy.probe,
          EXECUTABLE,
        );
        assert(
          typeof result === "string",
          `${how} to ${target.name} was accepted`,
        );
        assertEquals(
          spy.calls.length,
          0,
          `${how} to ${target.name} was probed`,
        );
        assertThrows(() => dedicatedCodexTestAuthSource(reader(env)), Error);
      }
    }
  } finally {
    for (const dir of made) await Deno.remove(dir, { recursive: true });
    await Deno.remove(elsewhere, { recursive: true });
    await Deno.remove(operator.home, { recursive: true });
  }
});

Deno.test("any auth.json that is a link or has more than one link is refused, the operator's or not", async () => {
  const other = await Deno.makeTempDir({ prefix: "bakery-unrelated-" });
  await Deno.writeTextFile(join(other, "unrelated.json"), "{}");
  const made: string[] = [];
  try {
    for (
      const [how, link] of [
        [
          "a symlink to an unrelated file",
          (at: string) => Deno.symlink(join(other, "unrelated.json"), at),
        ],
        [
          "a second hard link to an unrelated file",
          (at: string) => Deno.link(join(other, "unrelated.json"), at),
        ],
      ] as [string, (at: string) => Promise<void>][]
    ) {
      const dir = await Deno.makeTempDir({ prefix: "bakery-linked-codex-" });
      made.push(dir);
      await link(join(dir, "auth.json"));
      const spy = spyProbe();
      const env = { HOME: "/nonexistent-home", [CODEX_TEST_AUTH_DIR_ENV]: dir };
      const result = await codexTestCredentialGate(
        reader(env),
        spy.probe,
        EXECUTABLE,
      );
      assert(typeof result === "string", `${how} was accepted`);
      assertEquals(spy.calls.length, 0, how);
    }
    // Not a regular file at all: refused as holding no auth.json, by that
    // reason and not by the link count a directory happens to have.
    const notAFile = await Deno.makeTempDir({ prefix: "bakery-notafile-" });
    made.push(notAFile);
    await Deno.mkdir(join(notAFile, "auth.json"));
    const notAFileSpy = spyProbe();
    const notAFileResult = await codexTestCredentialGate(
      reader({
        HOME: "/nonexistent-home",
        [CODEX_TEST_AUTH_DIR_ENV]: notAFile,
      }),
      notAFileSpy.probe,
      EXECUTABLE,
    );
    assert(
      typeof notAFileResult === "string" &&
        notAFileResult.includes("holds no auth.json"),
      `a directory named auth.json: ${notAFileResult}`,
    );
    assertEquals(notAFileSpy.calls.length, 0);
    // And the plain case still passes: one regular file, one link.
    const plain = await dedicatedDirectory();
    made.push(plain);
    const spy = spyProbe(true);
    assertEquals(
      await codexTestCredentialGate(
        reader({ HOME: "/nonexistent-home", [CODEX_TEST_AUTH_DIR_ENV]: plain }),
        spy.probe,
        EXECUTABLE,
      ),
      true,
    );
  } finally {
    for (const dir of made) await Deno.remove(dir, { recursive: true });
    await Deno.remove(other, { recursive: true });
  }
});

Deno.test("the login is known even when HOME is unset or points elsewhere", async () => {
  // The account's own home directory counts as well as the HOME variable.
  const operator = await sentinelOperator();
  try {
    for (const home of [undefined, "/nonexistent-home"]) {
      const spy = spyProbe();
      const env: Env = { [CODEX_TEST_AUTH_DIR_ENV]: operator.login };
      if (home !== undefined) env["HOME"] = home;
      const result = await codexTestCredentialGate(
        reader(env),
        spy.probe,
        EXECUTABLE,
        () => operator.home,
      );
      assert(
        typeof result === "string" && result.includes("operator's own"),
        `HOME=${home} let the login through: ${result}`,
      );
      assertEquals(spy.calls.length, 0);
      assertThrows(
        () => dedicatedCodexTestAuthSource(reader(env), () => operator.home),
        Error,
      );
    }
  } finally {
    await Deno.remove(operator.home, { recursive: true });
  }
});

// --- QA round 2

Deno.test("an account home that cannot be found fails closed: the opt-in is refused, not waved through", async () => {
  const dedicated = await dedicatedDirectory();
  try {
    const env = {
      HOME: "/nonexistent-home",
      [CODEX_TEST_AUTH_DIR_ENV]: dedicated,
    };
    for (const missing of [() => undefined, () => "", () => "   "]) {
      const spy = spyProbe();
      const result = await codexTestCredentialGate(
        reader(env),
        spy.probe,
        EXECUTABLE,
        missing,
      );
      assert(
        typeof result === "string" && result.includes("home directory"),
        `an unknown account home was accepted: ${result}`,
      );
      assertEquals(spy.calls.length, 0);
      assertThrows(
        () => dedicatedCodexTestAuthSource(reader(env), missing),
        Error,
      );
    }
    // With a home it can find, the same directory is fine.
    assertEquals(
      await codexTestCredentialGate(
        reader(env),
        spyProbe(true).probe,
        EXECUTABLE,
      ),
      true,
    );
  } finally {
    await Deno.remove(dedicated, { recursive: true });
  }
});

Deno.test("HOME alone names the login: no other variable is needed to refuse it", async () => {
  const operator = await sentinelOperator();
  try {
    // Only HOME is set; CODEX_HOME and BAKERY_CODEX_AUTH_SOURCE_DIR are not.
    const homeOnly: Env = { HOME: operator.home };
    const asDirectory = {
      ...homeOnly,
      [CODEX_TEST_AUTH_DIR_ENV]: operator.login,
    };
    const spy = spyProbe();
    const result = await codexTestCredentialGate(
      reader(asDirectory),
      spy.probe,
      EXECUTABLE,
    );
    assert(
      typeof result === "string" && result.includes("operator's own"),
      String(result),
    );
    assertEquals(spy.calls.length, 0);

    // And a hard link to its login file, with HOME the only way to find it.
    const linked = await Deno.makeTempDir({ prefix: "bakery-home-only-" });
    try {
      await Deno.link(
        join(operator.login, "auth.json"),
        join(linked, "auth.json"),
      );
      const result2 = await codexTestCredentialGate(
        reader({ ...homeOnly, [CODEX_TEST_AUTH_DIR_ENV]: linked }),
        spy.probe,
        EXECUTABLE,
      );
      assert(
        typeof result2 === "string",
        "a hard link to the login file was accepted",
      );
      assertEquals(spy.calls.length, 0);
    } finally {
      await Deno.remove(linked, { recursive: true });
    }
  } finally {
    await Deno.remove(operator.home, { recursive: true });
  }
});

Deno.test("a file that is the operator's own by identity is refused even when it has one link (a bind mount)", async () => {
  // Only identity catches this: a bind mount of the login file gives it a second
  // path and no second link. The file-info seam reports the operator's own
  // device and inode for the dedicated path, as such a mount would.
  const operator = await sentinelOperator();
  const dedicated = await dedicatedDirectory();
  try {
    const operatorFile = Deno.statSync(join(operator.login, "auth.json"));
    const bindMounted = () => ({
      ...operatorFile,
      nlink: 1,
      isFile: true,
      isSymlink: false,
    });
    const env = { ...operator.env, [CODEX_TEST_AUTH_DIR_ENV]: dedicated };
    const spy = spyProbe();
    const result = await codexTestCredentialGate(
      reader(env),
      spy.probe,
      EXECUTABLE,
      NEUTRAL_HOME,
      bindMounted as never,
    );
    assert(
      typeof result === "string" &&
        result.includes("operator's own login file"),
      String(result),
    );
    assertEquals(spy.calls.length, 0);
    assertThrows(
      () =>
        dedicatedCodexTestAuthSource(
          reader(env),
          NEUTRAL_HOME,
          bindMounted as never,
        ),
      Error,
    );
    // The control: the dedicated directory's own file is accepted.
    assertEquals(
      await codexTestCredentialGate(
        reader(env),
        spyProbe(true).probe,
        EXECUTABLE,
      ),
      true,
    );
  } finally {
    await Deno.remove(operator.home, { recursive: true });
    await Deno.remove(dedicated, { recursive: true });
  }
});
