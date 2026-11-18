-- Provider routes, their monitored health and the incidents an outage opens
-- (#26 slice 2).
--
-- Slice 1 published the five reads; nothing served them. These are the
-- core-owned tables behind that surface: a route is the unit an outage is
-- scoped to, so one expired credential, one 429 or one broken network never
-- says the organization is down.
--
-- No row in these tables decides anything on its own. The circuit state is a
-- projection the host writes after judging evidence, and the tables are shaped
-- so the reads slice 1 promised are one query each:
--
--   - the route list needs the circuit state and the incident generation on the
--     route itself, or every page would fan out to a second table,
--   - health is one row per route, keyed by the route, so a health read cannot
--     return a stale second opinion,
--   - an incident carries its own generation, and a newer generation is what
--     makes an older one superseded. That is the fence the issue's AC1 needs:
--     a stale probe arriving late cannot close an incident it predates.
--
-- Business rules stay out of the database: there is no trigger, no rule and no
-- row-level security here. The invariants stated are the ones a mistaken writer
-- could otherwise satisfy silently (one health row per route, one open incident
-- per route, non-negative counters), and nothing more.

create table bakery.provider_routes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  -- The provider's own name for the service, lowercase and stable: it is what
  -- an operator matches against a status page, not a display label.
  provider text not null,
  -- The base URL work is admitted against. It is not a credential, and it is
  -- bounded because the contract bounds it.
  endpoint text not null,
  region text,
  model text not null,
  harness text not null,
  billing_route text not null,
  provider_account_id uuid,
  worker_binding_id uuid,
  credential_location text not null,
  status text not null default 'active',
  health text not null default 'unverified',
  incident_id uuid,
  incident_generation integer not null default 0,
  last_probe_at timestamptz,
  next_probe_at timestamptz,
  -- Separate from `health` on purpose: a route that answers a health read is
  -- reachable, and only a real inference attempt proves the inference path.
  -- Reading health never sets this.
  inference_verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint provider_routes_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint provider_routes_account_fk
    foreign key (organization_id, provider_account_id)
    references bakery.model_provider_accounts (organization_id, id)
    on delete restrict,
  constraint provider_routes_binding_fk
    foreign key (organization_id, worker_binding_id)
    references bakery.worker_provider_bindings (organization_id, id)
    on delete restrict,
  constraint provider_routes_organization_id_unique
    unique (organization_id, id),
  constraint provider_routes_status_check
    check (status in ('active', 'disabled', 'revoked')),
  constraint provider_routes_health_check
    check (health in ('healthy', 'degraded', 'open', 'unverified')),
  constraint provider_routes_harness_check
    check (harness in ('pi', 'claude_code', 'codex', 'mastra')),
  constraint provider_routes_billing_route_check
    check (billing_route in ('subscription', 'api_metered', 'local')),
  constraint provider_routes_credential_location_check
    check (credential_location in ('harness_host', 'bakery_secret')),
  constraint provider_routes_generation_check
    check (incident_generation >= 0),
  constraint provider_routes_endpoint_bytes_check
    check (octet_length(endpoint) between 1 and 2048)
);

-- The route list is keyset-paginated on (created_at, id) inside one
-- organization, and the two filters are equality predicates, so the index
-- carries them in the order the query names them.
create index provider_routes_organization_created_idx
  on bakery.provider_routes (organization_id, created_at desc, id desc);

create index provider_routes_organization_status_created_idx
  on bakery.provider_routes (organization_id, status, created_at desc, id desc);

create index provider_routes_organization_health_created_idx
  on bakery.provider_routes (organization_id, health, created_at desc, id desc);

