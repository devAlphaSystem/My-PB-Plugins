# PocketBase Plugins

A collection of plugins I created for my personal use, bringing extra tools to the PocketBase admin dashboard while keeping its native look and feel.

For Linux installation, stop PocketBase and run the desired command from your instance's directory or directly inside its `pb_hooks` directory. The installers require Bash, curl, GNU tar, gzip, and GNU coreutils.

The installers select the destination based on the current working directory:

- If the current directory is named `pb_hooks`, install there.
- Otherwise, use its direct child named `pb_hooks` if it exists.
- If that child does not exist, create `pb_hooks` in the current directory and install there.

The installers do not search recursively. The selected `pb_hooks` must be a real directory, not a file or symbolic link, and allow write and traversal access. Creating it also requires write and traversal access to the current directory. The same single command handles all three cases.

## [Hooks Manager](Hooks%20Manager/README.md)

Adds a **Hooks** page to browse, create, edit, and delete hook files. Save drafts before applying changes to `pb_hooks`.

### One-command installation on Linux

```bash
bash -o pipefail -c 'curl -fsSL https://raw.githubusercontent.com/devAlphaSystem/My-PB-Plugins/main/Hooks%20Manager/install.sh | bash'
```

## [Cron Manager](Cron%20Manager/README.md)

Extends **Settings > Crons** with tools to create JavaScript jobs, edit schedules, pause or resume jobs, run them manually, and view execution history for managed jobs.

### One-command installation on Linux

```bash
bash -o pipefail -c 'curl -fsSL https://raw.githubusercontent.com/devAlphaSystem/My-PB-Plugins/main/Cron%20Manager/install.sh | bash'
```

## [Update Notifier](Update%20Notifier/README.md)

Checks the latest official PocketBase release and adds an **Update available: v...** link beside the current version in the dashboard footer. Checks use a shared server cache and the native superuser session.

### One-command installation on Linux

```bash
bash -o pipefail -c 'curl -fsSL https://raw.githubusercontent.com/devAlphaSystem/My-PB-Plugins/main/Update%20Notifier/install.sh | bash'
```

After installation, start PocketBase and reload the admin dashboard with **Ctrl+Shift+R**.
