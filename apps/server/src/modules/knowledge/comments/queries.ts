import type { ActionContext } from "@bakery/contracts/action-registry";
import { contractSchemas } from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import type { z } from "zod";
import { decodeCursor, encodeCursor } from "../../../platform/cursor.ts";
import { sha256Hex } from "../../../platform/canonical-json.ts";
import { requireWorkTransaction } from "../../work/work-transaction.ts";
import {
  commentColumns,
  type CommentRow,
  loadComment,
  loadVersion,
  toComment,
} from "./rows.ts";
import { redactCommentAnchor } from "./redaction.ts";
import { commentPlacement } from "./placement.ts";

type Query = z.infer<typeof contractSchemas.CommentQuery>;

export function commentQueries(secret: string) {
  return async (context: ActionContext, input: Query, across: boolean) => {
    const work = requireWorkTransaction(context);
    if (input.rootId && input.status) {
      throw new StandardError({ code: "UNPROCESSABLE" });
    }
    const routeId = context.params.id;
    let artifactId: string;
    if (across) {
      const parent = await work.transaction.query<{ id: string }>(
        `select id from bakery.artifacts where organization_id=$1 and id=$2`,
        [work.organizationId, routeId],
      );
      if (!parent.rows[0]) {
        throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
      }
      artifactId = parent.rows[0].id;
    } else artifactId = (await loadVersion(work, routeId)).artifact_id;
    if (input.rootId) {
      const root = await loadComment(work, input.rootId);
      const source = await loadVersion(work, root.artifact_version_id);
      if (
        root.parent_comment_id !== null || source.artifact_id !== artifactId ||
        (!across && root.artifact_version_id !== routeId)
      ) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
    }
    const view = input.viewVersionId
      ? await loadVersion(work, input.viewVersionId, { bytes: true })
      : undefined;
    if (view && view.artifact_id !== artifactId) {
      throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
    }
    const binding = {
      action: across
        ? "artifactComments.listAcrossVersions"
        : "artifactComments.list",
      principalId: work.principalId,
      organizationId: work.organizationId,
      ordering: "createdAt:asc,id:asc",
      schemaVersion: 1,
      filters: await sha256Hex(
        JSON.stringify({
          routeId,
          rootId: input.rootId ?? null,
          status: input.status ?? null,
          viewVersionId: input.viewVersionId ?? null,
        }),
      ),
    };
    const position = await decodeCursor(secret, input.cursor, binding);
    const limit = input.limit ?? 25;
    const result = await work.transaction.query<CommentRow>(
      `select ${commentColumns}
      from bakery.artifact_comments c join bakery.artifact_versions v on v.organization_id=c.organization_id and v.id=c.artifact_version_id
      where c.organization_id=$1 and v.artifact_id=$2 and ($3::uuid is null or v.id=$3)
      and c.parent_comment_id is not distinct from $4::uuid
      and ($5::text is null or c.status=$5)
      and ($6::timestamptz is null or (c.created_at,c.id)>($6,$7::uuid))
      order by c.created_at,c.id limit $8`,
      [
        work.organizationId,
        artifactId,
        across ? null : routeId,
        input.rootId ?? null,
        input.status ?? null,
        position?.createdAt ?? null,
        position?.id ?? null,
        limit + 1,
      ],
    );
    const rows = result.rows.slice(0, limit);
    const items = [];
    for (const row of rows) {
      const comment = toComment(row);
      if (!view) {
        items.push(comment);
        continue;
      }
      const placement = commentPlacement(
        row.anchor === null
          ? null
          : contractSchemas.CommentAnchor.parse(row.anchor),
        await loadVersion(work, row.artifact_version_id),
        view,
      );
      items.push({
        ...comment,
        placement: {
          ...placement,
          anchor: redactCommentAnchor(
            placement.anchor,
            row.deleted_at !== null,
          ),
        },
      });
    }
    const last = rows.at(-1);
    return {
      items,
      nextCursor: result.rows.length > limit && last
        ? await encodeCursor(secret, binding, {
          id: last.id,
          createdAt: last.cursor_created_at,
        })
        : null,
    };
  };
}
