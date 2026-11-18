-- The workflow.stop step gets its writer.
--
-- `workflow.stop` has been a published step type since the action registry
-- landed: an author can put it in a workflow, the registry knows its input and
-- output, and `stopRun` in the work module had tests. What was missing was the
-- thing that calls it. Nothing dispatched the step, so a plan that reached one
-- either skipped it or hung, and the run's named outcome columns added in 0187
-- were columns no row ever filled.
--
-- 0187 deliberately issued no grant for those columns, and said why: bakery_app
-- holds only INSERT and SELECT on workflow_runs, the same trap that failed the
-- first attempt at this item with "permission denied for table
-- workflow_runs". The writer lands here together with the grant it needs, so the
-- two cannot be separated again.
--
-- Column-level, matching the existing grant: a stop sets the outcome, the
-- reason it ended, and the fact that it finished. It does not get to rewrite a
-- run's other columns.
--
-- `status` is not granted here and does not need to be: 0024 already grants
-- `bakery_app` update on that column, and the outcome writer uses that existing
-- grant. A stop ends a run as `canceled` rather than `succeeded`, so the status
-- comes from the same statement that records the named ending, never from a
-- separate write that could disagree with it.
grant update (outcome, outcome_reason, finished_at, updated_at, version)
  on bakery.workflow_runs
  to bakery_app;