import { assertEquals } from "@std/assert";
import transport from "../../docs/technical-design/transport-schemas.json" with {
  type: "json",
};
import type {
  AgentVersionCreateConfig,
  ContractInput,
  ContractInputMap,
} from "../../packages/contracts/src/contracts.ts";

type Equal<Left, Right> = (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2) ? true
  : false;
type Expect<Value extends true> = Value;
type ContractInputNamesMatchTransport = Expect<
  Equal<keyof ContractInputMap, keyof typeof transport.inputs>
>;
const _contractInputNamesMatchTransport: ContractInputNamesMatchTransport =
  true;

const validApplication = {
  slug: "bakery",
  name: "Bakery",
  description: "A software factory.",
} satisfies ContractInput<"ApplicationCreate">;
type ApplicationKeys = keyof ContractInput<"ApplicationCreate">;
// @ts-expect-error ApplicationCreate has no ownerId key.
const _invalidApplicationKey: ApplicationKeys = "ownerId";
// @ts-expect-error Unsupported action input names resolve to never.
const _unsupportedActionInput: ContractInput<"UnsupportedActionInput"> = {};

const numericApplicationName: ContractInput<"ApplicationCreate"> = {
  slug: "bakery",
  // @ts-expect-error ApplicationCreate.name is a string in the transport contract.
  name: 42,
  description: "A software factory.",
};

const unrelatedApplicationField: ContractInput<"ApplicationCreate"> = {
  slug: "bakery",
  name: "Bakery",
  description: "A software factory.",
  // @ts-expect-error Strict input keys reject fields absent from the literal definition.
  ownerId: "not-an-application-field",
};

const _invalidWorkerArtifact: ContractInput<"WorkerArtifact"> = {
  leaseToken: "x",
  fence: "1",
  // @ts-expect-error WorkerArtifact.artifactType is a closed transport enum.
  artifactType: "definitely-not-an-artifact-type",
  name: "x",
  contentType: "text/plain",
  content: new Uint8Array(),
  metadata: {},
};

const validAgentConfig: AgentVersionCreateConfig = {
  harness: "codex",
  billing: {
    provider: "openai",
    billingAccountId: "account-1",
    model: "gpt-5",
    billingRoute: "api",
    maxTokens: 1000,
    maxUsdReservation: 1,
    pricingMetadataSnapshot: "snapshot",
  },
};
const validAgentVersion: ContractInput<"AgentVersionCreate"> = {
  revision: 1,
  config: validAgentConfig,
  digest: "a".repeat(64),
};
const _invalidAgentVersionConfig: ContractInput<"AgentVersionCreate"> = {
  revision: 1,
  // @ts-expect-error AgentVersionCreate.config rejects unknown keys.
  config: { harness: "codex", unknown: true },
  digest: "a".repeat(64),
};

Deno.test("contract input map is derived from strict literal fields", () => {
  assertEquals(validApplication.name, "Bakery");
  assertEquals(typeof numericApplicationName.name, "number");
  assertEquals(
    (unrelatedApplicationField as unknown as Record<string, unknown>).ownerId,
    "not-an-application-field",
  );
  assertEquals(validAgentVersion.config.harness, "codex");
});
