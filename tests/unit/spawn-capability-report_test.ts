import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "node:path";
import {
  candidatesAlong,
  createSpawnFailureReporter,
  describeSpawnCapability,
  FULL_REPORTS_PER_PROCESS,
  gatherSpawnFacts,
  programOf,
  type SpawnFacts,
} from "../helpers/spawn-capability-report.ts";

// #229: a refused spawn used to say only `Requires run access to "git"`. These
// pin what it says now: the PATH the lane started with against the PATH now,
// where the program resolves in each, and that the text is bounded and cannot
// act on a log reader.

const baseFacts: SpawnFacts = {
  message: 'Requires run access to "git", run again with the --allow-run flag',
  program: "git",
  startupPath: "/usr/bin",
  currentPath: "/usr/bin",
  allowRun: "zip,unzip,node,git,/usr/bin/git",
  gitExecutable: undefined,
  candidatesAtStart: [{ path: "/usr/bin/git", realPath: "/usr/bin/git" }],
  candidatesNow: [{ path: "/usr/bin/git", realPath: "/usr/bin/git" }],
  permissions: [{ command: "git", state: "granted" }],
  processInfo: { pid: 4242, cwd: "/work", deno: "2.9.1" },
};

Deno.test("a PATH that changed since the lane started is named, with where git resolved in each", () => {
  const text = describeSpawnCapability({
    ...baseFacts,
    currentPath: "/bin:/usr/bin",
    candidatesNow: [
      { path: "/bin/git", realPath: "/usr/bin/git" },
      { path: "/usr/bin/git", realPath: "/usr/bin/git" },
    ],
  });
  assertStringIncludes(text, "PATH changed since start: YES");
  assertStringIncludes(
    text,
    "resolves to the same path: NO (start /usr/bin/git, now /bin/git)",
  );
  assertStringIncludes(text, "[1] /bin/git -> /usr/bin/git");
  assertStringIncludes(text, "PATH at lane start:      /usr/bin");
  assertStringIncludes(text, "PATH now:                /bin:/usr/bin");
  assertStringIncludes(text, "lane --allow-run:        zip,unzip,node,git");
  assertStringIncludes(text, "git=granted");
});

Deno.test("a PATH that did not change says so, and so does an unknown start", () => {
  const same = describeSpawnCapability(baseFacts);
  assertStringIncludes(same, "PATH changed since start: no");
  assertStringIncludes(same, "resolves to the same path: yes");
  const unknown = describeSpawnCapability({
    ...baseFacts,
    startupPath: undefined,
    allowRun: undefined,
  });
  assertStringIncludes(
    unknown,
    "unknown (BAKERY_TEST_STARTUP_PATH is not set: this process was not started by scripts/run-tests.ts)",
  );
  assertStringIncludes(unknown, "unknown (BAKERY_TEST_ALLOW_RUN is not set");
});

Deno.test("the report is bounded however much it is given", () => {
  const long = "/aaaa:".repeat(5_000);
  const many = Array.from({ length: 60 }, (_, index) => ({
    path: `/dir${index}/git`,
    realPath: `/real${index}/git`,
  }));
  const text = describeSpawnCapability({
    ...baseFacts,
    startupPath: long,
    currentPath: long + "x",
    allowRun: long,
    candidatesAtStart: many,
    candidatesNow: many,
    permissions: Array.from({ length: 60 }, (_, index) => ({
      command: `/cmd${index}`,
      state: "prompt",
    })),
  });
  const lines = text.split("\n");
  assert(lines.length <= 14, `${lines.length} lines`);
  for (const each of lines) assert(each.length < 1_200, `${each.length} chars`);
  assertStringIncludes(text, "(+52 more)");
  assertStringIncludes(text, "more)");
  assert(text.split("/cmd").length - 1 <= 12, "permissions were not capped");
});

Deno.test("values cannot break out of their line or act as a log command", () => {
  const text = describeSpawnCapability({
    ...baseFacts,
    currentPath: "/usr/bin\n::error::forged\n##[error]forged",
    startupPath: "/usr/bin\u001b[31m\u0007",
    message: 'Requires run access to "git"\n::add-mask::x',
  });
  for (const each of text.split("\n")) {
    assert(
      each.startsWith("[bakery-test]") || each.startsWith("  "),
      `a line starts as a command would: ${JSON.stringify(each)}`,
    );
  }
  assert(
    ![...text].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return (code < 32 && code !== 10) || code === 127;
    }),
    "a control character reached the report",
  );
});

