-- Whether a rollback of this release ended in `failed` (#63). Then the
-- environment may not run the release before this one, and the status alone
-- cannot say so: `failed` is also where a deploy that never changed anything
-- ends. The flag is set once by the move from rolling_back to failed, in code,
-- and never cleared. No rule lives in the database.
alter table bakery.deployments
  add column rollback_failed boolean not null default false;
