import { assertEquals } from "@std/assert";
import {
  agentOfCapabilities,
  enrollmentInput,
  environmentValue,
  harnessRepositorySetting,
  initialAnswers,
  installState,
  minutesLeft,
  parsedSlots,
  saveSetupCodeCommand,
  startWorkerCommand,
  systemProblems,
  workerEnvironment,
} from "../../apps/web/src/pages/machine-wizard.ts";

// #70 slice 1: the add-a-machine wizard asks three questions and makes one
// enrollment from the answers.

Deno.test("the answers start on the one supported system, valid except for the name and the agent", () => {
  const answers = initialAnswers();
  assertEquals([answers.os, answers.architecture], ["linux", "arm64"]);
  assertEquals(answers.slots, "1");
  assertEquals(answers.agent, null);
  assertEquals(systemProblems(answers), ["nameRequired"]);
});

Deno.test("the first step refuses an empty or oversized name and any slots but a whole number from 1 to 100", () => {
  const ok = { ...initialAnswers(), name: "build-mac-01" };
  assertEquals(systemProblems(ok), []);
  assertEquals(systemProblems({ ...ok, name: "   " }), ["nameRequired"]);
  assertEquals(systemProblems({ ...ok, name: "x".repeat(201) }), [
    "nameTooLong",
  ]);
  assertEquals(systemProblems({ ...ok, name: "x".repeat(200) }), []);
  for (
    const slots of ["", "0", "101", "-1", "1.5", "1e2", "abc", " ", "1000"]
  ) {
    assertEquals(parsedSlots(slots), null, JSON.stringify(slots));
    assertEquals(systemProblems({ ...ok, slots }), ["slotsInvalid"]);
  }
  for (
    const [text, value] of [["1", 1], [" 7 ", 7], ["100", 100], [
      "042",
      42,
    ]] as const
  ) {
    assertEquals(parsedSlots(text), value, text);
  }
  assertEquals(systemProblems({ ...ok, name: "", slots: "0" }), [
    "nameRequired",
    "slotsInvalid",
  ]);
});

Deno.test("the enrollment is made only from complete answers, with the capabilities a coding machine needs and the chosen agent", () => {
  const complete = {
    name: "  build-arm-01 ",
    os: "linux" as const,
    architecture: "arm64",
    slots: "2",
    agent: "codex" as const,
  };
  assertEquals(enrollmentInput(complete), {
    name: "build-arm-01",
    os: "linux",
    architecture: "arm64",
    capabilities: ["git", "shell", "web", "model", "codex"],
    slots: 2,
  });
  assertEquals(enrollmentInput({ ...complete, agent: null }), null);
  assertEquals(enrollmentInput({ ...complete, name: "" }), null);
  assertEquals(enrollmentInput({ ...complete, slots: "0" }), null);
  assertEquals(enrollmentInput({ ...complete, architecture: "  " }), null);
  // A system without an installer never makes a setup, whatever else is filled in.
  for (
    const [os, architecture] of [
      ["linux", "x86_64"],
      ["macos", "arm64"],
      ["macos", "x86_64"],
      ["windows", "x86_64"],
    ] as const
  ) {
    assertEquals(
      enrollmentInput({ ...complete, os: os as "linux", architecture }),
      null,
      `${os} ${architecture}`,
    );
  }
});

Deno.test("the worker settings name the machine, its slots and capabilities and exactly the chosen agent's, and never the setup code", () => {
  const answers = {
    name: "ci-linux-02",
    os: "linux" as const,
    architecture: "arm64",
    slots: "3",
  };
  const settings = (agent: "claude" | "codex" | "pi") =>
    workerEnvironment({
      serverUrl: "https://bakery.example",
      input: enrollmentInput({ ...answers, agent })!,
      agent,
    });
  const claude = settings("claude").split("\n");
  assertEquals(claude, [
    "BAKERY_SERVER_URL=https://bakery.example",
    "BAKERY_WORKER_STATE_DIR=/var/lib/bakery/worker",
    "BAKERY_WORKER_ENROLLMENT_TOKEN_FILE=/var/lib/bakery/worker/enrollment-token",
    "BAKERY_WORKER_NAME=ci-linux-02",
    "BAKERY_WORKER_SLOTS=3",
    "BAKERY_WORKER_CAPABILITIES=git,shell,web,model,claude",
    "BAKERY_CLAUDE_HARNESS=1",
    "BAKERY_CLAUDE_HARNESS_REPOSITORY=/workspace/repository",
    "BAKERY_CLAUDE_HARNESS_TIME_LIMIT_MS=120000",
    "BAKERY_CLAUDE_HARNESS_EXECUTABLE=claude",
  ]);
  // One agent only: a worker refuses to start with two harnesses enabled.
  for (
    const [agent, prefix, others] of [
      ["codex", "CODEX", /CLAUDE|BAKERY_PI_/],
      ["pi", "PI", /CLAUDE|CODEX/],
    ] as const
  ) {
    const lines = settings(agent);
    assertEquals(lines.includes(`BAKERY_${prefix}_HARNESS=1`), true, agent);
    assertEquals(others.test(lines), false, agent);
    assertEquals(
      lines.includes(`BAKERY_${prefix}_HARNESS_EXECUTABLE=${agent}`),
      true,
    );
  }
  // The code travels in a file, not in the settings.
  assertEquals(
    /TOKEN=|TOKEN_FD|enrollmentToken/.test(settings("claude")),
    false,
  );
});

