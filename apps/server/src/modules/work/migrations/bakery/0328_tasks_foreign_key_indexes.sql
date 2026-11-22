-- Two foreign-key checks on bakery.tasks had no index, so each read the whole
-- table. The bounded-load lane (#48) caught them as sequential scans on a large
-- table.
--
-- Deleting a principal checks tasks.created_by, which filters on created_by
-- alone.
create index tasks_created_by_idx
  on bakery.tasks (created_by);

-- Deleting a task sets its subtasks' parent to null (tasks_parent_fk), which
-- filters on (organization_id, parent_task_id).
create index tasks_parent_task_idx
  on bakery.tasks (organization_id, parent_task_id)
  where parent_task_id is not null;
