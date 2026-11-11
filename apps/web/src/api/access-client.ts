import {
  type ClientInputMap,
  type ClientOutputMap,
  createBakeryClient,
} from "@bakery/contracts/client";

import type { ApiResult } from "./client.ts";

export type MembershipPage = ClientOutputMap["Page<OrganizationMembership>"];
export type Membership = MembershipPage["items"][number];
export type InvitationPage = ClientOutputMap["Page<OrganizationInvitation>"];
export type Invitation = InvitationPage["items"][number];
export type PrincipalPage = ClientOutputMap["Page<Principal>"];
export type PrincipalRecord = PrincipalPage["items"][number];
export type AccessTokenPage = ClientOutputMap["Page<AccessToken>"];
export type AccessTokenRecord = AccessTokenPage["items"][number];
export type AccessTokenCreated = ClientOutputMap["AccessTokenCreated"];
export type AccessBindingPage = ClientOutputMap["Page<AccessBinding>"];
export type AccessBindingRecord = AccessBindingPage["items"][number];
export type MembershipUpdate = ClientInputMap["OrganizationMembershipUpdate"];
export type InvitationCreate = ClientInputMap["OrganizationInvitationCreate"];
export type ServiceAccountCreate = ClientInputMap["PrincipalCreate"];
export type AccessTokenCreate = ClientInputMap["AccessTokenCreate"];
export type AccessBindingCreate = ClientInputMap["AccessBindingCreate"];

type Result<T> = ApiResult<T>;

type Call<Input, Output> = (
  options: Input & {
    readonly organizationId: string;
    readonly signal?: AbortSignal;
  },
) => Promise<Result<Output>>;

type Mutation<Input, Output> = (
  options: Input & {
    readonly organizationId: string;
    readonly idempotencyKey?: string;
    readonly signal?: AbortSignal;
  },
) => Promise<Result<Output>>;

type Paged = { readonly cursor?: string; readonly limit?: number };

/**
 * Organization access administration: members, invitations, service accounts,
 * tokens and resource bindings. Every call names its organization; mutations
 * carry the row version they were made against as a strong `If-Match`.
 */
export type AccessAdminClient = {
  readonly members: {
    readonly list: Call<Paged, MembershipPage>;
    readonly update: Mutation<
      {
        readonly membershipId: string;
        readonly input: MembershipUpdate;
        readonly version: number;
      },
      Membership
    >;
    readonly remove: Mutation<
      { readonly membershipId: string; readonly version: number },
      null
    >;
  };
  readonly invitations: {
    readonly list: Call<Paged, InvitationPage>;
    readonly create: Mutation<
      { readonly input: InvitationCreate },
      Invitation
    >;
    readonly cancel: Mutation<{ readonly invitationId: string }, null>;
  };
  readonly principals: {
    readonly list: Call<Paged, PrincipalPage>;
    readonly create: Mutation<
      { readonly input: ServiceAccountCreate },
      PrincipalRecord
    >;
  };
  readonly tokens: {
    readonly list: Call<Paged, AccessTokenPage>;
    readonly create: Mutation<
      { readonly input: AccessTokenCreate },
      AccessTokenCreated
    >;
    readonly revoke: Mutation<
      { readonly tokenId: string; readonly version: number },
      null
    >;
  };
  readonly bindings: {
    readonly list: Call<Paged, AccessBindingPage>;
    readonly create: Mutation<
      { readonly input: AccessBindingCreate },
      AccessBindingRecord
    >;
    readonly delete: Mutation<
      { readonly bindingId: string; readonly version: number },
      null
    >;
  };
};

