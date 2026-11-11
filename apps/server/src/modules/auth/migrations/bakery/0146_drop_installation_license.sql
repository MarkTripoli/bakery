-- Every feature is always available, so the installation no longer stores a
-- licence key. Drop the narrow write function first, then the column.
drop function bakery.set_installation_license(text, integer, uuid);

alter table bakery.installation_settings drop column license_key;
