-- GHI-739: where Bakery sends its measurements is set in the app, not by an
-- environment variable. One row is one destination: a kind of destination (the
-- adapter that delivers to it), a name, whether it is on, which of the six kinds
-- of measurement it receives, and its non-secret settings. Its secret settings
-- (a sign-in header value, a Sentry key) are one JSON value sealed under the
-- installation key as an installation-owned secret; the row holds only the id of
-- that secret, never a value. The vocabulary of kind and measurements is
-- validated in TypeScript at the writer, so a new adapter needs no migration.
-- Removing a destination deletes the row; the application role cannot delete the
-- sealed secret record, which nothing references afterwards.
create table bakery.telemetry_destinations (
  id uuid primary key,
  kind text not null,
  name text not null,
  enabled boolean not null default true,
  measurements text[] not null,
  settings jsonb not null default '{}'::jsonb,
  -- Names of the secret fields that hold a value, so a read can say which are set
  -- without opening the secret.
  secret_fields text[] not null default '{}',
  secret_id uuid,
  credential_updated_at timestamptz,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint telemetry_destinations_secret_fk
    foreign key (secret_id) references bakery.secrets (id),
  constraint telemetry_destinations_created_by_fk
    foreign key (created_by) references bakery.principals (id),
  constraint telemetry_destinations_updated_by_fk
    foreign key (updated_by) references bakery.principals (id)
);

-- A name is unique ignoring case, so two destinations cannot look alike in a list
-- or in an alert.
create unique index telemetry_destinations_name_unique
  on bakery.telemetry_destinations (lower(name));
create index telemetry_destinations_created_idx
  on bakery.telemetry_destinations (created_at, id);

revoke all on bakery.telemetry_destinations from bakery_app;
grant select, insert, delete on bakery.telemetry_destinations to bakery_app;
grant update (name, enabled, measurements, settings, secret_fields, secret_id,
  credential_updated_at, updated_by, updated_at, version)
  on bakery.telemetry_destinations to bakery_app;
