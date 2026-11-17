-- Work type is an organization label, not a closed kernel set (chapter 25 §15.1,
-- O23). The four software-delivery labels stay valid defaults a pack can create;
-- the kernel never branches on the value, so it cannot be expressed as a
-- database constraint. Branching on a label in TypeScript is what O23 forbids,
-- and a constraint here would be a rule nobody can name in an error response.
--
-- Dropping the constraint is structural (the PostgreSQL boundary rail permits
-- it). Validation moves to the described contract: TaskCreate.taskType and
-- TaskBrief.taskType are lowercase kebab-case tokens of 1-40 characters.
--
-- `if exists` is deliberate and this statement is idempotent by design, not
-- defensive noise. 0008 creates the CHECK inline and unnamed, so PostgreSQL
-- auto-names it `tasks_task_type_check`; spelling that generated name is the
-- only way to drop it. On a database whose 0008 ran before the name was relied
-- on, or on a re-run against an already-migrated database, the constraint is
-- simply absent and the statement is a no-op rather than an error.
alter table bakery.tasks
  drop constraint if exists tasks_task_type_check;