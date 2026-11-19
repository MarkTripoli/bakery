-- Starts live with the workflow version, beside the specification rather than
-- inside it (one engine O8). The digest is computed over the definition alone,
-- so adding this column leaves every already-published version valid and
-- changes no existing digest: a start is authored and exported with a version,
-- but it is switched on only by publishing that version.
--
-- A version begins with no starts, which is why the default is an empty list
-- rather than null: "this version starts nothing" is a fact, and a null would
-- leave every reader deciding what absence means.
alter table bakery.workflow_versions
  add column starts jsonb not null default '[]'::jsonb;

alter table bakery.workflow_drafts
  add column starts jsonb not null default '[]'::jsonb;

-- The draft's update grant names its writable columns, so the new one is added
-- to it rather than widening the grant to the whole row: identity stays
-- immutable for the application role.
grant update (starts) on bakery.workflow_drafts to bakery_app;
