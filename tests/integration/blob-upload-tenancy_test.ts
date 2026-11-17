/**
 * The tenancy boundary on every blob upload path.
 *
 * A principal must not be able to touch an upload session it does not own, and
 * no organization may reach another's session at all. Both halves are proved
 * separately here because they fail differently: a cross-organization attempt
 * is stopped by the schema's composite foreign key, a structural refusal, while
 * a foreign principal inside the same organization has nothing structural
 * stopping it and must be refused by the server.
 *
 * The distinction matters for what a caller sees. A structural refusal surfaces
 * as a driver error, which a route can only report as an internal failure; a
 * server refusal is typed and names what was wrong. So the server must not lean
 * on the foreign key for the principal half — there is no key to lean on.
 */

import { assertEquals } from "@std/assert";
import { withPgTransaction } from "@bakery/persistence";
import {
  completeUploadSession,
  putUploadPart,
  startUploadSession,
} from "../../apps/server/src/modules/knowledge/blobs.ts";
import { sha256Bytes } from "../../apps/server/src/modules/knowledge/bytes.ts";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";

const DIGEST = await sha256Bytes(new TextEncoder().encode("part bytes"));

/**
 * Seeds a second principal in the same organization.
 *
 * Inserted directly because the point of the test is the boundary, not the
 * invitation flow: what matters is that the row is a real principal belonging to
 * the same organization as the session's owner.
 */
async function seedSiblingPrincipal(
  fixture: Parameters<Parameters<typeof withWorkerFixture>[0]>[0],
): Promise<string> {
  return await withPgTransaction(fixture.pgDatabase, async (tx) => {
    // Principals are global; membership is what ties one to an organization.
    // The sibling is a full member of the SAME organization, which is the case
    // no foreign key can catch.
    const principal = await tx.query<{ id: string }>(
      `insert into bakery.principals (id, display_name, principal_type)
       values ($1, 'Sibling', 'service')
       returning id`,
      [crypto.randomUUID()],
    );
    await tx.query(
      `insert into bakery.organization_memberships
         (id, organization_id, principal_id, role, status, joined_at,
          created_at, updated_at)
       values ($1, $2, $3, 'member', 'active', now(), now(), now())`,
      [crypto.randomUUID(), fixture.organizationId, principal.rows[0].id],
    );
    return principal.rows[0].id;
  });
}

Deno.test("a principal cannot write a part to another principal's session", () =>
  withWorkerFixture(async (fixture) => {
    const session = await withPgTransaction(
      fixture.pgDatabase,
      (tx) =>
        startUploadSession(tx, {
          organizationId: fixture.organizationId,
          principalId: fixture.principalId,
          sha256: DIGEST,
          sizeBytes: 1024,
          mediaType: "application/octet-stream",
        }),
    );

    const sibling = await seedSiblingPrincipal(fixture);

    // The sibling is in the same organization, so the composite foreign key
    // permits this row. Only the server can refuse it.
    let refused: unknown;
    try {
      await withPgTransaction(fixture.pgDatabase, (tx) =>
        putUploadPart(tx, {
          organizationId: fixture.organizationId,
          principalId: sibling,
          sessionId: session.id,
          partNumber: 1,
          sha256: DIGEST,
          content: new TextEncoder().encode("part bytes"),
        }));
    } catch (error) {
      refused = error;
    }
    assertEquals(
      (refused as { code?: string } | undefined)?.code,
      "RESOURCE_NOT_FOUND",
      "a foreign principal must be refused, not silently allowed",
    );
  }));

Deno.test("a principal cannot complete another principal's session", () =>
  withWorkerFixture(async (fixture) => {
    const session = await withPgTransaction(
      fixture.pgDatabase,
      (tx) =>
        startUploadSession(tx, {
          organizationId: fixture.organizationId,
          principalId: fixture.principalId,
          sha256: DIGEST,
          sizeBytes: 1024,
          mediaType: "application/octet-stream",
        }),
    );
    const sibling = await seedSiblingPrincipal(fixture);

    let refused: unknown;
    try {
      await withPgTransaction(
        fixture.pgDatabase,
        (tx) =>
          completeUploadSession(tx, {
            organizationId: fixture.organizationId,
            principalId: sibling,
            sessionId: session.id,
            blobId: session.id,
          }),
      );
    } catch (error) {
      refused = error;
    }
    assertEquals(
      (refused as { code?: string } | undefined)?.code,
      "RESOURCE_NOT_FOUND",
    );
  }));

Deno.test("an organization cannot reach another organization's session", () =>
  withWorkerFixture(async (fixture) => {
    const session = await withPgTransaction(
      fixture.pgDatabase,
      (tx) =>
        startUploadSession(tx, {
          organizationId: fixture.organizationId,
          principalId: fixture.principalId,
          sha256: DIGEST,
          sizeBytes: 1024,
          mediaType: "application/octet-stream",
        }),
    );

    // A second organization, with its own principal.
    const other = await withPgTransaction(fixture.pgDatabase, async (tx) => {
      const org = await tx.query<{ id: string }>(
        `insert into bakery.organizations (id, name, slug, created_at, updated_at)
         values ($1, 'Other', $2, now(), now()) returning id`,
        [crypto.randomUUID(), `other-${crypto.randomUUID()}`],
      );
      const principal = await tx.query<{ id: string }>(
        `insert into bakery.principals (id, display_name, principal_type)
         values ($1, 'Outsider', 'service') returning id`,
        [crypto.randomUUID()],
      );
      await tx.query(
        `insert into bakery.organization_memberships
           (id, organization_id, principal_id, role, status, joined_at,
            created_at, updated_at)
         values ($1, $2, $3, 'member', 'active', now(), now(), now())`,
        [crypto.randomUUID(), org.rows[0].id, principal.rows[0].id],
      );
      return {
        organizationId: org.rows[0].id,
        principalId: principal.rows[0].id,
      };
    });

    let refused: unknown;
    try {
      await withPgTransaction(fixture.pgDatabase, (tx) =>
        putUploadPart(tx, {
          organizationId: other.organizationId,
          principalId: other.principalId,
          sessionId: session.id,
          partNumber: 1,
          sha256: DIGEST,
          content: new TextEncoder().encode("part bytes"),
        }));
    } catch (error) {
      refused = error;
    }
    // The composite foreign key catches this, but the server must refuse it as
    // a typed miss rather than letting the driver's message become the answer.
    assertEquals(
      (refused as { code?: string } | undefined)?.code,
      "RESOURCE_NOT_FOUND",
      "a foreign organization must be a typed miss, not a driver error",
    );
  }));
