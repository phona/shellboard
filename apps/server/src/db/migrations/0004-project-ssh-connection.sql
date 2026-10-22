-- Explicit SSH connection settings. Passwords are intentionally not stored;
-- auth contains only the selected mode and, for key auth, an identity file
-- path on the Shellboard server.
ALTER TABLE projects ADD COLUMN ssh_port INTEGER;
ALTER TABLE projects ADD COLUMN ssh_username TEXT;
ALTER TABLE projects ADD COLUMN ssh_auth TEXT;
