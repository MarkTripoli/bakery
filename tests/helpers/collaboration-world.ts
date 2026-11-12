import { sha256Bytes } from "../../apps/server/src/modules/knowledge/bytes.ts";
import { createInitialDraftCandidate } from "../../apps/server/src/modules/knowledge/drafts.ts";
import { signSessionCookie } from "./auth.ts";
import {
  connectWebSocket,
  type WebSocketHandshakeFailure,
  type WebSocketNext,
  type WsClient,
} from "./ws-client.ts";

/** Runs one owner-role statement; works over an in-process pool or `stack.psql`. */
export type Query = (sql: string, params: unknown[]) => Promise<unknown>;

export type WorldMember = {
  providerUserId: string;
  principalId: string;
  sessionToken: string;
  cookie: string;
  displayName: string;
};

export type CollaborationWorld = {
  organizationId: string;
  artifactId: string;
  versionId: string;
  taskId: string;
  members: WorldMember[];
  /** Removes every row the world created. */
  cleanup(): Promise<void>;
};

/**
 * Seeds one organization with `memberCount` developer members (each with a
 * live session), an application, conversation, task and a text artifact
 * version a draft can be opened on. Owner-role SQL only; no app code runs.
 */
export async function seedCollaborationWorld(
  query: Query,
  secret: string,
  options: { memberCount?: number; text?: string; label?: string } = {},
): Promise<CollaborationWorld> {
  const now = new Date();
  const organizationId = crypto.randomUUID();
  const applicationId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  const taskId = crypto.randomUUID();
  const artifactId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const label = options.label ?? "collab";
  const content = new TextEncoder().encode(
    options.text ?? "alpha target omega",
  );
  const members: WorldMember[] = [];
  await query(
    `insert into public.organization (id,name,slug,"createdAt","updatedAt")
     values ($1,'Collaboration Org',$2,$3,$3)`,
    [organizationId, `${label}-${organizationId}`, now],
  );
  await query(
    `insert into bakery.organizations (id,name,slug,metadata,created_at,updated_at)
     values ($1,'Collaboration Org',$2,'{}'::jsonb,$3,$3)`,
    [organizationId, `${label}-${organizationId}`, now],
  );
  for (let index = 0; index < (options.memberCount ?? 2); index += 1) {
    const providerUserId = crypto.randomUUID();
    const principalId = crypto.randomUUID();
    const sessionToken = crypto.randomUUID();
    const displayName = `Member ${index + 1}`;
    await query(
      `insert into public."user" (id,name,email,"emailVerified","createdAt","updatedAt")
       values ($1,$2,$3,true,$4,$4)`,
      [
        providerUserId,
        displayName,
        `${label}-${providerUserId}@example.test`,
        now,
      ],
    );
    await query(
      `insert into bakery.principals (id,provider_user_id,display_name,principal_type)
       values ($1,$2,$3,'human')`,
      [principalId, providerUserId, displayName],
    );
    await query(
      `insert into public.member (id,"organizationId","userId",role,status,"createdAt","joinedAt","updatedAt")
       values ($1,$2,$3,'developer','active',$4,$4,$4)`,
      [crypto.randomUUID(), organizationId, providerUserId, now],
    );
    await query(
      `insert into bakery.organization_memberships (id,organization_id,principal_id,role,status,joined_at,created_at,updated_at,version)
       values ($1,$2,$3,'developer','active',$4,$4,$4,1)`,
      [crypto.randomUUID(), organizationId, principalId, now],
    );
    await query(
      `insert into public.session (id,token,"userId","expiresAt","createdAt","updatedAt")
       values ($1,$2,$3,$4,$5,$5)`,
      [
        crypto.randomUUID(),
        sessionToken,
        providerUserId,
        new Date(Date.now() + 3_600_000),
        now,
      ],
    );
    members.push({
      providerUserId,
      principalId,
      sessionToken,
      cookie: await signSessionCookie(sessionToken, secret),
      displayName,
    });
  }
  const owner = members[0]!;
  await query(
    `insert into bakery.applications (id,organization_id,slug,name)
     values ($1,$2,$3,'Collaboration Application')`,
    [applicationId, organizationId, `${label}-app-${applicationId}`],
  );
  await query(
    `insert into bakery.conversations (id,organization_id,application_id,title,created_by)
     values ($1,$2,$3,'Collaboration Conversation',$4)`,
    [conversationId, organizationId, applicationId, owner.principalId],
  );
  await query(
    `insert into bakery.tasks (id,organization_id,application_id,conversation_id,title,task_type,status,priority,created_by)
     values ($1,$2,$3,$4,'Collaboration Task','feature','active',50,$5)`,
    [taskId, organizationId, applicationId, conversationId, owner.principalId],
  );
  await query(
    `insert into bakery.artifacts (id,organization_id,task_id,artifact_type,name,revision,version)
     values ($1,$2,$3,'plan','draft source',1,1)`,
    [artifactId, organizationId, taskId],
  );
  await query(
    `insert into bakery.artifact_versions (id,organization_id,artifact_id,task_id,author_id,revision,metadata,content,sha256,size_bytes,media_type)
     values ($1,$2,$3,$4,$5,1,'{}'::jsonb,$6,$7,$8,'text/markdown')`,
    [
      versionId,
      organizationId,
      artifactId,
      taskId,
      owner.principalId,
      content,
      await sha256Bytes(content),
      content.length,
    ],
  );
  await query(
    `update bakery.artifacts set current_version_id=$3 where organization_id=$1 and id=$2`,
    [organizationId, artifactId, versionId],
  );
  return {
    organizationId,
    artifactId,
    versionId,
    taskId,
    members,
    async cleanup() {
      // Deleting the organization cascades its tenant rows; identity rows go after.
      await query("delete from bakery.organizations where id=$1", [
        organizationId,
      ]).catch(() => {});
      await query("delete from public.organization where id=$1", [
        organizationId,
      ]).catch(() => {});
      for (const member of members) {
        await query('delete from public.session where "userId"=$1', [
          member.providerUserId,
        ]).catch(() => {});
        await query("delete from bakery.principals where id=$1", [
          member.principalId,
        ]).catch(() => {});
        await query('delete from public."user" where id=$1', [
          member.providerUserId,
        ]).catch(() => {});
      }
    },
  };
}

