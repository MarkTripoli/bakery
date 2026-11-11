import { sha256Bytes } from "../../apps/server/src/modules/knowledge/bytes.ts";
import { authTestOrigin, openAuthFixture, signSessionCookie } from "./auth.ts";

export type DraftFixture = Awaited<ReturnType<typeof openAuthFixture>> & {
  ids: {
    organizationId: string;
    providerUserId: string;
    principalId: string;
    applicationId: string;
    conversationId: string;
    taskId: string;
    artifactId: string;
    versionId: string;
  };
  email: string;
  cookie: string;
};

export async function openDraftFixture(
  text = "alpha target omega 😀",
  options: Parameters<typeof openAuthFixture>[0] = {},
): Promise<DraftFixture> {
  const fixture = await openAuthFixture(options);
  const ids = {
    organizationId: crypto.randomUUID(),
    providerUserId: crypto.randomUUID(),
    principalId: crypto.randomUUID(),
    applicationId: crypto.randomUUID(),
    conversationId: crypto.randomUUID(),
    taskId: crypto.randomUUID(),
    artifactId: crypto.randomUUID(),
    versionId: crypto.randomUUID(),
  };
  const now = new Date();
  const email = `draft-${ids.providerUserId}@example.test`;
  const token = crypto.randomUUID();
  const content = new TextEncoder().encode(text);
  const digest = await sha256Bytes(content);
  try {
    await fixture.pgDatabase.query(
      `insert into public."user" (
         id,name,email,"emailVerified","createdAt","updatedAt"
       ) values ($1,'Draft Developer',$2,true,$3,$3)`,
      [ids.providerUserId, email, now],
    );
    await fixture.pgDatabase.query(
      `insert into bakery.principals (
         id,provider_user_id,display_name,principal_type
       ) values ($1,$2,'Draft Developer','human')`,
      [ids.principalId, ids.providerUserId],
    );
    await fixture.pgDatabase.query(
      `insert into public.organization (
         id,name,slug,"createdAt","updatedAt"
       ) values ($1,'Draft Organization',$2,$3,$3)`,
      [ids.organizationId, `draft-${ids.organizationId}`, now],
    );
    await fixture.pgDatabase.query(
      `insert into bakery.organizations (
         id,name,slug,metadata,created_at,updated_at
       ) values ($1,'Draft Organization',$2,'{}'::jsonb,$3,$3)`,
      [ids.organizationId, `draft-${ids.organizationId}`, now],
    );
    await fixture.pgDatabase.query(
      `insert into public.member (
         id,"organizationId","userId",role,status,"createdAt","joinedAt","updatedAt"
       ) values ($1,$2,$3,'developer','active',$4,$4,$4)`,
      [crypto.randomUUID(), ids.organizationId, ids.providerUserId, now],
    );
    await fixture.pgDatabase.query(
      `insert into bakery.organization_memberships (
         id,organization_id,principal_id,role,status,joined_at,
         created_at,updated_at,version
       ) values ($1,$2,$3,'developer','active',$4,$4,$4,1)`,
      [crypto.randomUUID(), ids.organizationId, ids.principalId, now],
    );
    await fixture.pgDatabase.query(
      `insert into public.session (
         id,token,"userId","expiresAt","createdAt","updatedAt"
       ) values ($1,$2,$3,$4,$5,$5)`,
      [
        crypto.randomUUID(),
        token,
        ids.providerUserId,
        new Date(Date.now() + 3_600_000),
        now,
      ],
    );
    await fixture.pgDatabase.query(
      `insert into bakery.applications (id,organization_id,slug,name)
       values ($1,$2,'draft-app','Draft Application')`,
      [ids.applicationId, ids.organizationId],
    );
    await fixture.pgDatabase.query(
      `insert into bakery.conversations (
         id,organization_id,application_id,title,created_by
       ) values ($1,$2,$3,'Draft Conversation',$4)`,
      [
        ids.conversationId,
        ids.organizationId,
        ids.applicationId,
        ids.principalId,
      ],
    );
    await fixture.pgDatabase.query(
      `insert into bakery.tasks (
         id,organization_id,application_id,conversation_id,title,task_type,
         status,priority,created_by
       ) values ($1,$2,$3,$4,'Draft Task','feature','active',50,$5)`,
      [
        ids.taskId,
        ids.organizationId,
        ids.applicationId,
        ids.conversationId,
        ids.principalId,
      ],
    );
    await fixture.pgDatabase.query(
      `insert into bakery.artifacts (
         id,organization_id,task_id,artifact_type,name,revision,version
       ) values ($1,$2,$3,'plan','draft source',1,1)`,
      [ids.artifactId, ids.organizationId, ids.taskId],
    );
    await fixture.pgDatabase.query(
      `insert into bakery.artifact_versions (
         id,organization_id,artifact_id,task_id,author_id,revision,metadata,
         content,sha256,size_bytes,media_type
       ) values ($1,$2,$3,$4,$5,1,'{}'::jsonb,$6,$7,$8,'text/markdown')`,
      [
        ids.versionId,
        ids.organizationId,
        ids.artifactId,
        ids.taskId,
        ids.principalId,
        content,
        digest,
        content.length,
      ],
    );
    await fixture.pgDatabase.query(
      `update bakery.artifacts
          set current_version_id=$3
        where organization_id=$1 and id=$2`,
      [ids.organizationId, ids.artifactId, ids.versionId],
    );
    return {
      ...fixture,
      ids,
      email,
      cookie: await signSessionCookie(token, fixture.config.auth!.secret),
    };
  } catch (error) {
    await fixture.close();
    throw error;
  }
}

export function draftRequest(
  fixture: Pick<DraftFixture, "cookie" | "ids">,
  path: string,
  init: RequestInit = {},
  organizationId = fixture.ids.organizationId,
): Request {
  const headers = new Headers(init.headers);
  headers.set("cookie", fixture.cookie);
  headers.set("origin", authTestOrigin);
  headers.set("Bakery-Organization-Id", organizationId);
  return new Request(`${authTestOrigin}${path}`, { ...init, headers });
}

export function jsonDraftRequest(
  fixture: Pick<DraftFixture, "cookie" | "ids">,
  path: string,
  method: "POST" | "PATCH",
  body: unknown,
  organizationId = fixture.ids.organizationId,
): Request {
  return draftRequest(fixture, path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }, organizationId);
}

export async function responseJson(response: Response): Promise<unknown> {
  const value = await response.json();
  if (!response.ok) {
    throw new Error(
      `HTTP_${response.status}:${JSON.stringify(value)}`,
    );
  }
  return value;
}

export async function cleanupDraftFixture(
  fixture: DraftFixture,
): Promise<void> {
  await fixture.pgDatabase.query(
    "delete from bakery.organizations where id=$1",
    [fixture.ids.organizationId],
  );
  await fixture.pgDatabase.query(
    "delete from public.organization where id=$1",
    [fixture.ids.organizationId],
  );
  await fixture.pgDatabase.query(
    "delete from bakery.principals where id=$1",
    [fixture.ids.principalId],
  );
  await fixture.pgDatabase.query(
    'delete from public."user" where id=$1',
    [fixture.ids.providerUserId],
  );
}
