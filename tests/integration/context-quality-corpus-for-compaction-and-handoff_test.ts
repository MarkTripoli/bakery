/**
 * #38 B12.07: a fixed context-quality corpus over the real pack route and a real
 * database. The corpus is small and deterministic so a regression shows as a
 * named failure: the constraints a step must obey are recalled, every citation
 * names the version, digest and byte range it came from, a failed test line
 * survives verbatim, and a tight budget compacts by omitting the lowest priority
 * items and truncating windows, never the required ones.
 */

import { assert, assertEquals } from "@std/assert";
import { retentionFixture } from "../helpers/artifact-retention.ts";
import { sha256Bytes } from "../../apps/server/src/modules/knowledge/bytes.ts";

type Fixture = Awaited<ReturnType<typeof retentionFixture>>;
type Json = Record<string, unknown>;

const CORPUS = {
  constraints: [
    "CONSTRAINT-1: never delete the ledger table.",
    "CONSTRAINT-2: every date is UTC.",
    "CONSTRAINT-3: pagination is keyset, never offset.",
  ].join("\n"),
  decision: "DECISION: the ledger export runs nightly at 02:00 UTC.",
  failedTest:
    "FAILED tests/unit/ledger_test.ts :: keeps its rows after an export ... expected 3 got 2",
  filler: "filler line that carries no constraint\n".repeat(1_500),
} as const;

const GENEROUS = {
  modelContextTokens: 200_000,
  counts: {},
  reserved: {
    output: 8_000,
    toolResults: 4_000,
    compaction: 4_000,
    safetyMargin: 2_000,
  },
};
const TIGHT = {
  modelContextTokens: 1_400,
  counts: {},
  reserved: {
    output: 200,
    toolResults: 200,
    compaction: 200,
    safetyMargin: 100,
  },
};

async function seed(fixture: Fixture, name: string, text: string) {
  const artifactId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const content = new TextEncoder().encode(text);
  await fixture.pgDatabase.query(
    "insert into bakery.artifacts(id,organization_id,task_id,artifact_type,name) values($1,$2,$3,'plan',$4)",
    [artifactId, fixture.organizationId, fixture.job.taskId, name],
  );
  await fixture.pgDatabase.query(
    `insert into bakery.artifact_versions(id,organization_id,artifact_id,task_id,author_id,revision,content,sha256,size_bytes,media_type,retention_class)
     values($1,$2,$3,$4,$5,1,$6,$7,$8,'text/plain','evidence')`,
    [
      versionId,
      fixture.organizationId,
      artifactId,
      fixture.job.taskId,
      fixture.principalId,
      content,
      await sha256Bytes(content),
      content.length,
    ],
  );
  return { versionId, content, sha256: await sha256Bytes(content) };
}

function candidate(
  itemId: string,
  artifactVersionId: string,
  priority: number,
  required: boolean,
  maxBytes = 4_096,
) {
  return {
    itemId,
    kind: "artifact",
    artifactVersionId,
    startByte: 0,
    maxBytes,
    priority,
    required,
  };
}

function build(fixture: Fixture, envelope: unknown, candidates: unknown[]) {
  return Promise.resolve(fixture.app.fetch(
    new Request(fixture.config.publicBaseUrl + "/v1/context-packs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: fixture.config.publicBaseUrl,
        "Bakery-Organization-Id": fixture.organizationId,
        Cookie: fixture.adminCookie,
      },
      body: JSON.stringify({ envelope, candidates }),
    }),
  ));
}

async function corpus(fixture: Fixture) {
  const constraints = await seed(fixture, "constraints", CORPUS.constraints);
  const decision = await seed(fixture, "decision", CORPUS.decision);
  const failed = await seed(fixture, "failed test", CORPUS.failedTest);
  const filler = await seed(fixture, "filler", CORPUS.filler);
  return {
    seeded: { constraints, decision, failed, filler },
    candidates: [
      candidate("constraints", constraints.versionId, 0, true),
      candidate("decision", decision.versionId, 1, false),
      candidate("failed", failed.versionId, 2, false),
      candidate("filler", filler.versionId, 9, false, 4_096),
    ],
  };
}

Deno.test("the corpus pack recalls every constraint, cites exactly, and keeps the failed test", async () => {
  const fixture = await retentionFixture();
  try {
    const { seeded, candidates } = await corpus(fixture);
    const response = await build(fixture, GENEROUS, candidates);
    assertEquals(response.status, 200, await response.clone().text());
    const pack = await response.json() as Json;
    assertEquals(pack.omitted, []);
    const items = new Map(
      (pack.items as Json[]).map((item) => [String(item.itemId), item]),
    );

    // Constraint recall: every constraint line is in the pack, verbatim.
    const constraintText = String(items.get("constraints")!.text);
    for (const line of CORPUS.constraints.split("\n")) {
      assert(constraintText.includes(line), "recalled: " + line);
    }
    // The failed test survives verbatim.
    assertEquals(String(items.get("failed")!.text), CORPUS.failedTest);

    // Citation correctness: version, digest and byte range name the exact
    // bytes the item's text was read from.
    const byId = {
      constraints: seeded.constraints,
      decision: seeded.decision,
      failed: seeded.failed,
      filler: seeded.filler,
    } as const;
    for (const [itemId, source] of Object.entries(byId)) {
      const item = items.get(itemId)!;
      const citation = item.citation as Json;
      assertEquals(citation.versionId, source.versionId, itemId);
      assertEquals(citation.sha256, source.sha256, itemId);
      const location = citation.location as {
        startByte: number;
        endByteExclusive: number;
      };
      const cited = new TextDecoder().decode(
        source.content.subarray(location.startByte, location.endByteExclusive),
      );
      assertEquals(String(item.text), cited, itemId + " cites its own bytes");
    }
    // The long filler is cut to its window and says so.
    assertEquals(items.get("filler")!.truncated, true);
    assert(String(items.get("filler")!.text).length <= 4_096);
  } finally {
    await fixture.closeRetention();
  }
});

Deno.test("a tight budget keeps the required constraints, drops the lowest priority first, and is repeatable", async () => {
  const fixture = await retentionFixture();
  try {
    const { candidates } = await corpus(fixture);
    const first = await build(fixture, TIGHT, candidates);
    assertEquals(first.status, 200, await first.clone().text());
    const pack = await first.json() as Json;
    const kept = (pack.items as Json[]).map((item) => String(item.itemId));
    const omitted = (pack.omitted as Json[]).map((entry) =>
      String(entry.itemId)
    );

    // The required constraints are never compacted away.
    assert(
      kept.includes("constraints"),
      "required item kept: " + JSON.stringify(pack),
    );
    const constraintText = String(
      (pack.items as Json[]).find((item) => item.itemId === "constraints")!
        .text,
    );
    for (const line of CORPUS.constraints.split("\n")) {
      assert(constraintText.includes(line), "still recalled: " + line);
    }
    // The budget fits the three small items and not the 60 KB filler, which is
    // the lowest priority: exactly it is dropped, nothing else, and the reason
    // is named. Nothing that is kept is cut short.
    assertEquals(kept, ["constraints", "decision", "failed"]);
    assertEquals(pack.omitted, [{ itemId: "filler", reason: "over_budget" }]);
    assertEquals(omitted, ["filler"]);
    assert(
      (pack.items as Json[]).every((item) => item.truncated === false),
      "kept items are whole",
    );
    // The same request builds the same pack.
    const again = await build(fixture, TIGHT, candidates);
    assertEquals((await again.json() as Json).packDigest, pack.packDigest);
  } finally {
    await fixture.closeRetention();
  }
});
