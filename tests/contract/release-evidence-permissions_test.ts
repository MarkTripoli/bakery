import { assert, assertEquals } from "@std/assert";

Deno.test(
  "production GitHub client strips authorization across a real local redirect",
  async () => {
    const apiAuthorizations: (string | null)[] = [];
    const cdnAuthorizations: (string | null)[] = [];
    const root = await Deno.makeTempDir();
    const script = `${root}/redirect-probe.ts`;
    const moduleUrl = new URL(
      "../../scripts/ci/release-evidence.ts",
      import.meta.url,
    ).href;
    const cdn = Deno.serve(
      { hostname: "127.0.0.1", port: 0 },
      (request) => {
        // Only the expected path is recorded: these servers listen on
        // random loopback ports a parallel test may also probe.
        if (new URL(request.url).pathname === "/private-asset.zip") {
          cdnAuthorizations.push(request.headers.get("authorization"));
          return new Response("private archive");
        }
        return new Response("not found", { status: 404 });
      },
    );
    const cdnOrigin = `http://127.0.0.1:${(cdn.addr as Deno.NetAddr).port}`;
    const api = Deno.serve(
      { hostname: "127.0.0.1", port: 0 },
      (request) => {
        if (
          new URL(request.url).pathname ===
            "/repos/owner/repo/releases/assets/581594789"
        ) {
          apiAuthorizations.push(request.headers.get("authorization"));
          return Response.redirect(`${cdnOrigin}/private-asset.zip`, 302);
        }
        return new Response("not found", { status: 404 });
      },
    );
    const apiOrigin = `http://127.0.0.1:${(api.addr as Deno.NetAddr).port}`;
    await Deno.writeTextFile(
      script,
      `
import { githubApiFromEnv } from ${JSON.stringify(moduleUrl)};
const expectDenied = Deno.env.get("EXPECT_DENIED") === "1";
try {
  const response = await githubApiFromEnv({
    apiOrigin: Deno.env.get("API_ORIGIN") ?? "",
  }).request("/releases/assets/581594789");
  if (expectDenied) {
    throw new Error("redirect unexpectedly succeeded without CDN grant");
  }
  if (!response.ok || await response.text() !== "private archive") {
    throw new Error("redirect retrieval returned the wrong archive");
  }
} catch (error) {
  if (!expectDenied || !(error instanceof Deno.errors.NotCapable)) {
    throw error;
  }
  console.error("EXPECTED_NOT_CAPABLE");
  Deno.exit(23);
}
`,
    );
    try {
      const success = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "--no-config",
          "--no-prompt",
          "--allow-env=GITHUB_TOKEN,GITHUB_REPOSITORY,API_ORIGIN,EXPECT_DENIED",
          `--allow-read=${Deno.cwd()},${root}`,
          `--allow-net=127.0.0.1:${(api.addr as Deno.NetAddr).port},127.0.0.1:${
            (cdn.addr as Deno.NetAddr).port
          }`,
          script,
        ],
        env: {
          GITHUB_TOKEN: "token",
          GITHUB_REPOSITORY: "owner/repo",
          API_ORIGIN: apiOrigin,
          EXPECT_DENIED: "0",
        },
        stdout: "piped",
        stderr: "piped",
      }).output();
      assertEquals(
        success.success,
        true,
        new TextDecoder().decode(success.stderr),
      );
      const denied = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "--no-config",
          "--no-prompt",
          "--allow-env=GITHUB_TOKEN,GITHUB_REPOSITORY,API_ORIGIN,EXPECT_DENIED",
          `--allow-read=${Deno.cwd()},${root}`,
          `--allow-net=127.0.0.1:${(api.addr as Deno.NetAddr).port}`,
          script,
        ],
        env: {
          GITHUB_TOKEN: "token",
          GITHUB_REPOSITORY: "owner/repo",
          API_ORIGIN: apiOrigin,
          EXPECT_DENIED: "1",
        },
        stdout: "piped",
        stderr: "piped",
      }).output();
      assertEquals(denied.success, false);
      assert(
        new TextDecoder().decode(denied.stderr).includes(
          "EXPECTED_NOT_CAPABLE",
        ),
      );
      assertEquals(apiAuthorizations, ["Bearer token", "Bearer token"]);
      assertEquals(cdnAuthorizations, [null]);
    } finally {
      await api.shutdown();
      await cdn.shutdown();
      await Deno.remove(root, { recursive: true });
    }
  },
);
