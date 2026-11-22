-- A batch's pin digest (issue #41): the SHA-256 over what it measures (dataset
-- revision, both pins, scorer revisions and whether each is required, and the
-- repetitions), stored at admission so runs that measured the same thing can
-- be listed by it. A batch admitted before this column is null: its digest is
-- still read, computed from its pins, but it is not listed by it. Facts only:
-- the digest is computed in TypeScript (modules/evaluations/domain.ts).
alter table bakery.evaluation_batches add column pin_digest text;

create index evaluation_batches_pin_digest_idx
  on bakery.evaluation_batches (organization_id, pin_digest, created_at desc, id desc)
  where pin_digest is not null;
