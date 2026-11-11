import { BakeryException } from "@bakery/contracts/exceptions";
import {
  assessBootstrapState,
  type BootstrapSnapshot,
  type BootstrapState,
  type HumanPrincipalInput,
} from "../domain/bootstrap.ts";
import { normalizeEmail } from "../domain/registration.ts";
import { AuthErrorCode } from "../domain/errors.ts";

class CreateSuperuserError extends BakeryException {
  constructor(code: string) {
    super(code);
    this.name = "CreateSuperuserError";
  }
}

export type CreateSuperuserInput = {
  email: string;
  displayName: string;
  password: string;
};

export type CreateSuperuserResult = {
  status: "completed" | "already-complete";
};

export type BootstrapTransaction = {
  inspect(): Promise<BootstrapState>;
  lockInstallation(): Promise<void>;
  ensureInstallationAdministrator(principalId: string): Promise<void>;
  createAdminMember(userId: string, organizationId: string): Promise<void>;
  createPersonalOrganization(userId: string): Promise<void>;
  upsertHumanPrincipal(user: HumanPrincipalInput): Promise<void>;
  verifyCredentialPassword(userId: string, password: string): Promise<boolean>;
};

export type BootstrapStore = {
  withBootstrapLock<T>(
    work: (transaction: BootstrapTransaction) => Promise<T>,
  ): Promise<T>;
};

export type BootstrapProvider = {
  createUser(input: CreateSuperuserInput): Promise<void>;
};

export type ExecuteCreateSuperuserDependencies = {
  persistence: BootstrapStore;
  provider: BootstrapProvider;
};

function conflict(): never {
  throw new CreateSuperuserError(AuthErrorCode.BootstrapConflict);
}

function failed(): never {
  throw new CreateSuperuserError(AuthErrorCode.BootstrapFailed);
}

async function runProvider(work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch {
    failed();
  }
}

async function requireMatchingPassword(
  transaction: BootstrapTransaction,
  userId: string,
  password: string,
): Promise<void> {
  try {
    if (await transaction.verifyCredentialPassword(userId, password)) return;
  } catch { /* fail closed below */ }
  conflict();
}

export async function executeCreateSuperuser(
  { persistence, provider }: ExecuteCreateSuperuserDependencies,
  input: CreateSuperuserInput,
): Promise<CreateSuperuserResult> {
  const email = normalizeEmail(input.email);
  const displayName = input.displayName.trim();
  if (!email || !displayName || !input.password) {
    throw new CreateSuperuserError(AuthErrorCode.BootstrapInputInvalid);
  }

  return await persistence.withBootstrapLock(async (transaction) => {
    const inspect = async (): Promise<BootstrapSnapshot> => {
      const snapshot = assessBootstrapState(await transaction.inspect(), email);
      if (!snapshot) conflict();
      return snapshot;
    };

    let snapshot = await inspect();
    let user = snapshot.user;

    if (user) {
      await requireMatchingPassword(transaction, user.id, input.password);
    } else {
      await runProvider(() =>
        provider.createUser({ ...input, email, displayName })
      );
      snapshot = await inspect();
      user = snapshot.user;
      if (!user) failed();
    }

    await transaction.lockInstallation();
    snapshot = await inspect();
    if (snapshot.user?.id !== user.id) conflict();
    await requireMatchingPassword(transaction, user.id, input.password);
    if (snapshot.complete) return { status: "already-complete" };

    if (!snapshot.principal) {
      await transaction.upsertHumanPrincipal({
        providerUserId: user.id,
        displayName: user.name,
      });
      snapshot = await inspect();
    }

    if (!snapshot.organization) {
      await transaction.createPersonalOrganization(user.id);
      snapshot = await inspect();
    }

    const organization = snapshot.organization;
    if (!organization) failed();
    if (!snapshot.member) {
      await transaction.createAdminMember(user.id, organization.id);
    }

    snapshot = await inspect();
    if (!snapshot.identityComplete || !snapshot.principal) failed();
    await transaction.ensureInstallationAdministrator(snapshot.principal.id);
    if (!(await inspect()).complete) failed();
    return { status: "completed" };
  });
}
