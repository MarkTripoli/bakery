import { assertEquals } from "@std/assert";
import { entriesOf, removeTreeSync } from "../../scripts/ci/temp-tree.ts";

// #242: test suites leaked `bakery-*` temp dirs into /tmp, which on the rig host
// is RAM-backed (43,000 entries, an ENOSPC for the rig daemon). The unit lane
// must leave its temp dir as it found it, pass or fail. This runs the real lane
// runner over the suites that leaked the most, with a temp dir of its own, and
// fails if anything is left in it afterwards.

const SUBSET = [
  "tests/unit/worker-claude-coordinator_test.ts",
  "tests/unit/worker-claude-harness_test.ts",
  "tests/unit/worker-readiness-checks_test.ts",
  "tests/unit/worker-codex-harness_test.ts",
  "tests/unit/worker-pi-harness_test.ts",
];

Deno.test("a unit lane run leaves nothing behind in the temp dir", async () => {
  const base = await Deno.makeTempDir({ prefix: "bkl-" });
  try {
    const run = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-env",
        "--allow-read",
        "--allow-run",
        "scripts/run-tests.ts",
        "unit",
        ...SUBSET,
      ],
      env: { TMPDIR: base, BAKERY_TEST_TMP_STRICT: "1" },
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    const text = new TextDecoder().decode(run.stdout) +
      new TextDecoder().decode(run.stderr);
    assertEquals(run.code, 0, `the lane failed:\n${text.slice(-1500)}`);
    const left = entriesOf(base);
    const prefixes = new Map<string, number>();
    for (const name of left) {
      const prefix = name.replace(/-?[A-Za-z0-9_]{6,}$/, "");
      prefixes.set(prefix, (prefixes.get(prefix) ?? 0) + 1);
    }
    assertEquals(
      left,
      [],
      `${left.length} entries were left in the temp dir; by prefix: ${
        JSON.stringify(Object.fromEntries(prefixes))
      }`,
    );
  } finally {
    removeTreeSync(base);
  }
});

Deno.test("the root tool sweeps only a lane root it made, and refuses anything else", async () => {
  const base = await Deno.makeTempDir({ prefix: "bkl-" });
  try {
    const stranger = `${base}/not-a-lane-root`;
    await Deno.mkdir(stranger);
    await Deno.writeTextFile(`${stranger}/keep`, "keep");
    const tool = (...args: string[]) =>
      new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "--allow-read",
          `--allow-write=${base}`,
          "scripts/ci/test-temp-root.ts",
          ...args,
        ],
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).output();
    assertEquals((await tool("sweep", base, stranger)).code, 2);
    assertEquals(
      entriesOf(stranger),
      ["keep"],
      "a path that is not a lane root was touched",
    );
    assertEquals((await tool("sweep", base, base)).code, 2);
    // The right name in the wrong place is not a lane root either.
    const decoy = `${base}/elsewhere/bakery-lane-decoy`;
    await Deno.mkdir(decoy, { recursive: true });
    await Deno.writeTextFile(`${decoy}/keep`, "keep");
    assertEquals((await tool("sweep", base, decoy)).code, 2);
    assertEquals(
      entriesOf(decoy),
      ["keep"],
      "a decoy outside the base was swept",
    );
    assertEquals((await tool("sweep", "relative/base", stranger)).code, 2);
    assertEquals((await tool("create", "relative/base")).code, 2);
    const made = new TextDecoder().decode((await tool("create", base)).stdout)
      .trim();
    assertEquals(made.startsWith(`${base}/bakery-lane-`), true, made);
    await Deno.writeTextFile(`${made}/leftover`, "x");
    const swept = JSON.parse(
      new TextDecoder().decode((await tool("sweep", base, made)).stdout),
    );
    assertEquals(swept.leaked, 1);
    assertEquals(
      entriesOf(base),
      ["elsewhere", "not-a-lane-root"],
      "the lane root was removed and nothing else was",
    );
  } finally {
    removeTreeSync(base);
  }
});

async function runUnitLane(files: string[], strict: boolean) {
  const base = await Deno.makeTempDir({ prefix: "bkl-" });
  try {
    const run = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-env",
        "--allow-read",
        "--allow-run",
        "scripts/run-tests.ts",
        "unit",
        ...files,
      ],
      env: { TMPDIR: base, BAKERY_TEST_TMP_STRICT: strict ? "1" : "0" },
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    return {
      code: run.code,
      text: new TextDecoder().decode(run.stdout) +
        new TextDecoder().decode(run.stderr),
      left: entriesOf(base),
    };
  } finally {
    removeTreeSync(base);
  }
}

Deno.test("every Deno temp call is cleaned at exit, including a directory a test locked", async () => {
  const run = await runUnitLane(
    ["tests/unit/fixtures/temp-via-every-deno-call.fixture.ts"],
    true,
  );
  assertEquals(run.code, 0, run.text.slice(-1200));
  assertEquals(run.left, [], "the lane left temp entries behind");
  assertEquals(
    run.text.includes("test temp root:"),
    false,
    "the sweep had to clean up after the preload",
  );
});

