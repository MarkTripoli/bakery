import { createHash } from "node:crypto";
import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";

// The trusted gate (issue #59 slice 6, design item 8): the files that decide
// what Bakery may do to itself. An update that changes any of them is not
// installed until the version running now has approved it, because a candidate
// must never approve the replacement of its own checks or its own launcher.
//
// The list is fixed here, in the launcher that is installed on the host, and
// the digests are taken from the files of each release as they sit on disk.
// Neither comes from the candidate: a release.json written by the candidate
// could leave out whatever it wanted to change.
export const TRUSTED_GATE_PATHS = Object.freeze([
  // The launcher itself and the host scripts it runs.
  "scripts/deploy",
  // The migration policy and the service units.
  "infra/production",
  // The checks that decide what may be merged.
  "apps/server/src/modules/repository-rules",
]);

/** How many approvals are kept; an older one no longer matters. */
export const APPROVAL_LIMIT = 20;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * The digest of every file under the trusted paths of one release directory,
 * keyed by its path from the release root. A link is digested by where it
 * points and never followed, so a release cannot make the gate read outside it.
 */
export async function gateDigests(directory, paths = TRUSTED_GATE_PATHS) {
  const digests = {};
  const visit = async (relative) => {
    const path = join(directory, relative);
    let stat;
    try {
      stat = await lstat(path);
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      digests[relative] = sha256(`link:${await readlink(path)}`);
    } else if (stat.isDirectory()) {
      for (const name of (await readdir(path)).sort()) {
        await visit(`${relative}/${name}`);
      }
    } else if (stat.isFile()) {
      digests[relative] = sha256(await readFile(path));
    } else {
      throw new Error("GATE_SPECIAL_FILE");
    }
  };
  for (const path of paths) await visit(path);
  return digests;
}

/**
 * What differs between two releases: [{ path, kind }] with kind added,
 * removed or changed, in path order. Empty when the gate is the same.
 */
export function gateChanges(before, after) {
  const changes = [];
  for (const path of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (!(path in before)) changes.push({ path, kind: "added" });
    else if (!(path in after)) changes.push({ path, kind: "removed" });
    else if (before[path] !== after[path]) {
      changes.push({ path, kind: "changed" });
    }
  }
  return changes.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

/** One digest for the whole trusted gate of a release. */
export function gateFingerprint(digests) {
  return sha256(JSON.stringify(Object.entries(digests).sort()));
}

/**
 * Whether a person approved exactly this move: this candidate, replacing this
 * running release, with this trusted gate. Anything else needs a new approval.
 */
export function approves(approvals, { sha, active, fingerprint }) {
  return approvals.some((approval) =>
    approval.sha === sha && approval.active === active &&
    approval.fingerprint === fingerprint
  );
}

/** The kept approvals. A file that is missing or unreadable means none: it fails closed. */
export async function readApprovals(path) {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

/** Adds one approval and keeps only the latest few. `write` writes the file atomically. */
export async function addApproval(path, approval, write) {
  const kept = [...await readApprovals(path), approval].slice(-APPROVAL_LIMIT);
  await write(path, `${JSON.stringify(kept, null, 2)}\n`);
  return kept;
}
