import { assert, assertEquals } from "@std/assert";
import {
  createMetricsRegistry,
  MAX_LABEL_VALUES,
  MAX_METRIC_LABELS,
  MAX_METRICS,
  MAX_SERIES_PER_METRIC,
  MAX_TOTAL_SERIES,
  type MetricSpecs,
  OTHER_LABEL_VALUE,
} from "../../packages/config/src/telemetry-metrics.ts";

// Metric labels are the one place a telemetry value becomes a dimension, and a
// dimension that can take an unbounded set of values is the cardinality
// explosion that takes a metrics backend down. Labels are therefore closed:
// each one lists its values when the registry is made, anything else lands in
// one shared "other" bucket, and the number of series a registry can ever hold
// is fixed by its definition. Run, attempt and job ids belong in traces.

const uuid = "0b9a1f0e-5a3c-4c1e-8f6a-2d4b7c9e1a30";

const specs: MetricSpecs = {
  jobs_total: {
    kind: "counter",
    help: "Jobs finished, by outcome.",
    labels: { outcome: ["done", "failed", "canceled"] },
  },
  lease_renewals_total: {
    kind: "counter",
    help: "Lease renewals, by result.",
    labels: { result: ["renewed", "lost"], source: ["worker", "server"] },
  },
  queue_depth: {
    kind: "gauge",
    help: "Items waiting.",
    labels: { queue: ["outbox", "spool"] },
  },
  uptime_seconds: { kind: "gauge", help: "Process uptime." },
};

Deno.test("a counter adds up per label combination and the snapshot lists what was touched", () => {
  const registry = createMetricsRegistry(specs);
  registry.inc("jobs_total", { outcome: "done" });
  registry.inc("jobs_total", { outcome: "done" }, 2);
  registry.inc("jobs_total", { outcome: "failed" });
  assertEquals(registry.snapshot(), [
    {
      name: "jobs_total",
      kind: "counter",
      labels: { outcome: "done" },
      value: 3,
    },
    {
      name: "jobs_total",
      kind: "counter",
      labels: { outcome: "failed" },
      value: 1,
    },
  ]);
  assertEquals(registry.overflow(), 0);
});

Deno.test("a gauge keeps the last value written and a metric without labels has one series", () => {
  const registry = createMetricsRegistry(specs);
  registry.set("queue_depth", { queue: "outbox" }, 40);
  registry.set("queue_depth", { queue: "outbox" }, 7);
  registry.set("uptime_seconds", {}, 12.5);
  registry.set("uptime_seconds", undefined, 13.5);
  const byName = Object.fromEntries(
    registry.snapshot().map((sample) => [sample.name, sample.value]),
  );
  assertEquals(byName, { queue_depth: 7, uptime_seconds: 13.5 });
});

Deno.test("a label value outside the declared list lands in one other bucket and is counted", () => {
  const registry = createMetricsRegistry(specs);
  for (
    const value of [
      uuid,
      "retrying",
      "DONE",
      "done ",
      "",
      "x".repeat(100_000),
      "<script>",
      42,
      null,
      undefined,
      {},
      [],
    ]
  ) {
    registry.inc("jobs_total", { outcome: value });
  }
  const samples = registry.snapshot();
  assertEquals(samples.length, 1);
  assertEquals(samples[0].labels, { outcome: OTHER_LABEL_VALUE });
  assertEquals(samples[0].value, 12);
  assertEquals(registry.overflow(), 12);
  assert(
    !JSON.stringify(samples).includes(uuid),
    "a value must never become a label",
  );
});

Deno.test("a missing label is the other bucket and an unknown label name is ignored but counted", () => {
  const registry = createMetricsRegistry(specs);
  registry.inc("lease_renewals_total", { result: "renewed" });
  registry.inc("lease_renewals_total", {
    result: "lost",
    source: "worker",
    runId: uuid,
  });
  assertEquals(registry.snapshot().map((s) => s.labels), [
    { result: "lost", source: "worker" },
    { result: "renewed", source: OTHER_LABEL_VALUE },
  ]);
  // One missing label and one label name that is not declared.
  assertEquals(registry.overflow(), 2);
});

Deno.test("an unknown metric creates nothing and never throws", () => {
  const registry = createMetricsRegistry(specs);
  registry.inc("nope", { a: "b" });
  registry.set("also_nope", {}, 1);
  registry.inc("__proto__", {});
  registry.inc("constructor", {});
  registry.inc("toString", {});
  assertEquals(registry.snapshot(), []);
  assertEquals(registry.overflow(), 5);
});

