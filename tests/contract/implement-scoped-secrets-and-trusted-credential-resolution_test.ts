import { assert, assertEquals } from "@std/assert";
import {
  assertDescribedSchema,
  contractSchemas,
  generateContracts,
} from "../../packages/contracts/src/contracts.ts";
import {
  SecretsImplementedAction,
  secretsImplementedActions,
} from "../../packages/contracts/src/implemented-actions.ts";
import { clientManifest } from "../../packages/contracts/generated/client-manifest.ts";
import { createSecretsActionRegistry } from "../../apps/server/src/modules/secrets/actions.ts";

Deno.test("source-described scoped contracts default deny and reject unbounded credential or authority inputs", () => {
  const input = {
    applicationId: crypto.randomUUID(),
    provider: "github",
    name: "Fixture credential",
    value: crypto.randomUUID(),
  };
  const parsed = contractSchemas.SecretCreate.parse(input);
  assertEquals(parsed.allowedPrincipalIds, []);
  assertEquals(parsed.allowedActions, []);
  for (
    const patch of [
      { applicationId: undefined },
      { provider: "other" },
      { value: "x".repeat(4097) },
      { value: "é".repeat(2049) },
      { value: "unsafe\ncredential" },
      { organizationId: crypto.randomUUID() },
      { accountId: "1" },
      { providerUrl: "https://fixture.test" },
      { allowedActions: ["*"] },
    ]
  ) {
    assert(
      !contractSchemas.SecretCreate.safeParse({ ...input, ...patch }).success,
    );
  }
  assert(!contractSchemas.SecretList.safeParse({}).success);
  assert(
    !contractSchemas.SecretGet.safeParse({ id: crypto.randomUUID() }).success,
  );
  for (
    const schema of [
      contractSchemas.SecretCreate,
      contractSchemas.SecretList,
      contractSchemas.SecretGet,
      contractSchemas.SecretRevoke,
      contractSchemas.SecretMetadata,
      contractSchemas["Page<SecretMetadata>"],
    ]
  ) assertDescribedSchema(schema);
});
Deno.test("only complete create/list/get/revoke actions are registered and emitted in client and OpenAPI", () => {
  const registry = createSecretsActionRegistry({
    run: (_action, context, _input, next) => next(context),
  }, "fixture-cursor-key");
  assertEquals(
    registry.list().map((a) => a.name).sort(),
    [...secretsImplementedActions].sort(),
  );
  const names = clientManifest.actions.filter((a) =>
    a.action.startsWith("secrets.")
  )
    .map((a) => a.action).sort();
  assertEquals(names, [...secretsImplementedActions].sort());
  const generated = generateContracts();
  assert(generated.implementedActions.includes(SecretsImplementedAction.Get));
  const paths = generated.openapi.paths as Record<string, unknown>;
  assert(paths["/v1/secrets/{id}"]);
});

Deno.test("revoke source and generated contracts require scoped DELETE JSON and metadata precondition", () => {
  const input = { id: crypto.randomUUID(), applicationId: crypto.randomUUID() };
  assert(contractSchemas.SecretRevoke.safeParse(input).success);
  for (
    const patch of [
      { id: undefined },
      { applicationId: undefined },
      { organizationId: crypto.randomUUID() },
      { provider: "github" },
      { value: "private" },
    ]
  ) {
    assert(
      !contractSchemas.SecretRevoke.safeParse({ ...input, ...patch }).success,
    );
  }
  const descriptor = clientManifest.actions.find((a) =>
    a.action === SecretsImplementedAction.Revoke
  )!;
  assertEquals(descriptor.method, "DELETE");
  assertEquals(descriptor.input, "SecretRevoke");
  assertEquals(descriptor.output, "NoContent");
  assertEquals(descriptor.idempotency, "natural; If-Match required");
  assertEquals(descriptor.idempotencyKeyOptional, true);
  const paths = generateContracts().openapi.paths as Record<string, {
    delete: {
      requestBody: {
        required: boolean;
        content: Record<string, { schema: { $ref: string } }>;
      };
      parameters: { name: string; in: string }[];
    };
  }>;
  const operation = paths["/v1/secrets/{id}"].delete;
  assertEquals(operation.requestBody.required, true);
  assertEquals(
    operation.requestBody.content["application/json"].schema.$ref,
    "#/components/schemas/SecretRevoke",
  );
  assert(
    !operation.parameters.some((p: { name: string; in: string }) =>
      p.name === "applicationId" && p.in === "query"
    ),
  );
  assert(
    operation.parameters.some((p) =>
      p.name === "If-Match" && p.in === "header" && "required" in p &&
      p.required === true
    ),
  );
});
