import { assertEquals, assertExists } from "@std/assert";
import { createSuperuser } from "../../apps/server/src/modules/auth/index.ts";
import {
  closePgDatabase,
  openPgDatabase,
} from "../../apps/server/src/platform/database.ts";
import { readRuntimeConfig } from "../../packages/config/src/env.ts";
import { authRequest, sessionCookie } from "../helpers/auth.ts";
import { type Stack, upStack } from "./helpers/stack.ts";
import {
  type ReviewFixture,
  seedReviewFixtures,
} from "./helpers/artifact-review-seed.ts";
import {
  ownedProcessGroup,
  terminateProcessGroup,
} from "./helpers/process-group.ts";

type Scope = { principalId: string; organizationId: string };

type ArtifactFixture = {
  scope: Scope;
  applicationId: string;
  conversationId: string;
  taskId: string;
  wrongTaskId: string;
  artifactId: string;
  versionId: string;
  artifactName: string;
  content: Uint8Array;
  contentText: string;
  sha256: string;
};

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
  )
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

async function seedSuperuser(
  stack: Stack,
  email: string,
  password: string,
): Promise<void> {
  const database = openPgDatabase(stack.ownerDatabaseUrl);
  try {
    const config = readRuntimeConfig({
      BAKERY_ENV: "test",
      BAKERY_APP_DATABASE_URL: stack.ownerDatabaseUrl,
      BAKERY_PUBLIC_BASE_URL: stack.origin,
      BETTER_AUTH_SECRET: stack.authSecret,
    }).auth!;
    await createSuperuser({ pgDatabase: database, config }, {
      email,
      displayName: "Seeded artifact read proof",
      password,
    });
  } finally {
    await closePgDatabase(database);
  }
}

async function seedArtifact(
  stack: Stack,
  email: string,
): Promise<ArtifactFixture> {
  const suffix = crypto.randomUUID();
  const applicationId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  const taskId = crypto.randomUUID();
  const wrongTaskId = crypto.randomUUID();
  const artifactId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const artifactName = "Seeded artifact read proof only";
  const contentText = [
    "seeded/read proof only",
    "bounded bytes from owned PostgreSQL artifact storage",
    "not a coding result",
  ].join("\n");
  const content = new TextEncoder().encode(contentText);
  const digest = await sha256(content);
  const database = openPgDatabase(stack.ownerDatabaseUrl);
  try {
    const scopes = await database.query<Scope>(
      `select principal.id as "principalId",
              membership.organization_id as "organizationId"
         from bakery.principals principal
         join public."user" provider_user
           on provider_user.id = principal.provider_user_id
         join bakery.organization_memberships membership
           on membership.principal_id = principal.id
        where provider_user.email = $1
          and membership.role = 'admin'
          and membership.status = 'active'`,
      [email],
    );
    const scope = scopes.rows[0];
    if (!scope) throw new Error("SEEDED_ARTIFACT_SCOPE_REQUIRED");
    await database.query(
      `insert into bakery.applications
         (id, organization_id, slug, name)
       values ($1, $2, $3, $4)`,
      [
        applicationId,
        scope.organizationId,
        `artifact-read-${suffix}`,
        "Seeded artifact read proof app",
      ],
    );
    await database.query(
      `insert into bakery.conversations
         (id, organization_id, application_id, title, created_by)
       values ($1, $2, $3, $4, $5)`,
      [
        conversationId,
        scope.organizationId,
        applicationId,
        "Seeded artifact read proof conversation",
        scope.principalId,
      ],
    );
    await database.query(
      `insert into bakery.tasks
         (id, organization_id, application_id, conversation_id, title,
          description, task_type, status, created_by)
       values
         ($1, $2, $3, $4, 'Seeded artifact link task',
          'Contains deterministic seeded/read proof bytes only.',
          'feature', 'queued', $5),
         ($6, $2, $3, $4, 'Wrong task read boundary',
          'Must not acquire the seeded artifact through a task link.',
          'feature', 'queued', $5)`,
      [
        taskId,
        scope.organizationId,
        applicationId,
        conversationId,
        scope.principalId,
        wrongTaskId,
      ],
    );
    await database.query(
      `insert into bakery.artifacts
         (id, organization_id, task_id, artifact_type, name, revision, version)
       values ($1, $2, $3, 'other', $4, 1, 1)`,
      [artifactId, scope.organizationId, taskId, artifactName],
    );
    await database.query(
      `insert into bakery.artifact_versions
         (id, organization_id, artifact_id, task_id, run_step_id, revision,
          author_id, subject_head_sha, subject_base_sha, step_key, metadata,
          content, sha256, size_bytes, media_type)
       values
         ($1, $2, $3, $4, null, 1, $5, null, null, null, $6::jsonb,
          $7, $8, $9, 'text/plain')`,
      [
        versionId,
        scope.organizationId,
        artifactId,
        taskId,
        scope.principalId,
        JSON.stringify({
          fixture: "seeded/read proof only",
          resultKind: "not-a-coding-result",
        }),
        content,
        digest,
        content.byteLength,
      ],
    );
    await database.query(
      `update bakery.artifacts
          set current_version_id = $1
        where organization_id = $2 and id = $3`,
      [versionId, scope.organizationId, artifactId],
    );
    const stored = await database.query<{
      size: number;
      digest: string;
      content: Uint8Array;
    }>(
      `select octet_length(content)::int as size,
              encode(sha256(content), 'hex') as digest,
              content
         from bakery.artifact_versions
        where organization_id = $1 and id = $2`,
      [scope.organizationId, versionId],
    );
    assertEquals(stored.rows[0]?.size, content.byteLength);
    assertEquals(stored.rows[0]?.digest, digest);
    assertEquals(
      Array.from(stored.rows[0]?.content ?? []),
      Array.from(content),
    );
    return {
      scope,
      applicationId,
      conversationId,
      taskId,
      wrongTaskId,
      artifactId,
      versionId,
      artifactName,
      content,
      contentText,
      sha256: digest,
    };
  } finally {
    await closePgDatabase(database);
  }
}

