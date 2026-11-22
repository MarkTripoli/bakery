-- A published workflow version pins the MCP tool each of its tool.call steps calls
-- (#435): the version, the step, the connection, the capability snapshot digest it
-- was published against and the exact tool name. The server writes one binding per
-- such step at publish and reads it back at invoke; nothing ever edits one (a
-- changed pin is a new version, and a version's bindings go with it by cascade).
-- Select and insert only, so a pin cannot be moved after publication.
grant select, insert on bakery.capability_bindings to bakery_app;
