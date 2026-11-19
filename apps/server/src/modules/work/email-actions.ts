import { Hono, type MiddlewareHandler } from "hono";
import type { SecretsKeyConfig } from "@bakery/config";
import {
  type ActionAuthorityRunner,
  type ActionContext,
  type ActionDefinition,
  ActionKind,
  ActionRegistry,
  assertRegisteredActions,
  HttpMethod,
} from "@bakery/contracts/action-registry";
import {
  ActionAccess,
  contractSchemas,
  OrganizationContextPolicy,
} from "@bakery/contracts/contracts";
import {
  assertImplementedActionRegistry,
  EmailSettingsImplementedAction as Action,
  emailSettingsImplementedActions,
} from "@bakery/contracts/implemented-actions";
import {
  createApiRouter,
  createNormalizedCommandMetadata,
  requireCommandMetadata,
  StandardError,
  unprocessable,
} from "@bakery/contracts/http";
import type { z } from "zod";
import { PostgresAuthorityRunner } from "../auth/adapters/authority-postgres.ts";
import { recordAuthAudit } from "../auth/application/audit.ts";
import { type AuthVariables, createActionContext } from "../auth/middleware.ts";
import {
  createPostgresCommandRunner,
  readCompletedCommandReplay,
} from "../../platform/command-replay.ts";
import type { PgDatabase } from "../../platform/database.ts";
import { installationActor } from "../integrations/postgres.ts";
import {
  EMAIL_SECURITIES,
  EMAIL_SETTINGS_ID,
  emailProjection,
  type EmailSecurity,
  type EmailTestOutcome,
  openEmailPassword,
  readEmailSettings,
  recordEmailTest,
  revokeEmailSecret,
  sealEmailPassword,
  upsertEmailSettings,
  writeEmailSecretVersion,
} from "./email-settings.ts";
import {
  sendMail,
  type SmtpConnection,
  type SmtpMessage,
  type SmtpOptions,
  type SmtpOutcome,
} from "./smtp-client.ts";

type Put = z.output<typeof contractSchemas.EmailSettingsPut>;
type TestResult = z.output<typeof contractSchemas.EmailTestResult>;

/** What the test action needs that a request cannot supply. */
export type EmailSettingsDependencies = Readonly<{
  secretsKey: SecretsKeyConfig | undefined;
  /** Replaces the real SMTP exchange in tests. */
  send?: (
    connection: SmtpConnection,
    message: SmtpMessage,
    options: SmtpOptions,
  ) => Promise<SmtpOutcome>;
  /** Test environments only: a loopback fixture may speak plain SMTP. */
  allowPlainLoopback?: boolean;
}>;

const HOST_PATTERN = /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/;
const ADDRESS_PATTERN = /^[^\s@<>"',;:\\]+@[^\s@<>"',;:\\]+\.[^\s@<>"',;:\\]+$/;
const LOOPBACK_OR_LINK_LOCAL =
  /^(localhost|127\.|0\.0\.0\.0|169\.254\.|::1$|\[::1\])/i;

function singleLine(value: string): boolean {
  return !/[\r\n\0]/.test(value);
}

/** Validates a save, naming the field and a fixed code, never echoing input. */
function validate(input: Put, dependencies: EmailSettingsDependencies) {
  const host = input.host.trim();
  if (!HOST_PATTERN.test(host)) {
    throw unprocessable(["host"], "invalid_host");
  }
  // The server connects to this host, so a name that points back at the
  // machine itself is refused; only a test fixture may use loopback.
  if (LOOPBACK_OR_LINK_LOCAL.test(host) && !dependencies.allowPlainLoopback) {
    throw unprocessable(["host"], "invalid_host");
  }
  if (!EMAIL_SECURITIES.includes(input.security as EmailSecurity)) {
    throw unprocessable(["security"], "invalid_security");
  }
  const fromAddress = input.fromAddress.trim();
  if (!ADDRESS_PATTERN.test(fromAddress) || !singleLine(fromAddress)) {
    throw unprocessable(["fromAddress"], "invalid_from_address");
  }
  const fromName = input.fromName.trim();
  if (fromName === "" || !singleLine(fromName)) {
    throw unprocessable(["fromName"], "invalid_from_name");
  }
  const username = input.username === undefined || input.username === null ||
      input.username.trim() === ""
    ? null
    : input.username.trim();
  if (username !== null && !singleLine(username)) {
    throw unprocessable(["username"], "invalid_username");
  }
  const password = input.password === undefined || input.password === ""
    ? null
    : input.password;
  if (password !== null && !singleLine(password)) {
    throw unprocessable(["password"], "invalid_password");
  }
  // A password without an account name cannot authenticate.
  if (password !== null && username === null) {
    throw unprocessable(["username"], "username_required");
  }
  return {
    host,
    port: input.port,
    security: input.security as EmailSecurity,
    username,
    fromAddress,
    fromName,
    password,
  };
}

