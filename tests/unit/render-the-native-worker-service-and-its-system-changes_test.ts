import { assert, assertEquals, assertFalse } from "@std/assert";
import {
  BootstrapError,
  describeChanges,
  environmentFilePath,
  environmentFileText,
  planLinuxService,
  planMacService,
  renderLaunchAgent,
  renderSystemdUnit,
  type ServiceSpec,
  workerPath,
} from "../../packages/worker-bootstrap/src/index.ts";

// #18 slice 3: the native service definitions as text, and the exact system
// changes installing them would make. Nothing here touches the machine.

const ROOT = "/var/lib/bakery-worker";
const spec = (overrides: Partial<ServiceSpec> = {}): ServiceSpec => ({
  root: ROOT,
  account: "bakery-worker",
  settings: {
    BAKERY_SERVER_URL: "https://bakery.example",
    BAKERY_WORKER_ENROLLMENT_TOKEN_FILE: `${ROOT}/enrollment-token`,
    BAKERY_WORKER_NAME: "build-linux-01",
    BAKERY_WORKER_SLOTS: "2",
  },
  ...overrides,
});

function refusal(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    assert(error instanceof BootstrapError, `a BootstrapError, got ${error}`);
    return error.code;
  }
  return "accepted";
}

Deno.test("the unit runs the worker by absolute path as a dedicated account, from an owner-only settings file", () => {
  assertEquals(
    renderSystemdUnit(spec()),
    [
      "[Unit]",
      "Description=Bakery native worker",
      "After=network-online.target",
      "Wants=network-online.target",
      "",
      "[Service]",
      "User=bakery-worker",
      "Group=bakery-worker",
      "EnvironmentFile=/var/lib/bakery-worker/worker.env",
      "ExecStart=/var/lib/bakery-worker/current/bakery-worker",
      "WorkingDirectory=/var/lib/bakery-worker",
      "Restart=on-failure",
      "RestartSec=3",
      "TimeoutStopSec=45",
      "KillMode=control-group",
      "Delegate=memory pids",
      "DelegateSubgroup=supervisor",
      "UMask=0077",
      "NoNewPrivileges=yes",
      "",
      "[Install]",
      "WantedBy=multi-user.target",
      "",
    ].join("\n"),
  );
  assertEquals(
    workerPath(ROOT),
    "/var/lib/bakery-worker/current/bakery-worker",
  );
  assertEquals(environmentFilePath(ROOT), "/var/lib/bakery-worker/worker.env");
});

Deno.test("the unit keeps every hardening and lifecycle line of the production unit it mirrors", async () => {
  const production = await Deno.readTextFile(
    new URL(
      "../../infra/production/systemd/bakery-worker.service",
      import.meta.url,
    ),
  );
  const rendered = renderSystemdUnit(spec());
  for (
    const key of [
      "Restart",
      "RestartSec",
      "TimeoutStopSec",
      "KillMode",
      "Delegate",
      "DelegateSubgroup",
      "UMask",
      "NoNewPrivileges",
    ]
  ) {
    const wanted = new RegExp(`^${key}=(.*)$`, "m").exec(production);
    const got = new RegExp(`^${key}=(.*)$`, "m").exec(rendered);
    assert(wanted, `the production unit has ${key}`);
    assertEquals(got?.[1], wanted[1], key);
  }
});