/**
 * Inserts an active draft with its initial checkpoint, the rows
 * `drafts.open` writes, built with the same pure Loro candidate. For
 * processes without draft isolation, where `drafts.open` answers 503.
 */
export async function seedDraft(
  query: Query,
  world: CollaborationWorld,
  text: string,
): Promise<string> {
  const candidate = await createInitialDraftCandidate(text);
  const draftId = crypto.randomUUID();
  const checkpointId = crypto.randomUUID();
  await query(
    `insert into bakery.artifact_drafts (id,organization_id,artifact_id,task_id,epoch,base_version_id,server_sequence,status)
     values ($1,$2,$3,$4,1,$5,0,'active')`,
    [
      draftId,
      world.organizationId,
      world.artifactId,
      world.taskId,
      world.versionId,
    ],
  );
  await query(
    `insert into bakery.artifact_draft_checkpoints (id,organization_id,draft_id,epoch,server_sequence,state,frontiers,text_content,text_digest)
     values ($1,$2,$3,1,0,$4,$5,$6,$7)`,
    [
      checkpointId,
      world.organizationId,
      draftId,
      candidate.state,
      candidate.frontiers,
      candidate.text,
      candidate.textDigest,
    ],
  );
  await query(
    `update bakery.artifact_drafts set current_checkpoint_id=$3 where organization_id=$1 and id=$2`,
    [world.organizationId, draftId, checkpointId],
  );
  return draftId;
}

export type Frame = Record<string, unknown> & { type: string };

/**
 * Opens `/v1/collaboration` on `baseUrl` with a member's cookie. The Origin
 * header defaults to `baseUrl`; pass `origin` when the server trusts another.
 */
export async function connectCollaboration(
  baseUrl: string,
  organizationId: string,
  cookie: string | null,
  options: { origin?: string; headers?: Record<string, string> } = {},
): Promise<WsClient | WebSocketHandshakeFailure> {
  const url = new URL("/v1/collaboration", baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("organizationId", organizationId);
  const request = new Headers({
    Origin: options.origin ?? new URL(baseUrl).origin,
    ...options.headers,
  });
  if (cookie !== null) request.set("Cookie", cookie);
  return await connectWebSocket(url, { headers: request });
}

/** Next text frame of `type`, skipping others and binaries; fails on close or timeout. */
export async function untilFrame(
  client: WsClient,
  type: string,
  timeoutMs = 5_000,
): Promise<Frame> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error(`no ${type} frame`);
    const value = await client.nextMessage(left);
    if (typeof value === "object" && "binary" in value) continue;
    if (typeof value !== "string") {
      throw new Error(`socket closed ${value.code} ${value.reason}`);
    }
    const frame = JSON.parse(value) as Frame;
    if (frame.type === type) return frame;
  }
}

/** Everything received within `ms`: text frames, binary count and a close. */
export async function collect(client: WsClient, ms: number): Promise<{
  frames: Frame[];
  binaries: number;
  closed?: { code: number; reason: string };
}> {
  const frames: Frame[] = [];
  let binaries = 0;
  const deadline = Date.now() + ms;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) return { frames, binaries };
    let value: WebSocketNext | { binary: Uint8Array };
    try {
      value = await client.nextMessage(left);
    } catch {
      return { frames, binaries };
    }
    if (typeof value === "object" && "binary" in value) binaries += 1;
    else if (typeof value !== "string") {
      return { frames, binaries, closed: value };
    } else frames.push(JSON.parse(value) as Frame);
  }
}