-- One health row per route. Keying on the route rather than holding an id
-- means a second writer updating health cannot insert a second opinion: it can
-- only update this row, and its `version` column is what an optimistic writer
-- compares.
create table bakery.provider_route_health (
  organization_id uuid not null,
  route_id uuid not null,
  health text not null,
  reason text,
  consecutive_failures integer not null default 0,
  consecutive_inference_trials integer not null default 0,
  -- A digest or bounded token that names the evidence the state was judged
  -- from, never the provider's free-form output.
  evidence_watermark text,
  last_failure_at timestamptz,
  last_success_at timestamptz,
  last_probe_at timestamptz,
  next_probe_at timestamptz,
  -- Set while a probe is leased. Two monitors that both believe they may probe
  -- would double the spend the issue exists to prevent.
  probe_lease_expires_at timestamptz,
  corroboration text not null default 'none',
  incident_id uuid,
  incident_generation integer not null default 0,
  inference_verified_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint provider_route_health_pkey primary key (organization_id, route_id),
  constraint provider_route_health_route_fk
    foreign key (organization_id, route_id)
    references bakery.provider_routes (organization_id, id) on delete cascade,
  constraint provider_route_health_health_check
    check (health in ('healthy', 'degraded', 'open', 'unverified')),
  constraint provider_route_health_reason_check
    check (
      reason is null or reason in (
        'rate_limited', 'credential_invalid', 'quota_exhausted',
        'transport_failure', 'provider_error', 'timeout',
        'reachable_inference_unverified'
      )
    ),
  constraint provider_route_health_corroboration_check
    check (corroboration in ('none', 'status_page')),
  constraint provider_route_health_counts_check
    check (consecutive_failures >= 0 and consecutive_inference_trials >= 0),
  constraint provider_route_health_generation_check
    check (incident_generation >= 0),
  constraint provider_route_health_watermark_bytes_check
    check (
      evidence_watermark is null or
      octet_length(evidence_watermark) between 1 and 512
    )
);

create table bakery.provider_incidents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  route_id uuid not null,
  -- Monotonic per route. A probe carries the generation it was admitted under,
  -- so a late answer from generation N cannot close or advance generation N+1.
  generation integer not null,
  status text not null default 'open',
  severity text not null,
  reason text,
  first_failure_at timestamptz not null,
  last_failure_at timestamptz not null,
  last_probe_at timestamptz,
  next_probe_at timestamptz,
  evidence_watermark text,
  affected_task_count integer not null default 0,
  recovered_task_count integer not null default 0,
  switched_task_count integer not null default 0,
  still_blocked_task_count integer not null default 0,
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint provider_incidents_route_fk
    foreign key (organization_id, route_id)
    references bakery.provider_routes (organization_id, id) on delete cascade,
  constraint provider_incidents_organization_id_unique
    unique (organization_id, id),
  constraint provider_incidents_route_generation_unique
    unique (organization_id, route_id, generation),
  constraint provider_incidents_status_check
    check (status in ('open', 'recovered', 'superseded')),
  constraint provider_incidents_severity_check
    check (severity in ('degraded', 'outage')),
  constraint provider_incidents_reason_check
    check (
      reason is null or reason in (
        'rate_limited', 'credential_invalid', 'quota_exhausted',
        'transport_failure', 'provider_error', 'timeout',
        'reachable_inference_unverified'
      )
    ),
  constraint provider_incidents_generation_check
    check (generation >= 1),
  constraint provider_incidents_counts_check
    check (
      affected_task_count >= 0 and recovered_task_count >= 0 and
      switched_task_count >= 0 and still_blocked_task_count >= 0
    ),
  -- A closed incident names when it closed; an open one has not closed yet.
  -- Stating it here is what stops a reader seeing "closed" with no time and
  -- having to guess whether the writer intended it.
  constraint provider_incidents_closed_check
    check (
      (status = 'open' and closed_at is null) or
      (status <> 'open' and closed_at is not null)
    )
);

-- At most one open incident per route. A second open incident would give the
-- route two current generations and every stale-probe check would be ambiguous.
create unique index provider_incidents_one_open_per_route_idx
  on bakery.provider_incidents (organization_id, route_id)
  where status = 'open';

create index provider_incidents_organization_created_idx
  on bakery.provider_incidents (organization_id, opened_at desc, id desc);

create index provider_incidents_route_created_idx
  on bakery.provider_incidents (organization_id, route_id, opened_at desc, id desc);

create index provider_incidents_organization_status_created_idx
  on bakery.provider_incidents (
    organization_id, status, opened_at desc, id desc
  );

create index provider_incidents_organization_severity_created_idx
  on bakery.provider_incidents (
    organization_id, severity, opened_at desc, id desc
  );

-- The route's current incident is read by id on the route row; it exists so a
-- listing needs no join. The foreign key is deferred to a separate statement
-- because the two tables reference each other.
alter table bakery.provider_routes
  add constraint provider_routes_incident_fk
  foreign key (organization_id, incident_id)
  references bakery.provider_incidents (organization_id, id)
  on delete set null;
