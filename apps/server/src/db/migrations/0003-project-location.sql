-- Projects may run their tmux pane locally or use the local tmux pane as an
-- SSH transport to a remote host. Existing projects remain local.
ALTER TABLE projects ADD COLUMN location TEXT NOT NULL DEFAULT 'local';
ALTER TABLE projects ADD COLUMN ssh_host TEXT;