Deno.test("a path, account or setting that could break out of the definition is refused before anything is rendered", () => {
  const roots = [
    "relative/root",
    "/opt/bakery worker",
    "/opt/x\nExecStart=/bin/sh",
    "/opt/x%h",
    "/opt/x$HOME",
    '/opt/"x"',
    "/opt/../etc",
    "/opt/x;rm",
    "",
    `/${"a".repeat(250)}`,
  ];
  for (const root of roots) {
    assertEquals(
      refusal(() => renderSystemdUnit(spec({ root }))),
      "SERVICE_SPEC_INVALID",
      JSON.stringify(root),
    );
    assertEquals(
      refusal(() => renderLaunchAgent(spec({ root }))),
      "SERVICE_SPEC_INVALID",
    );
    assertEquals(
      refusal(() => planLinuxService(spec({ root }))),
      "SERVICE_SPEC_INVALID",
    );
  }
  for (
    const account of [
      "Root",
      "9lives",
      "bakery worker",
      "root\nUser=0",
      "a".repeat(33),
      "a/b",
      "",
    ]
  ) {
    assertEquals(
      refusal(() => renderSystemdUnit(spec({ account }))),
      "SERVICE_SPEC_INVALID",
      JSON.stringify(account),
    );
  }
  const tokenSettings = [
    "BAKERY_WORKER_ENROLLMENT_TOKEN",
    "BAKERY_ENROLLMENT_TOKEN",
    "BAKERY_WORKER_ENROLLMENT_TOKEN_FD",
  ];
  for (const name of tokenSettings) {
    assertEquals(
      refusal(() =>
        environmentFileText(spec({ settings: { [name]: "bk_setup_secret" } }))
      ),
      "SERVICE_SETTING_REFUSED",
      name,
    );
    assertEquals(
      refusal(() =>
        renderLaunchAgent(spec({ settings: { [name]: "bk_setup_secret" } }))
      ),
      "SERVICE_SETTING_REFUSED",
    );
  }
  for (
    const settings of [
      { lowercase: "x" },
      { NOT_BAKERY: "x" },
      { BAKERY_X: "a\u0000b" },
      { BAKERY_X: "a\u001bb" },
      { BAKERY_X: "a\u007fb" },
      { BAKERY_X: "x".repeat(5000) },
      { "BAKERY_X\nBAKERY_Y": "x" },
    ]
  ) {
    assertEquals(
      refusal(() => environmentFileText(spec({ settings }))),
      "SERVICE_SETTING_REFUSED",
      JSON.stringify(settings).slice(0, 40),
    );
  }
});

Deno.test("the settings file is sorted, one per line, and a value that needs quoting is quoted so the service reads it back exactly", () => {
  assertEquals(
    environmentFileText(spec()),
    [
      "BAKERY_SERVER_URL=https://bakery.example",
      "BAKERY_WORKER_ENROLLMENT_TOKEN_FILE=/var/lib/bakery-worker/enrollment-token",
      "BAKERY_WORKER_NAME=build-linux-01",
      "BAKERY_WORKER_SLOTS=2",
      "",
    ].join("\n"),
  );
  assertEquals(
    environmentFileText(
      spec({
        settings: {
          BAKERY_B: "Alex's box",
          BAKERY_A: 'the "big" one',
          BAKERY_C: "path\\",
          BAKERY_D: "two\nlines",
          BAKERY_E: "build #2",
        },
      }),
    ),
    [
      'BAKERY_A="the \\"big\\" one"',
      `BAKERY_B="Alex's box"`,
      'BAKERY_C="path\\\\"',
      'BAKERY_D="two lines"',
      'BAKERY_E="build #2"',
      "",
    ].join("\n"),
  );
});

