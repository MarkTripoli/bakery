import { assertEquals } from "@std/assert";

export async function assertRunOutputState(options: {
  baseUrl: string;
  organizationId: string;
  taskId: string;
  sessionCookie: string;
  state: string;
  evidenceDir: string;
}): Promise<void> {
  const child = new Deno.Command("node", {
    args: ["apps/web/tests/helpers/run-output-parity-browser.mjs"],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(JSON.stringify({
    baseUrl: options.baseUrl,
    fixtureIds: {
      organizationId: options.organizationId,
      taskId: options.taskId,
    },
    sessionCookie: options.sessionCookie,
    state: options.state,
    evidenceDir: options.evidenceDir,
  })));
  await writer.close();
  const [status, stderr] = await Promise.all([
    child.status,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  assertEquals(
    status.code,
    0,
    `Production run state failed (${options.state}): ${stderr}`,
  );
  console.log(`PRODUCTION_RUN_STATE=${options.state}:passed`);
}
