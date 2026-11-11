import { assertEquals, assertRejects } from "@std/assert";
import {
  type BootstrapTransaction,
  executeCreateSuperuser,
} from "../../apps/server/src/modules/auth/application/createsuperuser.ts";
import {
  assessBootstrapState,
  type BootstrapState,
} from "../../apps/server/src/modules/auth/domain/bootstrap.ts";

const principalId = "00000000-0000-4000-8000-000000000001";
const input = {
  email: "owner@example.com",
  displayName: "Owner",
  password: "valid-password",
};

function fixture(initial: Partial<BootstrapState> = {}) {
  const events: string[] = [];
  const state: BootstrapState = {
    users: [],
    organizations: [],
    members: [],
    principals: [],
    installation: {
      principalId: null,
      repairVersion: null,
      grantedByPrincipalId: null,
      revoked: false,
    },
    ...initial,
  };
  let credentialValid = true;
  let onLock = () => {};
  const transaction: BootstrapTransaction = {
    inspect: () => Promise.resolve(structuredClone(state)),
    lockInstallation: () => {
      events.push("lock");
      onLock();
      return Promise.resolve();
    },
    verifyCredentialPassword: (_id, password) => {
      events.push("verify");
      return Promise.resolve(credentialValid && password === input.password);
    },
    upsertHumanPrincipal: (user) => {
      events.push("principal");
      state.principals.push({
        id: principalId,
        providerUserId: user.providerUserId,
        principalType: "human",
        disabled: false,
      });
      return Promise.resolve();
    },
    createPersonalOrganization: () => {
      events.push("organization");
      state.organizations.push({
        id: "organization",
        name: "Personal",
        slug: "personal",
      });
      return Promise.resolve();
    },
    createAdminMember: (userId, organizationId) => {
      events.push("member");
      state.members.push({
        id: "member",
        userId,
        organizationId,
        role: "admin",
      });
      return Promise.resolve();
    },
    ensureInstallationAdministrator: (id) => {
      events.push("grant-marker");
      state.installation = {
        principalId: id,
        repairVersion: 1,
        grantedByPrincipalId: id,
        revoked: false,
      };
      return Promise.resolve();
    },
  };
  const dependencies = {
    persistence: {
      withBootstrapLock: async <T>(
        work: (tx: BootstrapTransaction) => Promise<T>,
      ) => {
        const before = structuredClone(state);
        try {
          return await work(transaction);
        } catch (error) {
          const users = state.users;
          Object.assign(state, before, { users });
          throw error;
        }
      },
    },
    provider: {
      createUser: (user: typeof input) => {
        events.push("provider");
        state.users.push({
          id: "provider-user",
          email: user.email,
          name: user.displayName,
        });
        return Promise.resolve();
      },
    },
  };
  return {
    state,
    events,
    transaction,
    dependencies,
    changeCredential: () => {
      credentialValid = false;
    },
    whenLocked: (callback: () => void) => {
      onLock = callback;
    },
  };
}

Deno.test("bootstrap creates provider user before canonical lock and records authenticated self-grant", async () => {
  const f = fixture();
  assertEquals(await executeCreateSuperuser(f.dependencies, input), {
    status: "completed",
  });
  assertEquals(f.events, [
    "provider",
    "lock",
    "verify",
    "principal",
    "organization",
    "member",
    "grant-marker",
  ]);
  assertEquals(f.state.installation.principalId, principalId);
  assertEquals(f.state.installation.grantedByPrincipalId, principalId);
  assertEquals(f.state.installation.repairVersion, 1);
});

Deno.test("bootstrap repairs an authenticated unmarked legacy identity without creating a second user", async () => {
  const f = fixture();
  await executeCreateSuperuser(f.dependencies, input);
  f.state.installation = {
    principalId: null,
    repairVersion: null,
    grantedByPrincipalId: null,
    revoked: false,
  };
  f.events.length = 0;
  assertEquals(await executeCreateSuperuser(f.dependencies, input), {
    status: "completed",
  });
  assertEquals(f.events, ["verify", "lock", "verify", "grant-marker"]);
  assertEquals(f.state.users.length, 1);
});

Deno.test("marked bootstrap rerun uses recorded identity after installation growth", async () => {
  const f = fixture();
  await executeCreateSuperuser(f.dependencies, input);
  f.events.length = 0;
  f.state.organizations.push({ id: "other", name: "Other", slug: "other" });
  f.state.members.push({
    id: "other-member",
    userId: "other-user",
    organizationId: "other",
    role: "member",
  });
  assertEquals(await executeCreateSuperuser(f.dependencies, input), {
    status: "already-complete",
  });
  assertEquals(f.events, ["verify", "lock", "verify"]);
});

Deno.test("unmarked ambiguous legacy state fails before mutation", async () => {
  const f = fixture({
    users: [
      { id: "one", email: input.email, name: "Owner" },
      { id: "two", email: "second@example.com", name: "Second" },
    ],
  });
  await assertRejects(
    () => executeCreateSuperuser(f.dependencies, input),
    Error,
    "AUTH_BOOTSTRAP_CONFLICT",
  );
  assertEquals(f.events, []);
  assertEquals(f.state.installation.principalId, null);
});

Deno.test("bootstrap revalidates password after waiting for settings serialization", async () => {
  const f = fixture({
    users: [{ id: "provider-user", email: input.email, name: "Owner" }],
  });
  f.whenLocked(f.changeCredential);
  await assertRejects(
    () => executeCreateSuperuser(f.dependencies, input),
    Error,
    "AUTH_BOOTSTRAP_CONFLICT",
  );
  assertEquals(f.events, ["verify", "lock", "verify"]);
  assertEquals(f.state.principals, []);
  assertEquals(f.state.installation.principalId, null);
});

Deno.test("disabled, revoked and inconsistent marked bootstrap identities never reactivate", async () => {
  const f = fixture();
  await executeCreateSuperuser(f.dependencies, input);
  const original = structuredClone(f.state);
  for (
    const corrupt of [
      (state: BootstrapState) => {
        state.principals[0]!.disabled = true;
      },
      (state: BootstrapState) => {
        state.installation.revoked = true;
      },
      (state: BootstrapState) => {
        state.installation.repairVersion = 2;
      },
      (state: BootstrapState) => {
        state.installation.grantedByPrincipalId =
          "00000000-0000-4000-8000-000000000002";
      },
    ]
  ) {
    Object.assign(f.state, structuredClone(original));
    corrupt(f.state);
    f.events.length = 0;
    assertEquals(assessBootstrapState(f.state, input.email), null);
    await assertRejects(
      () => executeCreateSuperuser(f.dependencies, input),
      Error,
      "AUTH_BOOTSTRAP_CONFLICT",
    );
    assertEquals(f.events, []);
  }
});

Deno.test("bootstrap owner transaction failure preserves provider user for authenticated recovery", async () => {
  const f = fixture();
  const record = f.transaction.ensureInstallationAdministrator;
  f.transaction.ensureInstallationAdministrator = async (id) => {
    await record(id);
    throw new Error("interrupted");
  };
  await assertRejects(
    () => executeCreateSuperuser(f.dependencies, input),
    Error,
    "interrupted",
  );
  assertEquals(f.state.users.length, 1);
  assertEquals(f.state.principals, []);
  assertEquals(f.state.installation.principalId, null);
  f.transaction.ensureInstallationAdministrator = record;
  assertEquals(await executeCreateSuperuser(f.dependencies, input), {
    status: "completed",
  });
  assertEquals(f.state.users.length, 1);
});
