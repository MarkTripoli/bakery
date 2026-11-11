import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import type { PgTransactionClient } from "../../packages/persistence/src/postgres.ts";
import {
  canonicalJson,
  sha256Hex,
} from "../../apps/server/src/platform/canonical-json.ts";
import {
  commitArtifactVersion,
} from "../../apps/server/src/modules/knowledge/persistence.ts";
import {
  createTrustedRepositoryResolver,
  prepareArtifactVersionImport,
  proveArtifactVersionImport,
  type TrustedRepositoryScope,
} from "../../apps/server/src/modules/knowledge/import.ts";
import {
  MAX_ARTIFACT_BYTES,
  MAX_ARTIFACT_METADATA_BYTES,
} from "../../packages/contracts/src/contracts.ts";
import {
  readArtifactUpload,
  sha256Bytes,
  validateArtifactUpload,
} from "../../apps/server/src/modules/knowledge/bytes.ts";
import {
  classifyArtifactMedia,
  inferArtifactMediaType,
  storedMediaSafety,
} from "../../apps/server/src/modules/knowledge/media.ts";
import { StandardError } from "../../packages/contracts/src/http.ts";

const scope: TrustedRepositoryScope = {
  organizationId: "00000000-0000-4000-8000-000000000001",
  applicationId: "00000000-0000-4000-8000-000000000002",
  repositoryUuid: "00000000-0000-4000-8000-000000000003",
};
const principalId = "00000000-0000-4000-8000-000000000004";
const artifactId = "00000000-0000-4000-8000-000000000005";
const snapshotSha = "a".repeat(40);
const bareRepositoryPath = "/var/lib/bakery/trusted/repository.git";

type OperatorConfig = {
  schemaVersion: 1;
  entries: Array<{
    organizationId: string;
    applicationId: string;
    repositoryUuid: string;
    bareRepositoryPath: string;
    mappingRevision: string;
    mappingDigest: string;
    snapshotSha: string;
    status: "active" | "revoked";
  }>;
};

async function validOperatorConfig(): Promise<OperatorConfig> {
  const material = {
    applicationId: scope.applicationId,
    bareRepositoryPath,
    mappingRevision: "mapping-1",
    organizationId: scope.organizationId,
    repositoryUuid: scope.repositoryUuid,
    snapshotSha,
    status: "active" as const,
  };
  return {
    schemaVersion: 1,
    entries: [{
      ...material,
      mappingDigest: await sha256Hex(canonicalJson(material)),
    }],
  };
}

async function expectCode(
  work: () => Promise<unknown>,
  code: string,
): Promise<void> {
  const error = await assertRejects(work, StandardError);
  assertEquals(error.code, code);
}

function noQueryTransaction(): PgTransactionClient & { calls: number } {
  const transaction = {
    calls: 0,
    query() {
      transaction.calls += 1;
      throw new Error("unexpected database access");
    },
  };
  return transaction as unknown as PgTransactionClient & { calls: number };
}

Deno.test("trusted repository resolver validates and freezes the operator snapshot", async () => {
  const config = await validOperatorConfig();
  const resolver = createTrustedRepositoryResolver(config);
  const expected = {
    bareRepositoryPath,
    mappingRevision: "mapping-1",
    mappingDigest: config.entries[0].mappingDigest,
    snapshotSha,
  };
  config.entries[0].bareRepositoryPath = "/tmp/changed.git";
  assertEquals(await resolver.resolve(scope), expected);

  const stringResolver = createTrustedRepositoryResolver(
    JSON.stringify(await validOperatorConfig()),
  );
  assertEquals(await stringResolver.resolve(scope), expected);
});

Deno.test("environment configuration is read once at route construction time", async () => {
  const config = await validOperatorConfig();
  const previous = Deno.env.get("BAKERY_TRUSTED_REPOSITORIES_JSON");
  try {
    Deno.env.set(
      "BAKERY_TRUSTED_REPOSITORIES_JSON",
      JSON.stringify(config),
    );
    const resolver = createTrustedRepositoryResolver();
    Deno.env.set("BAKERY_TRUSTED_REPOSITORIES_JSON", "not-json");
    assertEquals(
      (await resolver.resolve(scope)).bareRepositoryPath,
      bareRepositoryPath,
    );
  } finally {
    if (previous === undefined) {
      Deno.env.delete("BAKERY_TRUSTED_REPOSITORIES_JSON");
    } else {
      Deno.env.set("BAKERY_TRUSTED_REPOSITORIES_JSON", previous);
    }
  }
});

