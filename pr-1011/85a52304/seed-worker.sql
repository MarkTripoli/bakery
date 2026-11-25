begin;
insert into bakery.principals (id, display_name, principal_type) values ('70a10000-0000-4000-8000-000000000001', 'Build host principal', 'worker');
insert into bakery.worker_hosts (id, organization_id, principal_id, principal_type, name, os, architecture, capabilities, slots, status, desired_mode, last_heartbeat_at, credential_hash, worker_session_id, worker_session_generation)
select '70a10000-0000-4000-8000-000000000002', o.id, '70a10000-0000-4000-8000-000000000001', 'worker', 'build-host-01', 'linux', 'x64', '["claude"]'::jsonb, 2, 'online', 'accepting', now(), 'seed-70-credential', '70a10000-0000-4000-8000-000000000003', 1 from bakery.organizations o limit 1;
commit;
