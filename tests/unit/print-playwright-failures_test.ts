import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "node:path";
import {
  MAX_FAILED_TESTS,
  PER_FILE_BYTES,
  render,
  TOTAL_BYTES,
} from "../../scripts/ci/print-playwright-failures.mjs";

// Candidate CI is artifact-free, so a red Playwright job prints the page
// snapshot of each failed test into its log. These tests pin what is printed,
// how much, and that page content can never act as a runner command.

async function withResults(
  run: (root: string) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "pw-results-" });
  try {
    await run(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

async function failedTest(
  root: string,
  name: string,
  snapshot: string,
  extra: Record<string, string> = {},
): Promise<void> {
  await Deno.mkdir(join(root, name));
  await Deno.writeTextFile(join(root, name, "error-context.md"), snapshot);
  for (const [file, content] of Object.entries(extra)) {
    await Deno.writeTextFile(join(root, name, file), content);
  }
}

/** Every line the runner would read as a workflow command. */
const commandLines = (text: string) =>
  text.split("\n").filter((line) => /^(::|##\[)/.test(line));

Deno.test("only failed tests are printed, each with its snapshot and the files beside it", async () => {
  await withResults(async (root) => {
    await failedTest(root, "b-failed", "- heading 'Not found'", {
      "trace.zip": "x".repeat(4096),
    });
    await failedTest(root, "a-failed", "- region 'Loading'");
    await Deno.mkdir(join(root, "c-passed"));
    await Deno.writeTextFile(join(root, "c-passed", "video.webm"), "v");
    const text = render(root);
    assertStringIncludes(text, "2 failed test(s) left a page snapshot");
    assertStringIncludes(text, "- heading 'Not found'");
    assertStringIncludes(text, "- region 'Loading'");
    assertStringIncludes(text, "trace.zip 4 KiB");
    assert(!text.includes("c-passed"), "a test without a snapshot was printed");
    assert(
      text.indexOf("a-failed") < text.indexOf("b-failed"),
      "failed tests are not in name order",
    );
  });
});

Deno.test("a snapshot larger than the per-file limit is cut and says how much was left out", async () => {
  await withResults(async (root) => {
    await failedTest(root, "big", "Q".repeat(PER_FILE_BYTES + 5000));
    const text = render(root);
    assertEquals(text.split("Q").length - 1, PER_FILE_BYTES);
    assertStringIncludes(text, "[truncated: 5000 of 21384 bytes not printed]");
  });
});

Deno.test("the total printed is bounded and the tests left out are counted", async () => {
  await withResults(async (root) => {
    const count = MAX_FAILED_TESTS + 5;
    for (let index = 0; index < count; index += 1) {
      await failedTest(
        root,
        `t${String(index).padStart(3, "0")}`,
        "Q".repeat(PER_FILE_BYTES),
      );
    }
    const text = render(root);
    const printed = text.split("Q").length - 1;
    assert(printed <= TOTAL_BYTES, `printed ${printed} bytes of snapshots`);
    const groups = text.split("::group::").length - 1;
    assertEquals(
      groups,
      Math.min(MAX_FAILED_TESTS, TOTAL_BYTES / PER_FILE_BYTES),
    );
    assertStringIncludes(
      text,
      `${count - groups} more failed test(s) not printed`,
    );
  });
});

Deno.test("the number of tests printed is bounded even when every snapshot is small", async () => {
  await withResults(async (root) => {
    const count = MAX_FAILED_TESTS + 3;
    for (let index = 0; index < count; index += 1) {
      await failedTest(root, `s${String(index).padStart(3, "0")}`, "small");
    }
    const text = render(root);
    assertEquals(text.split("::group::").length - 1, MAX_FAILED_TESTS);
    assertStringIncludes(text, "3 more failed test(s) not printed");
  });
});

Deno.test("page content cannot act as a runner command, and control characters are removed", async () => {
  await withResults(async (root) => {
    await failedTest(
      root,
      "hostile",
      [
        "::add-mask::secret",
        "::stop-commands::token",
        "##[error]forged",
        "plain",
        "esc \u001b[31mred\u001b[0m and \u0007 bell and del \u007f and cr\rX",
      ].join("\n"),
    );
    const text = render(root);
    assertEquals(
      commandLines(text),
      ["::group::hostile (error-context.md 1 KiB)", "::endgroup::"],
      "only the group markers this tool writes may start a line with a command",
    );
    assert(
      ![...text].some((character) => {
        const code = character.codePointAt(0)!;
        return code < 9 || (code > 10 && code < 32) || code === 127;
      }),
      "a control character reached the log",
    );
    assertStringIncludes(text, "  ::add-mask::secret");
  });
});

Deno.test("a name from the filesystem cannot break out of its log line", async () => {
  await withResults(async (root) => {
    await failedTest(root, "a\n::error::boom", "snapshot");
    const text = render(root);
    assertEquals(commandLines(text).length, 2);
    assertStringIncludes(text, "a???error??boom");
  });
});

Deno.test("a symlinked snapshot or directory is never read", async () => {
  await withResults(async (root) => {
    const outside = await Deno.makeTempDir({ prefix: "pw-outside-" });
    try {
      await Deno.writeTextFile(join(outside, "secret.txt"), "TOP-SECRET-VALUE");
      await Deno.mkdir(join(outside, "other"));
      await Deno.writeTextFile(
        join(outside, "other", "error-context.md"),
        "TOP-SECRET-DIR",
      );
      await Deno.mkdir(join(root, "linked-file"));
      await Deno.symlink(
        join(outside, "secret.txt"),
        join(root, "linked-file", "error-context.md"),
      );
      await Deno.symlink(join(outside, "other"), join(root, "linked-dir"));
      const text = render(root);
      assert(!text.includes("TOP-SECRET"), "a symlink target was printed");
      assertStringIncludes(text, "No failed test left a page snapshot");
    } finally {
      await Deno.remove(outside, { recursive: true });
    }
  });
});

Deno.test("a missing or empty results directory is reported, not an error", async () => {
  assertStringIncludes(
    render("/nonexistent/playwright-results"),
    "No Playwright results directory",
  );
  await withResults((root) => {
    assertStringIncludes(render(root), "No failed test left a page snapshot");
    return Promise.resolve();
  });
});

Deno.test("the command line prints the diagnostics and exits 0, whatever the directory", async () => {
  const script =
    new URL("../../scripts/ci/print-playwright-failures.mjs", import.meta.url)
      .pathname;
  await withResults(async (root) => {
    await failedTest(root, "cli", "- text: from the command line");
    for (const dir of [root, "/nonexistent/playwright-results"]) {
      const result = await new Deno.Command("node", {
        args: [script, dir],
        stdout: "piped",
        stderr: "piped",
      }).output();
      assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
      const out = new TextDecoder().decode(result.stdout);
      assert(out.length > 0, "nothing was printed");
      if (dir === root) assertStringIncludes(out, "from the command line");
    }
  });
});
