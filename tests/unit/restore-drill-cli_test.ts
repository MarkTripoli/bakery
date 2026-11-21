import { assert, assertEquals } from "@std/assert";
import {
  ApiFatal,
  ApiUnavailable,
  type DrillReport,
  type DrillReporter,
  type DrillView,
} from "../../scripts/deploy/backup-runner/api.ts";
import type {
  DrillOptions,
  DrillOutcome,
} from "../../scripts/deploy/backup-runner/drill.ts";
import { EXIT, main } from "../../scripts/deploy/restore-drill.ts";
import { DRILL_CHECKS } from "../../apps/server/src/modules/backups/drill-rules.ts";

/**
 * #64 slice D: the restore drill's command line. The drill itself and the
 * server are replaced, so these tests are about what the operator sees and what
 * is sent: the result line, the exit code, the report, and the retries.
 */

const TOKEN = "t".repeat(40);
const ENV = {
  BAKERY_API_URL: "https://bakery.example",
  BAKERY_BACKUP_RUNNER_TOKEN: TOKEN,
};
const ARGS = [
  "/var/lib/bakery/backups/set-1",
  "--identity",
  "/root/id.txt",
  "--key-file",
  "/etc/bakery/secrets.key",
];

const passed: DrillOutcome = {
  backupName: "set-1",
  startedAt: "2026-11-21T04:00:00.000Z",
  outcome: "passed",
  failureCode: null,
  detail: null,
  cutoffAt: "2026-11-21T03:00:05.000Z",
  rpoSeconds: 3595,
  rtoSeconds: 142,
  checksPassed: [...DRILL_CHECKS],
  checksFailed: [],
};
const failed: DrillOutcome = {
  ...passed,
  outcome: "failed",
  failureCode: "migration_unsupported",
  detail:
    "The backup holds 1 migration this release does not know (first: 0310_x).",
  checksPassed: [
    "manifest",
    "checksums",
    "key",
    "postgres",
    "redis",
    "files",
    "references",
  ],
  checksFailed: ["migrations"],
};

type Harness = {
  readonly out: string[];
  readonly log: string[];
  readonly sent: DrillReport[];
  readonly drilled: DrillOptions[];
  readonly waits: number[];
};

function harness(
  outcome: DrillOutcome,
  api: (sent: DrillReport[]) => DrillReporter["drill"],
): [Harness, Parameters<typeof main>[1]] {
  const h: Harness = { out: [], log: [], sent: [], drilled: [], waits: [] };
  return [h, {
    env: ENV,
    out: (line) => h.out.push(line),
    log: (line) => h.log.push(line),
    drill: (options) => {
      h.drilled.push(options);
      return Promise.resolve(outcome);
    },
    api: { drill: api(h.sent) } as DrillReporter,
    sleep: (ms) => {
      h.waits.push(ms);
      return Promise.resolve();
    },
  }];
}

const keep = (sent: DrillReport[]): DrillReporter["drill"] => (report) => {
  sent.push(report);
  const { drillId, ...rest } = report;
  return Promise.resolve(
    {
      id: drillId,
      recordedAt: "2026-11-21T04:03:00.000Z",
      ...rest,
    } as DrillView,
  );
};

Deno.test("a passed drill prints one line with its age and time, reports it, and exits 0", async () => {
  const [h, options] = harness(passed, keep);
  assertEquals(await main(ARGS, options), EXIT.passed);
  assertEquals(h.out, ["RESTORE_DRILL_PASSED backup=set-1 rpo=3595s rto=142s"]);
  assertEquals(h.sent.length, 1);
  assertEquals(h.sent[0].outcome, "passed");
  assertEquals(h.sent[0].rpoSeconds, 3595);
  assert(/^[0-9a-f-]{36}$/.test(h.sent[0].drillId), "a fresh uuid");
  assertEquals(h.drilled[0].keyFile, "/etc/bakery/secrets.key");
  assertEquals(h.drilled[0].releaseRoot, "/opt/bakery/background");
});

Deno.test("a failed drill names the failing check and its code, is still reported, and exits 1", async () => {
  const [h, options] = harness(failed, keep);
  assertEquals(await main(ARGS, options), EXIT.failed);
  assertEquals(h.out.length, 1);
  assert(
    h.out[0].startsWith(
      "RESTORE_DRILL_FAILED backup=set-1 code=migration_unsupported check=migrations",
    ),
  );
  assert(h.out[0].includes("0310_x"));
  assertEquals(h.sent.length, 1);
  assertEquals(h.sent[0].checksFailed, ["migrations"]);
});