/** emailSettings.get */
export async function getEmailSettings(context: ActionContext) {
  const { context: value } = installationActor(context);
  return emailProjection(await readEmailSettings(value.transaction));
}

/**
 * emailSettings.put: validates, checks If-Match under the row lock, seals a
 * supplied password as the next revision of one installation secret, and saves
 * the settings at the next version with the last test cleared, all in one
 * transaction with its audit row.
 */
export async function putEmailSettings(
  context: ActionContext,
  input: Put,
  dependencies: EmailSettingsDependencies,
) {
  const { context: value, actor } = installationActor(context);
  const principalId = actor.subject.principalId;
  const transaction = value.transaction;
  const settings = validate(input, dependencies);
  const expectedVersion = requireCommandMetadata(context).expectedVersion;
  const stored = await readEmailSettings(transaction, { lock: true });
  if (stored) {
    if (expectedVersion === undefined) {
      throw new StandardError({ code: "PRECONDITION_REQUIRED" });
    }
    if (expectedVersion !== stored.version) {
      throw new StandardError({ code: "PRECONDITION_FAILED" });
    }
  } else if (expectedVersion !== undefined) {
    throw new StandardError({ code: "PRECONDITION_FAILED" });
  }
  // With a stored password and an account name, omitting the password keeps it;
  // clearing the account name while keeping a password cannot authenticate.
  if (
    settings.password === null && stored?.secretId != null &&
    settings.username === null
  ) {
    throw unprocessable(["username"], "username_required");
  }
  const sealed = settings.password === null ? null : await sealEmailPassword(
    dependencies.secretsKey,
    stored,
    settings.password,
  );
  if (sealed) {
    await writeEmailSecretVersion(transaction, sealed, stored, principalId);
  }
  const saved = await upsertEmailSettings(transaction, stored, {
    host: settings.host,
    port: settings.port,
    security: settings.security,
    username: settings.username,
    fromAddress: settings.fromAddress,
    fromName: settings.fromName,
    sealed,
    principalId,
  });
  if (!saved) throw new StandardError({ code: "PRECONDITION_FAILED" });
  const result = await readEmailSettings(transaction);
  // Identifiers, flags and revision numbers only: no password, ciphertext, key
  // id or secret record id.
  await recordAuthAudit(transaction, value, {
    organizationId: null,
    principalId,
    operation: Action.EmailSettingsPut,
    resourceType: "installation_email_settings",
    resourceId: EMAIL_SETTINGS_ID,
    details: {
      replaced: stored !== null,
      passwordRotated: sealed !== null,
      version: result?.version ?? null,
    },
  });
  return emailProjection(result);
}

/** emailSettings.delete: turns email off, removing the stored password from use. */
export async function deleteEmailSettings(context: ActionContext) {
  const { context: value, actor } = installationActor(context);
  const transaction = value.transaction;
  const expectedVersion = requireCommandMetadata(context).expectedVersion;
  if (expectedVersion === undefined) {
    throw new StandardError({ code: "PRECONDITION_REQUIRED" });
  }
  const stored = await readEmailSettings(transaction, { lock: true });
  if (stored === null) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  if (stored.version !== expectedVersion) {
    throw new StandardError({ code: "PRECONDITION_FAILED" });
  }
  await transaction.query(
    "delete from bakery.installation_email_settings where id = $1",
    [EMAIL_SETTINGS_ID],
  );
  if (stored.secretId !== null) {
    await revokeEmailSecret(transaction, stored.secretId);
  }
  await recordAuthAudit(transaction, value, {
    organizationId: null,
    principalId: actor.subject.principalId,
    operation: Action.EmailSettingsDelete,
    resourceType: "installation_email_settings",
    resourceId: EMAIL_SETTINGS_ID,
    details: { passwordRemoved: stored.secretId !== null },
  });
  return null;
}