Deno.test("missing trusted repository environment fails closed", async () => {
  const previous = Deno.env.get("BAKERY_TRUSTED_REPOSITORIES_JSON");
  try {
    Deno.env.delete("BAKERY_TRUSTED_REPOSITORIES_JSON");
    const resolver = createTrustedRepositoryResolver();
    await expectCode(
      () => resolver.resolve(scope),
      "DEPENDENCY_UNAVAILABLE",
    );
  } finally {
    if (previous === undefined) {
      Deno.env.delete("BAKERY_TRUSTED_REPOSITORIES_JSON");
    } else {
      Deno.env.set("BAKERY_TRUSTED_REPOSITORIES_JSON", previous);
    }
  }
});

Deno.test("resolver rejects bounded, ambiguous, revoked, and digest-invalid config", async () => {
  const base = await validOperatorConfig();
  const overEntryLimit = {
    schemaVersion: 1,
    entries: Array.from({ length: 129 }, (_, index) => ({
      organizationId: crypto.randomUUID(),
      applicationId: crypto.randomUUID(),
      repositoryUuid: crypto.randomUUID(),
      bareRepositoryPath: `/var/lib/bakery/trusted/repository-${index}.git`,
      mappingRevision: "mapping-1",
      mappingDigest: "0".repeat(64),
      snapshotSha,
      status: "active",
    })),
  };
  await expectCode(
    () => createTrustedRepositoryResolver(overEntryLimit).resolve(scope),
    "DEPENDENCY_UNAVAILABLE",
  );

  const overByteLimit = {
    schemaVersion: 1,
    entries: Array.from({ length: 128 }, (_, index) => ({
      organizationId: crypto.randomUUID(),
      applicationId: crypto.randomUUID(),
      repositoryUuid: crypto.randomUUID(),
      bareRepositoryPath: `/var/lib/bakery/trusted/repository-${index}.git`,
      mappingRevision: "r".repeat(128),
      mappingDigest: "0".repeat(64),
      snapshotSha,
      status: "active",
    })),
  };
  await expectCode(
    () =>
      createTrustedRepositoryResolver(JSON.stringify(overByteLimit)).resolve(
        scope,
      ),
    "DEPENDENCY_UNAVAILABLE",
  );

  for (
    const invalidPath of ["/", "relative.git", "/var/lib/../repository.git"]
  ) {
    const invalid = structuredClone(base);
    invalid.entries[0].bareRepositoryPath = invalidPath;
    await expectCode(
      () => createTrustedRepositoryResolver(invalid).resolve(scope),
      "DEPENDENCY_UNAVAILABLE",
    );
  }
  for (const invalidRevision of ["", "mapping\n1", "é".repeat(65)]) {
    const invalid = structuredClone(base);
    invalid.entries[0].mappingRevision = invalidRevision;
    await expectCode(
      () => createTrustedRepositoryResolver(invalid).resolve(scope),
      "DEPENDENCY_UNAVAILABLE",
    );
  }
  const uppercaseSnapshot = structuredClone(base);
  uppercaseSnapshot.entries[0].snapshotSha = "A".repeat(40);
  await expectCode(
    () => createTrustedRepositoryResolver(uppercaseSnapshot).resolve(scope),
    "DEPENDENCY_UNAVAILABLE",
  );
  const revoked = structuredClone(base);
  revoked.entries[0].status = "revoked";
  await expectCode(
    () => createTrustedRepositoryResolver(revoked).resolve(scope),
    "DEPENDENCY_UNAVAILABLE",
  );

  const badDigest = structuredClone(base);
  badDigest.entries[0].mappingDigest = "0".repeat(64);
  await expectCode(
    () => createTrustedRepositoryResolver(badDigest).resolve(scope),
    "DEPENDENCY_UNAVAILABLE",
  );

  const duplicate = structuredClone(base);
  duplicate.entries.push({ ...duplicate.entries[0] });
  await expectCode(
    () => createTrustedRepositoryResolver(duplicate).resolve(scope),
    "DEPENDENCY_UNAVAILABLE",
  );
});

