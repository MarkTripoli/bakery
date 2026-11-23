-- Asynchronous MCP tools (#439, chapter 25 section 15.4, "long-running tools").
--
-- Some tools do not finish in the call: they accept a job and answer with a handle,
-- and a second tool reports the job's status. The Admin declares that shape on the
-- classification of the submitting tool, beside the paired read that already
-- confirms a write, so the declaration is the grant: nothing runs asynchronously
-- unless an Admin said how to read its status.
--
-- `async_form` is one JSON document, null for an ordinary tool:
--   handlePath, handleArgument  where the submit answer carries the job's handle,
--                               and the argument of the paired read that takes it;
--   statusPath                  where the paired read's answer carries the status;
--   doneValues, failedValues    the status values that end the job;
--   pollEveryMs                 how often the waiting step looks again.
-- Its shape, and that it is only set on a write_reconcilable tool, are enforced in
-- TypeScript; the schema carries no CHECK and no trigger.
alter table bakery.mcp_tool_classifications
  add column async_form jsonb;

grant update (async_form) on bakery.mcp_tool_classifications to bakery_app;
