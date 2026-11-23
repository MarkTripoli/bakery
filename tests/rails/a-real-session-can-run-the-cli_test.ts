/**
 * A real session can run `bakery` (#404, QA on PR #926).
 *
 * The first version of the session transport asked the environment for the
 * enrolled host's token, the attempt id and the organization. The worker puts
 * none of them there: it gives a session two variables, the address and the path
 * of a credential file, on purpose. So the tests that fed the CLI a hand-built
 * environment all passed while every real session failed at its first command,
 * which is the failure this case exists to make impossible.
 *
 * It spawns the real binary with exactly the map the worker composes — not a
 * copy of it — and lets it reach a stand-in gateway. If a future change needs a
 * third variable, this case fails here rather than in a session.
 */

import { assert, assertEquals } from "@std/assert";
import { join } from "node:path";
import { sessionEnvironment } from "../../apps/worker/src/session-credential-file.ts";

const ROOT = new URL(".", import.meta.url).pathname;
const CLI = join(ROOT, "../../packages/cli/src/main.ts");
const REPO = join(ROOT, "../..");

/**
 * A stand-in gateway, as its own process.
 *
 * The test process itself may not listen (the rails lane grants it no net
 * permission), so the server is a child that may. It prints the port it bound and
 * then answers the listing the CLI asks for.
 */
async function standInGateway(): Promise<
  { url: string; stop: () => Promise<void> }
> {
  const script = await Deno.makeTempFile({ suffix: ".ts" });
  await Deno.writeTextFile(
    script,
    `const server = Deno.serve({ port: 0, hostname: "127.0.0.1" }, (request) => {
       const path = new URL(request.url).pathname;
       if (path === "/v1/session/tools") {
         return new Response(JSON.stringify({ tools: [{
           name: "storageRoots.list",
           method: "GET",
           path: "/v1/storage/roots",
           scope: "files.read",
           readOnly: true,
         }] }), { headers: { "content-type": "application/json" } });
       }
       console.error("unexpected path " + path);
       return new Response(JSON.stringify({ code: "RESOURCE_NOT_FOUND" }), {
         status: 404,
         headers: { "content-type": "application/json" },
       });
     });
     console.log((server.addr as Deno.NetAddr).port);
   `,
  );
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-net", "--quiet", script],
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
  }
  reader.releaseLock();
  const port = text.trim().split("\n")[0];
  if (!/^\d+$/.test(port)) {
    child.kill();
    throw new Error(`the stand-in gateway printed no port: ${text}`);
  }
  return {
    url: `http://127.0.0.1:${port}`,
    async stop() {
      child.kill();
      await child.status;
      await Deno.remove(script);
    },
  };
}

Deno.test("the CLI runs with exactly the environment the worker gives a session", async () => {
  const gateway = await standInGateway();
  const stateDir = await Deno.makeTempDir({ prefix: "bakery-session-env-" });
  try {
    const assignment = {
      attemptId: "11111111-1111-4111-8111-111111111111",
      fence: "7",
      sessionCredential: "session-credential-6f1c9a2b4d8e0f37",
    };
    // What the worker composes, read from the worker's own function rather than
    // restated here: two variables and no host token anywhere.
    const environment = sessionEnvironment(stateDir, gateway.url, assignment);
    assertEquals(Object.keys(environment).sort(), [
      "BAKERY_SESSION_CREDENTIAL_FILE",
      "BAKERY_URL",
    ]);
    const credentialFile = environment.BAKERY_SESSION_CREDENTIAL_FILE;
    await Deno.mkdir(credentialFile.slice(0, credentialFile.lastIndexOf("/")), {
      recursive: true,
      mode: 0o700,
    });
    await Deno.writeTextFile(credentialFile, assignment.sessionCredential);
    await Deno.chmod(credentialFile, 0o600);

    const child = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-read",
        "--allow-env",
        "--allow-net",
        "--allow-write",
        "--quiet",
        CLI,
        "tools",
      ],
      cwd: REPO,
      // Exactly the worker's two variables. Nothing inherited, so a variable
      // that happens to be set on the machine running this test cannot rescue
      // the command.
      env: environment,
      stdout: "piped",
      stderr: "piped",
      clearEnv: true,
    });
    const { code, stdout, stderr } = await child.output();
    const printed = new TextDecoder().decode(stdout);
    const complained = new TextDecoder().decode(stderr);
    assertEquals(code, 0, `${complained}${printed}`);
    assert(
      printed.includes("storageRoots.list"),
      `the tool list did not reach the CLI: ${printed}${complained}`,
    );
    assert(
      !/BAKERY_HOST_TOKEN|BAKERY_ATTEMPT_ID|BAKERY_ORGANIZATION/.test(
        complained,
      ),
      `the CLI asked for a variable the worker never sets: ${complained}`,
    );
  } finally {
    await gateway.stop();
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("a session command that needs the network fails only on the network", async () => {
  // A command with no gateway to talk to must report that, and not a missing
  // setting: the difference is whether the session is misconfigured or the
  // server is unreachable.
  const stateDir = await Deno.makeTempDir({ prefix: "bakery-session-env-" });
  try {
    const credentialFile = join(stateDir, "credential");
    await Deno.writeTextFile(
      credentialFile,
      "session-credential-6f1c9a2b4d8e0f37",
    );
    const child = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-read",
        "--allow-env",
        "--allow-net",
        "--allow-write",
        "--quiet",
        CLI,
        "tools",
      ],
      cwd: REPO,
      env: {
        BAKERY_SESSION_CREDENTIAL_FILE: credentialFile,
        // A port nothing listens on.
        BAKERY_URL: "http://127.0.0.1:9",
      },
      stdout: "piped",
      stderr: "piped",
      clearEnv: true,
    });
    const { code, stdout, stderr } = await child.output();
    const complained = new TextDecoder().decode(stderr);
    assertEquals(code, 1, `${complained}${new TextDecoder().decode(stdout)}`);
    assert(
      !/Set BAKERY_/.test(complained),
      `the CLI reported a missing setting instead of the network: ${complained}`,
    );
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});