Deno.test("import input and parent preconditions fail before Git or database access", async () => {
  const transaction = noQueryTransaction();
  const resolver = createTrustedRepositoryResolver(await validOperatorConfig());
  const context = {
    organizationId: scope.organizationId,
    principalId,
    artifactId,
    requestId: "unit-import-request",
  };
  const headers = { idempotencyKey: "unit-import", ifMatch: '"v1"' };

  await expectCode(
    () =>
      prepareArtifactVersionImport(
        transaction,
        context,
        headers,
        resolver,
        { path: "../readme.txt", commitSha: snapshotSha },
      ),
    "UNPROCESSABLE",
  );
  await expectCode(
    () =>
      prepareArtifactVersionImport(
        transaction,
        context,
        headers,
        resolver,
        { path: "src/readme.txt", commitSha: "not-a-commit" },
      ),
    "UNPROCESSABLE",
  );
  await expectCode(
    () =>
      prepareArtifactVersionImport(
        transaction,
        context,
        { idempotencyKey: "unit-import", ifMatch: '"v0"' },
        resolver,
        { path: "src/readme.txt", commitSha: snapshotSha },
      ),
    "PRECONDITION_REQUIRED",
  );
  assertEquals(transaction.calls, 0);

  await expectCode(
    () =>
      commitArtifactVersion(transaction, {
        scope: {
          organizationId: scope.organizationId,
          taskId: "00000000-0000-4000-8000-000000000006",
          applicationId: scope.applicationId,
          repositoryId: scope.repositoryUuid,
          conversationId: null,
        },
        parent: {
          id: artifactId,
          revision: 1,
          version: 1,
          currentVersionId: "00000000-0000-4000-8000-000000000007",
        },
        version: {
          parentVersionId: null,
          runStepId: "00000000-0000-4000-8000-000000000008",
          authorId: principalId,
          subjectHeadSha: snapshotSha,
          subjectBaseSha: null,
          stepKey: null,
          metadata: {},
          content: new Uint8Array([1]),
          sha256: "b".repeat(64),
          mediaType: "application/octet-stream",
        },
        promotion: { kind: "human" },
      }),
    "PRECONDITION_REQUIRED",
  );
  assertEquals(transaction.calls, 0);
});
Deno.test("import provenance validation fails before authority and Git access", async () => {
  const transaction = noQueryTransaction();
  const resolver = createTrustedRepositoryResolver(await validOperatorConfig());
  const context = {
    organizationId: scope.organizationId,
    principalId,
    artifactId,
    requestId: "unit-provenance-request",
  };
  const headers = { idempotencyKey: "unit-provenance", ifMatch: '"v1"' };
  const invalidPaths = [
    "",
    "/src/readme.txt",
    "src//readme.txt",
    "src/./readme.txt",
    "src/../readme.txt",
    "src/readme.txt/",
    "src\\readme.txt",
    "src/read\u0000me.txt",
    "src/read\u0001me.txt",
    "\uD800",
  ];
  for (const path of invalidPaths) {
    await expectCode(
      () =>
        prepareArtifactVersionImport(
          transaction,
          context,
          headers,
          resolver,
          { path, commitSha: snapshotSha },
        ),
      "UNPROCESSABLE",
    );
  }
  await expectCode(
    () =>
      prepareArtifactVersionImport(
        transaction,
        context,
        headers,
        resolver,
        {
          path: "src/readme.txt",
          commitSha: snapshotSha,
          repositoryId: scope.repositoryUuid,
        } as unknown as { path: string; commitSha: string },
      ),
    "UNPROCESSABLE",
  );
  assertEquals(transaction.calls, 0);

  const controller = new AbortController();
  controller.abort("caller canceled");
  await expectCode(
    () =>
      proveArtifactVersionImport({
        context: { ...context, signal: controller.signal },
        headers,
        input: { path: "src/readme.txt", commitSha: snapshotSha },
        expectedVersion: 1,
        scope: {
          taskId: "00000000-0000-4000-8000-000000000006",
          applicationId: scope.applicationId,
          repositoryUuid: scope.repositoryUuid,
          conversationId: null,
          parentId: artifactId,
          parentRevision: 1,
          parentVersion: 1,
          currentVersionId: null,
        },
        source: {
          bareRepositoryPath,
          mappingRevision: "mapping-1",
          mappingDigest: "b".repeat(64),
          snapshotSha,
        },
      }),
    "DEPENDENCY_TIMEOUT",
  );
});

