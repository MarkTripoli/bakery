-- Unlisted definitions and coordinator definition proposals (issue #420,
-- chapter 25 section 13 item 13).
--
-- Visibility. A workflow definition is listed (it appears in the library and
-- can be made the active version) or unlisted (a coordinator-proposed pipeline
-- a person accepted in a conversation: readable by id, runnable at an exact
-- published version, absent from the library). Visibility and origin are
-- outside every digest, the same rule coordination plans follow for their
-- origin (0141). The vocabularies (listed | unlisted; origin_kind gains
-- coordinator) live in TypeScript, not in a CHECK constraint: the PostgreSQL
-- boundary rail forbids them.
--
-- origin_conversation_id and origin_turn_id say which conversation and which
-- coordinator turn proposed an unlisted definition; both are null for every
-- other origin. Their foreign keys null only their own column when the
-- referenced row goes, so an organization delete cascades in any order.
--
-- Save as workflow (factory-modes.md section 4.2 step 5) copies one published
-- version of an unlisted definition into a NEW listed definition with its own
-- draft, through #598's one copy writer. The source stays unlisted and
-- unchanged. The copy has origin_kind copy, and 0179's
-- origin_source_workflow_id, origin_source_version_id and origin_source_digest
-- name the source definition, version and digest (sourceWorkflowId,
-- sourceVersionId and sourceDigest in the read shape). One source version has
-- at most one save-as-workflow copy: the writer refuses a second one with
-- workflow_copy_exists under the source row lock. There is no unique index for
-- it, because the same columns also record ordinary "Make a copy" forks, which
-- may copy one version more than once.
--
-- Existing rows default to listed with null provenance, which is what they
-- already are, so no data repair is needed.
alter table bakery.workflow_definitions
  add column visibility text not null default 'listed',
  add column origin_conversation_id uuid,
  add column origin_turn_id uuid,
  add constraint workflow_definitions_origin_conversation_fk
    foreign key (organization_id, origin_conversation_id)
    references bakery.conversations (organization_id, id)
    on delete set null (origin_conversation_id),
  add constraint workflow_definitions_origin_turn_fk
    foreign key (organization_id, origin_turn_id)
    references bakery.conversation_turns (organization_id, id)
    on delete set null (origin_turn_id);

-- One proposal is one coherent change a coordinator turn asked for, decided
-- whole by a person: the full definition document it wants the conversation's
-- unlisted draft to hold. workflow_id names the unlisted definition it edits;
-- null proposes a new one, and accepting it fills workflow_id with the
-- definition the accept created. base_draft_version is the draft version the
-- proposal was made against (null when there was no draft), the precondition
-- the accept passes to the editor's own draft update, so a draft changed since
-- refuses a stale proposal instead of overwriting it.
--
-- state is waiting | accepted | rejected, enforced by the decision path.
-- bakery_app may only move a waiting row to a decision; the proposal content
-- itself is immutable after insert.
create table bakery.workflow_definition_proposals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  conversation_id uuid not null,
  turn_id uuid not null,
  workflow_id uuid,
  base_draft_version integer,
  name text not null,
  definition jsonb not null,
  digest text not null,
  state text not null default 'waiting',
  decided_by uuid,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint workflow_definition_proposals_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint workflow_definition_proposals_conversation_fk
    foreign key (organization_id, conversation_id)
    references bakery.conversations (organization_id, id) on delete cascade,
  constraint workflow_definition_proposals_turn_fk
    foreign key (organization_id, turn_id)
    references bakery.conversation_turns (organization_id, id) on delete cascade,
  constraint workflow_definition_proposals_workflow_fk
    foreign key (organization_id, workflow_id)
    references bakery.workflow_definitions (organization_id, id)
    on delete cascade,
  constraint workflow_definition_proposals_decided_by_fk
    foreign key (decided_by)
    references bakery.principals (id) on delete restrict,
  constraint workflow_definition_proposals_organization_id_unique
    unique (organization_id, id)
);

create index workflow_definition_proposals_conversation_idx
  on bakery.workflow_definition_proposals (
    organization_id, conversation_id, created_at desc, id desc
  );

grant select, insert on bakery.workflow_definition_proposals to bakery_app;
grant update (workflow_id, state, decided_by, decided_at, updated_at, version)
  on bakery.workflow_definition_proposals
  to bakery_app;
