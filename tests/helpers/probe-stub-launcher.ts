/**
 * Stub launchers for the probe's server-side tests (#437 slice 2).
 *
 * A stub is a shell script, not a mock: the launcher is a process that reads a
 * frame on stdin, writes one on stdout and exits, and only a process exercises
 * the server's spawn, bounds and exit-code handling.
 *
 * Every stub answers THREE questions now. `probeArtifactBytes` asks the sandbox
 * self-test first and refuses to touch the bytes when the sandbox is not
 * sealed, so a stub that only answered the probe frame would be read as "the
 * network is reachable" — which is the fail-closed path, not the one under test.
 * The self-test branch is therefore built in and defaults to the sealed answer;
 * a test that wants an unsealed sandbox overrides it.
 */

/** The sealed answer: the sandbox cut the worker off, which is what we want. */
export const SEALED =
  '{"selfTest":"network","reachable":false,"detail":"PermissionDenied"}';

/** The unsealed answer: a connect inside the unit succeeded. */
export const UNSEALED =
  '{"selfTest":"network","reachable":true,"detail":"connected"}';

/** The read-only answer: the canary could not be created. */
export const READ_ONLY =
  '{"selfTest":"filesystem","writable":false,"detail":"ReadOnly"}';

/** The writable answer: a canary was created, so the unit is not sealed. */
export const WRITABLE =
  '{"selfTest":"filesystem","writable":true,"detail":"created"}';

/** The probe frame for a 2x2 PNG, which is the answer most tests want. */
export const PNG_FRAME =
  '{"result":{"status":"described","kind":"image","mediaType":"image/png","byteLength":16,"width":2,"height":2}}';

/** Writes a stub launcher and makes it executable. */
export async function writeStub(
  dir: string,
  name: string,
  options: {
    /** What the network self-test writes, or `exit:<code>` to exit instead. */
    readonly selfTest?: string;
    /**
     * What the filesystem self-test writes, or `exit:<code>` to exit instead.
     * Defaults to the read-only answer, because a sandbox that is sealed is the
     * state under test; a test that wants a writable one says so.
     */
    readonly filesystem?: string;
    /** The probe branch: shell, with the request already in `$request`. */
    readonly probe: string;
  },
): Promise<string> {
  const path = `${dir}/${name}`;
  const branch = (answer: string) =>
    answer.startsWith("exit:")
      ? `exit ${answer.slice("exit:".length)}`
      : `printf '%s' '${answer}'`;
  const selfTestBranch = branch(options.selfTest ?? SEALED);
  const filesystemBranch = branch(options.filesystem ?? READ_ONLY);
  await Deno.writeTextFile(
    path,
    `#!/bin/sh
# Every stub reads its request first: the server sends a self-test frame before
# it ever names a file, and a stub that did not branch here would answer the
# wrong question.
request=$(cat) || request=
case "$request" in
  # The filesystem question is asked after the network one, so it is matched
  # first: both requests carry "selfTest", and only one carries "filesystem".
  *filesystem*)
    ${filesystemBranch}
    ;;
  *selfTest*)
    ${selfTestBranch}
    ;;
  *)
${options.probe.split("\n").map((line) => `    ${line}`).join("\n")}
    ;;
esac
`,
  );
  await Deno.chmod(path, 0o755);
  return path;
}
