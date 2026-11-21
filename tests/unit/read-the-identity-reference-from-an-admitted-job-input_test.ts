import { assertEquals } from "@std/assert";
import { identityRefFromEffectiveInput } from "../../packages/persistence/src/repository-admission.ts";

// A step note left before the step started is appended to the job's input at
// admission (#412). The strict identity parse used to see `stepNotes` as a
// foreign key, so an identity step that had a note was refused on every claim.

const identityRef = "11111111-1111-4111-8111-111111111111";
const repositoryProfile = { repositoryId: "frozen context the server adds" };

Deno.test("the identity reference is read from an input the server added its context to", () => {
  assertEquals(
    identityRefFromEffectiveInput({ identityRef, repositoryProfile }),
    identityRef,
  );
});

Deno.test("step notes appended at admission do not hide the identity reference", () => {
  assertEquals(
    identityRefFromEffectiveInput({
      identityRef,
      repositoryProfile,
      stepNotes: ["look at the second account"],
    }),
    identityRef,
  );
});

Deno.test("a workflow-owned extra field or a missing reference still yields none", () => {
  assertEquals(
    identityRefFromEffectiveInput({ identityRef, repositoryProfile, extra: 1 }),
    null,
  );
  assertEquals(identityRefFromEffectiveInput({ repositoryProfile }), null);
  assertEquals(identityRefFromEffectiveInput({ identityRef: "nope" }), null);
  assertEquals(identityRefFromEffectiveInput(null), null);
  assertEquals(identityRefFromEffectiveInput([identityRef]), null);
});