Deno.test("the number of series can never exceed what the definition allows, whatever is thrown at it", () => {
  const registry = createMetricsRegistry(specs);
  const names = ["jobs_total", "lease_renewals_total", "queue_depth", "x"];
  let seed = 12345;
  const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
  for (let index = 0; index < 100_000; index += 1) {
    registry.inc(names[next() % names.length], {
      outcome: `v${next()}`,
      result: next() % 3 === 0 ? "renewed" : `r${next()}`,
      source: `s${next()}`,
      queue: `q${next()}`,
    });
  }
  // jobs: 3 values + other = 4; renewals: (2 + 1) x (2 + 1) = 9; queue: 2 + 1 = 3;
  // uptime: 1. Nothing the loop does can make a seventeenth series.
  assert(registry.snapshot().length <= 4 + 9 + 3 + 1);
});

Deno.test("a counter ignores a step that is negative or not a number, and saturates instead of overflowing", () => {
  const registry = createMetricsRegistry(specs);
  for (const by of [-1, Number.NaN, Number.POSITIVE_INFINITY, "2", null, {}]) {
    registry.inc("jobs_total", { outcome: "done" }, by as number);
  }
  assertEquals(registry.snapshot(), []);
  assertEquals(registry.overflow(), 6);
  registry.inc("jobs_total", { outcome: "done" }, Number.MAX_SAFE_INTEGER);
  registry.inc("jobs_total", { outcome: "done" }, Number.MAX_SAFE_INTEGER);
  assertEquals(registry.snapshot()[0].value, Number.MAX_SAFE_INTEGER);
});

Deno.test("a gauge ignores a value that is not a finite number in range", () => {
  const registry = createMetricsRegistry(specs);
  registry.set("queue_depth", { queue: "spool" }, 5);
  for (
    const value of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      2 ** 60,
      -(2 ** 60),
      "9",
      null,
      undefined,
    ]
  ) {
    registry.set("queue_depth", { queue: "spool" }, value as number);
  }
  assertEquals(registry.snapshot()[0].value, 5);
  assertEquals(registry.overflow(), 8);
});

Deno.test("inc on a gauge and set on a counter are refused", () => {
  const registry = createMetricsRegistry(specs);
  registry.inc("queue_depth", { queue: "outbox" });
  registry.set("jobs_total", { outcome: "done" }, 5);
  assertEquals(registry.snapshot(), []);
  assertEquals(registry.overflow(), 2);
});

Deno.test("hostile labels never throw and never become a label value", () => {
  const registry = createMetricsRegistry(specs);
  const boom = () => {
    throw new Error("trap boom");
  };
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const hostile: unknown[] = [
    new Proxy({}, {
      get: boom,
      has: boom,
      ownKeys: boom,
      getOwnPropertyDescriptor: boom,
    }),
    revoked.proxy,
    {
      get outcome(): string {
        throw new Error("getter boom");
      },
    },
    Object.create({ outcome: "done" }),
    { [Symbol("outcome")]: "done" },
    "outcome=done",
    42,
    [],
    () => "done",
  ];
  for (const labels of hostile) {
    registry.inc("jobs_total", labels as Record<string, unknown>);
  }
  const samples = registry.snapshot();
  assertEquals(samples.length, 1);
  assertEquals(samples[0].labels, { outcome: OTHER_LABEL_VALUE });
  // Nothing is lost: each call counted once, in the other bucket.
  assertEquals(samples[0].value, hostile.length);
});

Deno.test("a snapshot is sorted, bounded and a copy", () => {
  const registry = createMetricsRegistry(specs);
  registry.set("uptime_seconds", {}, 1);
  registry.inc("jobs_total", { outcome: "failed" });
  registry.inc("jobs_total", { outcome: "canceled" });
  registry.inc("jobs_total", { outcome: "done" });
  const first = registry.snapshot();
  assertEquals(
    first.map((s) => `${s.name}/${JSON.stringify(s.labels)}`),
    [
      'jobs_total/{"outcome":"canceled"}',
      'jobs_total/{"outcome":"done"}',
      'jobs_total/{"outcome":"failed"}',
      "uptime_seconds/{}",
    ],
  );
  (first[0] as { value: number }).value = 999;
  (first[0].labels as Record<string, string>).outcome = "tampered";
  assertEquals(registry.snapshot()[0].value, 1);
  assertEquals(registry.snapshot()[0].labels, { outcome: "canceled" });
  assert(registry.snapshot().length <= MAX_TOTAL_SERIES);
});

