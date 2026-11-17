-- Work type is an organization label, not a closed kernel set (chapter 25 §15.1,
-- O23). The four software-delivery labels stay valid defaults a pack can create;
-- the kernel never branches on the value, so it cannot be expressed as a
-- database constraint. Branching on a label in TypeScript is what O23 forbids,
-- and a constraint here would be a rule nobody can name in an error response.
--
-- Dropping the constraint is structural (the PostgreSQL boundary rail permits
-- it). Validation moves to the described contract: TaskCreate.taskType is a
-- lowercase kebab-case token of 1-40 characters, and TaskBrief carries whatever
-- label the task row holds.
alter table bakery.tasks
  drop constraint if exists tasks_task_type_check;