Deno.test("a machine name the settings file could misread is quoted so the service reads it back exactly", () => {
  const line = (name: string) =>
    workerEnvironment({
      serverUrl: "https://bakery.example",
      input: enrollmentInput({
        name,
        os: "linux",
        architecture: "arm64",
        slots: "1",
        agent: "claude",
      })!,
      agent: "claude",
    }).split("\n").find((entry) => entry.startsWith("BAKERY_WORKER_NAME="));
  // Plain names stay as they are.
  assertEquals(line("ci-linux-02"), "BAKERY_WORKER_NAME=ci-linux-02");
  // A space, an apostrophe, a double quote, a hash or a trailing backslash.
  assertEquals(line("Alex's box"), 'BAKERY_WORKER_NAME="Alex\'s box"');
  assertEquals(
    line('the "big" one'),
    'BAKERY_WORKER_NAME="the \\"big\\" one"',
  );
  assertEquals(line("build #2"), 'BAKERY_WORKER_NAME="build #2"');
  assertEquals(line("path\\"), 'BAKERY_WORKER_NAME="path\\\\"');
  // Escapes do not pile up: a backslash before a quote keeps both.
  assertEquals(line('a\\"b'), 'BAKERY_WORKER_NAME="a\\\\\\"b"');
  // A line break cannot be in a value.
  assertEquals(environmentValue("one\ntwo"), '"one two"');
});

Deno.test("the setup code is typed into a file only its owner can read, and a Linux worker starts as its service", () => {
  const save = saveSetupCodeCommand();
  assertEquals(save.split("\n"), [
    "mkdir -p /var/lib/bakery/worker",
    "umask 077",
    "cat > /var/lib/bakery/worker/enrollment-token",
  ]);
  // The command names the file, never a code: nothing secret is in it.
  assertEquals(/[A-Za-z0-9_-]{24,}/.test(save.replace(/[\/.]/g, " ")), false);
  assertEquals(
    startWorkerCommand("linux"),
    "sudo systemctl enable --now bakery-worker",
  );
  assertEquals(startWorkerCommand("macos"), null);
});

Deno.test("the repository setting is named per agent", () => {
  assertEquals(
    harnessRepositorySetting("claude"),
    "BAKERY_CLAUDE_HARNESS_REPOSITORY",
  );
  assertEquals(
    harnessRepositorySetting("codex"),
    "BAKERY_CODEX_HARNESS_REPOSITORY",
  );
  assertEquals(harnessRepositorySetting("pi"), "BAKERY_PI_HARNESS_REPOSITORY");
  // The setting the sentence names is the one in the settings block.
  const input = enrollmentInput({
    name: "x",
    os: "linux",
    architecture: "arm64",
    slots: "1",
    agent: "pi",
  })!;
  const settings = workerEnvironment({
    serverUrl: "https://b.example",
    input,
    agent: "pi",
  });
  assertEquals(
    settings.includes(
      `${harnessRepositorySetting("pi")}=/workspace/repository`,
    ),
    true,
  );
});

Deno.test("a machine with no known coding agent gets the settings without any agent's", () => {
  const input = {
    name: "old-box",
    os: "linux" as const,
    architecture: "arm64",
    capabilities: ["git", "shell"],
    slots: 1,
  };
  const lines = workerEnvironment({
    serverUrl: "https://b.example",
    input,
    agent: null,
  }).split("\n");
  assertEquals(lines, [
    "BAKERY_SERVER_URL=https://b.example",
    "BAKERY_WORKER_STATE_DIR=/var/lib/bakery/worker",
    "BAKERY_WORKER_ENROLLMENT_TOKEN_FILE=/var/lib/bakery/worker/enrollment-token",
    "BAKERY_WORKER_NAME=old-box",
    "BAKERY_WORKER_SLOTS=1",
    "BAKERY_WORKER_CAPABILITIES=git,shell",
  ]);
});

Deno.test("an existing enrollment's agent is read back from its capabilities", () => {
  assertEquals(
    agentOfCapabilities(["git", "shell", "web", "model", "codex"]),
    "codex",
  );
  assertEquals(agentOfCapabilities(["git"]), null);
  assertEquals(agentOfCapabilities("claude"), null);
  assertEquals(agentOfCapabilities(null), null);
});

Deno.test("the install step counts whole minutes left and reads the enrollment's state against the clock", () => {
  const now = Date.parse("2026-01-01T00:00:00.000Z");
  assertEquals(minutesLeft("2026-01-01T00:30:00.000Z", now), 30);
  // A page that showed the code a moment late still reads the whole ten minutes,
  // and one that is nearly out never reads zero while it still works.
  assertEquals(minutesLeft("2026-01-01T00:10:00.200Z", now), 10);
  assertEquals(minutesLeft("2026-01-01T00:09:59.000Z", now), 10);
  assertEquals(minutesLeft("2026-01-01T00:00:01.000Z", now), 1);
  assertEquals(minutesLeft("2026-01-01T00:00:00.000Z", now), 0);
  assertEquals(minutesLeft("2025-12-31T23:00:00.000Z", now), 0);
  assertEquals(minutesLeft("not a date", now), 0);
  const live = "2026-01-01T00:30:00.000Z";
  assertEquals(
    installState({ state: "pending", expiresAt: live }, now),
    "waiting",
  );
  assertEquals(
    installState({ state: "consumed", expiresAt: live }, now),
    "connected",
  );
  assertEquals(
    installState({ state: "canceled", expiresAt: live }, now),
    "canceled",
  );
  assertEquals(
    installState({ state: "expired", expiresAt: live }, now),
    "expired",
  );
  // Pending but past its time: expired, whatever the server has not yet marked.
  assertEquals(
    installState(
      { state: "pending", expiresAt: "2025-12-31T23:59:59.000Z" },
      now,
    ),
    "expired",
  );
  // A connected machine stays connected even after the code's time is up.
  assertEquals(
    installState(
      { state: "consumed", expiresAt: "2025-12-31T23:00:00.000Z" },
      now,
    ),
    "connected",
  );
});