Deno.test("what the preload cannot see is swept from the run's own temp root, reported, and fails a strict run", async () => {
  const strict = await runUnitLane(
    ["tests/unit/fixtures/temp-via-node-mkdtemp.fixture.ts"],
    true,
  );
  assertEquals(strict.code, 3, strict.text.slice(-1200));
  assertEquals(strict.left, [], "the swept root was left in the temp dir");
  assertEquals(
    strict.text.includes("1 entries were still there"),
    true,
    strict.text.slice(-800),
  );
  assertEquals(
    strict.text.includes("bakery-fixture-node"),
    true,
    "the report names the leaked prefix",
  );

  const lenient = await runUnitLane(
    ["tests/unit/fixtures/temp-via-node-mkdtemp.fixture.ts"],
    false,
  );
  assertEquals(
    lenient.code,
    0,
    "outside strict mode a swept leak does not fail the lane",
  );
  assertEquals(lenient.left, []);
});

Deno.test("a swapped lane root is reported, as a link and never followed, and is not a clean sweep (#268)", async () => {
  const base = await Deno.makeTempDir({ prefix: "bkl-" });
  try {
    const outside = `${base}/outside`;
    await Deno.mkdir(`${outside}/inner`, { recursive: true });
    await Deno.writeTextFile(`${outside}/inner/keep`, "keep");
    await Deno.chmod(`${outside}/inner`, 0o755);
    await Deno.chmod(outside, 0o755);
    const link = `${base}/bakery-lane-link`;
    // The rails lane's write grant is scoped to the temp dir, and Deno refuses a
    // symlink under a scoped grant, so the link is made by `ln`.
    const made = await new Deno.Command("ln", {
      args: ["-s", outside, link],
      stdin: "null",
      stdout: "null",
      stderr: "piped",
    }).output();
    assertEquals(made.code, 0, new TextDecoder().decode(made.stderr));
    const run = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-read",
        `--allow-write=${base}`,
        "scripts/ci/test-temp-root.ts",
        "sweep",
        base,
        link,
      ],
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(run.code, 0, new TextDecoder().decode(run.stderr));
    const report = JSON.parse(new TextDecoder().decode(run.stdout));
    // The swap is reported, not a clean 0: the link was there, and says where
    // it pointed. What it pointed at is not counted, listed or swept.
    assertEquals(report.leaked, 1, "a swapped lane root reported as clean");
    assertEquals(report.anomaly, "root_symlink");
    assertEquals(report.anomalyTarget, outside);
    assertEquals(report.prefixes, {}, "the link's target was listed");
    assertEquals(
      entriesOf(base),
      ["outside"],
      "the link was not removed, or more than the link was",
    );
    assertEquals(entriesOf(`${outside}/inner`), ["keep"]);
    assertEquals(
      (await Deno.stat(outside)).mode! & 0o777,
      0o755,
      "the target's mode was changed",
    );
    assertEquals(
      (await Deno.stat(`${outside}/inner`)).mode! & 0o777,
      0o755,
      "a directory below the target was changed",
    );
  } finally {
    removeTreeSync(base);
  }
});

/** Runs the root tool's `sweep` over `root` with a write grant on `base` only. */
async function sweepRoot(base: string, root: string) {
  const run = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-read",
      `--allow-write=${base}`,
      "scripts/ci/test-temp-root.ts",
      "sweep",
      base,
      root,
    ],
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: run.code,
    stderr: new TextDecoder().decode(run.stderr),
    report: JSON.parse(new TextDecoder().decode(run.stdout) || "null"),
  };
}

Deno.test("a lane root that is a file or is gone is reported by kind, not swept as clean (#268)", async () => {
  const base = await Deno.makeTempDir({ prefix: "bkl-" });
  try {
    const file = `${base}/bakery-lane-file`;
    await Deno.writeTextFile(file, "not a directory");
    const asFile = await sweepRoot(base, file);
    assertEquals(asFile.code, 0, asFile.stderr);
    assertEquals(asFile.report.anomaly, "root_other");
    assertEquals(asFile.report.leaked, 1);
    assertEquals(entriesOf(base), [], "the file was left in place");
    const gone = await sweepRoot(base, `${base}/bakery-lane-gone`);
    assertEquals(gone.code, 0, gone.stderr);
    assertEquals(gone.report.anomaly, "root_missing");
    assertEquals(gone.report.leaked, 0, "nothing was there to leak");
  } finally {
    removeTreeSync(base);
  }
});

Deno.test("a sweep whose removal fails still prints its report and says why (#268)", async () => {
  const base = await Deno.makeTempDir({ prefix: "bkl-" });
  try {
    const root = `${base}/bakery-lane-stuck`;
    await Deno.mkdir(root);
    await Deno.writeTextFile(`${root}/leftover`, "x");
    // A directory that cannot be written to refuses the removal of what is in
    // it, which is how a failing removal looks to the tool.
    await Deno.chmod(base, 0o500);
    let swept;
    try {
      swept = await sweepRoot(base, root);
    } finally {
      await Deno.chmod(base, 0o700);
    }
    assertEquals(swept.code, 0, swept.stderr);
    assertEquals(swept.report.leaked, 1, "the report is lost with the removal");
    assertEquals(
      typeof swept.report.removeError,
      "string",
      "the removal failure is not reported",
    );
    // The contents went; the root itself could not be unlinked from `base`.
    assertEquals(Deno.statSync(root).isDirectory, true, "the root is gone");
  } finally {
    removeTreeSync(base);
  }
});
