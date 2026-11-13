import { closeSync, lstatSync, openSync, readdirSync, readSync } from "node:fs";
import { join, resolve } from "node:path";
import { argv } from "node:process";
import { fileURLToPath } from "node:url";

/**
 * Prints what Playwright left for each failed browser test into the job log.
 *
 * Candidate CI is artifact-free (docs/technical-design/ci-evidence-storage.md):
 * evidence travels in job logs, so a red browser job has nothing to download.
 * The page snapshot Playwright writes beside a failed test (`error-context.md`)
 * is small text and says what was on screen, which is usually the question. The
 * binary files (screenshots, traces, video) stay on the runner and are only
 * listed.
 *
 * The snapshot is page content, so it is untrusted: every printed line is
 * indented, which keeps a line such as `::add-mask::` or `##[error]` from being
 * read by the runner as a workflow command. Only regular files are read, never
 * through a symlink, each bounded, and the whole print is bounded. Diagnostics
 * never change a job's result: the CLI exits 0.
 */

/** The most of one snapshot that is printed. */
export const PER_FILE_BYTES = 16 * 1024;
/**
 * The most snapshot text printed in one run, across all failed tests. Printing
 * stops once it is reached, so it is the limit when it is a whole number of
 * `PER_FILE_BYTES` snapshots, as it is now; otherwise one snapshot may end past it.
 */
export const TOTAL_BYTES = 192 * 1024;
/** The most failed tests whose snapshot is printed. */
export const MAX_FAILED_TESTS = 25;

const CONTEXT_FILE = "error-context.md";
/** Whether a character code is a control character other than tab and newline. */
const isControl = (code) =>
  code < 9 || (code > 10 && code < 32) || code === 127;

/** A name or path that is safe to put on a log line of its own. */
const label = (name) => name.replace(/[^A-Za-z0-9._ /-]/g, "?");

/** Indents every line and replaces control characters, so no line can be a command. */
const neutralize = (text) =>
  text
    .split(/\r\n|\n|\r/)
    .map((line) =>
      `  ${
        Array.from(
          line,
          (character) => isControl(character.codePointAt(0)) ? "?" : character,
        ).join("")
      }`
    )
    .join("\n");

const regularFileSize = (path) => {
  try {
    const info = lstatSync(path);
    return info.isFile() ? info.size : null;
  } catch {
    return null;
  }
};

/** At most `limit` bytes from the start of a regular file, and its full size. */
function readHead(path, limit) {
  const size = regularFileSize(path);
  if (size === null) return null;
  const buffer = Buffer.alloc(Math.min(size, limit));
  const descriptor = openSync(path, "r");
  try {
    const read = readSync(descriptor, buffer, 0, buffer.length, 0);
    return { size, text: buffer.subarray(0, read).toString("utf8") };
  } finally {
    closeSync(descriptor);
  }
}

const kib = (bytes) => `${Math.max(1, Math.round(bytes / 1024))} KiB`;

/**
 * The log text for the failed tests under a Playwright output directory: one
 * folded group per failed test, holding its file list and page snapshot.
 *
 * @param {string} root the Playwright `outputDir`
 * @returns {string}
 */
export function render(root) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return `No Playwright results directory at ${
      label(root)
    }; nothing to print.`;
  }
  // A Dirent from readdir reports a symlink as a symlink, never as a directory.
  const failed = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .filter((name) => regularFileSize(join(root, name, CONTEXT_FILE)) !== null);
  if (failed.length === 0) {
    return `No failed test left a page snapshot under ${label(root)}.`;
  }
  const out = [
    `${failed.length} failed test(s) left a page snapshot under ${
      label(root)
    }.`,
  ];
  let printed = 0;
  let shown = 0;
  for (const name of failed) {
    if (shown >= MAX_FAILED_TESTS || printed >= TOTAL_BYTES) break;
    const directory = join(root, name);
    const files = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry) =>
        `${label(entry.name)} ${
          kib(regularFileSize(join(directory, entry.name)) ?? 0)
        }`
      );
    const head = readHead(
      join(directory, CONTEXT_FILE),
      PER_FILE_BYTES,
    );
    if (head === null) continue;
    out.push(`::group::${label(name)} (${files.join(", ")})`);
    out.push(neutralize(head.text));
    if (head.size > Buffer.byteLength(head.text)) {
      out.push(
        `  [truncated: ${
          head.size - Buffer.byteLength(head.text)
        } of ${head.size} bytes not printed]`,
      );
    }
    out.push("::endgroup::");
    printed += Buffer.byteLength(head.text);
    shown += 1;
  }
  if (shown < failed.length) {
    out.push(
      `${
        failed.length - shown
      } more failed test(s) not printed (limit of ${MAX_FAILED_TESTS} tests or ${
        TOTAL_BYTES / 1024
      } KiB).`,
    );
  }
  return out.join("\n");
}

if (argv[1] && resolve(argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(render(argv[2] ?? "artifacts/ui-baseline/test-results"));
  } catch (error) {
    console.log(
      `Could not print Playwright failure diagnostics: ${
        label(String(error?.message ?? error))
      }`,
    );
  }
}
