import { assert, assertEquals } from "@std/assert";
import {
  call,
  type Fixture,
  install,
  publishWithPages,
  secondOrganization,
  withPluginFixture,
} from "../helpers/plugin-pages-fixture.ts";
import {
  problemCode,
  registeredWorker,
  seedEligibleJob,
  workerFixtureCapabilities,
} from "../helpers/worker-execution.ts";
import { claimAssignment } from "../helpers/worker-execution/scenarios.ts";

/**
 * The route that hands a contained plugin job its code (#29, B14.02): the
 * files of the install's pinned bundle, for the install the job names, to a
 * worker that proves the attempt's lease and fence, and never for authority
 * that is already gone.
 */

const CAPS = [...workerFixtureCapabilities, "plugin.job.contained"];
const JOB_JS = "export default () => ({ ok: true });\n";

type Store = Parameters<typeof publishWithPages>[1];

async function setup(
  fixture: Fixture,
  store: Store,
  options: { capabilities?: string[]; entry?: string; installId?: string } = {},
) {
  const published = await publishWithPages(
    fixture,
    store,
    {
      name: "nightly-helper",
      requestedCapabilities: options.capabilities ?? ["jobs.schedule"],
    },
    { "jobs/nightly.js": JOB_JS, "lib/util.js": "export const x = 1;\n" },
  );
  assertEquals(published.response.status, 201, await published.response.text());
  const installId = await install(fixture, published);
  const worker = await registeredWorker(fixture, { capabilities: CAPS });
  await seedEligibleJob(
    fixture.pgDatabase,
    fixture.organizationId,
    fixture.principalId,
    {
      action: "plugin.job",
      capabilities: ["plugin.job.contained"],
      input: {
        installId: options.installId ?? installId,
        entry: options.entry ?? "jobs/nightly.js",
      },
    },
  );
  const assignment = await claimAssignment(fixture, worker, {
    capabilities: CAPS,
    supportedActions: ["plugin.job"],
  });
  assertEquals(assignment.action, "plugin.job");
  return { installId, worker, assignment, published };
}

/** Names the plugin version a leased job was admitted with, as admission would. */
async function nameVersion(
  fixture: Fixture,
  jobId: string,
  versionId: string,
) {
  await fixture.pgDatabase.query(
    `update bakery.jobs
        set input = input || jsonb_build_object('versionId', $2::text)
      where id = $1`,
    [jobId, versionId],
  );
}

async function filesOf(response: Response): Promise<Map<string, string>> {
  assertEquals(response.status, 200, await response.clone().text());
  const body = await response.json();
  return new Map<string, string>(
    body.files.map((f: { path: string; contentBase64: string }) => [
      f.path,
      atob(f.contentBase64),
    ]),
  );
}

