Test-only scripted coordinator outcomes (BAKERY_SCRIPTED_COORDINATOR_DIR).

Lookup: `<triggerMessageId>.json`, `<conversationId>.json`, `default.json`.
`<turnId>.hold` blocks a turn until `<turnId>.release` exists. Enable in compose
(server must run with `BAKERY_ENV=test`):
`BAKERY_ENV=test BAKERY_SCRIPTED_COORDINATOR_DIR=/workspace/tests/fixtures/scripted-coordinator`.

`templates/fs26-*.json` are copies the FS26 real-API browser spec places as
`<conversationId>.json` before each agent turn (reply, question, plan revision,
revised plan revision, results). They are not looked up by name.