Deno.test("--no-report runs the drill and prints the result without touching the server", async () => {
  const [h, options] = harness(passed, keep);
  assertEquals(
    await main([...ARGS, "--no-report"], { ...options, env: {} }),
    EXIT.passed,
  );
  assertEquals(h.sent.length, 0);
  assertEquals(h.out.length, 1);
});

Deno.test("a network error or a 5xx is retried with the same report, up to three tries", async () => {
  let tries = 0;
  const seen: string[] = [];
  const [h, options] = harness(passed, () => (report) => {
    tries += 1;
    seen.push(report.drillId);
    if (tries < 3) return Promise.reject(new ApiUnavailable("network"));
    return Promise.resolve(
      {
        id: report.drillId,
        recordedAt: "x",
        ...report,
      } as unknown as DrillView,
    );
  });
  assertEquals(await main(ARGS, options), EXIT.passed);
  assertEquals(tries, 3);
  // The same id every time, so the server cannot record it twice.
  assertEquals(new Set(seen).size, 1);
  assertEquals(h.waits.length, 2);
});

Deno.test("a result that cannot be delivered after three tries exits 3 and says the drill itself passed", async () => {
  const [h, options] = harness(
    passed,
    () => () => Promise.reject(new ApiUnavailable("status 503")),
  );
  assertEquals(await main(ARGS, options), EXIT.notReported);
  assert(
    h.log.some((line) =>
      line.includes("could not be reported") && line.includes("passed")
    ),
  );
  assertEquals(h.out.length, 1);
});

Deno.test("a server refusal is not retried and exits 3", async () => {
  let tries = 0;
  const [h, options] = harness(passed, () => () => {
    tries += 1;
    return Promise.reject(new ApiFatal(409, "drill_id_reused"));
  });
  assertEquals(await main(ARGS, options), EXIT.notReported);
  assertEquals(tries, 1);
  assert(h.log.some((line) => line.includes("drill_id_reused")));
});

Deno.test("bad arguments exit 64 before any drill runs", async () => {
  for (
    const args of [
      [],
      ["/set"],
      ["/set", "--identity"],
      ["/set", "/other", "--identity", "/id"],
      ["/set", "--identity", "/id", "--bogus"],
    ]
  ) {
    const [h, options] = harness(passed, keep);
    assertEquals(await main(args, options), EXIT.usage, args.join(" "));
    assertEquals(h.drilled.length, 0);
  }
});

Deno.test("without a usable runner credential the drill is not run at all unless --no-report is given", async () => {
  const [h, options] = harness(passed, keep);
  const { api: _unused, ...rest } = options;
  assertEquals(
    await main(ARGS, {
      ...rest,
      env: { BAKERY_API_URL: "https://bakery.example" },
    }),
    EXIT.usage,
  );
  assertEquals(h.drilled.length, 0);
  assert(h.log.some((line) => line.includes("--no-report")));
  assertEquals(
    await main([...ARGS, "--no-report"], { ...rest, env: {} }),
    EXIT.passed,
  );
  assertEquals(h.drilled.length, 1);
});

Deno.test("the runner's credential never appears in anything the command prints", async () => {
  const [h, options] = harness(
    failed,
    () => () => Promise.reject(new ApiUnavailable(`bearer ${TOKEN}`)),
  );
  await main(ARGS, options);
  for (const line of [...h.out, ...h.log]) assert(!line.includes(TOKEN), line);
});

Deno.test("a set with no cutoff prints an unknown age, not a number", async () => {
  const [h, options] = harness(
    { ...failed, cutoffAt: null, rpoSeconds: null },
    keep,
  );
  await main(ARGS, options);
  assert(h.out[0].includes("rpo=unknown rto=142s"), h.out[0]);
  assert(!h.out[0].includes("unknowns"));
});

Deno.test("--scratch-root is passed to the drill, so the wrapper and the drill agree on where it writes", async () => {
  const [h, options] = harness(passed, keep);
  await main(
    [...ARGS, "--scratch-root", "/srv/scratch", "--no-report"],
    options,
  );
  assertEquals(h.drilled[0].scratchRoot, "/srv/scratch");
  const [h2, options2] = harness(passed, keep);
  assertEquals(await main([...ARGS, "--scratch-root"], options2), EXIT.usage);
  assertEquals(h2.drilled.length, 0);
});
