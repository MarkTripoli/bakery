-- Mentions that share a conversation (chapter 24, #73). The inbox signal and
-- mark-all-read batches come from 0184_inbox_signal_and_read_batches.
--
-- conversation_access_grants is the direct grant chapter 24 names: one row per
-- person per conversation. A typed mention by someone with sharing authority
-- creates or reactivates it in the same transaction as the message; revoking
-- it is an explicit, version-checked action. Inherited access (an organization
-- role) never has a row here, so removing a grant can never remove that.
-- Repeated provenance (granted again after a revoke) lives in audit_events;
-- this row holds the current grant and who gave it.
create table bakery.conversation_access_grants (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  conversation_id uuid not null,
  principal_id uuid not null,
  granted_by uuid not null,
  source_message_id uuid,
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by uuid,
  version integer not null default 1,
  constraint conversation_access_grants_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint conversation_access_grants_conversation_fk
    foreign key (organization_id, conversation_id)
    references bakery.conversations (organization_id, id) on delete cascade,
  constraint conversation_access_grants_principal_fk
    foreign key (principal_id)
    references bakery.principals (id) on delete cascade,
  constraint conversation_access_grants_granted_by_fk
    foreign key (granted_by)
    references bakery.principals (id) on delete restrict,
  constraint conversation_access_grants_revoked_by_fk
    foreign key (revoked_by)
    references bakery.principals (id) on delete restrict,
  constraint conversation_access_grants_message_fk
    foreign key (organization_id, source_message_id)
    references bakery.messages (organization_id, id),
  constraint conversation_access_grants_one_per_principal
    unique (organization_id, conversation_id, principal_id),
  constraint conversation_access_grants_organization_id_unique
    unique (organization_id, id)
);

-- The authority check reads "does this principal hold a live grant on this
-- conversation"; the unique key above already serves it.
grant select, insert on bakery.conversation_access_grants to bakery_app;
grant update (granted_by, source_message_id, granted_at, revoked_at,
  revoked_by, version)
  on bakery.conversation_access_grants to bakery_app;

-- The typed people a message names. The principal is the identity; the
-- display name is a snapshot for rendering only and never authorizes.
create table bakery.message_mentions (
  organization_id uuid not null,
  message_id uuid not null,
  principal_id uuid not null,
  ordinal integer not null,
  display_name text not null,
  created_at timestamptz not null default now(),
  constraint message_mentions_pkey
    primary key (organization_id, message_id, principal_id),
  constraint message_mentions_message_fk
    foreign key (organization_id, message_id)
    references bakery.messages (organization_id, id) on delete cascade,
  constraint message_mentions_principal_fk
    foreign key (principal_id)
    references bakery.principals (id) on delete cascade
);
grant select, insert on bakery.message_mentions to bakery_app;

-- The same for an artifact comment.
create table bakery.artifact_comment_mentions (
  organization_id uuid not null,
  comment_id uuid not null,
  principal_id uuid not null,
  ordinal integer not null,
  display_name text not null,
  created_at timestamptz not null default now(),
  constraint artifact_comment_mentions_pkey
    primary key (organization_id, comment_id, principal_id),
  constraint artifact_comment_mentions_comment_fk
    foreign key (organization_id, comment_id)
    references bakery.artifact_comments (organization_id, id),
  constraint artifact_comment_mentions_principal_fk
    foreign key (principal_id)
    references bakery.principals (id) on delete cascade
);
grant select, insert on bakery.artifact_comment_mentions to bakery_app;