async function startVite(
  serverOrigin: string,
): Promise<{ origin: string; stop: () => Promise<void> }> {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  const origin = `http://127.0.0.1:${port}`;
  console.log(`ARTIFACT_VITE_E2E_PORT=${port}`);
  const command = new Deno.Command("setsid", {
    args: [
      "pnpm",
      "--dir",
      "apps/web",
      "exec",
      "vite",
      "preview",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
    ],
    env: {
      ...Deno.env.toObject(),
      BAKERY_SERVER_PORT: new URL(serverOrigin).port,
    },
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const group = ownedProcessGroup(command);
  const stdout = new Response(command.stdout).text();
  const stderr = new Response(command.stderr).text();
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await terminateProcessGroup(group);
    await Promise.all([stdout, stderr]);
    console.log("ARTIFACT_VITE_E2E_PROCESS_GROUP_CLEANUP=passed");
  };
  try {
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        if ((await fetch(origin)).ok) return { origin, stop };
      } catch {
        // Vite is still starting.
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("ARTIFACT_VITE_E2E_SERVER_NOT_READY");
  } catch (error) {
    await stop();
    throw error;
  }
}

async function proveInPhoneBrowser(
  baseUrl: string,
  fixture: ArtifactFixture,
  cookie: string,
): Promise<void> {
  const child = new Deno.Command("node", {
    args: ["apps/web/tests/helpers/task-artifact-linked-read-browser.mjs"],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(JSON.stringify({
    baseUrl,
    fixture: {
      organizationId: fixture.scope.organizationId,
      taskId: fixture.taskId,
      wrongTaskId: fixture.wrongTaskId,
      artifactId: fixture.artifactId,
      versionId: fixture.versionId,
      artifactName: fixture.artifactName,
      contentText: fixture.contentText,
      sha256: fixture.sha256,
      sizeBytes: fixture.content.byteLength,
    },
    sessionCookie: cookie,
  })));
  await writer.close();
  const [status, stdout, stderr] = await Promise.all([
    child.status,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  assertEquals(
    status.code,
    0,
    `Artifact browser helper failed with exit code ${status.code}: ${stderr}`,
  );
  assertEquals(stdout.includes("ARTIFACT_PHONE_BROWSER_PROOF=passed"), true);
}

async function proveLiveArtifactBrowsers(
  baseUrl: string,
  fixture: ArtifactFixture,
  review: ReviewFixture,
  credentials: Readonly<
    { email: string; password: string; sessionCookie: string }
  >,
  previewOrigin: string,
): Promise<void> {
  for (const project of ["desktop", "mobile"]) {
    for (
      const spec of [
        "artifact-retrieval",
        "artifact-page-live",
        "artifact-preview-live",
      ]
    ) {
      const result = await new Deno.Command("pnpm", {
        args: [
          "--filter",
          "@bakery/web",
          "exec",
          "playwright",
          "test",
          `tests/${spec}.spec.ts`,
          "--grep",
          "protected artifact|live artifact",
          `--project=${project}`,
          `--output=../../artifacts/ui-baseline/test-results/artifact-live-${project}-${spec}`,
          "--workers=2",
        ],
        env: {
          ...Deno.env.toObject(),
          BASE_URL: baseUrl,
          BAKERY_REAL_API: "1",
          BAKERY_ARTIFACT_EMAIL: credentials.email,
          BAKERY_ARTIFACT_PASSWORD: credentials.password,
          BAKERY_ARTIFACT_SESSION_COOKIE: credentials.sessionCookie,
          BAKERY_ARTIFACT_ORGANIZATION_ID: fixture.scope.organizationId,
          BAKERY_ARTIFACT_TASK_ID: fixture.taskId,
          BAKERY_ARTIFACT_ID: fixture.artifactId,
          BAKERY_ARTIFACT_VERSION_ID: fixture.versionId,
          BAKERY_ARTIFACT_SHA256: fixture.sha256,
          BAKERY_REVIEW_ARTIFACT_ID: review.reviewArtifactId,
          BAKERY_REVIEW_VERSION1_ID: review.reviewVersion1Id,
          BAKERY_REVIEW_VERSION2_ID: review.reviewVersion2Id,
          BAKERY_REVIEW_VERSION1_TEXT: review.reviewVersion1Text.trim(),
          BAKERY_REVIEW_VERSION2_TEXT: review.reviewVersion2Text.trim(),
          BAKERY_EXPIRED_TASK_ID: review.expiredTaskId,
          BAKERY_EXPIRED_ARTIFACT_ID: review.expiredArtifactId,
          BAKERY_EXPIRED_SHA256: review.expiredSha256,
          BAKERY_DENIED_SESSION_COOKIE: review.deniedSessionCookie,
          BAKERY_ARTIFACT_PREVIEW_ORIGIN: previewOrigin,
          BAKERY_PREVIEW_TASK_ID: review.previewTaskId,
          BAKERY_PREVIEW_ARTIFACT_ID: review.previewArtifactId,
          BAKERY_PREVIEW_VERSION_ID: review.previewVersionId,
          BAKERY_PREVIEW_HEADING: review.previewHeading,
        },
        stdout: "piped",
        stderr: "piped",
      }).output();
      const decoder = new TextDecoder();
      const output = `${decoder.decode(result.stdout)}${
        decoder.decode(result.stderr)
      }`
        .replaceAll(credentials.password, "[REDACTED]")
        .replaceAll(review.deniedSessionCookie, "[REDACTED]")
        .replaceAll(credentials.sessionCookie, "[REDACTED]");
      console.log(output);
      assertEquals(
        result.code,
        0,
        `Live artifact ${project} ${spec} Playwright cases failed with exit code ${result.code}`,
      );
    }
  }
}

Deno.test(
  "task artifact link reads immutable bounded bytes from owned PostgreSQL",
  async () => {
    const stack = await upStack("artifact-linked-read");
    let vite: { origin: string; stop: () => Promise<void> } | undefined;
    const email = `e2e-artifact-read-${crypto.randomUUID()}@example.test`;
    const password = `Artifact-Read-${crypto.randomUUID()}`;
    try {
      await seedSuperuser(stack, email, password);
      const fixture = await seedArtifact(stack, email);
      const review = await seedReviewFixtures(stack, fixture.scope, fixture);
      const signIn = await stack.fetch(
        authRequest("/api/auth/sign-in/email", { email, password }),
      );
      assertEquals(signIn.status, 200);
      const cookie = sessionCookie(signIn);
      const headers = {
        cookie,
        "Bakery-Organization-Id": fixture.scope.organizationId,
      };

      const descriptor = await stack.fetch(
        new Request(
          `${stack.origin}/v1/artifacts/${fixture.artifactId}`,
          { headers },
        ),
      );
      assertEquals(descriptor.status, 200, await descriptor.clone().text());
      const descriptorBody = await descriptor.json();
      assertEquals(descriptorBody.taskId, fixture.taskId);
      assertEquals(descriptorBody.currentVersionId, fixture.versionId);

      const versions = await stack.fetch(
        new Request(
          `${stack.origin}/v1/artifacts/${fixture.artifactId}/versions?limit=100`,
          { headers },
        ),
      );
      assertEquals(versions.status, 200, await versions.clone().text());
      const versionsBody = await versions.json();
      assertEquals(versionsBody.items.length, 1);
      assertEquals(versionsBody.items[0].id, fixture.versionId);
      assertEquals(versionsBody.items[0].sha256, fixture.sha256);
      assertEquals(versionsBody.items[0].sizeBytes, fixture.content.byteLength);
      assertEquals(versionsBody.items[0].revision, 1);

      const rangeStart = 7;
      const rangeEnd = 28;
      const ranged = await stack.fetch(
        new Request(
          `${stack.origin}/v1/artifact-versions/${fixture.versionId}/content`,
          { headers: { ...headers, range: `bytes=${rangeStart}-${rangeEnd}` } },
        ),
      );
      assertEquals(ranged.status, 206, await ranged.clone().text());
      assertEquals(
        Array.from(new Uint8Array(await ranged.arrayBuffer())),
        Array.from(fixture.content.slice(rangeStart, rangeEnd + 1)),
      );
      assertEquals(
        ranged.headers.get("content-range"),
        `bytes ${rangeStart}-${rangeEnd}/${fixture.content.byteLength}`,
      );
      assertEquals(ranged.headers.get("etag"), `"${fixture.sha256}"`);

      const wrongTaskList = await stack.fetch(
        new Request(
          `${stack.origin}/v1/artifacts?taskId=${fixture.wrongTaskId}`,
          { headers },
        ),
      );
      assertEquals(wrongTaskList.status, 200);
      assertEquals((await wrongTaskList.json()).items, []);

      const unauthorized = await stack.fetch(
        new Request(
          `${stack.origin}/v1/artifact-versions/${fixture.versionId}/content`,
          {
            headers: {
              "Bakery-Organization-Id": fixture.scope.organizationId,
              range: "bytes=0-3",
            },
          },
        ),
      );
      assertEquals(unauthorized.status, 401);
      assertEquals((await unauthorized.text()).includes("seeded/read"), false);

      assertEquals(
        (await stack.psql<{ role: string }>("select current_user as role"))[0]
          ?.role,
        "bakery",
      );
      const connectedRoles = await stack.psql<{ role: string }>(
        "select distinct usename as role from pg_stat_activity where datname = current_database()",
      );
      assertExists(connectedRoles.find(({ role }) => role === "bakery_app"));
      console.log("OWNED_POSTGRES_AUTH=owner:bakery,server:bakery_app");

      const build = await new Deno.Command("pnpm", {
        args: ["--filter", "@bakery/web", "build"],
        stdout: "inherit",
        stderr: "inherit",
      }).spawn().status;
      assertEquals(build.code, 0, "Artifact web production build failed");
      vite = await startVite(stack.origin);
      // The app is served on 127.0.0.1 (the Vite origin) and previews on
      // localhost, the same server listener under a different host: distinct
      // hostnames mean the preview origin shares no cookie jar with the app.
      const previewOrigin = `http://localhost:${new URL(stack.origin).port}`;
      await stack.restartServer({
        BAKERY_PUBLIC_BASE_URL: vite.origin,
        BAKERY_ARTIFACT_PREVIEW_ORIGIN: previewOrigin,
      });
      await proveInPhoneBrowser(vite.origin, fixture, cookie);
      await proveLiveArtifactBrowsers(vite.origin, fixture, review, {
        email,
        password,
        sessionCookie: cookie,
      }, previewOrigin);
    } finally {
      await vite?.stop();
      await stack.down();
      console.log("ARTIFACT_LINKED_READ_STACK_CLEANUP=passed");
    }
  },
);