Deno.test("a definition that would allow unbounded or unsafe series is refused when the registry is made", () => {
  const ok = { kind: "counter", help: "h" } as const;
  const many = (count: number) =>
    Array.from({ length: count }, (_, i) => `v${i}`);
  const bad: Array<[string, MetricSpecs]> = [
    ["upper case metric name", { Jobs: ok }],
    ["metric name with a dash", { "jobs-total": ok }],
    ["metric name too short", { a: ok }],
    ["metric name starting with a digit", { "1jobs": ok }],
    ["metric name too long", { ["a" + "b".repeat(64)]: ok }],
    ["bad kind", { jobs_total: { kind: "histogram" as never, help: "h" } }],
    ["blank help", { jobs_total: { kind: "counter", help: " " } }],
    ["help that is far too long", {
      jobs_total: { kind: "counter", help: "h".repeat(1000) },
    }],
    ["label name upper case", {
      jobs_total: { ...ok, labels: { Outcome: ["a1"] } },
    }],
    ["too many labels", {
      jobs_total: {
        ...ok,
        labels: Object.fromEntries(
          Array.from(
            { length: MAX_METRIC_LABELS + 1 },
            (_, i) => [`l${i}x`, ["a1"]],
          ),
        ),
      },
    }],
    ["no values for a label", {
      jobs_total: { ...ok, labels: { outcome: [] } },
    }],
    ["too many values for a label", {
      jobs_total: { ...ok, labels: { outcome: many(MAX_LABEL_VALUES + 1) } },
    }],
    ["the reserved other value", {
      jobs_total: { ...ok, labels: { outcome: ["done", OTHER_LABEL_VALUE] } },
    }],
    ["a duplicate value", {
      jobs_total: { ...ok, labels: { outcome: ["done", "done"] } },
    }],
    ["a value with a space", {
      jobs_total: { ...ok, labels: { outcome: ["not ok"] } },
    }],
    ["a value that looks like an id", {
      jobs_total: { ...ok, labels: { outcome: [uuid] } },
    }],
    ["a value as long as a hex id", {
      jobs_total: { ...ok, labels: { outcome: ["a" + "b".repeat(31)] } },
    }],
    ["a value with upper case", {
      jobs_total: { ...ok, labels: { outcome: ["Done"] } },
    }],
    ["a value that is far too long", {
      jobs_total: { ...ok, labels: { outcome: ["a".repeat(100)] } },
    }],
    ["a value that is not a string", {
      jobs_total: { ...ok, labels: { outcome: [7 as never] } },
    }],
    ["too many series for one metric", {
      jobs_total: {
        ...ok,
        labels: { aa: many(16), bb: many(16) },
      },
    }],
  ];
  assert(MAX_SERIES_PER_METRIC < 17 * 17);
  for (const [name, definition] of bad) {
    let error: unknown;
    try {
      createMetricsRegistry(definition);
    } catch (caught) {
      error = caught;
    }
    assert(error instanceof RangeError, `${name}: ${String(error)}`);
    assert(
      !String((error as Error).message).includes(uuid),
      `${name} echoed an entry`,
    );
  }
});

Deno.test("too many metrics, and too many series across them, are refused", () => {
  const tooMany = Object.fromEntries(
    Array.from(
      { length: MAX_METRICS + 1 },
      (_, i) => [`metric_${i}x`, { kind: "counter", help: "h" }],
    ),
  ) as MetricSpecs;
  let error: unknown;
  try {
    createMetricsRegistry(tooMany);
  } catch (caught) {
    error = caught;
  }
  assert(error instanceof RangeError);
  // Each of these is within the per-metric limit; together they are not.
  const values = Array.from({ length: 15 }, (_, i) => `v${i}`);
  const wide = Object.fromEntries(
    Array.from({ length: 12 }, (_, i) => [`wide_${i}x`, {
      kind: "counter",
      help: "h",
      labels: { aa: values, bb: values.slice(0, 14) },
    }]),
  ) as MetricSpecs;
  error = undefined;
  try {
    createMetricsRegistry(wide);
  } catch (caught) {
    error = caught;
  }
  assert(error instanceof RangeError, "series across metrics must be bounded");
  // The limits themselves are allowed.
  createMetricsRegistry(
    Object.fromEntries(
      Array.from(
        { length: MAX_METRICS },
        (_, i) => [`metric_${i}x`, { kind: "counter", help: "h" }],
      ),
    ) as MetricSpecs,
  );
});

