-- The Slack app Bakery signs and speaks as (#415).
--
-- One native app, installed into workspaces, is what the design names. Its signing
-- secret is the app's, not a workspace's: Slack signs every request to Bakery with
-- it, and verification happens before anything in the body is trusted -- including
-- the team id. So the secret cannot be looked up from the request; it is read from
-- here, and the verified request's workspace is then matched against the post it
-- names.
--
-- One row, the same shape as the GitHub App registration: the app's identity in
-- columns, both secrets in bakery.secrets with their active version in
-- bakery.secret_versions under the same encryption key. Nothing here holds plaintext
-- and no route returns a secret; the ingress decrypts the signing secret in memory
-- and the client secret is only for the installation flow.
--
-- `id` is boolean with a single true row, like installation_settings: "the Slack
-- app" is a property of the installation, not of an organization, so there is
-- nothing to key it on and no second row to allow.
create table bakery.slack_app_settings (
  id boolean primary key default true,
  -- Slack's own app id (A...). Opaque here; the shape is checked in code, where a
  -- refusal can say which field was wrong.
  external_app_id text not null,
  -- The app's OAuth client id, which is the audience of the signing-in token.
  client_id text not null,
  signing_secret_id uuid not null,
  client_secret_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint slack_app_settings_signing_secret_fk
    foreign key (signing_secret_id) references bakery.secrets (id),
  constraint slack_app_settings_client_secret_fk
    foreign key (client_secret_id) references bakery.secrets (id)
);

-- One row, enforced by structure: a unique index on a constant leaves no second
-- row to insert, without a CHECK the boundary rail forbids in a migration.
create unique index slack_app_settings_single_row
  on bakery.slack_app_settings ((true));

grant select on bakery.slack_app_settings to bakery_app;

comment on table bakery.slack_app_settings is
  'The one Slack app Bakery verifies and signs as; secrets live encrypted in bakery.secrets.';
