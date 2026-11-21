import { assertEquals } from "@std/assert";
import { createConnection } from "../../apps/server/src/modules/integrations/connections.ts";
import {
  GITHUB_PROVIDER_IDENTITY,
  LINEAR_PROVIDER_IDENTITY,
} from "../../apps/server/src/modules/integrations/registry.ts";

/**
 * The generic connection door, read off the deployed providers.
 *
 * `integrationConnections.create` serves api-token providers only. A provider that
 * binds through a completed auth attempt (GitHub's app install, Linear's OAuth2)
 * answers `STATE_CONFLICT` with `auth_attempt_required`, and an id that is not a
 * deployed provider answers `RESOURCE_NOT_FOUND`. The integration lane proves it
 * against a database; this runs on every pull request, so a regression to
 * "GitHub answers 404 again" is caught without one.
 */

const principalId = "00000000-0000-4000-8000-000000000001";
const subject = { principalId, principalType: "human", displayName: "Ada" };
const context = {
  transaction: {},
  principal: subject,
  authority: {
    organizationId: "00000000-0000-4000-8000-0000000000aa",
    subject,
  },
} as never;

/** What the door answers, as `code:reason`, or `returned` when it did not throw. */
function outcome(providerId: string): string {
  try {
    createConnection(context, {
      providerId,
      displayName: "x",
      settings: {},
    } as never);
    return "returned";
  } catch (error) {
    const failure = error as {
      code?: string;
      params?: { reason?: string };
      message?: string;
    };
    const reason = failure.params?.reason;
    return (failure.code ?? failure.message ?? "error") +
      (reason ? `:${reason}` : "");
  }
}

Deno.test("GitHub and Linear need an auth attempt, and an unknown provider is not found", () => {
  assertEquals(
    outcome(GITHUB_PROVIDER_IDENTITY.uuid),
    "STATE_CONFLICT:auth_attempt_required",
  );
  assertEquals(
    outcome(LINEAR_PROVIDER_IDENTITY.uuid),
    "STATE_CONFLICT:auth_attempt_required",
  );
  assertEquals(outcome(crypto.randomUUID()), "RESOURCE_NOT_FOUND");
});
