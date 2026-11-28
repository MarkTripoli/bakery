import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  LINK_LINUX_ROOT,
  linkServiceSpec,
  linuxLinkScript,
  macLinkService,
} from "../../packages/worker-bootstrap/src/service-link.ts";
import {
  type ServiceRunner,
  startLinkedService,
} from "../../packages/worker-bootstrap/src/service-start.ts";
import { LinkStepFailed } from "../../packages/worker-bootstrap/src/link.ts";
import type { PairingBinding } from "../../packages/worker-bootstrap/src/pairing.ts";

const BINDING: PairingBinding = {
  version: 1,
  serverOrigin: "https://bakery.example",
  organizationName: "Fixture Org",
  name: "build-box-01",
  os: "linux",
  architecture: "arm64",
  slots: 2,
  capabilities: ["git", "claude"],
  boundAt: "2026-11-28T00:00:00.000Z",
  enrollmentId: "link",
};

const SOURCE = "/home/ana/.local/share/bakery-worker";

function fakeRunner(codes: number[] = []) {
  const runs: (readonly string[])[] = [];
  const files: { path: string; text: string; mode: number }[] = [];
  const directories: string[] = [];
  const removed: string[] = [];
  const runner: ServiceRunner = {
    run: (argv) => {
      runs.push(argv);
      return Promise.resolve(codes.shift() ?? 0);
    },
    writeFile: (path, text, mode) => {
      files.push({ path, text, mode });
      return Promise.resolve();
    },
    makeDirectory: (path) => {
      directories.push(path);
      return Promise.resolve();
    },
    remove: (path) => {
      removed.push(path);
      return Promise.resolve();
    },
  };
  return { runner, runs, files, directories, removed };
}

Deno.test("the Linux service is one sudo script: account, root, worker, settings, unit, start", () => {
  const script = linuxLinkScript(BINDING, SOURCE);
  const lines = script.split("\n");
  assertEquals(lines[0], "set -eu");
  assert(
    script.includes(
      "useradd --system --user-group --home-dir '/var/lib/bakery-worker' --shell /usr/sbin/nologin bakery-worker",
    ),
  );
  assert(
    script.includes(
      `cp -a '${SOURCE}'/releases '${SOURCE}'/current '${SOURCE}/pairing.json' '${SOURCE}/enrollment-token' '/var/lib/bakery-worker'/`,
    ),
  );
  assert(
    script.includes(
      "chown -R bakery-worker:bakery-worker '/var/lib/bakery-worker'",
    ),
  );
  assert(
    script.includes(
      "install -m 0600 -o bakery-worker -g bakery-worker /dev/stdin '/var/lib/bakery-worker/worker.env'",
    ),
  );
  assert(
    script.includes(
      "install -m 0644 -o root -g root /dev/stdin '/etc/systemd/system/bakery-worker.service'",
    ),
  );
  assert(script.includes("BAKERY_SERVER_URL=https://bakery.example"));
  assert(
    script.includes("BAKERY_WORKER_STATE_DIR=/var/lib/bakery-worker/state"),
  );
  assert(script.includes("BAKERY_CLAUDE_HARNESS=1"));
  assert(script.includes("User=bakery-worker"));
  assertEquals(lines.slice(-4), [
    "systemctl daemon-reload",
    "systemctl enable bakery-worker",
    "systemctl restart bakery-worker",
    "",
  ]);
  assert(
    !script.includes("K7QM"),
    "the link code is copied as a file, never written in the script",
  );
});

Deno.test("rerunning the script keeps the worker's registration", () => {
  const script = linuxLinkScript(BINDING, SOURCE);
  assert(!script.includes("registration.json"));
});

Deno.test("a path with a quote stays one shell word", () => {
  const script = linuxLinkScript(BINDING, "/home/o'neil/root");
  assert(script.includes("'/home/o'\\''neil/root'/releases"));
});

Deno.test("a machine with no coding agent gets no harness settings", () => {
  const spec = linkServiceSpec(
    { ...BINDING, capabilities: ["git"] },
    LINK_LINUX_ROOT,
    "bakery-worker",
  );
  assertEquals(
    Object.keys(spec.settings).filter((name) => name.includes("HARNESS")),
    [],
  );
});

