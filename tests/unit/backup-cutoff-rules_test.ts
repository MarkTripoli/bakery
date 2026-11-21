import { assert, assertEquals } from "@std/assert";
import {
  type Census,
  censusOf,
  compareCensus,
  type EffectRow,
  effectsDigest,
  isLiveEffectStatus,
  LIVE_EFFECT_STATUSES,
  operationKey,
  parseCensus,
  parseCutoff,
  type RestoredEffectRow,
  unknownOutcomeEffects,
} from "../../apps/server/src/modules/backups/cutoff-rules.ts";

// #64 slice C (also #49): the cutoff of a backup and the census of effects that
// could still reach a provider. Pure rules: no database, no network.

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const effect = (
  n: number,
  status: string,
  operation = "github.merge",
): EffectRow => ({
  id: id(n),
  status,
  operation,
});

Deno.test("only prepared, submitted and uncertain effects are unsettled", () => {
  assertEquals([...LIVE_EFFECT_STATUSES], [
    "prepared",
    "submitted",
    "uncertain",
  ]);
  for (const live of ["prepared", "submitted", "uncertain"]) {
    assert(isLiveEffectStatus(live), live);
  }
  for (const settled of ["confirmed", "failed", "", "PREPARED", "canceled"]) {
    assertEquals(isLiveEffectStatus(settled), false, settled);
  }
});

Deno.test("the census counts live effects by status and by operation, and ignores settled ones", async () => {
  const census = await censusOf([
    effect(1, "prepared", "github.merge"),
    effect(2, "submitted", "github.merge"),
    effect(3, "uncertain", "slack.post"),
    effect(4, "confirmed", "github.merge"),
    effect(5, "failed", "slack.post"),
    effect(6, "confirmed", "linear.update"),
  ]);
  assertEquals(
    [census.total, census.prepared, census.submitted, census.uncertain],
    [3, 1, 1, 1],
  );
  // Sorted by name; settled effects never appear, even under a new name.
  assertEquals(census.byOperation, [
    { operation: "github.merge", count: 2 },
    { operation: "slack.post", count: 1 },
  ]);
  assertEquals(parseCensus(census), census);
});