export function createAccessAdminClient(options: {
  readonly baseUrl: string;
  readonly fetchImpl: typeof fetch;
  readonly versionEtag: (version: number) => string;
  readonly failed: (error: unknown) => ApiResult<never>;
}): AccessAdminClient {
  const scoped = (organizationId: string) =>
    createBakeryClient({
      baseUrl: options.baseUrl,
      fetch: options.fetchImpl,
      getContext: () => ({ organizationId }),
    }).actions;
  const run = async <T>(work: () => Promise<T>) => {
    try {
      return { ok: true, data: await work() } as const;
    } catch (error) {
      return options.failed(error);
    }
  };
  const page = (value: Paged) => ({
    ...(value.cursor === undefined ? {} : { cursor: value.cursor }),
    ...(value.limit === undefined ? {} : { limit: value.limit }),
  });
  return {
    members: {
      list: (o) =>
        run(() =>
          scoped(o.organizationId)["organizationMemberships.list"](
            { id: o.organizationId, ...page(o) },
            { signal: o.signal },
          )
        ),
      update: (o) =>
        run(() =>
          scoped(o.organizationId)["organizationMemberships.update"](
            { id: o.organizationId, membershipId: o.membershipId, ...o.input },
            {
              ifMatch: options.versionEtag(o.version),
              idempotencyKey: o.idempotencyKey,
              signal: o.signal,
            },
          )
        ),
      remove: (o) =>
        run(async () => {
          await scoped(o.organizationId)["organizationMemberships.delete"](
            { id: o.organizationId, membershipId: o.membershipId },
            {
              ifMatch: options.versionEtag(o.version),
              idempotencyKey: o.idempotencyKey,
              signal: o.signal,
            },
          );
          return null;
        }),
    },
    invitations: {
      list: (o) =>
        run(() =>
          scoped(o.organizationId)["organizationInvitations.list"](
            { id: o.organizationId, ...page(o) },
            { signal: o.signal },
          )
        ),
      create: (o) =>
        run(() =>
          scoped(o.organizationId)["organizationInvitations.create"](
            { id: o.organizationId, ...o.input },
            { idempotencyKey: o.idempotencyKey, signal: o.signal },
          )
        ),
      cancel: (o) =>
        run(async () => {
          await scoped(o.organizationId)["organizationInvitations.cancel"](
            { id: o.organizationId, invitationId: o.invitationId },
            { idempotencyKey: o.idempotencyKey, signal: o.signal },
          );
          return null;
        }),
    },
    principals: {
      list: (o) =>
        run(() =>
          scoped(o.organizationId)["principals.list"](page(o), {
            signal: o.signal,
          })
        ),
      create: (o) =>
        run(() =>
          scoped(o.organizationId)["principals.create"](o.input, {
            idempotencyKey: o.idempotencyKey,
            signal: o.signal,
          })
        ),
    },
    tokens: {
      list: (o) =>
        run(() =>
          scoped(o.organizationId)["accessTokens.list"](page(o), {
            signal: o.signal,
          })
        ),
      create: (o) =>
        run(() =>
          scoped(o.organizationId)["accessTokens.create"](o.input, {
            idempotencyKey: o.idempotencyKey,
            signal: o.signal,
          })
        ),
      revoke: (o) =>
        run(async () => {
          await scoped(o.organizationId)["accessTokens.revoke"](
            { id: o.tokenId },
            {
              ifMatch: options.versionEtag(o.version),
              idempotencyKey: o.idempotencyKey,
              signal: o.signal,
            },
          );
          return null;
        }),
    },
    bindings: {
      list: (o) =>
        run(() =>
          scoped(o.organizationId)["accessBindings.list"](page(o), {
            signal: o.signal,
          })
        ),
      create: (o) =>
        run(() =>
          scoped(o.organizationId)["accessBindings.create"](o.input, {
            idempotencyKey: o.idempotencyKey,
            signal: o.signal,
          })
        ),
      delete: (o) =>
        run(async () => {
          await scoped(o.organizationId)["accessBindings.delete"](
            { id: o.bindingId },
            {
              ifMatch: options.versionEtag(o.version),
              idempotencyKey: o.idempotencyKey,
              signal: o.signal,
            },
          );
          return null;
        }),
    },
  };
}
