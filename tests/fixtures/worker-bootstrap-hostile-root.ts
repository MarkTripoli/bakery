import { createHash } from "node:crypto";
import { chmod, mkdir, symlink, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  doctor,
  installationStatus,
  type Probes,
} from "../../packages/worker-bootstrap/src/index.ts";

/**
 * Builds an install root whose one record is hostile, then asks `status` and
 * `doctor` about it and prints how long they took and what they said. Run by a
 * security test as its own process (this script creates the `current` link and
 * the FIFO, which the security lane's scoped permissions do not allow in-process).
 *
 * Usage: deno run -A worker-bootstrap-hostile-root.ts <pairing|release|binary> <fifo|devzero|sparse|directory> <empty-root>
 */
const [which, hostile, root] = Deno.args;
const BINARY = new TextEncoder().encode(
  "#!/bin/sh\necho bakery worker 1.2.3\n",
);
const release = join(root, "releases", "1.2.3-linux-x64");
await chmod(root, 0o700);
await mkdir(release, { recursive: true });
await writeFile(join(release, "bakery-worker"), BINARY, { mode: 0o755 });
await writeFile(
  join(release, "release.json"),
  JSON.stringify({
    release: "1.2.3",
    target: "linux-x64",
    file: "bakery-worker",
    size: BINARY.length,
    sha256: createHash("sha256").update(BINARY).digest("hex"),
    keyId: "k1",
    stateFormat: 1,
    protocol: { min: 1, max: 1 },
    installedAt: "2026-11-14T00:00:00.000Z",
  }),
);
await symlink(join("releases", "1.2.3-linux-x64"), join(root, "current"));
await writeFile(
  join(root, "pairing.json"),
  JSON.stringify({
    version: 1,
    serverOrigin: "https://bakery.example",
    organizationName: "Acme",
    enrollmentId: "00000000-0000-4000-8000-0000000000e1",
    name: "build-linux-01",
    os: "linux",
    architecture: "x64",
    slots: 2,
    capabilities: ["git"],
    boundAt: "2026-11-14T00:00:00.000Z",
  }),
  { mode: 0o600 },
);

const target = which === "pairing"
  ? join(root, "pairing.json")
  : which === "release"
  ? join(release, "release.json")
  : join(release, "bakery-worker");
await Deno.remove(target);
if (hostile === "fifo") {
  const made = await new Deno.Command("mkfifo", { args: [target] }).output();
  if (!made.success) throw new Error("mkfifo failed");
} else if (hostile === "devzero") {
  await symlink("/dev/zero", target);
} else if (hostile === "sparse") {
  await writeFile(target, "");
  await truncate(target, 300 * 1024 * 1024);
} else if (hostile === "directory") {
  await mkdir(target);
} else throw new Error("unknown hostile kind");

const probes: Probes = {
  serviceState: () => Promise.resolve("active"),
  runs: () => Promise.resolve(true),
  freeBytes: () => Promise.resolve(10 * 1024 ** 3),
  uid: () => 1000,
};
const started = Date.now();
const report = await installationStatus(root, probes);
const checks = await doctor(root, probes);
console.log(JSON.stringify({
  ms: Date.now() - started,
  installation: report.installation,
  pairing: report.pairing.state,
  checks: Object.fromEntries(checks.map((check) => [check.id, check.status])),
  rss: Deno.memoryUsage().rss,
}));
