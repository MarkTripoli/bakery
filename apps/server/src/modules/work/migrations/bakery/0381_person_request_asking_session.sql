alter table bakery.person_requests
  add column asked_by_session_id uuid,
  add constraint person_requests_asked_by_session_fk
    foreign key (asked_by_session_id)
    references bakery.agent_sessions (id) on delete set null;

create index person_requests_agent_asks
  on bakery.person_requests (organization_id, run_id)
  where asked_by_kind = 'agent';