Deno.test("programOf reads the program a refusal names, and nothing else", () => {
  assertEquals(programOf('Requires run access to "git", run again'), "git");
  assertEquals(
    programOf('Requires run access to "/usr/bin/setsid", run again'),
    "/usr/bin/setsid",
  );
  assertEquals(programOf('Requires env access to "PATH"'), undefined);
  assertEquals(programOf("something else"), undefined);
});

Deno.test("candidatesAlong lists where a program is found, in PATH order, with where each really points", async () => {
  const root = await Deno.makeTempDir({ prefix: "spawn-report-" });
  const first = join(root, "first");
  const second = join(root, "second");
  const third = join(root, "third");
  for (const directory of [first, second, third]) await Deno.mkdir(directory);
  await Deno.writeTextFile(join(second, "zzprog"), "#!/bin/sh\n");
  await Deno.symlink(join(second, "zzprog"), join(first, "zzprog"));
  await Deno.mkdir(join(third, "zzprog"));
  const found = candidatesAlong(
    `${first}:${root}/missing::${second}/:${third}`,
    "zzprog",
  );
  assertEquals(found.map((candidate) => candidate.path), [
    join(first, "zzprog"),
    `${second}/zzprog`,
  ]);
  assertEquals(found[0].realPath, await Deno.realPath(join(second, "zzprog")));
  assertEquals(candidatesAlong(undefined, "zzprog"), []);
  assertEquals(candidatesAlong(first, undefined), []);
  assertEquals(candidatesAlong(first, "../zzprog"), []);
  assertEquals(
    candidatesAlong(third, "zzprog"),
    [],
    "a directory is no program",
  );
});

Deno.test("gatherSpawnFacts reads the process and the PATHs it is given", async () => {
  const root = await Deno.makeTempDir({ prefix: "spawn-report-" });
  await Deno.writeTextFile(join(root, "zzprog"), "#!/bin/sh\n");
  const error = new Deno.errors.NotCapable(
    'Requires run access to "zzprog", run again with the --allow-run flag\nstack',
  );
  const facts = gatherSpawnFacts(error, {
    startupPath: "/nonexistent",
    currentPath: `${root}:/nonexistent`,
    allowRun: "git",
    gitExecutable: "/usr/bin/git",
  });
  assertEquals(facts.program, "zzprog");
  assertEquals(facts.message.includes("\n"), false, "only the first line");
  assertEquals(facts.candidatesAtStart, []);
  assertEquals(facts.candidatesNow.map((candidate) => candidate.path), [
    join(root, "zzprog"),
  ]);
  assertEquals(facts.processInfo.pid, Deno.pid);
  assert(
    facts.permissions.every((permission) => permission.state.length > 0),
    "every queried command has a state",
  );
  assert(
    facts.permissions.some((permission) => permission.command === "zzprog"),
  );
  assertStringIncludes(
    describeSpawnCapability(facts),
    "PATH changed since start: YES",
  );
});

Deno.test("the reporter reports a refused spawn once, in full for the first few, and ignores anything else", () => {
  const written: string[] = [];
  const report = createSpawnFailureReporter(
    (text) => written.push(text),
    () => baseFacts,
  );
  const refusals = Array.from(
    { length: FULL_REPORTS_PER_PROCESS + 3 },
    () =>
      new Deno.errors.NotCapable(
        'Requires run access to "git", run again with the --allow-run flag',
      ),
  );
  for (const refusal of refusals) report(refusal);
  report(refusals[0]);
  assertEquals(written.length, refusals.length, "each error is reported once");
  for (const text of written.slice(0, FULL_REPORTS_PER_PROCESS)) {
    assertStringIncludes(text, "PATH changed since start");
  }
  for (const text of written.slice(FULL_REPORTS_PER_PROCESS)) {
    assert(
      !text.includes("PATH changed since start"),
      "a later report was full",
    );
    assertStringIncludes(text, "spawn refused again");
  }
  assertStringIncludes(written.at(-1) ?? "", "(3 not reported in full");

  const before = written.length;
  report(new Deno.errors.NotCapable('Requires env access to "PATH"'));
  report(new Error('Requires run access to "git"'));
  report("Requires run access to");
  report(undefined);
  assertEquals(written.length, before, "only a refused run is reported");
});

