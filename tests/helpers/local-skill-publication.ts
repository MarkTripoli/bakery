import { assertEquals } from "@std/assert";
import { canonicalJson } from "../../apps/server/src/platform/canonical-json.ts";
import { createSuperuser } from "../../apps/server/src/modules/auth/index.ts";
import type { SkillFileStoreOperations } from "../../apps/server/src/modules/catalog/storage.ts";
import {
  authRequest,
  authTestOrigin,
  cleanupAuthFixture,
  openAuthFixture,
  sessionCookie,
} from "./auth.ts";

export type TestSkill = {
  id: string;
  sourceId: string;
  slug: string;
  name: string;
  activeVersionId: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  version: number;
};

export type TestUploadFile = Readonly<{
  path: string;
  content: Uint8Array;
  mediaType?: string;
  isExecutable?: boolean;
}>;

export type TestUpload = {
  revision: number;
  digest: string;
  entryPath: string;
  manifest: Record<string, unknown> & {
    schemaVersion: number;
    license: string;
    entryPath: string;
    files: Array<{
      path: string;
      mediaType: string;
      sizeBytes: number;
      sha256: string;
      isExecutable: boolean;
    }>;
  };
  files: Array<{
    path: string;
    mediaType: string;
    isExecutable: boolean;
    contentBase64: string;
  }>;
};

export async function sha256(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string"
    ? new TextEncoder().encode(value)
    : value;
  const result = await crypto.subtle.digest(
    "SHA-256",
    new Uint8Array(bytes).buffer as ArrayBuffer,
  );
  return Array.from(
    new Uint8Array(result),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function base64(bytes: Uint8Array): string {
  let encoded = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    encoded += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(encoded);
}

export async function makeUpload(
  files: readonly TestUploadFile[],
  options: Readonly<{
    revision?: number;
    license?: string;
    entryPath?: string;
    manifestExtra?: Record<string, unknown>;
  }> = {},
): Promise<TestUpload> {
  const manifestFiles = await Promise.all(files.map(async (file) => ({
    path: file.path,
    mediaType: file.mediaType ?? "text/markdown",
    sizeBytes: file.content.byteLength,
    sha256: await sha256(file.content),
    isExecutable: file.isExecutable ?? false,
  })));
  const entryPath = options.entryPath ?? files[0]?.path ?? "SKILL.md";
  const manifest = {
    schemaVersion: 1,
    license: options.license ?? "MIT",
    entryPath,
    files: manifestFiles,
    ...options.manifestExtra,
  };
  return {
    revision: options.revision ?? 1,
    digest: await sha256(canonicalJson(manifest)),
    entryPath,
    manifest,
    files: files.map((file) => ({
      path: file.path,
      mediaType: file.mediaType ?? "text/markdown",
      isExecutable: file.isExecutable ?? false,
      contentBase64: base64(file.content),
    })),
  };
}

export type PublicationIdentity = Readonly<{
  email: string;
  password: string;
}>;

export async function openPublicationTestContext(
  options: Readonly<{
    root: string;
    store?: SkillFileStoreOperations;
    identity?: PublicationIdentity;
    secretsKey?: NonNullable<
      Parameters<typeof openAuthFixture>[0]
    >["secretsKey"];
  }>,
): Promise<{
  fixture: Awaited<ReturnType<typeof openAuthFixture>>;
  identity: PublicationIdentity;
  organizationId: string;
  principalId: string;
  cookie: string;
  headers: Record<string, string>;
  createSkill: (slug?: string) => Promise<TestSkill>;
  publish: (
    skillId: string,
    upload: TestUpload,
    idempotencyKey?: string,
    headers?: Record<string, string>,
  ) => Promise<Response>;
  close: (cleanup?: boolean) => Promise<void>;
}> {
  const fixture = await openAuthFixture({
    skillFileRoot: options.root,
    skillFileStore: options.store,
    secretsKey: options.secretsKey,
  });
  const identity = options.identity ?? {
    email: `skill-publication-${crypto.randomUUID()}@example.test`,
    password: `Skill-Publication-${crypto.randomUUID()}`,
  };
  if (!options.identity) {
    await createSuperuser({
      pgDatabase: fixture.pgDatabase,
      config: fixture.config.auth!,
    }, {
      email: identity.email,
      displayName: "Skill Publication Admin",
      password: identity.password,
    });
  }
  const scope = await fixture.pgDatabase.query<{
    organizationId: string;
    principalId: string;
  }>(
    `select membership.organization_id as "organizationId",
            membership.principal_id as "principalId"
       from bakery.organization_memberships as membership
       join bakery.principals as principal on principal.id = membership.principal_id
       join public."user" as provider_user on provider_user.id = principal.provider_user_id
      where provider_user.email = $1 and membership.status = 'active'
      order by membership.created_at
      limit 1`,
    [identity.email],
  );
  const actor = scope.rows[0];
  if (!actor) throw new Error("SKILL_PUBLICATION_ACTOR_MISSING");
  const signIn = await fixture.auth.handler(authRequest(
    "/api/auth/sign-in/email",
    { email: identity.email, password: identity.password },
  ));
  assertEquals(signIn.status, 200, await signIn.clone().text());
  const cookie = sessionCookie(signIn);
  const headers = {
    cookie,
    origin: authTestOrigin,
    "Bakery-Organization-Id": actor.organizationId,
  };
  const createSkill = async (slug = `skill-${crypto.randomUUID()}`) => {
    const response = await fixture.app.fetch(authRequest(
      "/v1/skills",
      { slug, name: `Skill ${slug}` },
      {
        cookie,
        headers: {
          ...headers,
          "Idempotency-Key": `create-${slug}`,
        },
      },
    ));
    assertEquals(response.status, 201, await response.clone().text());
    return await response.json() as TestSkill;
  };
  const publish = async (
    skillId: string,
    upload: TestUpload,
    idempotencyKey = `publish-${skillId}-${upload.revision}`,
    extraHeaders: Record<string, string> = {},
  ) =>
    await fixture.app.fetch(
      new Request(`${authTestOrigin}/v1/skills/${skillId}/versions`, {
        method: "POST",
        headers: {
          ...headers,
          ...extraHeaders,
          "content-type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(upload),
      }),
    );
  return {
    fixture,
    identity,
    organizationId: actor.organizationId,
    principalId: actor.principalId,
    cookie,
    headers,
    createSkill,
    publish,
    async close(cleanup = false) {
      if (cleanup) {
        await cleanupAuthFixture(fixture.pgDatabase, [identity.email]);
      }
      await fixture.close();
    },
  };
}

export async function assertProblem(
  response: Response,
  status: number,
  code: string,
  forbidden: readonly string[] = [],
): Promise<Record<string, unknown>> {
  const text = await response.clone().text();
  assertEquals(response.status, status, text);
  assertEquals(
    response.headers.get("content-type"),
    "application/problem+json",
  );
  const problem = await response.json() as Record<string, unknown>;
  assertEquals(problem.status, status);
  assertEquals(problem.code, code);
  for (const value of forbidden) {
    assertEquals(text.includes(value), false, `problem leaked ${value}`);
  }
  return problem;
}