const testSlot = Symbol("private email test outcome");
type TestedContext = ActionContext & {
  [testSlot]?: {
    outcome: EmailTestOutcome;
    address: string | null;
    version: number;
  };
};

/** What the preparation stage decided before any mail server is called. */
type TestStage =
  | { readonly replay: unknown }
  | {
    readonly outcome: EmailTestOutcome;
    readonly address: string | null;
    readonly version: number;
  }
  | {
    readonly connection: SmtpConnection;
    readonly fromAddress: string;
    readonly fromName: string;
    readonly address: string;
    readonly version: number;
  };

const TEST_MESSAGE: Omit<SmtpMessage, "fromAddress" | "fromName" | "to"> = {
  subject: "Bakery test email",
  text:
    "This is a test email from your Bakery installation. If you can read it, " +
    "Bakery can send email with these settings. No action is needed.",
};

/**
 * emailSettings.test, following the skill storage verify precedent so the mail
 * server is called between committed transactions, never inside one:
 * 1. under the live installation-administrator check, return a completed
 *    replay, else read the saved settings, the administrator's own address and
 *    open the password in memory;
 * 2. send one message outside any transaction, bounded in time;
 * 3. record the fixed outcome through `next` with its audit row.
 * The test goes only to the signed-in administrator's own address.
 */
async function runTest(
  authority: ActionAuthorityRunner,
  action: ActionDefinition,
  context: ActionContext,
  input: unknown,
  next: (context: ActionContext) => Promise<unknown>,
  dependencies: EmailSettingsDependencies,
): Promise<unknown> {
  const parsed = contractSchemas.Empty.parse(input);
  const metadata = createNormalizedCommandMetadata(
    action,
    context.request,
    context.params,
    parsed,
  );
  const stage = await authority.run(
    action,
    context,
    parsed,
    async (authorized): Promise<TestStage> => {
      const { context: value, actor } = installationActor(authorized);
      const replay = await readCompletedCommandReplay({
        context: authorized,
        metadata,
        input: parsed,
      });
      if (replay) return { replay };
      const stored = await readEmailSettings(value.transaction);
      if (stored === null) {
        return { outcome: "not_configured", address: null, version: 0 };
      }
      const owner = await value.transaction.query<{ email: string }>(
        `select account.email
           from bakery.principals as principal
           join public."user" as account
             on account.id = principal.provider_user_id
          where principal.id = $1`,
        [actor.subject.principalId],
      );
      const address = owner.rows[0]?.email;
      if (address === undefined) {
        return {
          outcome: "not_configured",
          address: null,
          version: stored.version,
        };
      }
      const password = await openEmailPassword(
        value.transaction,
        dependencies.secretsKey,
        stored,
      );
      return {
        connection: {
          host: stored.host,
          port: stored.port,
          security: stored.security,
          username: stored.username,
          password,
        },
        // The sender comes from the same read as the connection and the version,
        // so a save that lands while the test is in flight can never produce a
        // message on mixed settings.
        fromAddress: stored.fromAddress,
        fromName: stored.fromName,
        address,
        version: stored.version,
      };
    },
  ) as TestStage;
  if ("replay" in stage) return stage.replay;
  context.signal.throwIfAborted();
  let outcome: EmailTestOutcome;
  let address: string | null;
  if ("outcome" in stage) {
    outcome = stage.outcome;
    address = stage.address;
  } else {
    outcome = await (dependencies.send ?? sendMail)(
      stage.connection,
      {
        ...TEST_MESSAGE,
        fromAddress: stage.fromAddress,
        fromName: stage.fromName,
        to: stage.address,
      },
      {
        signal: context.signal,
        allowPlainLoopback: dependencies.allowPlainLoopback,
      },
    );
    address = stage.address;
  }
  const tested = { outcome, address, version: stage.version };
  return await authority.run(
    action,
    context,
    parsed,
    (authorized) =>
      next(Object.assign(authorized, { [testSlot]: tested }) as TestedContext),
  );
}

