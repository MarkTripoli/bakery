-- Backup settings (issue #80 slice S1b): when backups run and where a copy is
-- sent off the server. Each is one installation-wide row. The S3 access key id
-- and secret access key are one AES-GCM payload in bakery.secrets /
-- bakery.secret_versions with organization_id and application_id null (as the
-- skill storage credentials are); these tables hold only the non-secret fields
-- and the secret id. `version` is the If-Match precondition. Structure only:
-- validation, authorization and the singleton rule are enforced in TypeScript.

create table bakery.backup_schedule_settings (
  id text primary key,
  enabled boolean not null default false,
  -- hourly, daily or weekly; the closed vocabulary is owned by TypeScript.
  interval_kind text not null default 'daily',
  -- HH:MM in UTC: the minute of every hour for hourly, the time of day for
  -- daily and weekly.
  time_of_day_utc text not null default '03:00',
  days_to_keep integer not null default 30,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint backup_schedule_settings_updated_by_fk
    foreign key (updated_by) references bakery.principals (id)
    on delete set null
);

create table bakery.backup_offsite_settings (
  id text primary key,
  endpoint text not null,
  region text not null,
  bucket text not null,
  prefix text not null default '',
  secret_id uuid,
  credential_updated_at timestamptz,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint backup_offsite_settings_secret_fk
    foreign key (secret_id) references bakery.secrets (id),
  constraint backup_offsite_settings_updated_by_fk
    foreign key (updated_by) references bakery.principals (id)
    on delete set null
);

grant select on bakery.backup_schedule_settings to bakery_app;
grant insert (
  id, enabled, interval_kind, time_of_day_utc, days_to_keep, version,
  created_at, updated_at, updated_by
) on bakery.backup_schedule_settings to bakery_app;
grant update (
  enabled, interval_kind, time_of_day_utc, days_to_keep, version, updated_at,
  updated_by
) on bakery.backup_schedule_settings to bakery_app;

grant select on bakery.backup_offsite_settings to bakery_app;
grant insert (
  id, endpoint, region, bucket, prefix, secret_id, credential_updated_at,
  version, created_at, updated_at, updated_by
) on bakery.backup_offsite_settings to bakery_app;
grant update (
  endpoint, region, bucket, prefix, secret_id, credential_updated_at, version,
  updated_at, updated_by
) on bakery.backup_offsite_settings to bakery_app;