async function files(
  fixture: Fixture,
  worker: Awaited<ReturnType<typeof registeredWorker>>,
  assignment: Awaited<ReturnType<typeof claimAssignment>>,
  over: Record<string, string> = {},
) {
  const host = await fixture.pgDatabase.query<{ version: number }>(
    `select protocol_version as version from bakery.worker_hosts where id = $1`,
    [worker.registration.workerHostId],
  );
  // A GET carries no body, which `workerRequest` always sends.
  return await Promise.resolve(fixture.app.fetch(
    new Request(
      `${fixture.config.publicBaseUrl}/v1/worker/attempts/${assignment.attemptId}/plugin-job-files`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${worker.credential}`,
          "X-Bakery-Worker-Protocol-Version": String(host.rows[0].version),
          "X-Worker-Lease-Token": String(assignment.leaseToken),
          "X-Worker-Fence": String(assignment.fence),
          "X-Worker-Session-Id": worker.registration.workerSessionId,
          "X-Worker-Session-Generation":
            worker.registration.workerSessionGeneration,
          ...over,
        },
      },
    ),
  ));
}

async function refused(response: Response, reason: string) {
  const text = await response.text();
  assertEquals(response.status, 409, text);
  const body = JSON.parse(text);
  assertEquals(body.code, "STATE_CONFLICT");
  assert(text.includes(reason), `expected ${reason} in ${text}`);
}

Deno.test("a leased job is handed the files of its install's bundle, and the entry it was admitted with", () =>
  withPluginFixture(async (fixture, store) => {
    const { worker, assignment } = await setup(fixture, store);
    const response = await files(fixture, worker, assignment);
    assertEquals(response.status, 200, await response.clone().text());
    const body = await response.json();
    assertEquals(body.entry, "jobs/nightly.js");
    assert(/^[0-9a-f]{64}$/.test(body.bundleDigest));
    const byPath = new Map<string, string>(
      body.files.map((
        f: { path: string; contentBase64: string },
      ) => [f.path, atob(f.contentBase64)]),
    );
    assertEquals(byPath.get("jobs/nightly.js"), JOB_JS);
    assertEquals(byPath.get("lib/util.js"), "export const x = 1;\n");
  }));

Deno.test("a worker without the lease, the fence or the session is refused", () =>
  withPluginFixture(async (fixture, store) => {
    const { worker, assignment } = await setup(fixture, store);
    for (
      const over of <Record<string, string>[]> [
        { "X-Worker-Lease-Token": "not-the-lease-token" },
        { "X-Worker-Fence": String(BigInt(assignment.fence) + 1n) },
        { "X-Worker-Session-Id": crypto.randomUUID() },
      ]
    ) {
      const response = await files(fixture, worker, assignment, over);
      assertEquals(response.status, 409, JSON.stringify(over));
      assertEquals(await problemCode(response), "LEASE_FENCED");
    }
    const other = await registeredWorker(fixture, { capabilities: CAPS });
    const stolen = await files(fixture, other, assignment);
    assertEquals(stolen.status, 409);
    assertEquals(await problemCode(stolen), "LEASE_FENCED");
  }));

Deno.test("an install that is off, ungranted or missing its entry gets no code", () =>
  withPluginFixture(async (fixture, store) => {
    const off = await setup(fixture, store);
    const turnedOff = await call(
      fixture,
      `/v1/plugin-installs/${off.installId}`,
      { method: "PATCH", body: { status: "disabled" } },
    );
    assertEquals(turnedOff.status, 200);
    await refused(
      await files(fixture, off.worker, off.assignment),
      "plugin_install_off",
    );
  }));

Deno.test("an install whose manifest never asked for jobs.schedule gets no code", () =>
  withPluginFixture(async (fixture, store) => {
    const { worker, assignment } = await setup(fixture, store, {
      capabilities: ["state.read"],
    });
    await refused(
      await files(fixture, worker, assignment),
      "plugin_job_not_granted",
    );
  }));

Deno.test("an entry the bundle does not contain gets no code", () =>
  withPluginFixture(async (fixture, store) => {
    const { worker, assignment } = await setup(fixture, store, {
      entry: "jobs/missing.js",
    });
    await refused(
      await files(fixture, worker, assignment),
      "plugin_job_entry_missing",
    );
  }));

Deno.test("a job that names a version of its install's package is handed that version's code, not the install's", () =>
  withPluginFixture(async (fixture, store) => {
    const { installId, worker, assignment, published } = await setup(
      fixture,
      store,
    );
    const newer = "export default () => ({ ok: 'v2' });\n";
    const second = await publishWithPages(
      fixture,
      store,
      { name: "nightly-helper", requestedCapabilities: ["jobs.schedule"] },
      { "jobs/nightly.js": newer },
      published.packageId,
    );
    assertEquals(second.response.status, 201, await second.response.text());
    await nameVersion(fixture, assignment.jobId, second.versionId);

    const named = await filesOf(await files(fixture, worker, assignment));
    assertEquals(named.get("jobs/nightly.js"), newer);
    // The install still points at its own version: only this job moved.
    const row = await fixture.pgDatabase.query<{ plugin_version_id: string }>(
      `select plugin_version_id from bakery.plugin_installs where id = $1`,
      [installId],
    );
    assertEquals(row.rows[0].plugin_version_id, published.versionId);
  }));

Deno.test("a job that names a version of another package, or none, is handed no code", () =>
  withPluginFixture(async (fixture, store) => {
    const { worker, assignment } = await setup(fixture, store);
    const elsewhere = await publishWithPages(
      fixture,
      store,
      { name: "other-helper", requestedCapabilities: ["jobs.schedule"] },
      { "jobs/nightly.js": "export default () => ({ stolen: true });\n" },
    );
    assertEquals(elsewhere.response.status, 201);
    for (const versionId of [elsewhere.versionId, crypto.randomUUID()]) {
      await nameVersion(fixture, assignment.jobId, versionId);
      await refused(
        await files(fixture, worker, assignment),
        "plugin_job_version_not_in_package",
      );
    }
  }));

Deno.test("a job that names an unpublished version of its own package is handed no code", () =>
  withPluginFixture(async (fixture, store) => {
    const { worker, assignment, published } = await setup(fixture, store);
    const draft = await publishWithPages(
      fixture,
      store,
      { name: "nightly-helper", requestedCapabilities: ["jobs.schedule"] },
      { "jobs/nightly.js": "export default () => ({ draft: true });\n" },
      published.packageId,
    );
    assertEquals(draft.response.status, 201, await draft.response.text());
    // A version nobody published is not code a job may run, even in its own package.
    await fixture.pgDatabase.query(
      `update bakery.plugin_versions set published_at = null where id = $1`,
      [draft.versionId],
    );
    await nameVersion(fixture, assignment.jobId, draft.versionId);
    await refused(
      await files(fixture, worker, assignment),
      "plugin_job_version_not_in_package",
    );
  }));

Deno.test("a job that names no version is handed the install's current version", () =>
  withPluginFixture(async (fixture, store) => {
    const { worker, assignment } = await setup(fixture, store);
    const served = await filesOf(await files(fixture, worker, assignment));
    assertEquals(served.get("jobs/nightly.js"), JOB_JS);
  }));

/** Copies one row to another organization under a new id, changing only what is named. */
async function cloneRow(
  fixture: Fixture,
  table: string,
  from: { organizationId: string; id: string },
  to: Record<string, string>,
) {
  await fixture.pgDatabase.query(
    `insert into bakery.${table}
     select (jsonb_populate_record(
       null::bakery.${table},
       to_jsonb(t) || $3::jsonb
     )).*
       from bakery.${table} t
      where t.organization_id = $1 and t.id = $2`,
    [from.organizationId, from.id, JSON.stringify(to)],
  );
}

Deno.test("a job cannot be handed the code of an install that lives in another organization", () =>
  withPluginFixture(async (fixture, store) => {
    const { installId, worker, assignment } = await setup(fixture, store);
    const other = await secondOrganization(fixture);
    // The same install, version and package copied into the other organization,
    // with the bundle reference left pointing at this one. Only the tenant
    // predicate in the route's query keeps the copy from being served.
    const row = await fixture.pgDatabase.query<{
      plugin_package_id: string;
      plugin_version_id: string;
    }>(
      `select plugin_package_id, plugin_version_id from bakery.plugin_installs
        where organization_id = $1 and id = $2`,
      [fixture.organizationId, installId],
    );
    const foreign = {
      pkg: crypto.randomUUID(),
      version: crypto.randomUUID(),
      install: crypto.randomUUID(),
    };
    const here = fixture.organizationId;
    await cloneRow(
      fixture,
      "plugin_packages",
      { organizationId: here, id: row.rows[0].plugin_package_id },
      { organization_id: other.organizationId, id: foreign.pkg },
    );
    await cloneRow(
      fixture,
      "plugin_versions",
      { organizationId: here, id: row.rows[0].plugin_version_id },
      {
        organization_id: other.organizationId,
        id: foreign.version,
        plugin_package_id: foreign.pkg,
      },
    );
    await cloneRow(
      fixture,
      "plugin_installs",
      { organizationId: here, id: installId },
      {
        organization_id: other.organizationId,
        id: foreign.install,
        plugin_package_id: foreign.pkg,
        plugin_version_id: foreign.version,
      },
    );
    await fixture.pgDatabase.query(
      `insert into bakery.plugin_install_grants (organization_id, plugin_install_id, capability)
       values ($1, $2, 'jobs.schedule')`,
      [other.organizationId, foreign.install],
    );
    // The job (in this organization) now names the other organization's install.
    await fixture.pgDatabase.query(
      `update bakery.jobs
          set input = input || jsonb_build_object('installId', $2::text)
        where id = $1`,
      [assignment.jobId, foreign.install],
    );
    try {
      await refused(
        await files(fixture, worker, assignment),
        "plugin_install_gone",
      );
    } finally {
      // The copies are this test's, in an organization the fixture will delete
      // at teardown. Left behind they block that delete with a foreign key
      // violation, and every later test in the run pays for it.
      const org = other.organizationId;
      await fixture.pgDatabase.query(
        `delete from bakery.plugin_install_grants
          where organization_id = $1 and plugin_install_id = $2`,
        [org, foreign.install],
      );
      await fixture.pgDatabase.query(
        `delete from bakery.plugin_installs where organization_id = $1 and id = $2`,
        [org, foreign.install],
      );
      await fixture.pgDatabase.query(
        `delete from bakery.plugin_versions where organization_id = $1 and id = $2`,
        [org, foreign.version],
      );
      await fixture.pgDatabase.query(
        `delete from bakery.plugin_packages where organization_id = $1 and id = $2`,
        [org, foreign.pkg],
      );
    }
  }));

Deno.test("an uninstalled install is gone, not merely off", () =>
  withPluginFixture(async (fixture, store) => {
    const { installId, worker, assignment } = await setup(fixture, store);
    const removed = await call(fixture, `/v1/plugin-installs/${installId}`, {
      method: "PATCH",
      body: { status: "uninstalled" },
    });
    assertEquals(removed.status, 200, await removed.clone().text());
    await refused(
      await files(fixture, worker, assignment),
      "plugin_install_gone",
    );
  }));

async function jobFor(
  fixture: Fixture,
  store: Store,
  files: Record<string, string>,
) {
  const published = await publishWithPages(
    fixture,
    store,
    { name: "big-helper", requestedCapabilities: ["jobs.schedule"] },
    files,
  );
  assertEquals(published.response.status, 201, await published.response.text());
  const installId = await install(fixture, published);
  const worker = await registeredWorker(fixture, { capabilities: CAPS });
  await seedEligibleJob(
    fixture.pgDatabase,
    fixture.organizationId,
    fixture.principalId,
    {
      action: "plugin.job",
      capabilities: ["plugin.job.contained"],
      input: { installId, entry: "jobs/nightly.js" },
    },
  );
  const assignment = await claimAssignment(fixture, worker, {
    capabilities: CAPS,
    supportedActions: ["plugin.job"],
  });
  return { worker, assignment };
}

Deno.test("a bundle over the byte cap is not handed out", () =>
  withPluginFixture(async (fixture, store) => {
    // Under the archive reader's own limit, over the route's.
    const { worker, assignment } = await jobFor(fixture, store, {
      "jobs/nightly.js": JOB_JS,
      "data.bin": "a".repeat(9 * 1024 * 1024),
    });
    await refused(
      await files(fixture, worker, assignment),
      "plugin_bundle_too_large",
    );
  }));

Deno.test("a bundle the archive reader refuses is unreadable, not missing", () =>
  withPluginFixture(async (fixture, store) => {
    const many: Record<string, string> = { "jobs/nightly.js": JOB_JS };
    for (let i = 0; i < 300; i++) {
      many[`lib/f${i}.js`] = `export const n = ${i};\n`;
    }
    const { worker, assignment } = await jobFor(fixture, store, many);
    await refused(
      await files(fixture, worker, assignment),
      "plugin_bundle_unreadable",
    );
  }));

Deno.test("a version whose stored bundle reference is not the recomputed key is not read", () =>
  withPluginFixture(async (fixture, store) => {
    const { installId, worker, assignment } = await setup(fixture, store);
    // A row naming any other key would read bytes this version never had.
    await fixture.pgDatabase.query(
      `update bakery.plugin_versions v
          set bundle_object_ref = 'organizations/other/blobs/' || v.bundle_digest
         from bakery.plugin_installs i
        where i.organization_id = $1 and i.id = $2
          and v.organization_id = i.organization_id
          and v.id = i.plugin_version_id`,
      [fixture.organizationId, installId],
    );
    await refused(
      await files(fixture, worker, assignment),
      "plugin_bundle_missing",
    );
  }));