/** emailSettings.test, after the send: records and audits the fixed outcome. */
async function recordTest(context: ActionContext): Promise<TestResult> {
  const { context: value, actor } = installationActor(context);
  const tested = (context as TestedContext)[testSlot];
  if (!tested) throw new StandardError({ code: "INTERNAL" });
  if (tested.version > 0) {
    await recordEmailTest(
      value.transaction,
      tested.version,
      tested.outcome,
      tested.address,
      actor.subject.principalId,
    );
  }
  await recordAuthAudit(value.transaction, value, {
    organizationId: null,
    principalId: actor.subject.principalId,
    operation: Action.EmailSettingsTest,
    resourceType: "installation_email_settings",
    resourceId: EMAIL_SETTINGS_ID,
    details: { outcome: tested.outcome },
  });
  return contractSchemas.EmailTestResult.parse({
    outcome: tested.outcome,
    testedAt: new Date().toISOString(),
    address: tested.address,
  });
}

export function createEmailSettingsAuthorityRunner(
  authority: ActionAuthorityRunner,
  dependencies: EmailSettingsDependencies,
): ActionAuthorityRunner {
  return {
    run(action, context, input, next) {
      if (action.name === Action.EmailSettingsTest) {
        return runTest(authority, action, context, input, next, dependencies);
      }
      return authority.run(action, context, input, next);
    },
  };
}

export function createEmailSettingsActionRegistry(
  database: PgDatabase,
  dependencies: EmailSettingsDependencies,
): ActionRegistry {
  const registry = new ActionRegistry(
    createEmailSettingsAuthorityRunner(
      new PostgresAuthorityRunner(database),
      dependencies,
    ),
    createPostgresCommandRunner(),
    "natural-idempotency",
  );
  const policy = {
    access: ActionAccess.InstallationAdministrator,
    organizationContext:
      OrganizationContextPolicy.InstallationAdministratorScope,
  } as const;
  registry.register({
    name: Action.EmailSettingsGet,
    method: HttpMethod.Get,
    path: "/v1/installation/email",
    input: contractSchemas.Empty,
    output: contractSchemas.EmailSettings,
    policy: { ...policy, type: ActionKind.Query },
    handler: getEmailSettings,
  }).register({
    name: Action.EmailSettingsPut,
    method: HttpMethod.Put,
    path: "/v1/installation/email",
    input: contractSchemas.EmailSettingsPut,
    output: contractSchemas.EmailSettings,
    explicitIdempotency: "key",
    policy: { ...policy, type: ActionKind.Command, sessionOnly: true },
    handler: (context, input) =>
      putEmailSettings(context, input as Put, dependencies),
  }).register({
    name: Action.EmailSettingsTest,
    method: HttpMethod.Post,
    path: "/v1/installation/email/test",
    input: contractSchemas.Empty,
    output: contractSchemas.EmailTestResult,
    explicitIdempotency: "key",
    successStatus: 200,
    policy: { ...policy, type: ActionKind.Command, sessionOnly: true },
    handler: recordTest,
  }).register({
    name: Action.EmailSettingsDelete,
    method: HttpMethod.Delete,
    path: "/v1/installation/email",
    input: contractSchemas.Empty,
    output: contractSchemas.NoContent,
    explicitIdempotency: "key-and-if-match",
    policy: { ...policy, type: ActionKind.Command, sessionOnly: true },
    handler: (context) => deleteEmailSettings(context),
  });
  assertRegisteredActions(registry);
  assertImplementedActionRegistry(registry, emailSettingsImplementedActions);
  return registry;
}

export function createEmailSettingsRoutes(options: {
  database: PgDatabase;
  browserSession: MiddlewareHandler<{ Variables: AuthVariables }>;
  publicBaseUrl: string;
  dependencies: EmailSettingsDependencies;
}) {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("/v1/installation/email", options.browserSession);
  app.use("/v1/installation/email/*", options.browserSession);
  app.route(
    "/",
    createApiRouter({
      registry: createEmailSettingsActionRegistry(
        options.database,
        options.dependencies,
      ),
      publicBaseUrl: options.publicBaseUrl,
      createContext: createActionContext,
    }),
  );
  return app;
}
