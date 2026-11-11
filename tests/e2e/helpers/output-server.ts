import { z } from "zod";
import { openAuthFixture } from "../../helpers/auth.ts";
import { waitForCondition } from "../../helpers/worker-execution/recovery-support.ts";

const ReadySchema = z.object({
  port: z.number().int().min(1).max(65535).describe(
    "Loopback TCP port owned by the output test server.",
  ),
  pid: z.number().int().positive().describe(
    "Operating-system process identity of this server instance.",
  ),
}).strict().describe(
  "Readiness record for a separately running output test server.",
);

export async function startOutputServer(directory: string) {
  const readyPath = `${directory}/server-${crypto.randomUUID()}.json`;
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-env",
      "--allow-read",
      "--allow-net",
      "--allow-sys=hostname,uid",
      `--allow-write=${directory}`,
      new URL(import.meta.url).pathname,
      readyPath,
    ],
    env: { NODE_ENV: "test" },
    stdout: "null",
    stderr: "inherit",
  }).spawn();
  let exited = false;
  const status = child.status.then((value) => {
    exited = true;
    return value;
  });
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    if (!exited) child.kill("SIGTERM");
    const timer = setTimeout(() => {
      if (!exited) child.kill("SIGKILL");
    }, 5000);
    try {
      await status;
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    let ready: z.output<typeof ReadySchema> | undefined;
    await waitForCondition(
      async () => {
        if (exited) throw new Error("OUTPUT_SERVER_EXITED_BEFORE_READY");
        try {
          ready = ReadySchema.parse(
            JSON.parse(await Deno.readTextFile(readyPath)),
          );
          return true;
        } catch (error) {
          if (error instanceof Deno.errors.NotFound) return false;
          throw error;
        }
      },
      "OUTPUT_SERVER_START_TIMEOUT",
      30_000,
    );
    if (!ready) throw new Error("OUTPUT_SERVER_NOT_READY");
    const { port, pid } = ready;
    return {
      pid,
      stop,
      async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);
        url.hostname = "127.0.0.1";
        url.port = String(port);
        return await fetch(new Request(url, request));
      },
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

if (import.meta.main) {
  const readyPath = Deno.args[0];
  if (!readyPath) throw new Error("OUTPUT_SERVER_READY_PATH_REQUIRED");
  const fixture = await openAuthFixture();
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen: () => {},
  }, (request) => fixture.app.fetch(request));
  const shutdown = () => {
    void server.shutdown();
  };
  Deno.addSignalListener("SIGTERM", shutdown);
  try {
    await Deno.writeTextFile(
      `${readyPath}.tmp`,
      JSON.stringify({ port: server.addr.port, pid: Deno.pid }),
    );
    await Deno.rename(`${readyPath}.tmp`, readyPath);
    await server.finished;
  } finally {
    Deno.removeSignalListener("SIGTERM", shutdown);
    await fixture.close();
  }
}
