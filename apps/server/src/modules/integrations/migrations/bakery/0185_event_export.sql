-- Event export: subscriptions, destinations and the delivery projection
-- (issue #21, B11.03).
--
-- * integration_destinations: where an organization's events are sent. The
--   origin is stored as an origin and path, never as a free-form URL, so a
--   dispatch rereads it and can never be pointed somewhere the subscription did
--   not authorize. The secret is a reference to a stored secret version, never
--   the material. `recovery_identity` is the stable name a receiver can key
--   idempotency on across retries; it is immutable, so a retry after a
--   redeploy presents the same identity.
-- * integration_event_subscriptions: which exact event kinds an organization
--   exports from which source resource to which destination. Event kinds are an
--   array because a subscription names a set, and an empty set is a
--   subscription that exports nothing rather than one that exports everything.
--   `authorization_revision` is the connection revision the subscription was
--   granted under, so a revoked grant is visible at export time.
-- * integration_deliveries: one row per (subscription, event) attempt. The
--   unique identity is (subscription_id, source_event_id, attempt), so a retry
--   is a new attempt of the same delivery rather than a new delivery, and a
--   replay of the same event cannot silently fork the delivery identity.
--
-- Structure only. The state machines, event-kind matching, acknowledgement
-- semantics, export authorization and SSRF checks are enforced in TypeScript by
-- Zod-parsed rows, per the PostgreSQL boundary rails: no CHECK constraints, no
-- triggers, no functions.
--
-- Grants follow 0143: application roles insert and read freely, and may update
-- only the columns whose lifecycle transitions the application performs.
--
-- Delivery history is protected by two independent doors, because closing only
-- one is not enough. There is no DELETE grant on integration_deliveries, and
-- every foreign key that reaches a delivery is ON DELETE RESTRICT rather than
-- CASCADE. A CASCADE would have defeated the missing grant entirely: Postgres
-- performs referential actions without checking the deleting role's privilege
-- on the referencing table, so a role holding DELETE on a subscription could
-- have erased its deliveries through the cascade. That is not theoretical -
-- it was reproduced on a real database against the CASCADE version of this
-- file, where bakery_app held no DELETE on deliveries and still took the row
-- count from 1 to 0 by deleting the subscription. Retiring a subscription or a
-- destination is therefore a status change, never a row delete.

create table bakery.integration_destinations (
  id uuid primary key,
  organization_id uuid not null,
  connection_id uuid not null,
  installation_id uuid not null,
  kind text not null,
  origin text not null,
  path text not null,
  secret_version_id uuid not null,
  recovery_identity text not null,
  status text not null,
  health text not null,
  acknowledgement_state text not null,
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  next_allowed_at timestamptz,
  last_problem_code text,
  tombstoned_at timestamptz,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  version integer not null,

  constraint integration_destinations_organization_id_unique
    unique (organization_id, id),
  constraint integration_destinations_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint integration_destinations_connection_fk
    foreign key (organization_id, connection_id)
    references bakery.integration_connections (organization_id, id)
    on delete cascade,
  -- The stable name a receiver deduplicates on. Unique per organization so two
  -- destinations can never appear to a receiver as one.
  constraint integration_destinations_recovery_identity_unique
    unique (organization_id, recovery_identity),
  -- Superset of (organization_id, id), so it constrains nothing new; it exists
  -- only so a child can name the destination AND its connection in one key.
  constraint integration_destinations_connection_identity_unique
    unique (organization_id, id, connection_id)
);

-- Dispatch reads due destinations by organization; the secondary index exists
-- so the connection cascade finds its referencing rows instead of scanning.
create index integration_destinations_due_idx
  on bakery.integration_destinations (organization_id, next_allowed_at);

-- The source resource must belong to the same connection as the subscription.
-- integration_resources is already unique on (organization_id, id), so this
-- superset key constrains nothing new; it exists so the child key can name the
-- connection as well.
alter table bakery.integration_resources
  add constraint integration_resources_connection_identity_unique
  unique (organization_id, id, connection_id);

create table bakery.integration_event_subscriptions (
  id uuid primary key,
  organization_id uuid not null,
  connection_id uuid not null,
  installation_id uuid not null,
  destination_id uuid not null,
  source_resource_id uuid not null,
  event_kinds text[] not null,
  authorization_revision integer not null,
  status text not null,
  revoked_at timestamptz,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  version integer not null,

  constraint integration_event_subscriptions_organization_id_unique
    unique (organization_id, id),
  -- Superset of (organization_id, id); lets a delivery name its subscription
  -- and that subscription's destination in one key.
  constraint integration_event_subscriptions_destination_identity_unique
    unique (organization_id, id, destination_id),
  constraint integration_event_subscriptions_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint integration_event_subscriptions_connection_fk
    foreign key (organization_id, connection_id)
    references bakery.integration_connections (organization_id, id)
    on delete cascade,
  -- Composite keys pin the destination and the source to the same
  -- organization and connection, so a subscription cannot name another
  -- tenant's destination or a resource it never had access to.
  -- Both keys carry connection_id, so a subscription cannot pair its own
  -- connection with another connection's destination or source resource.
  constraint integration_event_subscriptions_destination_fk
    foreign key (organization_id, destination_id, connection_id)
    references bakery.integration_destinations (organization_id, id, connection_id)
    on delete restrict,
  constraint integration_event_subscriptions_source_fk
    foreign key (organization_id, source_resource_id, connection_id)
    references bakery.integration_resources (organization_id, id, connection_id)
    on delete restrict
);

create index integration_event_subscriptions_connection_idx
  on bakery.integration_event_subscriptions (connection_id, installation_id);

-- Export asks "which subscriptions want this event from this resource", so the
-- lookup is by source resource, not by organization alone.
create index integration_event_subscriptions_source_idx
  on bakery.integration_event_subscriptions (source_resource_id, status);

create table bakery.integration_deliveries (
  id uuid primary key,
  organization_id uuid not null,
  subscription_id uuid not null,
  destination_id uuid not null,
  source_event_id text not null,
  event_kind text not null,
  attempt integer not null,
  delivery_identity text not null,
  payload_digest text not null,
  status text not null,
  acknowledgement_state text not null,
  response_status integer,
  outcome_code text,
  not_before timestamptz,
  attempted_at timestamptz,
  settled_at timestamptz,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  version integer not null,

  constraint integration_deliveries_organization_id_unique
    unique (organization_id, id),
  constraint integration_deliveries_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  -- RESTRICT, not CASCADE: a delivery records an attempt that may already have
  -- reached a receiver, and a cascade would let a role with DELETE on the
  -- parent erase that history without ever holding DELETE here. Retiring a
  -- subscription or destination is a status change, not a row delete.
  constraint integration_deliveries_subscription_fk
    foreign key (organization_id, subscription_id, destination_id)
    references bakery.integration_event_subscriptions (organization_id, id, destination_id)
    on delete restrict,
  constraint integration_deliveries_destination_fk
    foreign key (organization_id, destination_id)
    references bakery.integration_destinations (organization_id, id)
    on delete restrict,
  -- A retry is another attempt of one delivery, never a second delivery of the
  -- same event, and the identity a receiver sees is derived from this triple.
  constraint integration_deliveries_attempt_unique
    unique (subscription_id, source_event_id, attempt),
  constraint integration_deliveries_identity_unique
    unique (delivery_identity)
);

-- The recovery sweep reads unsettled deliveries in due order.
create index integration_deliveries_due_idx
  on bakery.integration_deliveries (status, not_before);

grant select, insert, delete on bakery.integration_destinations to bakery_app;
grant update (status, health, acknowledgement_state, last_attempt_at,
  last_success_at, next_allowed_at, last_problem_code, tombstoned_at,
  secret_version_id, updated_at, version)
  on bakery.integration_destinations to bakery_app;

grant select, insert, delete on bakery.integration_event_subscriptions
  to bakery_app;
grant update (status, revoked_at, authorization_revision, event_kinds,
  updated_at, version)
  on bakery.integration_event_subscriptions to bakery_app;

-- No DELETE: a delivery records an attempt that may have reached a receiver.
grant select, insert on bakery.integration_deliveries to bakery_app;
grant update (status, acknowledgement_state, response_status, outcome_code,
  not_before, attempted_at, settled_at, updated_at, version)
  on bakery.integration_deliveries to bakery_app;