Deno.test("the LaunchAgent runs in the user's session, restarts only after a failure, and escapes what it is given", () => {
  const plist = renderLaunchAgent(
    spec({
      root: "/Users/operator/bakery-worker",
      account: "operator",
      settings: {
        BAKERY_WORKER_NAME: `<Alex & "Co"> 'box'`,
        BAKERY_WORKER_SLOTS: "2",
      },
    }),
  );
  assert(plist.includes("<string>io.bakery.worker</string>"));
  assert(
    plist.includes(
      "<string>/Users/operator/bakery-worker/current/bakery-worker</string>",
    ),
  );
  assert(plist.includes("<key>RunAtLoad</key>\n    <true/>"));
  assert(plist.includes("<key>SuccessfulExit</key>\n      <false/>"));
  assert(plist.includes("<key>Umask</key>\n    <integer>63</integer>"));
  // The name with markup in it is data, not structure.
  assert(
    plist.includes(
      "<string>&lt;Alex &amp; &quot;Co&quot;&gt; &apos;box&apos;</string>",
    ),
  );
  assertFalse(plist.includes("<Alex"));
  // The code is never in it.
  assertFalse(/enrollment.?token/i.test(plist));
  assert(plist.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  assert(plist.trimEnd().endsWith("</plist>"));
});

Deno.test("the Linux plan names every change in order and who makes it: the administrator only for the account, the unit and the service", () => {
  const plan = planLinuxService(spec());
  assertEquals(plan.map((change) => change.actor), [
    "administrator",
    "administrator",
    "service-account",
    "service-account",
    "administrator",
    "administrator",
    "administrator",
  ]);
  assertEquals(plan[0]!.command, [
    "useradd",
    "--system",
    "--user-group",
    "--home-dir",
    ROOT,
    "--shell",
    "/usr/sbin/nologin",
    "bakery-worker",
  ]);
  assertEquals(plan[1]!.command, [
    "install",
    "--directory",
    "--owner",
    "bakery-worker",
    "--group",
    "bakery-worker",
    "--mode",
    "0700",
    ROOT,
  ]);
  assertEquals(plan[3]!.file, {
    path: `${ROOT}/worker.env`,
    mode: "0600",
    owner: "bakery-worker",
  });
  assertEquals(plan[4]!.file, {
    path: "/etc/systemd/system/bakery-worker.service",
    mode: "0644",
    owner: "root",
  });
  assertEquals(plan[5]!.command, ["systemctl", "daemon-reload"]);
  assertEquals(plan[6]!.command, [
    "systemctl",
    "enable",
    "--now",
    "bakery-worker",
  ]);
  // Pairing is done by the service account, and never with a code on a command line.
  const pairing = plan[2]!.command!;
  assertEquals(pairing.slice(0, 2), ["bakery-worker", "setup"]);
  assertFalse(pairing.some((word) => /token|bk_setup/i.test(word)));
  // No change is a `sudo` anything: the operator decides how to be an administrator.
  for (const change of plan) {
    assertFalse((change.command ?? []).includes("sudo"));
  }
});

Deno.test("the macOS plan needs no administrator: the user's own agent, loaded into the user's session", () => {
  const plan = planMacService(
    spec({ root: "/Users/operator/bakery-worker", account: "operator" }),
    "/Users/operator",
    501,
  );
  assertEquals(plan.map((change) => change.actor), ["user", "user"]);
  assertEquals(plan[0]!.file, {
    path: "/Users/operator/Library/LaunchAgents/io.bakery.worker.plist",
    mode: "0644",
    owner: "operator",
  });
  assertEquals(plan[1]!.command, [
    "launchctl",
    "bootstrap",
    "gui/501",
    "/Users/operator/Library/LaunchAgents/io.bakery.worker.plist",
  ]);
  assertEquals(
    refusal(() => planMacService(spec(), "relative", 501)),
    "SERVICE_SPEC_INVALID",
  );
  assertEquals(
    refusal(() => planMacService(spec(), "/Users/o p", 501)),
    "SERVICE_SPEC_INVALID",
  );
  assertEquals(
    refusal(() => planMacService(spec(), "/Users/o", -1)),
    "SERVICE_SPEC_INVALID",
  );
  assertEquals(
    refusal(() => planMacService(spec(), "/Users/o", 1.5)),
    "SERVICE_SPEC_INVALID",
  );
});

Deno.test("the changes are shown as numbered text, with the actor and the exact command or file", () => {
  assertEquals(
    describeChanges(planLinuxService(spec())),
    [
      "1. [administrator] Create the dedicated account bakery-worker (no login shell).",
      "     $ useradd --system --user-group --home-dir /var/lib/bakery-worker --shell /usr/sbin/nologin bakery-worker",
      "2. [administrator] Create the install root, owned by bakery-worker and private to it.",
      "     $ install --directory --owner bakery-worker --group bakery-worker --mode 0700 /var/lib/bakery-worker",
      "3. [service-account] Install the verified worker and pair it, as bakery-worker (never as root).",
      "     $ bakery-worker setup --server <your Bakery address> --root /var/lib/bakery-worker",
      "4. [service-account] Write the worker's non-secret settings, readable by its owner only.",
      "     file /var/lib/bakery-worker/worker.env (mode 0600, owner bakery-worker)",
      "5. [administrator] Install the service definition.",
      "     file /etc/systemd/system/bakery-worker.service (mode 0644, owner root)",
      "6. [administrator] Make systemd read the new definition.",
      "     $ systemctl daemon-reload",
      "7. [administrator] Start the worker now and at every boot.",
      "     $ systemctl enable --now bakery-worker",
      "",
    ].join("\n"),
  );
});

Deno.test("the service module renders text and plans changes only: no file system, no process, no sudo", async () => {
  const source = await Deno.readTextFile(
    new URL("../../packages/worker-bootstrap/src/service.ts", import.meta.url),
  );
  // Strip comments: the module says "sudo" only to say it never runs it.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(
    /^\s*\/\/.*$/gm,
    "",
  );
  assertFalse(
    /node:fs|node:child_process|Deno\.(Command|run|writeFile|writeTextFile|mkdir|remove)|process\.(env|exit)/
      .test(code),
  );
  assertFalse(/sudo/.test(code.replace(/"sudo"/g, "")));
});