Deno.test("on Linux, link runs the script once under sudo and stops on a failure", async () => {
  const ok = fakeRunner();
  await startLinkedService(BINDING, {
    target: "linux",
    root: SOURCE,
    home: "/home/ana",
    uid: 1000,
    username: "ana",
  }, ok.runner);
  assertEquals(ok.runs.length, 1);
  assertEquals(ok.runs[0]!.slice(0, 3), ["sudo", "sh", "-c"]);
  const failed = fakeRunner([1]);
  const error = await assertRejects(
    () =>
      startLinkedService(BINDING, {
        target: "linux",
        root: SOURCE,
        home: "/home/ana",
        uid: 1000,
        username: "ana",
      }, failed.runner),
    LinkStepFailed,
  );
  assertEquals(error.log, `${SOURCE}/service.log`);
});

Deno.test("on macOS, link writes the LaunchAgent and loads it in the user's session", async () => {
  const mac = { ...BINDING, os: "macos" as const };
  const fake = fakeRunner([1, 0]);
  await startLinkedService(mac, {
    target: "macos",
    root: "/Users/ana/.local/share/bakery-worker",
    home: "/Users/ana",
    uid: 501,
    username: "ana",
  }, fake.runner);
  const expected = macLinkService(
    mac,
    "/Users/ana/.local/share/bakery-worker",
    "ana",
    "/Users/ana",
    501,
  );
  assertEquals(fake.directories, ["/Users/ana/Library/LaunchAgents"]);
  assertEquals(fake.files, [{
    path: "/Users/ana/Library/LaunchAgents/io.bakery.worker.plist",
    text: expected.plist,
    mode: 0o644,
  }]);
  assertEquals(fake.runs, [
    ["launchctl", "bootout", "gui/501/io.bakery.worker"],
    [
      "launchctl",
      "bootstrap",
      "gui/501",
      "/Users/ana/Library/LaunchAgents/io.bakery.worker.plist",
    ],
  ]);
  assert(!fake.runs.some((argv) => argv[0] === "sudo"));
  const refused = fakeRunner([0, 5]);
  await assertRejects(
    () =>
      startLinkedService(mac, {
        target: "macos",
        root: "/Users/ana/.local/share/bakery-worker",
        home: "/Users/ana",
        uid: 501,
        username: "ana",
      }, refused.runner),
    LinkStepFailed,
  );
});

Deno.test("a Linux repair checks the machine id before it changes anything, then drops the registration", () => {
  const host = "6c1f0c1e-4b0e-4c55-9a59-3c3e8f6b1a01";
  const lines = linuxLinkScript(BINDING, SOURCE, host).split("\n");
  assertEquals(lines[0], "set -eu");
  assertEquals(
    lines[1],
    `grep -Eqs '"workerHostId" *: *"${host}"' '/var/lib/bakery-worker/state/registration.json' || exit 3`,
  );
  const drop = lines.indexOf(
    "rm -f '/var/lib/bakery-worker/state/registration.json'",
  );
  const copy = lines.findIndex((line) => line.startsWith("cp -a "));
  assert(drop > copy && copy > 1);
  assert(!linuxLinkScript(BINDING, SOURCE).includes("registration.json"));
});

Deno.test("a Linux repair for another machine stops with its own words", async () => {
  const fake = fakeRunner([3]);
  const error = await assertRejects(
    () =>
      startLinkedService(
        BINDING,
        {
          target: "linux",
          root: SOURCE,
          home: "/home/ana",
          uid: 1000,
          username: "ana",
        },
        fake.runner,
        "0b2d6f43-5c1e-4f8e-8d2a-7e9a1c4b2f02",
      ),
    LinkStepFailed,
  );
  assert(error.message.includes("another machine"));
});

Deno.test("a macOS repair drops the old registration from the user's root", async () => {
  const fake = fakeRunner([0, 0]);
  await startLinkedService(
    { ...BINDING, os: "macos" },
    {
      target: "macos",
      root: "/Users/ana/.local/share/bakery-worker",
      home: "/Users/ana",
      uid: 501,
      username: "ana",
    },
    fake.runner,
    "6c1f0c1e-4b0e-4c55-9a59-3c3e8f6b1a01",
  );
  assertEquals(fake.removed, [
    "/Users/ana/.local/share/bakery-worker/state/registration.json",
  ]);
});
