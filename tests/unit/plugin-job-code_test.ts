import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  isSafeRelativePath,
  materializePluginCode,
  PLUGIN_CODE_MAX_BYTES,
  PLUGIN_CODE_MAX_FILES,
  PluginCodeError,
} from "../../apps/worker/src/plugin-job-code.ts";

/**
 * A plugin job's code is written from bytes that crossed a network (#29,
 * B14.02), so the worker re-checks every path and cap before it writes.
 */

const b64 = (text: string) => btoa(text);

async function inTemp<T>(run: (parent: string) => Promise<T>): Promise<T> {
  const parent = await Deno.makeTempDir({ prefix: "plugin-code-test-" });
  try {
    return await run(parent);
  } finally {
    await Deno.remove(parent, { recursive: true });
  }
}

async function listing(root: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(dir: string) {
    for await (const entry of Deno.readDir(dir)) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory) await walk(path);
      else found.push(path.slice(root.length + 1));
    }
  }
  await walk(root);
  return found.sort();
}

Deno.test("plain relative paths pass; anything that can leave the directory does not", () => {
  for (const good of ["a.js", "jobs/nightly.js", "a/b/c.txt", "é.js"]) {
    assert(isSafeRelativePath(good), good);
  }
  for (
    const bad of [
      "",
      "/etc/passwd",
      "../escape.js",
      "a/../../escape.js",
      "a/./b.js",
      "a//b.js",
      "a/",
      "..",
      ".",
      "a\\b.js",
      "a\0b.js",
      "a\nb.js",
      "x".repeat(501),
    ]
  ) assert(!isSafeRelativePath(bad), JSON.stringify(bad));
});

Deno.test("the files are written readable by the job user, and removing them leaves nothing", () =>
  inTemp(async (parent) => {
    const code = await materializePluginCode({
      entry: "jobs/nightly.js",
      files: [
        { path: "jobs/nightly.js", contentBase64: b64("run()") },
        { path: "lib/util.js", contentBase64: b64("export {}") },
      ],
    }, parent);
    assertEquals(await listing(code.dir), ["jobs/nightly.js", "lib/util.js"]);
    assertEquals(
      await Deno.readTextFile(`${code.dir}/jobs/nightly.js`),
      "run()",
    );
    // Anyone may read and enter; no one but the owner may write.
    assertEquals((await Deno.stat(code.dir)).mode! & 0o777, 0o755);
    assertEquals(
      (await Deno.stat(`${code.dir}/jobs/nightly.js`)).mode! & 0o777,
      0o644,
    );
    await code.remove();
    assertEquals(await listing(parent), []);
    assertEquals([...Deno.readDirSync(parent)].length, 0);
  }));

Deno.test("a hostile or malformed response writes nothing at all", () =>
  inTemp(async (parent) => {
    const ok = { path: "main.js", contentBase64: b64("x") };
    const cases: [string, Parameters<typeof materializePluginCode>[0]][] = [
      ["file_path", {
        entry: "main.js",
        files: [ok, { path: "../x.js", contentBase64: b64("y") }],
      }],
      ["file_path", {
        entry: "main.js",
        files: [ok, { path: "/abs.js", contentBase64: b64("y") }],
      }],
      ["entry_path", { entry: "../main.js", files: [ok] }],
      ["entry_missing", { entry: "other.js", files: [ok] }],
      ["duplicate_path", {
        entry: "main.js",
        files: [ok, { path: "main.js", contentBase64: b64("z") }],
      }],
      ["duplicate_path", {
        entry: "main.js",
        files: [ok, { path: "MAIN.js", contentBase64: b64("z") }],
      }],
      ["file_not_base64", {
        entry: "main.js",
        files: [{ path: "main.js", contentBase64: "not base64!" }],
      }],
      // `atob` alone accepts both of these, so only the strict check refuses them.
      ["file_not_base64", {
        entry: "main.js",
        files: [{ path: "main.js", contentBase64: "YQ" }],
      }],
      ["file_not_base64", {
        entry: "main.js",
        files: [{ path: "main.js", contentBase64: "YQ==\n" }],
      }],
      ["file_count", { entry: "main.js", files: [] }],
      ["too_large", {
        entry: "main.js",
        files: [{
          path: "main.js",
          contentBase64: btoa("a".repeat(PLUGIN_CODE_MAX_BYTES + 1)),
        }],
      }],
      ["file_count", {
        entry: "f0.js",
        files: Array.from({ length: PLUGIN_CODE_MAX_FILES + 1 }, (_, i) => ({
          path: `f${i}.js`,
          contentBase64: b64("x"),
        })),
      }],
    ];
    for (const [reason, response] of cases) {
      const error = await assertRejects(
        () => materializePluginCode(response, parent),
        PluginCodeError,
      );
      assertEquals(error.reason, reason, JSON.stringify(response).slice(0, 60));
      assertEquals([...Deno.readDirSync(parent)].length, 0, reason);
    }
  }));