Deno.test("bounded media decisions and multipart reader cleanup are consumer-visible", async () => {
  const encoder = new TextEncoder();
  const plain = encoder.encode("plain text");
  assertEquals(
    classifyArtifactMedia({
      declaredType: "text/plain",
      content: plain,
    }),
    {
      mediaType: "text/plain",
      safety: "safe",
      viewerEligible: true,
      attachmentOnly: false,
    },
  );
  assertEquals(
    classifyArtifactMedia({
      declaredType: "text/html",
      content: encoder.encode("<script>alert(1)</script>"),
    }),
    {
      mediaType: "text/html",
      safety: "unsafe",
      viewerEligible: false,
      attachmentOnly: true,
    },
  );
  for (
    const activeDocument of [
      '<div onclick="alert(1)">content</div>',
      '<img src=x alt=">" onerror="alert(1)">',
      '<p onclick="alert(1)">content</p>',
      '<!-- README -->\n<div title=">"><img src=x onerror="alert(1)"></div>',
      "<div><!-- passive comment --><iframe src=/unsafe></iframe></div>",
      "<div><!--><img src=x onerror=alert(1)></div>",
      "<div><!-- passive --!><iframe src=/unsafe></iframe></div>",
      '<div><img src="x"onerror="alert(1)"></div>',
      "<!--><img src=x onerror=alert(1)><!-- -->",
      "<img src=x' onerror=alert(1)>",
      "<x-widget_demo onclick=alert(1)>click</x-widget_demo>",
      "<x.widget onclick=alert(1)>click</x.widget>",
      "<x-é onclick=alert(1)>click</x-é>",
      '<?<x title="><img src=x onerror=alert(1)>">',
      `</div title="<x title='>"><img src=x onerror=alert(1)>'>`,
      '</?<x title="><img src=x onerror=alert(1)>">',
      '<textarea><x title="</textarea><img src=x onerror=alert(1)>">',
      '<xmp><x title="</xmp><img src=x onerror=alert(1)>">',
      "<noembed>active text state</noembed>",
      "<noframes>active text state</noframes>",
      "<noscript>active text state</noscript>",
      "<plaintext>active text state",
      "<template>active content</template>",
      '<math><![CDATA[><x title="]]></math><img src=x onerror=alert(1)>">',
      `<p>README</p><!doctype html public "><x title='"><img src=x onerror=alert(1)>'>`,
      '<s:svg xmlns:s="http://www.w3.org/2000/svg"><s:script>run()</s:script></s:svg>',
      '<_s:svg xmlns:_s="http://www.w3.org/2000/svg"><_s:script>run()</_s:script></_s:svg>',
      '<h:html xmlns:h="http://www.w3.org/1999/xhtml"><h:script>run()</h:script></h:html>',
      '<iframe src="https://example.test/"></iframe>',
      "<svg/>",
      '<!DOCTYPE svg><svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>',
    ]
  ) {
    assertEquals(
      classifyArtifactMedia({
        declaredType: "text/plain",
        content: encoder.encode(activeDocument),
      }),
      null,
      activeDocument,
    );
  }
  for (
    const activeXml of [
      '<s:svg xmlns:s="http://www.w3.org/2000/svg"><s:script>run()</s:script></s:svg>',
      '<h:html xmlns:h="http://www.w3.org/1999/xhtml"><h:script>run()</h:script></h:html>',
      '<_s:svg xmlns:_s="http://www.w3.org/2000/svg"><_s:script>run()</_s:script></_s:svg>',
    ]
  ) {
    assertEquals(
      classifyArtifactMedia({
        declaredType: "application/xml",
        content: encoder.encode(activeXml),
      }),
      null,
      activeXml,
    );
  }
  const svgDoctype =
    '<!DOCTYPE svg><svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>';
  assertEquals(
    classifyArtifactMedia({
      declaredType: "image/svg+xml",
      content: encoder.encode(svgDoctype),
    }),
    {
      mediaType: "image/svg+xml",
      safety: "unsafe",
      viewerEligible: false,
      attachmentOnly: true,
    },
  );
  for (
    const markdown of [
      '<p align="center">project</p>',
      '<div align="center"><img src="badge.png"></div>',
      "<table><tr><td>status</td></tr></table>",
      '<div title="<img src=x onerror=ignored>">quoted text</div>',
      "<div><!-- <script>alert(1)</script> -->safe text</div>",
      "<!-- <!doctype html> -->\n<div>safe README</div>",
      "<!-- markdownlint-disable -->\n# Project",
      '<?<x title="ignored">plain text',
      `</div title="<x title='ignored'>">plain text`,
      '</?<x title="ignored">plain text',
    ]
  ) {
    assertEquals(
      classifyArtifactMedia({
        declaredType: "text/markdown",
        content: encoder.encode(markdown),
      })?.safety,
      "safe",
    );
  }
  assertEquals(
    classifyArtifactMedia({
      declaredType: "application/octet-stream",
      content: new Uint8Array([0, 1, 2]),
    }),
    {
      mediaType: "application/octet-stream",
      safety: "unknown",
      viewerEligible: false,
      attachmentOnly: true,
    },
  );
  assertEquals(
    classifyArtifactMedia({
      declaredType: "image/png",
      content: plain,
    }),
    null,
  );
  assertEquals(storedMediaSafety("image/svg+xml"), "unsafe");
  assertEquals(inferArtifactMediaType("src/readme.TXT"), "text/plain");

  const requestFor = (
    content: Uint8Array,
    metadata: unknown = {},
    contentType = "text/plain",
  ): Request => {
    const form = new FormData();
    form.set("leaseToken", "unit-lease");
    form.set("fence", "1");
    form.set("artifactType", "patch");
    form.set("name", "unit-upload");
    form.set("contentType", contentType);
    form.set("metadata", JSON.stringify(metadata));
    form.set("content", new File([new Uint8Array(content)], "unit.txt"));
    const request = new Request("http://localhost/v1/worker/upload", {
      method: "POST",
      body: form,
    });
    request.headers.set("idempotency-key", "unit-upload");
    return request;
  };

  const exactContent = new Uint8Array(MAX_ARTIFACT_BYTES).fill(0x61);
  const exact = await readArtifactUpload(requestFor(exactContent));
  assertEquals(exact.content.byteLength, MAX_ARTIFACT_BYTES);
  assertEquals(exact.contentSha256, await sha256Bytes(exactContent));

  const metadataBaseBytes = encoder.encode('{"value":""}').byteLength;
  const metadataAtLimit = {
    value: "m".repeat(MAX_ARTIFACT_METADATA_BYTES - metadataBaseBytes),
  };
  assertEquals(
    encoder.encode(JSON.stringify(metadataAtLimit)).byteLength,
    MAX_ARTIFACT_METADATA_BYTES,
  );
  const boundedMetadata = await readArtifactUpload(
    requestFor(new Uint8Array([0x61]), metadataAtLimit),
  );
  assertEquals(boundedMetadata.metadata, metadataAtLimit);

  await expectCode(
    () =>
      readArtifactUpload(
        requestFor(
          new Uint8Array(MAX_ARTIFACT_BYTES + 1).fill(0x61),
        ),
      ),
    "BODY_TOO_LARGE",
  );
  await expectCode(
    () =>
      readArtifactUpload(
        requestFor(new Uint8Array([0x61]), {
          value: "m".repeat(
            MAX_ARTIFACT_METADATA_BYTES - metadataBaseBytes + 1,
          ),
        }),
      ),
    "UNPROCESSABLE",
  );
  const unsafeMediaError = assertThrows(
    () =>
      validateArtifactUpload({
        idempotencyKey: "unit-upload",
        leaseToken: "unit-lease",
        fence: "1",
        artifactType: "patch",
        name: "unit-upload",
        contentType: "image/png",
        content: plain,
        metadata: {},
      }),
    StandardError,
  );
  assertEquals(unsafeMediaError.code, "UNPROCESSABLE");

  let canceled = false;
  const oversizedStream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new Uint8Array(MAX_ARTIFACT_BYTES + 1_048_576 + 1).fill(0x61),
      );
    },
    cancel() {
      canceled = true;
    },
  });
  const oversizedRequest = new Request(
    "http://localhost/v1/worker/upload",
    {
      method: "POST",
      headers: {
        "content-type": "multipart/form-data; boundary=unit",
        "idempotency-key": "unit-overflow",
      },
      body: oversizedStream,
      duplex: "half",
    } as RequestInit,
  );
  await expectCode(
    () => readArtifactUpload(oversizedRequest),
    "BODY_TOO_LARGE",
  );
  assertEquals(canceled, true);
});
