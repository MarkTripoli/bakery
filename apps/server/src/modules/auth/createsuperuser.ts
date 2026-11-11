import type { ServerAuthConfig } from "@bakery/config";
import type { PgDatabase } from "../../platform/database.ts";
import { createReadyAuthProvider } from "./adapters/better-auth.ts";
import { createPostgresAuthPersistence } from "./adapters/postgres.ts";
import {
  type CreateSuperuserInput,
  type CreateSuperuserResult,
  executeCreateSuperuser,
} from "./application/createsuperuser.ts";

export type CreateSuperuserDependencies = {
  pgDatabase: PgDatabase;
  config: ServerAuthConfig;
};

export async function createSuperuser(
  { pgDatabase, config }: CreateSuperuserDependencies,
  input: CreateSuperuserInput,
): Promise<CreateSuperuserResult> {
  const persistence = createPostgresAuthPersistence(pgDatabase);
  const auth = await createReadyAuthProvider({
    pgDatabase,
    config,
    persistence,
  });

  return executeCreateSuperuser({
    persistence,
    provider: {
      async createUser({ email, displayName, password }) {
        await auth.api.signUpEmail({
          body: { email, name: displayName, password, rememberMe: false },
        });
      },
    },
  }, input);
}
