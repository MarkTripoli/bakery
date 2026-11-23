/**
 * Writes a plugin job's code to disk for a contained runtime (#29, B14.02).
 *
 * The server parses the install's bundle and sends plain files, so the worker
 * never unpacks an archive. It still treats every path as hostile: it is about
 * to write to its own disk from bytes that crossed a network. A path that
 * could leave the directory, a duplicate, a file or byte count past the caps,
 * or a missing entry stops the job before anything is written.
 *
 * The directory and files are made readable by anyone, because the job runs as
 * an unprivileged user inside the boundary and a bind mount keeps host
 * permissions. The runtime mounts it read-only.
 */

export const PLUGIN_CODE_MAX_FILES = 256;
export const PLUGIN_CODE_MAX_BYTES = 8 * 1024 * 1024;
/** The server accepts paths up to 500 characters, so the worker does too. */
const MAX_PATH_CHARS = 500;

export class PluginCodeError extends Error {
  constructor(readonly reason: string) {
    super(`PLUGIN_CODE_${reason.toUpperCase()}`);
  }
}

export type PluginCodeResponse = Readonly<{
  entry: string;
  files: readonly Readonly<{ path: string; contentBase64: string }>[];
}>;

export type MaterializedPluginCode = Readonly<{
  dir: string;
  entry: string;
  remove(): Promise<void>;
}>;

/** True when `path` is a plain relative path with no way out of its directory. */
export function isSafeRelativePath(path: string): boolean {
  if (path.length === 0 || path.length > MAX_PATH_CHARS) return false;
  if (path.startsWith("/") || path.includes("\\") || path.includes("\0")) {
    return false;
  }
  // Control characters have no place in a file name.
  // deno-lint-ignore no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(path)) return false;
  return path.split("/").every((segment) =>
    segment.length > 0 && segment !== "." && segment !== ".."
  );
}

function decodeStrict(text: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) {
    throw new PluginCodeError("file_not_base64");
  }
  try {
    return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
  } catch {
    throw new PluginCodeError("file_not_base64");
  }
}

export async function materializePluginCode(
  response: PluginCodeResponse,
  parent: string,
): Promise<MaterializedPluginCode> {
  if (!Array.isArray(response.files)) throw new PluginCodeError("no_files");
  if (
    response.files.length === 0 || response.files.length > PLUGIN_CODE_MAX_FILES
  ) {
    throw new PluginCodeError("file_count");
  }
  if (!isSafeRelativePath(response.entry)) {
    throw new PluginCodeError("entry_path");
  }
  const decoded = new Map<string, Uint8Array>();
  let total = 0;
  for (const file of response.files) {
    if (typeof file.path !== "string" || !isSafeRelativePath(file.path)) {
      throw new PluginCodeError("file_path");
    }
    // Two names that differ only in case are one file on some filesystems.
    const key = file.path.toLowerCase();
    if ([...decoded.keys()].some((seen) => seen.toLowerCase() === key)) {
      throw new PluginCodeError("duplicate_path");
    }
    if (typeof file.contentBase64 !== "string") {
      throw new PluginCodeError("file_not_base64");
    }
    const bytes = decodeStrict(file.contentBase64);
    total += bytes.byteLength;
    if (total > PLUGIN_CODE_MAX_BYTES) throw new PluginCodeError("too_large");
    decoded.set(file.path, bytes);
  }
  if (!decoded.has(response.entry)) throw new PluginCodeError("entry_missing");

  const dir = await Deno.makeTempDir({ dir: parent, prefix: "plugin-job-" });
  try {
    await Deno.chmod(dir, 0o755);
    for (const [path, bytes] of decoded) {
      const target = `${dir}/${path}`;
      const slash = target.lastIndexOf("/");
      await Deno.mkdir(target.slice(0, slash), {
        recursive: true,
        mode: 0o755,
      });
      await Deno.writeFile(target, bytes, { createNew: true, mode: 0o644 });
    }
  } catch (error) {
    await Deno.remove(dir, { recursive: true }).catch(() => undefined);
    throw error;
  }
  return {
    dir,
    entry: response.entry,
    remove: () => Deno.remove(dir, { recursive: true }).catch(() => undefined),
  };
}
