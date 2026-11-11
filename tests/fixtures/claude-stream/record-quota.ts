/**
 * Hand-run recorder for the Claude quota fixtures. Never runs in CI.
 *
 *   deno run --allow-all tests/fixtures/claude-stream/record-quota.ts
 *
 * It starts a loopback HTTP stub of `POST /v1/messages` that answers 429
 * (`rate-limit`) or 400 "credit balance is too low" (`billing`), then runs the
 * REAL installed `claude` CLI against it with the adapter's own flags and a
 * synthetic API key, and writes the CLI's stdout verbatim to
 * `quota-<variant>.jsonl` next to this file, with a `quota-<variant>.meta.json`
 * naming the CLI version, exit code and what the recording is.
 *
 * Label: real CLI output against a loopback 429/400 stub; not a real provider
 * quota. A real exhausted-subscription sample needs an exhausted claude.ai plan
 * (owner-gated); no fixture here is hand-edited.
 */
import { join } from "node:path";

const SYNTHETIC_KEY = "sk-ant-api03-SYNTHETIC-RECORDING";
const STUB_MESSAGE = "BAKERY_STUB_MESSAGE";
const here = new URL(".", import.meta.url).pathname;

type Variant = "rate-limit" | "billing";

function stubResponse(variant: Variant): Response {
  if (variant === "rate-limit") {
    return new Response(
      JSON.stringify({
        type: "error",
        error: {
          type: "rate_limit_error",
          message: `This request would exceed your rate limit. ${STUB_MESSAGE}`,
        },
      }),
      {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "0" },
      },
    );
  }
  return new Response(
    JSON.stringify({
      type: "error",
      error: {
        type: "invalid_request_error",
        message:
          `Your credit balance is too low to access the Anthropic API. ${STUB_MESSAGE}`,
      },
    }),
    { status: 400, headers: { "content-type": "application/json" } },
  );
}

async function run(
  args: string[],
  env: Record<string, string>,
  stdin: string,
  cwd: string,
): Promise<{ code: number; stdout: string }> {
  const child = new Deno.Command("claude", {
    args,
    env,
    clearEnv: true,
    cwd,
    stdin: "piped",
    stdout: "piped",
    stderr: "null",
  }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(stdin));
  await writer.close();
  const output = await child.output();
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout),
  };
}

async function record(variant: Variant): Promise<void> {
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    async (request) => {
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/v1/messages") {
        await request.arrayBuffer();
        return stubResponse(variant);
      }
      return new Response("{}", {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    },
  );
  const scratch = await Deno.makeTempDir({ prefix: "bakery-claude-quota-" });
  try {
    const home = join(scratch, "home");
    const config = join(scratch, "config");
    const work = join(scratch, "work");
    for (const dir of [home, config, work]) await Deno.mkdir(dir);
    const version = new TextDecoder().decode(
      (await new Deno.Command("claude", {
        args: ["--version"],
        stdout: "piped",
      }).output()).stdout,
    ).trim();
    const result = await run(
      [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--restricted",
        "--tools",
        "Read",
      ],
      {
        PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
        HOME: home,
        CLAUDE_CONFIG_DIR: config,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.addr.port}`,
        ANTHROPIC_API_KEY: SYNTHETIC_KEY,
        CLAUDE_CODE_MAX_RETRIES: "1",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      },
      "Reply with the single word ready.",
      work,
    );
    if (result.stdout.includes(SYNTHETIC_KEY)) {
      throw new Error("RECORDING_CONTAINS_SYNTHETIC_KEY");
    }
    const base = join(here, `quota-${variant}`);
    await Deno.writeTextFile(`${base}.jsonl`, result.stdout);
    await Deno.writeTextFile(
      `${base}.meta.json`,
      JSON.stringify(
        {
          cliVersion: version,
          exitCode: result.code,
          recordedAt: new Date().toISOString(),
          variant,
          stubMessageMarker: STUB_MESSAGE,
          label:
            "real CLI output against a loopback 429/400 stub; not a real provider quota",
        },
        null,
        2,
      ) + "\n",
    );
    console.log(
      `recorded ${variant}: exit ${result.code}, ${
        result.stdout.split("\n").filter(Boolean).length
      } lines`,
    );
  } finally {
    await server.shutdown();
    await Deno.remove(scratch, { recursive: true });
  }
}

for (const variant of ["rate-limit", "billing"] as const) await record(variant);