Deno.test("the reporter never throws into the spawn it describes", () => {
  const report = createSpawnFailureReporter(
    () => {
      throw new Error("the log is closed");
    },
    () => {
      throw new Error("the facts are unreadable");
    },
  );
  report(new Deno.errors.NotCapable('Requires run access to "git"'));
});

// QA of #304: tests refuse `/nonexistent/kill` on purpose, so a healthy run must
// not print an incident-shaped report for it. An absolute path never depends on
// the PATH, and one that is not on disk cannot be a path-resolution problem.

Deno.test("a refusal for an absolute path that is not on disk prints nothing and does not use up the full reports", () => {
  const written: string[] = [];
  const report = createSpawnFailureReporter(
    (text) => written.push(text),
    () => baseFacts,
    () => false,
  );
  for (let index = 0; index < FULL_REPORTS_PER_PROCESS + 2; index += 1) {
    report(
      new Deno.errors.NotCapable(
        'Requires run access to "/nonexistent/kill", run again with the --allow-run flag',
      ),
    );
  }
  assertEquals(written, [], "a deliberate refusal was reported");
  report(
    new Deno.errors.NotCapable(
      'Requires run access to "git", run again with the --allow-run flag',
    ),
  );
  assertEquals(written.length, 1);
  assertStringIncludes(written[0], "PATH changed since start");
});

Deno.test("a refusal for an absolute path that exists, and for a bare name, is still reported", () => {
  const written: string[] = [];
  const report = createSpawnFailureReporter(
    (text) => written.push(text),
    () => baseFacts,
    (path) => path === "/usr/bin/present",
  );
  report(
    new Deno.errors.NotCapable('Requires run access to "/usr/bin/present"'),
  );
  report(new Deno.errors.NotCapable('Requires run access to "git"'));
  report(new Deno.errors.NotCapable('Requires run access to "no-such-bare"'));
  assertEquals(written.length, 3);
});

Deno.test("by default a path is on disk when it can be read, a symlink included", async () => {
  const root = await Deno.makeTempDir({ prefix: "spawn-report-" });
  const file = join(root, "program");
  await Deno.writeTextFile(file, "#!/bin/sh\n");
  await Deno.symlink(file, join(root, "link"));
  await Deno.symlink(join(root, "nowhere"), join(root, "dangling"));
  const written: string[] = [];
  const report = createSpawnFailureReporter(
    (text) => written.push(text),
    () => baseFacts,
  );
  for (const path of [file, join(root, "link"), join(root, "dangling")]) {
    report(new Deno.errors.NotCapable(`Requires run access to "${path}"`));
  }
  report(
    new Deno.errors.NotCapable(`Requires run access to "${root}/missing"`),
  );
  assertEquals(
    written.length,
    3,
    "the file, the symlink and the dangling symlink are on disk; the missing path is not",
  );
});

Deno.test("C1 controls and the line separators are replaced like any other control character", () => {
  const text = describeSpawnCapability({
    ...baseFacts,
    currentPath: "/usr/bin\u0085next\u009b31m\u2028two\u2029three\u007fend",
  });
  for (const code of [0x7f, 0x85, 0x9b, 0x2028, 0x2029]) {
    assert(
      !text.includes(String.fromCodePoint(code)),
      `U+${code.toString(16)} reached the report`,
    );
  }
  assertStringIncludes(text, "/usr/bin?next?31m?two?three?end");
  assertEquals(
    text.split("\n").length,
    describeSpawnCapability(baseFacts).split("\n").length,
    "a separator started a new line",
  );
});

Deno.test("when it cannot be told whether a path is on disk the refusal is reported", async () => {
  const root = await Deno.makeTempDir({ prefix: "spawn-report-" });
  const locked = join(root, "locked");
  await Deno.mkdir(locked);
  await Deno.writeTextFile(join(locked, "program"), "#!/bin/sh\n");
  await Deno.chmod(locked, 0o000);
  try {
    const written: string[] = [];
    const report = createSpawnFailureReporter(
      (text) => written.push(text),
      () => baseFacts,
    );
    report(
      new Deno.errors.NotCapable(
        `Requires run access to "${join(locked, "program")}"`,
      ),
    );
    assertEquals(
      written.length,
      1,
      "a path that could not be checked was hidden",
    );
  } finally {
    await Deno.chmod(locked, 0o700);
  }
});