Deno.test("the definition is copied, so changing it afterwards cannot widen the labels", () => {
  const values = ["done"];
  const definition = {
    jobs_total: { kind: "counter", help: "h", labels: { outcome: values } },
  } as const;
  const registry = createMetricsRegistry(definition as unknown as MetricSpecs);
  values.push("sneaky");
  (definition.jobs_total.labels as Record<string, string[]>).extra = ["x"];
  registry.inc("jobs_total", { outcome: "sneaky" });
  assertEquals(registry.snapshot()[0].labels, { outcome: OTHER_LABEL_VALUE });
});

Deno.test("the version changes exactly when a snapshot would, so equal versions mean equal snapshots", () => {
  const registry = createMetricsRegistry(specs);
  const start = registry.version();
  const versions: number[] = [start];
  const step = (what: string, act: () => void, changes: boolean) => {
    const before = registry.version();
    act();
    const after = registry.version();
    assertEquals(after !== before, changes, what);
    versions.push(after);
  };
  step(
    "a new series appears",
    () => registry.inc("jobs_total", { outcome: "done" }),
    true,
  );
  step(
    "a counter grows",
    () => registry.inc("jobs_total", { outcome: "done" }, 2),
    true,
  );
  step(
    "a counter grows by nothing",
    () => registry.inc("jobs_total", { outcome: "done" }, 0),
    false,
  );
  step("a snapshot is read", () => void registry.snapshot(), false);
  step("overflow is read", () => void registry.overflow(), false);
  step("an unknown metric is refused", () => registry.inc("nope", {}), false);
  step(
    "a negative increment is refused",
    () => registry.inc("jobs_total", { outcome: "done" }, -1),
    false,
  );
  step(
    "a non-number increment is refused",
    () => registry.inc("jobs_total", { outcome: "done" }, "1"),
    false,
  );
  step(
    "a value folds into other, which is a new series",
    () => registry.inc("jobs_total", { outcome: "weird" }),
    true,
  );
  step(
    "that same fold again only grows it",
    () => registry.inc("jobs_total", { outcome: "weird" }, 0),
    false,
  );
  assert(
    versions.every((v, i) => i === 0 || v >= versions[i - 1]!),
    "the version never goes back",
  );
});

Deno.test("a gauge set to the value it already has does not change the version, and a different one does", () => {
  const registry = createMetricsRegistry({
    depth: { kind: "gauge", help: "Depth." },
  });
  registry.set("depth", {}, 3);
  const after = registry.version();
  registry.set("depth", {}, 3);
  assertEquals(registry.version(), after);
  registry.set("depth", {}, 4);
  assert(registry.version() > after);
  registry.set("depth", {}, Number.NaN);
  const refused = registry.version();
  registry.set("depth", {}, Number.NaN);
  assertEquals(registry.version(), refused, "a refused value changes nothing");
});

Deno.test("a counter pinned at its ceiling stops changing the version", () => {
  const registry = createMetricsRegistry({
    big: { kind: "counter", help: "Big." },
  });
  registry.inc("big", {}, Number.MAX_SAFE_INTEGER);
  const pinned = registry.version();
  registry.inc("big", {}, 5);
  assertEquals(registry.version(), pinned, "at the ceiling nothing changes");
});

Deno.test("a series created at zero changes the version, because the snapshot now has an entry it did not have", () => {
  const registry = createMetricsRegistry({
    jobs_total: {
      kind: "counter",
      help: "Jobs.",
      labels: { outcome: ["done"] },
    },
    depth: { kind: "gauge", help: "Depth." },
  });
  const empty = registry.version();
  assertEquals(registry.snapshot().length, 0);
  registry.inc("jobs_total", { outcome: "done" }, 0);
  assertEquals(registry.snapshot().length, 1, "the series exists, at zero");
  assert(
    registry.version() > empty,
    "a counter series created by an increment of nothing",
  );
  const afterCounter = registry.version();
  registry.set("depth", {}, 0);
  assertEquals(registry.snapshot().length, 2);
  assert(
    registry.version() > afterCounter,
    "a gauge series created by a write of zero",
  );
});
