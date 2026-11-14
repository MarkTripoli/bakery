import { assertEquals } from "@std/assert";
import {
  type DockerRun,
  parseLaneStacks,
  sweepLaneStacks,
} from "../../scripts/ci/lane-stacks.ts";

// #246: the compose stacks a lane run left up are removed by the runner, by the
// names its fixtures registered, and by nothing else.

Deno.test("the registry's names are read once each, and a line that is not a compose project of this repository is ignored", () => {
  assertEquals(
    parseLaneStacks(
      [
        "bakery-e2e-review-loop-3fd08dc0",
        "bakery-issue40-inngest-e23b2653",
        "bakery-e2e-review-loop-3fd08dc0",
        "  bakery-e06-turns-ab12cd34  ",
        "",
        "other-project",
        "--all",
        "-v",
        "bakery-x; rm -rf ~",
        "bakery-$(id)",
        "Bakery-upper",
        "bakery-",
        `bakery-${"a".repeat(200)}`,
        "../bakery-x",
      ].join("\n"),
    ),
    [
      "bakery-e2e-review-loop-3fd08dc0",
      "bakery-issue40-inngest-e23b2653",
      "bakery-e06-turns-ab12cd34",
    ],
  );
  assertEquals(parseLaneStacks(""), []);
});

/** A docker that knows the resources of some projects and removes them as asked. */
function fakeDocker(
  state: Record<
    string,
    { containers: string[]; networks: string[]; volumes: string[] }
  >,
  options: { composeRemoves?: boolean; broken?: boolean } = {},
) {
  const calls: string[][] = [];
  const docker: DockerRun = (args) => {
    calls.push([...args]);
    if (options.broken) return Promise.resolve({ code: 127, text: "" });
    const label = args.find((arg) =>
      arg.startsWith("label=com.docker.compose.project=")
    );
    const project = label?.split("=").at(-1);
    if (args[0] === "ps" && project) {
      return Promise.resolve({
        code: 0,
        text: (state[project]?.containers ?? []).join("\n"),
      });
    }
    if (args[0] === "network" && args[1] === "ls" && project) {
      return Promise.resolve({
        code: 0,
        text: (state[project]?.networks ?? []).join("\n"),
      });
    }
    if (args[0] === "volume" && args[1] === "ls" && project) {
      return Promise.resolve({
        code: 0,
        text: (state[project]?.volumes ?? []).join("\n"),
      });
    }
    if (args[0] === "compose") {
      const name = args[args.indexOf("--project-name") + 1]!;
      if (options.composeRemoves !== false && state[name]) {
        state[name] = { containers: [], networks: [], volumes: [] };
      }
      return Promise.resolve({ code: 0, text: "" });
    }
    if (args[0] === "rm") {
      for (const entry of Object.values(state)) {
        entry.containers = entry.containers.filter((id) => !args.includes(id));
      }
    }
    if (args[0] === "network" && args[1] === "rm") {
      for (const entry of Object.values(state)) {
        entry.networks = entry.networks.filter((id) => !args.includes(id));
      }
    }
    if (args[0] === "volume" && args[1] === "rm") {
      for (const entry of Object.values(state)) {
        entry.volumes = entry.volumes.filter((id) => !args.includes(id));
      }
    }
    return Promise.resolve({ code: 0, text: "" });
  };
  return { docker, calls };
}

Deno.test("a registered project with something left is removed by name; one already torn down is not touched", async () => {
  const { docker, calls } = fakeDocker({
    "bakery-issue40-inngest-a": {
      containers: ["c1", "c2"],
      networks: ["n1"],
      volumes: ["v1"],
    },
    "bakery-e2e-b": { containers: [], networks: [], volumes: [] },
  });
  const swept = await sweepLaneStacks(
    ["bakery-issue40-inngest-a", "bakery-e2e-b"],
    docker,
  );
  assertEquals(swept, { removed: ["bakery-issue40-inngest-a"], failed: [] });
  // Compose is asked to take down the one with something left, and never the other.
  const downs = calls.filter((call) => call[0] === "compose");
  assertEquals(downs.length, 1);
  assertEquals(downs[0], [
    "compose",
    "--project-name",
    "bakery-issue40-inngest-a",
    "down",
    "-v",
    "--remove-orphans",
  ]);
});

Deno.test("what compose could not remove goes by id from the project's own label, and a project that cannot be emptied is reported", async () => {
  const stubborn = fakeDocker(
    {
      "bakery-e2e-a": {
        containers: ["created-1"],
        networks: ["net-1"],
        volumes: ["vol-1"],
      },
    },
    { composeRemoves: false },
  );
  assertEquals(
    await sweepLaneStacks(["bakery-e2e-a"], stubborn.docker),
    { removed: ["bakery-e2e-a"], failed: [] },
  );
  assertEquals(
    stubborn.calls.find((call) => call[0] === "rm"),
    ["rm", "-f", "-v", "created-1"],
  );
  assertEquals(
    stubborn.calls.find((call) => call[0] === "network" && call[1] === "rm"),
    ["network", "rm", "net-1"],
  );
  assertEquals(
    stubborn.calls.find((call) => call[0] === "volume" && call[1] === "rm"),
    ["volume", "rm", "-f", "vol-1"],
  );
  // Only ids found under the registered project are ever removed by id.
  const everything = stubborn.calls.flat().filter((arg) =>
    arg.startsWith("label=")
  );
  for (const label of everything) {
    assertEquals(label, "label=com.docker.compose.project=bakery-e2e-a");
  }
  // A docker that cannot be asked leaves the project reported, not silently ignored.
  const broken = fakeDocker({}, { broken: true });
  assertEquals(
    await sweepLaneStacks(["bakery-e2e-a"], broken.docker),
    { removed: [], failed: ["bakery-e2e-a"] },
  );
  // A project that refuses to go is failed, not removed.
  const stuck: DockerRun = (args) =>
    Promise.resolve({
      code: 0,
      text: args[0] === "ps" ? "still-here" : "",
    });
  assertEquals(
    await sweepLaneStacks(["bakery-e2e-a"], stuck),
    { removed: [], failed: ["bakery-e2e-a"] },
  );
});

Deno.test("a stack nobody registered is never touched, whatever else is up", async () => {
  const { docker, calls } = fakeDocker({
    "bakery-e2e-theirs": { containers: ["x"], networks: ["y"], volumes: ["z"] },
    "bakery-e2e-mine": { containers: ["a"], networks: [], volumes: [] },
  });
  assertEquals(
    await sweepLaneStacks(["bakery-e2e-mine"], docker),
    { removed: ["bakery-e2e-mine"], failed: [] },
  );
  for (const call of calls) {
    assertEquals(call.includes("bakery-e2e-theirs"), false, call.join(" "));
    assertEquals(
      call.some((arg) => arg.endsWith("project=bakery-e2e-theirs")),
      false,
      call.join(" "),
    );
  }
  assertEquals(calls.some((call) => call.includes("x")), false);
});