Deno.test("an empty installation has an empty census with the digest of no ids", async () => {
  const census = await censusOf([]);
  assertEquals(census.total, 0);
  assertEquals(census.byOperation, []);
  assertEquals(census.digest, await effectsDigest([]));
  // SHA-256 of the empty text.
  assertEquals(
    census.digest,
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
  assertEquals(parseCensus(census), census);
});

Deno.test("the digest does not depend on the order of the effects, and changes with any of them", async () => {
  const a = [
    effect(1, "prepared"),
    effect(2, "submitted"),
    effect(3, "uncertain"),
  ];
  const forward = await censusOf(a);
  const backward = await censusOf([...a].reverse());
  assertEquals(forward.digest, backward.digest);
  // One more effect, one fewer, or a different one: another digest.
  assert(
    (await censusOf([...a, effect(4, "prepared")])).digest !== forward.digest,
  );
  assert((await censusOf(a.slice(1))).digest !== forward.digest);
  assert(
    (await censusOf([effect(9, "prepared"), ...a.slice(1)])).digest !==
      forward.digest,
  );
  // A status change between live statuses keeps the ids, so the digest holds
  // while the per-status counts show the difference.
  const moved = await censusOf([effect(1, "uncertain"), ...a.slice(1)]);
  assertEquals(moved.digest, forward.digest);
  assertEquals(moved.uncertain, 2);
  // A settled effect is not in the digest at all.
  const withSettled = await censusOf([...a, effect(7, "confirmed")]);
  assertEquals(withSettled.digest, forward.digest);
});

Deno.test("an operation name outside the code-defined shape is counted as other and reveals nothing", async () => {
  assertEquals(
    operationKey("github.pull_request.merge"),
    "github.pull_request.merge",
  );
  assertEquals(operationKey("a"), "a");
  for (
    const odd of [
      "",
      "GitHub.Merge",
      "has space",
      "tenant:acme/secret-project",
      "https://example.test/hook?token=abc",
      "1starts-with-digit",
      "x".repeat(81),
    ]
  ) {
    assertEquals(operationKey(odd), "other", odd);
  }
  const census = await censusOf([
    effect(1, "prepared", "tenant:acme/secret-project"),
    effect(2, "prepared", "https://example.test/hook?token=abc"),
    effect(3, "prepared", "github.merge"),
  ]);
  assertEquals(census.byOperation, [
    { operation: "github.merge", count: 1 },
    { operation: "other", count: 2 },
  ]);
  assert(!JSON.stringify(census).includes("secret-project"));
  assert(!JSON.stringify(census).includes("token"));
});

Deno.test("a census carries no id, target or argument: only counts, names and one digest", async () => {
  const census = await censusOf([
    effect(1, "prepared"),
    effect(2, "submitted"),
  ]);
  assertEquals(Object.keys(census).sort(), [
    "byOperation",
    "digest",
    "prepared",
    "submitted",
    "total",
    "uncertain",
  ]);
  const text = JSON.stringify(census);
  assert(!text.includes(id(1)) && !text.includes(id(2)));
});

const goodCensus: Census = {
  total: 3,
  prepared: 1,
  submitted: 1,
  uncertain: 1,
  byOperation: [{ operation: "a.b", count: 3 }],
  digest: "0".repeat(64),
};

Deno.test("a database cutoff must carry a census that adds up; a host-clock cutoff must not", () => {
  const at = "2026-11-20T12:00:03.250Z";
  assertEquals(parseCutoff({ at, source: "database", effects: goodCensus }), {
    at,
    source: "database",
    effects: goodCensus,
  });
  assertEquals(parseCutoff({ at, source: "host-clock", effects: null }), {
    at,
    source: "host-clock",
    effects: null,
  });
  assertEquals(parseCutoff({ at, source: "host-clock" }), {
    at,
    source: "host-clock",
    effects: null,
  });
  const refused: [unknown, string][] = [
    [null, "missing"],
    ["2026-11-20T12:00:00Z", "missing"],
    [{ at, source: "database" }, "census"],
    [{ at, source: "database", effects: null }, "census"],
    [{ at, source: "host-clock", effects: goodCensus }, "cannot carry"],
    [{ at, source: "somewhere" }, "source"],
    [{ at: "yesterday", source: "host-clock" }, "malformed"],
    [{ at: "2026-11-20 12:00:00", source: "host-clock" }, "malformed"],
    [{ at: "2026-13-45T99:00:00Z", source: "host-clock" }, "malformed"],
    [{ at: 123, source: "host-clock" }, "malformed"],
  ];
  for (const [value, word] of refused) {
    const result = parseCutoff(value);
    assertEquals(typeof result, "string", JSON.stringify(value));
    assert(
      String(result).includes(word),
      `${JSON.stringify(value)}: ${result}`,
    );
  }
});

Deno.test("a census that does not add up, or is malformed, is refused", () => {
  const bad: [Partial<Census> | Record<string, unknown>, string][] = [
    [{ ...goodCensus, total: 4 }, "do not add up"],
    [{ ...goodCensus, prepared: -1 }, "prepared"],
    [{ ...goodCensus, submitted: 1.5 }, "submitted"],
    [{ ...goodCensus, digest: "xyz" }, "digest"],
    [{ ...goodCensus, digest: "A".repeat(64) }, "digest"],
    [{ ...goodCensus, byOperation: "nope" }, "operation counts"],
    [
      { ...goodCensus, byOperation: [{ operation: "a.b", count: 2 }] },
      "do not add up",
    ],
    [
      { ...goodCensus, byOperation: [{ operation: "Bad Name", count: 3 }] },
      "malformed",
    ],
    [
      { ...goodCensus, byOperation: [{ operation: "a.b", count: 0 }] },
      "malformed",
    ],
    [
      {
        ...goodCensus,
        byOperation: [{ operation: "b", count: 2 }, {
          operation: "a",
          count: 1,
        }],
      },
      "sorted",
    ],
    [
      {
        ...goodCensus,
        byOperation: [{ operation: "a", count: 2 }, {
          operation: "a",
          count: 1,
        }],
      },
      "sorted",
    ],
  ];
  for (const [value, word] of bad) {
    const result = parseCensus(value);
    assertEquals(typeof result, "string", JSON.stringify(value).slice(0, 80));
    assert(String(result).includes(word), `${word}: ${result}`);
  }
  assertEquals(typeof parseCensus(null), "string");
  assertEquals(parseCensus(goodCensus), goodCensus);
});

const restored = (
  n: number,
  status: string,
  updatedAt: string,
  operation = "github.merge",
): RestoredEffectRow => ({
  id: id(n),
  status,
  operation,
  updatedAt: new Date(updatedAt),
});

Deno.test("a restore treats every unsettled effect as unknown and none that was settled", () => {
  const cutoff = "2026-11-20T12:00:00.000Z";
  const result = unknownOutcomeEffects(cutoff, [
    restored(1, "prepared", "2026-11-20T11:00:00.000Z"),
    restored(2, "submitted", "2026-11-20T11:30:00.000Z"),
    restored(3, "uncertain", "2026-11-20T11:59:59.999Z"),
    restored(4, "confirmed", "2026-11-20T11:00:00.000Z"),
    restored(5, "failed", "2026-11-20T10:00:00.000Z"),
  ]);
  assertEquals(result.block, [id(1), id(2), id(3)]);
  assertEquals(result.anomalies, []);
});

Deno.test("an effect changed after the cutoff is an anomaly, whatever its status", () => {
  const cutoff = "2026-11-20T12:00:00.000Z";
  const result = unknownOutcomeEffects(cutoff, [
    // Exactly at the cutoff is not after it.
    restored(1, "confirmed", "2026-11-20T12:00:00.000Z"),
    restored(2, "confirmed", "2026-11-20T12:00:00.001Z"),
    restored(3, "prepared", "2026-11-20T12:05:00.000Z"),
    restored(4, "failed", "2026-11-21T00:00:00.000Z"),
  ]);
  assertEquals(result.anomalies, [id(2), id(3), id(4)]);
  // An unsettled effect is blocked either way.
  assertEquals(result.block, [id(3)]);
});

Deno.test("results come back sorted, and a restore of nothing blocks nothing", () => {
  const cutoff = "2026-11-20T12:00:00.000Z";
  const result = unknownOutcomeEffects(cutoff, [
    restored(9, "prepared", "2026-11-20T11:00:00.000Z"),
    restored(2, "prepared", "2026-11-20T11:00:00.000Z"),
  ]);
  assertEquals(result.block, [id(2), id(9)]);
  assertEquals(unknownOutcomeEffects(cutoff, []), { block: [], anomalies: [] });
});

Deno.test("a cutoff time that is not a time is refused, not guessed", () => {
  for (const bad of ["", "soon", "2026-99-99T00:00:00Z"]) {
    let error: unknown;
    try {
      unknownOutcomeEffects(bad, []);
    } catch (caught) {
      error = caught;
    }
    assert(
      error instanceof Error && error.message === "CUTOFF_TIME_INVALID",
      bad,
    );
  }
});

Deno.test("a restored database matches the census it was dumped with, and every difference is named", async () => {
  const rows = [
    effect(1, "prepared", "a.b"),
    effect(2, "submitted", "a.b"),
    effect(3, "uncertain", "c.d"),
  ];
  const recorded = await censusOf(rows);
  // Settled effects and order do not matter.
  assertEquals(
    await compareCensus(
      recorded,
      [...rows].reverse().concat([effect(8, "confirmed")]),
    ),
    [],
  );
  // An effect missing from the restore.
  const missing = await compareCensus(recorded, rows.slice(1));
  assertEquals(missing.map((m) => m.field).sort(), [
    "byOperation",
    "digest",
    "prepared",
    "total",
  ]);
  // An effect that appeared that the census never saw.
  const extra = await compareCensus(recorded, [
    ...rows,
    effect(4, "prepared", "a.b"),
  ]);
  assert(extra.some((m) => m.field === "total" && m.found === 4));
  // The same ids but a different status split: only the counts differ.
  const moved = await compareCensus(recorded, [
    effect(1, "uncertain", "a.b"),
    rows[1],
    rows[2],
  ]);
  assertEquals(moved.map((m) => m.field).sort(), ["prepared", "uncertain"]);
});

Deno.test("the digest is the SHA-256 of the sorted ids, one per line", async () => {
  const ids = [id(3), id(1), id(2)];
  const expected = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode([id(1), id(2), id(3)].join("\n")),
  );
  const hex = [...new Uint8Array(expected)].map((b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
  assertEquals(await effectsDigest(ids), hex);
  // The input is not reordered in place.
  assertEquals(ids, [id(3), id(1), id(2)]);
});
